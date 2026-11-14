// The GraphQL v4 surface (POST /api/graphql): a small parser and executor for the schema the
// suite drives — gh's and github-mcp-server's documents, nothing more. It covers operations with
// names, variables (string/int/object/enum/list/null), aliases, inline and named fragments,
// Relay-style global ids, cursor pagination on issues, introspection of the types the clients
// feature-detect, mutations that write through the same store as REST, and GitHub's operation
// batching (a JSON array of documents answers an array of results, in order).
//
// Global ids are opaque and stable: base64 of a type-tagged path ("Repository:5",
// "Issue:5:3"), never the plain database id or number. An unknown field is a 200 with an
// `errors` array naming the field; an unknown repository is data.repository = null, no errors.

import { Forge, type RepoRec, type IssueRec, type PullRec, VIEWER, createIssue, createPull, mergePull, pullChanges, pullMergeable, refOf } from './store.ts';

// ----------------------------------------------------------------------------------------------
// global ids

export function globalId(...parts: ReadonlyArray<string | number>): string {
  return Buffer.from(parts.join(':'), 'utf8').toString('base64');
}

function decodeGlobalId(id: string): string[] | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    return parts.length >= 2 ? parts : null;
  } catch {
    return null;
  }
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const value = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------------------------
// tokenizer

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\ufeff') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const text = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        tokens.push({ kind: 'string', value: text });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' }[esc] ?? esc;
            j += 2;
          }
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let kind: Token['kind'] = 'int';
      if (source[j] === '.' || source[j] === 'e' || source[j] === 'E') {
        kind = 'float';
        while (j < source.length && /[0-9eE+\-.]/.test(source[j])) j += 1;
      }
      tokens.push({ kind, value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ----------------------------------------------------------------------------------------------
// parser

type ValueNode =
  | { t: 'var'; name: string }
  | { t: 'null' }
  | { t: 'scalar'; value: unknown }
  | { t: 'enum'; name: string }
  | { t: 'list'; items: ValueNode[] }
  | { t: 'object'; fields: Record<string, ValueNode> };

type Selection =
  | { kind: 'field'; alias?: string; name: string; args: Record<string, ValueNode>; selection?: Selection[] }
  | { kind: 'inline'; typeCondition: string; selection: Selection[] }
  | { kind: 'spread'; name: string };

interface Operation {
  op: 'query' | 'mutation';
  name?: string;
  selection: Selection[];
}

interface Fragment {
  typeCondition: string;
  selection: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`Expected ${value}, found ${token.value}`);
  }

  private skipDirectives(): void {
    while (this.peek().value === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek().value === '(') this.parseArguments();
    }
  }

  private parseType(): void {
    if (this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next(); // type name
    }
    if (this.peek().value === '!') this.next();
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.value === '$') {
      const name = this.next();
      return { t: 'var', name: name.value };
    }
    if (token.value === '[') {
      const items: ValueNode[] = [];
      while (this.peek().value !== ']') items.push(this.parseValue());
      this.expect(']');
      return { t: 'list', items };
    }
    if (token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (this.peek().value !== '}') {
        const key = this.next().value;
        this.expect(':');
        fields[key] = this.parseValue();
      }
      this.expect('}');
      return { t: 'object', fields };
    }
    if (token.kind === 'string') return { t: 'scalar', value: token.value };
    if (token.kind === 'int') return { t: 'scalar', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { t: 'scalar', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { t: 'scalar', value: true };
      if (token.value === 'false') return { t: 'scalar', value: false };
      if (token.value === 'null') return { t: 'null' };
      return { t: 'enum', name: token.value };
    }
    throw new Error(`Unexpected value token ${token.value}`);
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.expect('(');
    while (this.peek().value !== ')') {
      const name = this.next().value;
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek().value !== '}') selections.push(this.parseSelection());
    this.expect('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek().kind === 'spread') {
      this.next();
      const name = this.next();
      if (name.value === 'on') {
        const typeCondition = this.next().value;
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      return { kind: 'spread', name: name.value };
    }
    let name = this.next().value;
    let alias: string | undefined;
    if (this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args = this.peek().value === '(' ? this.parseArguments() : {};
    this.skipDirectives();
    const selection = this.peek().value === '{' ? this.parseSelectionSet() : undefined;
    return { kind: 'field', alias, name, args, selection };
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, Fragment> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, Fragment>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.value === '{') {
        operations.push({ op: 'query', selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().value === '(') {
          // Variable definitions: parse and discard (values arrive as JSON variables).
          this.next();
          while (this.peek().value !== ')') {
            this.expect('$');
            this.next(); // variable name
            this.expect(':');
            this.parseType();
            if (this.peek().value === '=') {
              this.next();
              this.parseValue();
            }
            this.skipDirectives();
          }
          this.expect(')');
        }
        this.skipDirectives();
        operations.push({ op: token.value as 'query' | 'mutation', name, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        this.expect('on');
        const typeCondition = this.next().value;
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`Unexpected token ${token.value} in GraphQL document`);
    }
    return { operations, fragments };
  }
}

// ----------------------------------------------------------------------------------------------
// schema (field -> return type; '' means a scalar or a leaf the executor completes directly)

const OBJECT_FIELDS: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Node: { id: '' },
  User: { id: '', login: '', name: '', email: '' },
  Repository: {
    id: '',
    databaseId: '',
    name: '',
    nameWithOwner: '',
    owner: 'User',
    defaultBranchRef: 'Ref',
    viewerPermission: '',
    hasIssuesEnabled: '',
    isPrivate: '',
    description: '',
    createdAt: '',
    updatedAt: '',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequest: 'PullRequest',
    pullRequests: 'PullRequestConnection',
  },
  Ref: { id: '', name: '' },
  Issue: { id: '', number: '', title: '', state: '', body: '', createdAt: '', updatedAt: '', author: 'User' },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo', totalCount: '' },
  IssueEdge: { node: 'Issue', cursor: '' },
  PullRequest: {
    id: '',
    number: '',
    title: '',
    body: '',
    state: '',
    merged: '',
    mergeable: '',
    headRefName: '',
    baseRefName: '',
    files: 'PullRequestChangedFileConnection',
    createdAt: '',
    updatedAt: '',
    mergedAt: '',
    author: 'User',
  },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo', totalCount: '' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', totalCount: '' },
  PullRequestChangedFile: { path: '', additions: '', deletions: '' },
  PageInfo: { hasNextPage: '', hasPreviousPage: '', startCursor: '', endCursor: '' },
  IssueComment: { id: '', body: '', createdAt: '', author: 'User' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: '' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: '' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: '' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: '' },
  AddCommentPayload: { commentEdge: 'CommentEdge', subject: 'Issue', clientMutationId: '' },
  CommentEdge: { node: 'IssueComment', cursor: '' },
  __Type: { name: '', kind: '', description: '', fields: '__Field', enumValues: '__EnumValue', possibleTypes: '__Type', ofType: '__Type', specifiedByURL: '' },
  __Field: { name: '', description: '', type: '__Type', args: '__InputValue', isDeprecated: '', deprecationReason: '' },
  __EnumValue: { name: '', description: '', isDeprecated: '', deprecationReason: '' },
  __InputValue: { name: '', description: '', type: '__Type', defaultValue: '' },
  __Schema: { queryType: '__Type', mutationType: '__Type', subscriptionType: '__Type', types: '__Type', directives: '__Directive' },
  __Directive: { name: '', description: '', locations: '', args: '__InputValue' },
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
};

