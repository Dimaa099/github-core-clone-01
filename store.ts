// The forge's store: one process-wide state holding every repository (with its own git object
// store), its issues, pull requests, labels and comments. REST, GraphQL, MCP and the git smart-HTTP
// surface all read and write through here, so an object created on one surface is the same object
// on every other.
//
// Determinism: nothing here reads the wall clock or a random source. A logical sequence counter
// stamps every mutation; timestamps are a fixed epoch plus that sequence, so two runs that take
// the same requests produce the same bytes.

import {
  ObjectStore,
  buildCommit,
  collectReachable,
  commitTree,
  flattenTree,
  isAncestor,
  mergeBase,
  parseCommit,
  treeFromFiles,
} from './gitobj.ts';

/** The one user the trial token belongs to (wire.ts's scenario viewer). */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** 2025-01-01T00:00:00Z: the fixed epoch the logical clock counts from. */
const EPOCH_SEC = 1735689600;

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedSeq: number | null;
  seq: number;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  store: ObjectStore;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  seq: number;
}

export class Forge {
  readonly repos = new Map<string, RepoRec>();
  readonly reposById = new Map<number, RepoRec>();
  private nextRepoId = 1;
  private nextDbId = 1;
  private nextCommentId = 1;
  private seq = 0;
  requestCount = 0;

  /** Advance the logical clock; the returned sequence stamps one mutation. */
  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  /** The ISO timestamp for a sequence value (or for a fresh tick when omitted). */
  iso(seq?: number): string {
    return new Date((EPOCH_SEC + (seq ?? this.seq)) * 1000).toISOString();
  }

  /** The git identity line for a server-made commit at `seq`. */
  identity(seq: number): string {
    return `${VIEWER.name} <${VIEWER.email}> ${EPOCH_SEC + seq} +0000`;
  }

  allocDbId(): number {
    const id = this.nextDbId;
    this.nextDbId += 1;
    return id;
  }

  allocCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(`${owner}/${name}`);
  }

  createRepo(name: string, fields: { description?: string; private?: boolean }): RepoRec {
    const repo: RepoRec = {
      id: this.nextRepoId++,
      owner: VIEWER.login,
      name,
      description: fields.description ?? '',
      private: fields.private ?? false,
      defaultBranch: 'main',
      store: new ObjectStore(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      seq: this.tick(),
    };
    this.repos.set(`${repo.owner}/${name}`, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  deleteRepo(repo: RepoRec): void {
    this.repos.delete(`${repo.owner}/${repo.name}`);
    this.reposById.delete(repo.id);
  }

  /** All of the viewer's repositories, in creation order. */
  listRepos(): RepoRec[] {
    return [...this.repos.values()];
  }
}

// ----------------------------------------------------------------------------------------------
// git-side helpers over a RepoRec

export function refOf(repo: RepoRec, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

export function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The files (path -> blob oid) at a commit, or an empty map when the commit is unknown. */
export function filesAtCommit(repo: RepoRec, commitOid: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!commitOid) return out;
  const tree = commitTree(repo.store, commitOid);
  for (const [path, entry] of flattenTree(repo.store, tree)) out.set(path, entry.oid);
  return out;
}

/** Commit a whole file map on top of `parent` (or as a root commit) and return the commit id. */
export function commitFiles(
  forge: Forge,
  repo: RepoRec,
  files: ReadonlyMap<string, string>,
  parents: readonly string[],
  message: string,
): string {
  const seq = forge.tick();
  const tree = treeFromFiles(repo.store, files);
  const identity = forge.identity(seq);
  return repo.store.put('commit', buildCommit({ tree, parents, author: identity, committer: identity, message }));
}

/**
 * The contents-API write: set `path` to `content` on `branch`, creating the branch (from the
 * default branch's tip) when it does not exist yet. Returns the new commit and blob ids.
 */
export function writeFile(
  forge: Forge,
  repo: RepoRec,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): { commitSha: string; blobSha: string; created: boolean } {
  let tip = refOf(repo, branch);
  if (!tip) tip = refOf(repo, repo.defaultBranch);
  const files = filesAtCommit(repo, tip);
  const created = !files.has(path);
  const blobSha = repo.store.put('blob', content);
  files.set(path, blobSha);
  const commitSha = commitFiles(forge, repo, files, tip ? [tip] : [], message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobSha, created };
}

/** The contents-API delete: remove `path` on `branch` with a commit. */
export function deleteFile(
  forge: Forge,
  repo: RepoRec,
  branch: string,
  path: string,
  message: string,
): { commitSha: string } {
  const tip = refOf(repo, branch);
  const files = filesAtCommit(repo, tip);
  files.delete(path);
  const commitSha = commitFiles(forge, repo, files, tip ? [tip] : [], message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha };
}

/** Resolve a ref-ish (branch name, tag name, full ref or commit id) to a commit id. */
export function resolveRef(repo: RepoRec, ref: string | undefined): string | undefined {
  if (!ref) return refOf(repo, repo.defaultBranch);
  const byRef = repo.refs.get(ref);
  if (byRef) return byRef;
  const byHead = repo.refs.get(`refs/heads/${ref}`);
  if (byHead) return byHead;
  const byTag = repo.refs.get(`refs/tags/${ref}`);
  if (byTag) return byTag;
  if (/^[0-9a-f]{40}$/.test(ref) && repo.store.has(ref)) return ref;
  return undefined;
}

// ----------------------------------------------------------------------------------------------
// pull-request diff and merge

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-diff counts between two blob bodies (an LCS over lines; bodies here are small). */
export function lineDiff(oldData: Buffer | undefined, newData: Buffer | undefined): { additions: number; deletions: number } {
  const oldLines = oldData ? countLines(oldData) : [];
  const newLines = newData ? countLines(newData) : [];
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
  // LCS via dynamic programming, bounded: fall back to a whole-file count for very large inputs.
  if (oldLines.length * newLines.length > 4_000_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const dp = new Array<number>(newLines.length + 1).fill(0);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    let prev = 0;
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      const saved = dp[j];
      dp[j] = oldLines[i] === newLines[j] ? prev + 1 : Math.max(dp[j], dp[j + 1]);
      prev = saved;
    }
  }
  const common = dp[0];
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

/**
 * The changed files of a pull request: the diff between the merge base of head and base and the
 * head tip. When there is no merge base the base tree counts as empty.
 */
export function pullChanges(repo: RepoRec, pull: PullRec): FileChange[] {
  const headTip = refOf(repo, pull.headRef) ?? pull.headSha;
  const baseTip = refOf(repo, pull.baseRef);
  const base = baseTip ? mergeBase(repo.store, headTip, baseTip) : null;
  const fromFiles = filesAtCommit(repo, base ?? undefined);
  const toFiles = filesAtCommit(repo, headTip);
  const paths = new Set([...fromFiles.keys(), ...toFiles.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const before = fromFiles.get(path);
    const after = toFiles.get(path);
    if (before === after) continue;
    const oldData = before ? repo.store.get(before)?.data : undefined;
    const newData = after ? repo.store.get(after)?.data : undefined;
    const { additions, deletions } = lineDiff(oldData, newData);
    changes.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: 'conflict' | 'already' | 'gone' };

/**
 * Merge a pull request into its base branch. `squash` produces one commit whose tree is the
 * three-way merge of merge-base, base and head; `merge` produces a two-parent merge commit with
 * the same tree. A path both sides changed differently is a conflict.
 */
export function mergePull(forge: Forge, repo: RepoRec, pull: PullRec, method: 'squash' | 'merge'): MergeOutcome {
  const baseTip = refOf(repo, pull.baseRef);
  const headTip = refOf(repo, pull.headRef) ?? pull.headSha;
  if (!baseTip || !headTip) return { ok: false, reason: 'gone' };
  if (isAncestor(repo.store, headTip, baseTip)) {
    // The head is already contained in the base: nothing to merge, but the pull still closes.
    pull.merged = true;
    pull.mergeCommitSha = baseTip;
    pull.state = 'closed';
    pull.mergedSeq = forge.tick();
    return { ok: true, sha: baseTip };
  }
  const base = mergeBase(repo.store, baseTip, headTip);
  const baseFiles = filesAtCommit(repo, base ?? undefined);
  const ourFiles = filesAtCommit(repo, baseTip);
  const theirFiles = filesAtCommit(repo, headTip);
  const merged = new Map<string, string>();
  const paths = new Set([...baseFiles.keys(), ...ourFiles.keys(), ...theirFiles.keys()]);
  for (const path of paths) {
    const atBase = baseFiles.get(path);
    const ours = ourFiles.get(path);
    const theirs = theirFiles.get(path);
    if (theirs === atBase) {
      if (ours !== undefined) merged.set(path, ours);
    } else if (ours === atBase) {
      if (theirs !== undefined) merged.set(path, theirs);
    } else if (ours === theirs) {
      if (ours !== undefined) merged.set(path, ours);
    } else {
      return { ok: false, reason: 'conflict' };
    }
  }
  const seq = forge.tick();
  const tree = treeFromFiles(repo.store, merged);
  const identity = forge.identity(seq);
  const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
  const message = method === 'merge' ? `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}` : `${pull.title}\n\n${pull.body}`;
  const sha = repo.store.put('commit', buildCommit({ tree, parents, author: identity, committer: identity, message }));
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.state = 'closed';
  pull.mergedSeq = seq;
  return { ok: true, sha };
}

/** True when a pull request would merge cleanly right now (GraphQL's mergeable). */
export function pullMergeable(repo: RepoRec, pull: PullRec): boolean {
  const baseTip = refOf(repo, pull.baseRef);
  const headTip = refOf(repo, pull.headRef) ?? pull.headSha;
  if (!baseTip || !headTip) return false;
  if (isAncestor(repo.store, headTip, baseTip)) return true;
  const base = mergeBase(repo.store, baseTip, headTip);
  const baseFiles = filesAtCommit(repo, base ?? undefined);
  const ourFiles = filesAtCommit(repo, baseTip);
  const theirFiles = filesAtCommit(repo, headTip);
  const paths = new Set([...baseFiles.keys(), ...ourFiles.keys(), ...theirFiles.keys()]);
  for (const path of paths) {
    const atBase = baseFiles.get(path);
    const ours = ourFiles.get(path);
    const theirs = theirFiles.get(path);
    if (theirs !== atBase && ours !== atBase && ours !== theirs) return false;
  }
  return true;
}

/** Create an issue on a repository with the next shared issue/pull number. */
export function createIssue(forge: Forge, repo: RepoRec, fields: { title: string; body: string; labels?: string[] }): IssueRec {
  const issue: IssueRec = {
    dbId: forge.allocDbId(),
    number: repo.nextNumber++,
    title: fields.title,
    body: fields.body,
    state: 'open',
    labels: fields.labels ? [...fields.labels] : [],
    comments: [],
    seq: forge.tick(),
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

/** Create a pull request record; the caller has validated the branches exist. */
export function createPull(forge: Forge, repo: RepoRec, fields: { title: string; body: string; head: string; base: string }): PullRec {
  const pull: PullRec = {
    dbId: forge.allocDbId(),
    number: repo.nextNumber++,
    title: fields.title,
    body: fields.body,
    state: 'open',
    headRef: fields.head,
    baseRef: fields.base,
    headSha: refOf(repo, fields.head) ?? '',
    merged: false,
    mergeCommitSha: null,
    mergedSeq: null,
    seq: forge.tick(),
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** Objects reachable from every ref (handy for debugging; not on any hot path). */
export function allReachable(repo: RepoRec): Set<string> {
  return collectReachable(repo.store, repo.refs.values());
}

export function commitMessageOf(repo: RepoRec, commitOid: string): string {
  const obj = repo.store.get(commitOid);
  if (!obj || obj.type !== 'commit') return '';
  const message = parseCommit(obj.data).message;
  return message.endsWith('\n') ? message.slice(0, -1) : message;
}
