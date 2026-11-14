// The REST v3 surface (/api/v3): repositories, contents, branches, commits, labels, issues and
// pull requests, in GitHub's shapes and statuses. Every handler returns {status, body, headers};
// app.ts serializes. Errors are thrown as HttpError and rendered by app.ts as {"message": ...}.
//
// The wire contract the suite drives (checks-rest.ts's header is the authority):
//   - a repo under another owner is 404 (never 403); no token is 401 (decided in app.ts);
//   - contents PUT on an unborn repository creates its first commit; a stale sha is 409;
//   - an issue with an unknown label is 422; a conflicted pull-request merge is 405;
//   - list endpoints paginate with Link rel="next" headers on this origin.

import { parseCommit } from './gitobj.ts';
import {
  Forge,
  type IssueRec,
  type PullRec,
  type RepoRec,
  VIEWER,
  commitMessageOf,
  createIssue,
  createPull,
  deleteFile,
  filesAtCommit,
  mergePull,
  pullChanges,
  refOf,
  resolveRef,
  writeFile,
} from './store.ts';
import { commitTree, listCommits as gitListCommits, parseTree } from './gitobj.ts';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RestRequest {
  method: string;
  /** Decoded path segments after /api/v3. */
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
  /** Absolute base URL of this request (scheme + authority), for Link headers. */
  origin: string;
  /** The full request path (no query), for Link headers. */
  path: string;
}

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const notFound = (): HttpError => new HttpError(404, 'Not Found');

export function repoOr404(forge: Forge, owner: string, name: string): RepoRec {
  const repo = forge.getRepo(owner, name);
  if (!repo) throw notFound();
  return repo;
}

// ----------------------------------------------------------------------------------------------
// shapes

export function repoJson(forge: Forge, repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: forge.iso(repo.seq),
    updated_at: forge.iso(repo.seq),
  };
}

export function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' };
}

function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', description: label?.description ?? null };
}

export function issueJson(forge: Forge, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.dbId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    comments: issue.comments.length,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: forge.iso(issue.seq),
    updated_at: forge.iso(issue.seq),
  };
}

export function pullJson(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = refOf(repo, pull.headRef) ?? pull.headSha;
  const baseSha = refOf(repo, pull.baseRef) ?? '';
  return {
    id: pull.dbId,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedSeq === null ? null : forge.iso(pull.mergedSeq),
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: forge.iso(pull.seq),
    updated_at: forge.iso(pull.mergedSeq ?? pull.seq),
  };
}

function commentJson(forge: Forge, comment: { id: number; body: string; seq: number }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: forge.iso(comment.seq),
    updated_at: forge.iso(comment.seq),
  };
}

// ----------------------------------------------------------------------------------------------
// pagination