function typeKind(name: string): string {
  if (ENUM_VALUES[name]) return 'ENUM';
  if (OBJECT_FIELDS[name]) return 'OBJECT';
  return 'OBJECT';
}

// ----------------------------------------------------------------------------------------------
// execution

interface GObj {
  __type: string;
  src: unknown;
}

const wrap = (type: string, src: unknown): GObj => ({ __type: type, src });
const isGObj = (value: unknown): value is GObj =>
  typeof value === 'object' && value !== null && '__type' in (value as Record<string, unknown>);

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, Fragment>;
}

class GqlError extends Error {}

function evalValue(node: ValueNode, ctx: Ctx): unknown {
  switch (node.t) {
    case 'var':
      return ctx.variables[node.name] ?? null;
    case 'null':
      return null;
    case 'scalar':
      return node.value;
    case 'enum':
      return node.name;
    case 'list':
      return node.items.map((item) => evalValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = evalValue(value, ctx);
      return out;
    }
  }
}

function evalArgs(args: Record<string, ValueNode>, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = evalValue(value, ctx);
  return out;
}

const userObj = (login: string): GObj => wrap('User', { login });

// ---- domain resolvers

function repoByGlobalId(forge: Forge, id: unknown): RepoRec {
  const parts = typeof id === 'string' ? decodeGlobalId(id) : null;
  if (!parts || parts[0] !== 'Repository') throw new GqlError(`Unknown repository id ${String(id)}`);
  const repo = forge.reposById.get(Number.parseInt(parts[1], 10));
  if (!repo) throw new GqlError(`Unknown repository id ${String(id)}`);
  return repo;
}

function issueByGlobalId(forge: Forge, id: unknown): { repo: RepoRec; issue: IssueRec } {
  const parts = typeof id === 'string' ? decodeGlobalId(id) : null;
  if (!parts || parts[0] !== 'Issue') throw new GqlError(`Unknown issue id ${String(id)}`);
  const repo = forge.reposById.get(Number.parseInt(parts[1], 10));
  const issue = repo?.issues.get(Number.parseInt(parts[2], 10));
  if (!repo || !issue) throw new GqlError(`Unknown issue id ${String(id)}`);
  return { repo, issue };
}

function pullByGlobalId(forge: Forge, id: unknown): { repo: RepoRec; pull: PullRec } {
  const parts = typeof id === 'string' ? decodeGlobalId(id) : null;
  if (!parts || parts[0] !== 'PullRequest') throw new GqlError(`Unknown pull request id ${String(id)}`);
  const repo = forge.reposById.get(Number.parseInt(parts[1], 10));
  const pull = repo?.pulls.get(Number.parseInt(parts[2], 10));
  if (!repo || !pull) throw new GqlError(`Unknown pull request id ${String(id)}`);
  return { repo, pull };
}

interface IssuePage {
  nodes: Array<{ repo: RepoRec; issue: IssueRec }>;
  hasNextPage: boolean;
  endCursor: string | null;
  totalCount: number;
}

function issuesConnection(repo: RepoRec, args: Record<string, unknown>): IssuePage {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? null) as { direction?: string } | null;
  const direction = typeof orderBy?.direction === 'string' ? orderBy.direction : 'DESC';
  list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const afterNumber = numberFromCursor(args.after);
    const index = afterNumber === null ? -1 : list.findIndex((issue) => issue.number === afterNumber);
    if (index >= 0) start = index + 1;
  }
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : 30;
  const slice = list.slice(start, start + first);
  return {
    nodes: slice.map((issue) => ({ repo, issue })),
    hasNextPage: start + slice.length < list.length,
    endCursor: slice.length ? cursorFor(slice[slice.length - 1].number) : null,
    totalCount: list.length,
  };
}