interface Page {
  perPage: number;
  page: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

/** Slice `items` to the requested page and build the Link header for the pages around it. */
function paginate<T>(req: RestRequest, items: readonly T[]): { slice: T[]; headers: Record<string, string> } {
  const { perPage, page } = pageOf(req.query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const urlFor = (target: number): string => {
    const params = new URLSearchParams(req.query);
    params.set('per_page', String(perPage));
    params.set('page', String(target));
    return `${req.origin}${req.path}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < lastPage) {
    links.push(`<${urlFor(page + 1)}>; rel="next"`, `<${urlFor(lastPage)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`, `<${urlFor(page - 1)}>; rel="prev"`);
  }
  return { slice, headers: links.length ? { link: links.join(', ') } : {} };
}

// ----------------------------------------------------------------------------------------------
// repositories

function createRepo(forge: Forge, req: RestRequest): RestReply {
  const body = req.body ?? {};
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') throw new HttpError(422, 'Repository name is required');
  if (forge.getRepo(VIEWER.login, name)) {
    throw new HttpError(422, 'Repository creation failed: name already exists on this account');
  }
  const repo = forge.createRepo(name, {
    description: typeof body.description === 'string' ? body.description : '',
    private: typeof body.private === 'boolean' ? body.private : false,
  });
  if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
  return { status: 201, body: repoJson(forge, repo) };
}

function listOwnRepos(forge: Forge, req: RestRequest): RestReply {
  const { slice, headers } = paginate(req, forge.listRepos());
  return { status: 200, body: slice.map((repo) => repoJson(forge, repo)), headers };
}

function getRepo(forge: Forge, owner: string, name: string): RestReply {
  return { status: 200, body: repoJson(forge, repoOr404(forge, owner, name)) };
}

function patchRepo(forge: Forge, owner: string, name: string, req: RestRequest): RestReply {
  const repo = repoOr404(forge, owner, name);
  const body = req.body ?? {};
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.private = body.private;
  if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
  if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
    forge.repos.delete(`${repo.owner}/${repo.name}`);
    repo.name = body.name;
    forge.repos.set(`${repo.owner}/${repo.name}`, repo);
  }
  return { status: 200, body: repoJson(forge, repo) };
}

function deleteRepo(forge: Forge, owner: string, name: string): RestReply {
  const repo = repoOr404(forge, owner, name);
  forge.deleteRepo(repo);
  return { status: 204 };
}

// ----------------------------------------------------------------------------------------------
// branches, refs, commits

function listBranches(forge: Forge, repo: RepoRec, req: RestRequest): RestReply {
  const branches = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const { slice, headers } = paginate(req, branches);
  return { status: 200, body: slice, headers };
}

function getBranch(repo: RepoRec, branch: string): RestReply {
  const sha = refOf(repo, branch);
  if (!sha) throw notFound();
  return { status: 200, body: { name: branch, commit: { sha }, protected: false } };
}

function createRef(repo: RepoRec, req: RestRequest): RestReply {
  const body = req.body ?? {};
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new HttpError(422, 'Invalid ref or sha');
  }
  const target = repo.store.get(sha);
  if (!target) throw new HttpError(422, `Object ${sha} does not exist`);
  if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
  repo.refs.set(ref, sha);
  return { status: 201, body: { ref, object: { sha, type: target.type } } };
}

function getRef(repo: RepoRec, refPath: string): RestReply {
  const ref = `refs/${refPath}`;
  const sha = repo.refs.get(ref);
  if (!sha) throw notFound();
  const target = repo.store.get(sha);
  return { status: 200, body: { ref, object: { sha, type: target?.type ?? 'commit' } } };
}

function listCommits(forge: Forge, repo: RepoRec, req: RestRequest): RestReply {
  const shaParam = req.query.get('sha') ?? undefined;
  const tip = resolveRef(repo, shaParam);
  if (!tip) return { status: 200, body: [] };
  const { perPage, page } = pageOf(req.query);
  const commits = listCommitsAll(repo, tip, perPage * page);
  const slice = commits.slice((page - 1) * perPage, page * perPage);
  return {
    status: 200,
    body: slice.map((oid) => {
      const obj = repo.store.get(oid)!;
      const commit = parseCommit(obj.data);
      const stamp = / (\d+) [+-]\d{4}$/.exec(commit.author);
      const date = stamp ? new Date(Number(stamp[1]) * 1000).toISOString() : forge.iso(repo.seq);
      const person = (line: string) => {
        const match = /^(.*) <(.*)>/.exec(line);
        return { name: match?.[1] ?? '', email: match?.[2] ?? '', date };
      };
      return {
        sha: oid,
        commit: {
          message: commitMessageOf(repo, oid),
          author: person(commit.author),
          committer: person(commit.committer),
          tree: { sha: commit.tree },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      };
    }),
  };
}

function listCommitsAll(repo: RepoRec, tip: string, limit: number): string[] {
  return gitListCommits(repo.store, tip, limit);
}

// ----------------------------------------------------------------------------------------------
// contents

function contentsGet(forge: Forge, repo: RepoRec, path: string, req: RestRequest): RestReply {
  void forge;
  const ref = req.query.get('ref') ?? undefined;
  const commit = resolveRef(repo, ref);
  if (!commit) throw notFound();
  const tree = commitTree(repo.store, commit);
  if (!tree) throw notFound();
  if (path === '') return { status: 200, body: dirListing(repo, tree, '') };
  // Walk to the named node.
  const segments = path.split('/');
  let treeOid = tree;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = repo.store.get(treeOid);
    if (!obj || obj.type !== 'tree') throw notFound();
    const entry = parseTree(obj.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) throw notFound();
    if (i === segments.length - 1) {
      if (entry.mode === '40000') return { status: 200, body: dirListing(repo, entry.oid, path) };
      const blob = repo.store.get(entry.oid);
      if (!blob) throw notFound();
      return {
        status: 200,
        body: {
          type: 'file',
          encoding: 'base64',
          content: blob.data.toString('base64'),
          name: entry.name,
          path,
          sha: entry.oid,
          size: blob.data.length,
        },
      };
    }
    if (entry.mode !== '40000') throw notFound();
    treeOid = entry.oid;
  }
  throw notFound();
}

function dirListing(repo: RepoRec, treeOid: string, prefix: string): Record<string, unknown>[] {
  const obj = repo.store.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  return parseTree(obj.data)
    .map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : (repo.store.get(entry.oid)?.data.length ?? 0),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function contentsPut(forge: Forge, repo: RepoRec, path: string, req: RestRequest): RestReply {
  const body = req.body ?? {};
  const message = typeof body.message === 'string' ? body.message : '';
  const contentB64 = typeof body.content === 'string' ? body.content : '';
  if (path === '') throw new HttpError(422, 'Path is required');
  const content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const tip = refOf(repo, branch) ?? refOf(repo, repo.defaultBranch);
  const existing = tip ? filesAtCommit(repo, tip).get(path) : undefined;
  const sentSha = typeof body.sha === 'string' ? body.sha : undefined;
  if (existing !== undefined && sentSha !== undefined && sentSha !== existing) {
    throw new HttpError(409, `${path} does not match the sha ${sentSha}`);
  }
  if (existing === undefined && sentSha !== undefined && refOf(repo, branch)) {
    throw new HttpError(422, `${path} does not exist on ${branch}`);
  }
  const result = writeFile(forge, repo, branch, path, content, message);
  return {
    status: result.created ? 201 : 200,
    body: {
      content: { name: path.split('/').pop(), path, sha: result.blobSha, size: content.length, encoding: 'base64' },
      commit: { sha: result.commitSha, message },
    },
  };
}

function contentsDelete(forge: Forge, repo: RepoRec, path: string, req: RestRequest): RestReply {
  const body = req.body ?? {};
  const message = typeof body.message === 'string' ? body.message : '';
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const tip = refOf(repo, branch);
  const existing = tip ? filesAtCommit(repo, tip).get(path) : undefined;
  if (existing === undefined) throw notFound();
  const sentSha = typeof body.sha === 'string' ? body.sha : undefined;
  if (sentSha !== undefined && sentSha !== existing) {
    throw new HttpError(409, `${path} does not match the sha ${sentSha}`);
  }
  const result = deleteFile(forge, repo, branch, path, message);
  return { status: 200, body: { content: null, commit: { sha: result.commitSha, message } } };
}

// ----------------------------------------------------------------------------------------------
// labels

function createLabel(repo: RepoRec, req: RestRequest): RestReply {
  const body = req.body ?? {};
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') throw new HttpError(422, 'Label name is required');
  const existing = repo.labels.get(name);
  if (!existing) {
    repo.labels.set(name, {
      name,
      color: typeof body.color === 'string' ? body.color : 'ededed',
      description: typeof body.description === 'string' ? body.description : null,
    });
  }
  return { status: 201, body: labelJson(repo, name) };
}

function listLabels(repo: RepoRec, req: RestRequest): RestReply {
  const labels = [...repo.labels.values()].map((label) => labelJson(repo, label.name));
  const { slice, headers } = paginate(req, labels);
  return { status: 200, body: slice, headers };
}

// ----------------------------------------------------------------------------------------------
// issues

function validateLabels(repo: RepoRec, labels: unknown): string[] {
  if (labels === undefined) return [];
  if (!Array.isArray(labels)) throw new HttpError(422, 'Labels must be an array');
  const names: string[] = [];
  for (const label of labels) {
    const name = typeof label === 'string' ? label : '';
    if (!repo.labels.has(name)) throw new HttpError(422, `Label "${name}" does not exist in this repository`);
    names.push(name);
  }
  return names;
}

function createIssueHandler(forge: Forge, repo: RepoRec, req: RestRequest): RestReply {
  const body = req.body ?? {};
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') throw new HttpError(422, 'Title is required');
  const labels = validateLabels(repo, body.labels);
  const issue = createIssue(forge, repo, {
    title,
    body: typeof body.body === 'string' ? body.body : '',
    labels,
  });
  return { status: 201, body: issueJson(forge, repo, issue) };
}

function listIssues(forge: Forge, repo: RepoRec, req: RestRequest): RestReply {
  const state = req.query.get('state') ?? 'open';
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  const direction = req.query.get('direction') ?? 'desc';
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const { slice, headers } = paginate(req, issues);
  return { status: 200, body: slice.map((issue) => issueJson(forge, repo, issue)), headers };
}

function issueOr404(repo: RepoRec, number: number): IssueRec {
  const issue = repo.issues.get(number);
  if (!issue) throw notFound();
  return issue;
}

function patchIssue(forge: Forge, repo: RepoRec, number: number, req: RestRequest): RestReply {
  const issue = issueOr404(repo, number);
  const body = req.body ?? {};
  if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.labels !== undefined) issue.labels = validateLabels(repo, body.labels);
  return { status: 200, body: issueJson(forge, repo, issue) };
}

function createComment(forge: Forge, repo: RepoRec, number: number, req: RestRequest): RestReply {
  const issue = issueOr404(repo, number);
  const body = req.body ?? {};
  const comment = {
    id: forge.allocCommentId(),
    body: typeof body.body === 'string' ? body.body : '',
    seq: forge.tick(),
  };
  issue.comments.push(comment);
  return { status: 201, body: commentJson(forge, comment) };
}

function listComments(forge: Forge, repo: RepoRec, number: number, req: RestRequest): RestReply {
  const issue = issueOr404(repo, number);
  const { slice, headers } = paginate(req, issue.comments);
  return { status: 200, body: slice.map((comment) => commentJson(forge, comment)), headers };
}

// ----------------------------------------------------------------------------------------------
// pull requests

function branchFromHead(value: unknown): string {
  if (typeof value !== 'string') return '';
  const colon = value.indexOf(':');
  return colon >= 0 ? value.slice(colon + 1) : value;
}

function createPullHandler(forge: Forge, repo: RepoRec, req: RestRequest): RestReply {
  const body = req.body ?? {};
  const title = typeof body.title === 'string' ? body.title : '';
  const head = branchFromHead(body.head);
  const base = branchFromHead(body.base);
  if (!refOf(repo, head)) throw new HttpError(422, `Head branch "${head}" does not exist`);
  if (!refOf(repo, base)) throw new HttpError(422, `Base branch "${base}" does not exist`);
  if (head === base) throw new HttpError(422, 'Head and base must differ');
  const duplicate = [...repo.pulls.values()].some(
    (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
  );
  if (duplicate) throw new HttpError(422, 'A pull request already exists for this head and base');
  const pull = createPull(forge, repo, {
    title,
    body: typeof body.body === 'string' ? body.body : '',
    head,
    base,
  });
  return { status: 201, body: pullJson(forge, repo, pull) };
}

function listPulls(forge: Forge, repo: RepoRec, req: RestRequest): RestReply {
  const state = req.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => b.number - a.number);
  const { slice, headers } = paginate(req, pulls);
  return { status: 200, body: slice.map((pull) => pullJson(forge, repo, pull)), headers };
}

function pullOr404(repo: RepoRec, number: number): PullRec {
  const pull = repo.pulls.get(number);
  if (!pull) throw notFound();
  return pull;
}

function pullFiles(repo: RepoRec, number: number): RestReply {
  const pull = pullOr404(repo, number);
  return { status: 200, body: pullChanges(repo, pull) };
}

function mergePullHandler(forge: Forge, repo: RepoRec, number: number, req: RestRequest): RestReply {
  const pull = repo.pulls.get(number);
  if (!pull) throw notFound();
  if (pull.merged) throw new HttpError(405, 'Pull request has already been merged');
  if (pull.state !== 'open') throw new HttpError(405, 'Pull request is not open');
  const method = (req.body?.merge_method as string) === 'merge' ? 'merge' : 'squash';
  const outcome = mergePull(forge, repo, pull, method);
  if (!outcome.ok) {
    if (outcome.reason === 'conflict') throw new HttpError(405, 'Pull request is not mergeable: merge conflict');
    throw new HttpError(405, 'Pull request is not mergeable');
  }
  return { status: 200, body: { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' } };
}

// ----------------------------------------------------------------------------------------------
// router

export function handleRest(forge: Forge, req: RestRequest): RestReply {
  const segments = req.segments;
  const method = req.method;

  if (segments.length === 0) {
    if (method === 'GET') {
      return {
        status: 200,
        body: {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          rate_limit_url: '/api/v3/rate_limit',
        },
        headers: { 'x-oauth-scopes': 'repo, read:org' },
      };
    }
    throw notFound();
  }

  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    return { status: 200, body: { installed_version: '1.0.0' } };
  }

  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    return { status: 200, body: userJson() };
  }

  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'POST') return createRepo(forge, req);
    if (method === 'GET') return listOwnRepos(forge, req);
    throw notFound();
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1];
    const name = segments[2];
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return getRepo(forge, owner, name);
      if (method === 'PATCH') return patchRepo(forge, owner, name, req);
      if (method === 'DELETE') return deleteRepo(forge, owner, name);
      throw notFound();
    }

    const repo = repoOr404(forge, owner, name);

    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') return listBranches(forge, repo, req);
      if (rest.length >= 2 && method === 'GET') return getBranch(repo, rest.slice(1).join('/'));
      throw notFound();
    }
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') return listCommits(forge, repo, req);
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'GET') return contentsGet(forge, repo, path, req);
      if (method === 'PUT') return contentsPut(forge, repo, path, req);
      if (method === 'DELETE') return contentsDelete(forge, repo, path, req);
      throw notFound();
    }
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') return createRef(repo, req);
      if (rest.length >= 3 && method === 'GET') return getRef(repo, rest.slice(2).join('/'));
      throw notFound();
    }
    if (rest[0] === 'labels') {
      if (rest.length === 1 && method === 'POST') return createLabel(repo, req);
      if (rest.length === 1 && method === 'GET') return listLabels(repo, req);
      throw notFound();
    }
    if (rest[0] === 'issues') {
      if (rest.length === 1 && method === 'POST') return createIssueHandler(forge, repo, req);
      if (rest.length === 1 && method === 'GET') return listIssues(forge, repo, req);
      const number = Number.parseInt(rest[1] ?? '', 10);
      if (rest.length === 2 && method === 'GET') return { status: 200, body: issueJson(forge, repo, issueOr404(repo, number)) };
      if (rest.length === 2 && method === 'PATCH') return patchIssue(forge, repo, number, req);
      if (rest.length === 3 && rest[2] === 'comments' && method === 'POST') return createComment(forge, repo, number, req);
      if (rest.length === 3 && rest[2] === 'comments' && method === 'GET') return listComments(forge, repo, number, req);
      throw notFound();
    }
    if (rest[0] === 'pulls') {
      if (rest.length === 1 && method === 'POST') return createPullHandler(forge, repo, req);
      if (rest.length === 1 && method === 'GET') return listPulls(forge, repo, req);
      const number = Number.parseInt(rest[1] ?? '', 10);
      if (rest.length === 2 && method === 'GET') return { status: 200, body: pullJson(forge, repo, pullOr404(repo, number)) };
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') return pullFiles(repo, number);
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') return mergePullHandler(forge, repo, number, req);
      throw notFound();
    }
  }

  throw notFound();
}