function resolveField(typeName: string, src: unknown, field: string, args: Record<string, unknown>, ctx: Ctx): unknown {
  const forge = ctx.forge;
  switch (typeName) {
    case 'Query': {
      if (field === 'viewer') return userObj(VIEWER.login);
      if (field === 'repository') {
        const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? wrap('Repository', repo) : null;
      }
      if (field === 'node') {
        const parts = typeof args.id === 'string' ? decodeGlobalId(args.id) : null;
        if (!parts) return null;
        if (parts[0] === 'Repository') {
          const repo = forge.reposById.get(Number.parseInt(parts[1], 10));
          return repo ? wrap('Repository', repo) : null;
        }
        if (parts[0] === 'Issue') {
          const repo = forge.reposById.get(Number.parseInt(parts[1], 10));
          const issue = repo?.issues.get(Number.parseInt(parts[2], 10));
          return repo && issue ? wrap('Issue', { repo, issue }) : null;
        }
        if (parts[0] === 'PullRequest') {
          const repo = forge.reposById.get(Number.parseInt(parts[1], 10));
          const pull = repo?.pulls.get(Number.parseInt(parts[2], 10));
          return repo && pull ? wrap('PullRequest', { repo, pull }) : null;
        }
        return null;
      }
      if (field === '__type') {
        const name = String(args.name ?? '');
        if (!OBJECT_FIELDS[name] && !ENUM_VALUES[name]) return null;
        return wrap('__Type', { name });
      }
      if (field === '__schema') return wrap('__Schema', {});
      return null;
    }
    case 'Mutation': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      if (field === 'createIssue') {
        const repo = repoByGlobalId(forge, input.repositoryId);
        const issue = createIssue(forge, repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
        });
        return wrap('CreateIssuePayload', { repo, issue });
      }
      if (field === 'closeIssue') {
        const { repo, issue } = issueByGlobalId(forge, input.issueId);
        issue.state = 'closed';
        return wrap('CloseIssuePayload', { repo, issue });
      }
      if (field === 'createPullRequest') {
        const repo = repoByGlobalId(forge, input.repositoryId);
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        if (!refOf(repo, head)) throw new GqlError(`Head branch "${head}" does not exist`);
        if (!refOf(repo, base)) throw new GqlError(`Base branch "${base}" does not exist`);
        const pull = createPull(forge, repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          head,
          base,
        });
        return wrap('CreatePullRequestPayload', { repo, pull });
      }
      if (field === 'mergePullRequest') {
        const { repo, pull } = pullByGlobalId(forge, input.pullRequestId);
        if (!pull.merged) {
          const method = String(input.mergeMethod ?? 'SQUASH');
          const outcome = mergePull(forge, repo, pull, method === 'MERGE' ? 'merge' : 'squash');
          if (!outcome.ok) throw new GqlError('Pull request is not mergeable');
        }
        return wrap('MergePullRequestPayload', { repo, pull });
      }
      if (field === 'addComment') {
        const { repo, issue } = issueByGlobalId(forge, input.subjectId);
        const comment = { id: forge.allocCommentId(), body: String(input.body ?? ''), seq: forge.tick() };
        issue.comments.push(comment);
        return wrap('AddCommentPayload', { repo, issue, comment });
      }
      return null;
    }
    case 'User': {
      const user = src as { login: string };
      if (field === 'login') return user.login;
      if (field === 'id') return globalId('User', VIEWER.id);
      if (field === 'name') return user.login === VIEWER.login ? VIEWER.name : user.login;
      if (field === 'email') return user.login === VIEWER.login ? VIEWER.email : null;
      return null;
    }
    case 'Repository': {
      const repo = src as RepoRec;
      switch (field) {
        case 'id':
          return globalId('Repository', repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return userObj(repo.owner);
        case 'defaultBranchRef':
          return wrap('Ref', { name: repo.defaultBranch });
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'isPrivate':
          return repo.private;
        case 'description':
          return repo.description;
        case 'createdAt':
          return forge.iso(repo.seq);
        case 'updatedAt':
          return forge.iso(repo.seq);
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue ? wrap('Issue', { repo, issue }) : null;
        }
        case 'issues':
          return wrap('IssueConnection', issuesConnection(repo, args));
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull ? wrap('PullRequest', { repo, pull }) : null;
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 30;
          const all = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
          return wrap('PullRequestConnection', {
            nodes: all.slice(0, first).map((pull) => ({ repo, pull })),
            totalCount: all.length,
            hasNextPage: all.length > first,
            endCursor: null,
          });
        }
        default:
          return null;
      }
    }
    case 'Ref': {
      const ref = src as { name: string };
      if (field === 'name') return ref.name;
      if (field === 'id') return globalId('Ref', ref.name);
      return null;
    }
    case 'Issue': {
      const { repo, issue } = src as { repo: RepoRec; issue: IssueRec };
      switch (field) {
        case 'id':
          return globalId('Issue', repo.id, issue.number);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state.toUpperCase();
        case 'createdAt':
          return forge.iso(issue.seq);
        case 'updatedAt':
          return forge.iso(issue.seq);
        case 'author':
          return userObj(VIEWER.login);
        default:
          return null;
      }
    }
    case 'IssueConnection': {
      const page = src as IssuePage;
      if (field === 'nodes') return page.nodes.map((node) => wrap('Issue', node));
      if (field === 'pageInfo') {
        return wrap('PageInfo', {
          hasNextPage: page.hasNextPage,
          hasPreviousPage: false,
          startCursor: page.nodes.length ? cursorFor(page.nodes[0].issue.number) : null,
          endCursor: page.endCursor,
        });
      }
      if (field === 'totalCount') return page.totalCount;
      return null;
    }
    case 'PullRequestConnection': {
      const conn = src as { nodes: Array<{ repo: RepoRec; pull: PullRec }>; totalCount: number; hasNextPage: boolean; endCursor: string | null };
      if (field === 'nodes') return conn.nodes.map((node) => wrap('PullRequest', node));
      if (field === 'totalCount') return conn.totalCount;
      if (field === 'pageInfo') {
        return wrap('PageInfo', { hasNextPage: conn.hasNextPage, hasPreviousPage: false, startCursor: null, endCursor: conn.endCursor });
      }
      return null;
    }
    case 'PageInfo': {
      const info = src as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
      return info[field as keyof typeof info] ?? null;
    }
    case 'PullRequest': {
      const { repo, pull } = src as { repo: RepoRec; pull: PullRec };
      switch (field) {
        case 'id':
          return globalId('PullRequest', repo.id, pull.number);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return pull.merged ? 'UNKNOWN' : pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'files': {
          const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 30;
          const changes = pullChanges(repo, pull);
          return wrap('PullRequestChangedFileConnection', {
            nodes: changes.slice(0, first).map((change) => ({ path: change.filename, additions: change.additions, deletions: change.deletions })),
            totalCount: changes.length,
          });
        }
        case 'createdAt':
          return forge.iso(pull.seq);
        case 'updatedAt':
          return forge.iso(pull.mergedSeq ?? pull.seq);
        case 'mergedAt':
          return pull.mergedSeq === null ? null : forge.iso(pull.mergedSeq);
        case 'author':
          return userObj(VIEWER.login);
        default:
          return null;
      }
    }
    case 'PullRequestChangedFileConnection': {
      const conn = src as { nodes: Array<{ path: string; additions: number; deletions: number }>; totalCount: number };
      if (field === 'nodes') return conn.nodes.map((node) => wrap('PullRequestChangedFile', node));
      if (field === 'totalCount') return conn.totalCount;
      return null;
    }
    case 'PullRequestChangedFile': {
      const file = src as { path: string; additions: number; deletions: number };
      return file[field as keyof typeof file] ?? null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const payload = src as { repo: RepoRec; issue: IssueRec };
      if (field === 'issue') return wrap('Issue', payload);
      if (field === 'clientMutationId') return null;
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const payload = src as { repo: RepoRec; pull: PullRec };
      if (field === 'pullRequest') return wrap('PullRequest', payload);
      if (field === 'clientMutationId') return null;
      return null;
    }
    case 'AddCommentPayload': {
      const payload = src as { repo: RepoRec; issue: IssueRec; comment: { id: number; body: string; seq: number } };
      if (field === 'commentEdge') return wrap('CommentEdge', payload);
      if (field === 'subject') return wrap('Issue', payload);
      if (field === 'clientMutationId') return null;
      return null;
    }
    case 'CommentEdge': {
      const payload = src as { repo: RepoRec; issue: IssueRec; comment: { id: number; body: string; seq: number } };
      if (field === 'node') return wrap('IssueComment', payload);
      if (field === 'cursor') return cursorFor(payload.comment.id);
      return null;
    }
    case 'IssueComment': {
      const payload = src as { repo: RepoRec; issue: IssueRec; comment: { id: number; body: string; seq: number } };
      if (field === 'id') return globalId('IssueComment', payload.repo.id, payload.issue.number, payload.comment.id);
      if (field === 'body') return payload.comment.body;
      if (field === 'createdAt') return forge.iso(payload.comment.seq);
      if (field === 'author') return userObj(VIEWER.login);
      return null;
    }
    case '__Type': {
      const type = src as { name: string };
      if (field === 'name') return type.name;
      if (field === 'kind') return typeKind(type.name);
      if (field === 'description') return null;
      if (field === 'fields') {
        const fields = OBJECT_FIELDS[type.name];
        if (!fields) return null;
        return Object.keys(fields).map((name) => wrap('__Field', { name }));
      }
      if (field === 'enumValues') {
        const values = ENUM_VALUES[type.name];
        if (!values) return null;
        return values.map((name) => wrap('__EnumValue', { name }));
      }
      return null;
    }
    case '__Field': {
      const f = src as { name: string };
      if (field === 'name') return f.name;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      return null;
    }
    case '__EnumValue': {
      const v = src as { name: string };
      if (field === 'name') return v.name;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      return null;
    }
    case '__Schema': {
      if (field === 'queryType') return wrap('__Type', { name: 'Query' });
      if (field === 'mutationType') return wrap('__Type', { name: 'Mutation' });
      return null;
    }
    default:
      return null;
  }
}

function fragmentApplies(condition: string, typeName: string): boolean {
  if (condition === typeName) return true;
  if (condition === 'Node' && (typeName === 'Repository' || typeName === 'Issue' || typeName === 'PullRequest')) return true;
  return false;
}

function completeValue(value: unknown, selection: Selection[] | undefined, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, selection, ctx));
  if (isGObj(value)) {
    if (!selection) return {};
    return executeSelectionSet(value.__type, value.src, selection, ctx);
  }
  return value;
}

function executeSelectionSet(typeName: string, src: unknown, selections: Selection[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[key] = typeName;
        continue;
      }
      const args = evalArgs(selection.args, ctx);
      const value = resolveField(typeName, src, selection.name, args, ctx);
      out[key] = completeValue(value, selection.selection, ctx);
    } else if (selection.kind === 'inline') {
      if (fragmentApplies(selection.typeCondition, typeName)) {
        Object.assign(out, executeSelectionSet(typeName, src, selection.selection, ctx));
      }
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment && fragmentApplies(fragment.typeCondition, typeName)) {
        Object.assign(out, executeSelectionSet(typeName, src, fragment.selection, ctx));
      }
    }
  }
  return out;
}

// ----------------------------------------------------------------------------------------------
// validation: an unknown field is a 200 with an errors array naming it

function validateSelections(typeName: string, selections: Selection[], ctx: Ctx, errors: string[]): void {
  const fields = OBJECT_FIELDS[typeName];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') continue;
      if (!fields || !(selection.name in fields)) {
        errors.push(`Field '${selection.name}' doesn't exist on type '${typeName}'`);
        continue;
      }
      const returnType = fields[selection.name];
      if (selection.selection && returnType && OBJECT_FIELDS[returnType]) {
        validateSelections(returnType, selection.selection, ctx, errors);
      } else if (selection.selection && returnType === 'Node') {
        validateSelections('Node', selection.selection, ctx, errors);
      }
    } else if (selection.kind === 'inline') {
      validateSelections(selection.typeCondition, selection.selection, ctx, errors);
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) validateSelections(fragment.typeCondition, fragment.selection, ctx, errors);
    }
  }
}

// ----------------------------------------------------------------------------------------------
// HTTP entry

export interface GraphqlReply {
  status: number;
  body: unknown;
}

function executeOne(forge: Forge, request: { query?: unknown; variables?: unknown; operationName?: unknown }): unknown {
  if (typeof request.query !== 'string') {
    return { errors: [{ message: 'A GraphQL query string is required' }] };
  }
  let document: { operations: Operation[]; fragments: Map<string, Fragment> };
  try {
    document = new Parser(tokenize(request.query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  let operation: Operation | undefined;
  if (typeof request.operationName === 'string' && request.operationName !== '') {
    operation = document.operations.find((candidate) => candidate.name === request.operationName);
  }
  operation ??= document.operations[0];
  if (!operation) return { errors: [{ message: 'No operation in the document' }] };
  const ctx: Ctx = {
    forge,
    variables: (typeof request.variables === 'object' && request.variables !== null ? request.variables : {}) as Record<string, unknown>,
    fragments: document.fragments,
  };
  const rootType = operation.op === 'mutation' ? 'Mutation' : 'Query';
  const errors: string[] = [];
  validateSelections(rootType, operation.selection, ctx, errors);
  if (errors.length > 0) {
    return { errors: errors.map((message) => ({ message })), data: null };
  }
  try {
    const data = executeSelectionSet(rootType, null, operation.selection, ctx);
    return { data };
  } catch (err) {
    if (err instanceof GqlError) return { errors: [{ message: err.message }], data: null };
    throw err;
  }
}

/** POST /api/graphql: one document, or a JSON array of documents answered in order. */
export function handleGraphql(forge: Forge, rawBody: Buffer): GraphqlReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return { status: 400, body: { errors: [{ message: 'Invalid JSON body' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((entry) => executeOne(forge, (entry ?? {}) as { query?: unknown })) };
  }
  return { status: 200, body: executeOne(forge, (parsed ?? {}) as { query?: unknown }) };
}
