// The MCP endpoint (POST /mcp): JSON-RPC 2.0, modern-era discovery plus the legacy initialize
// handshake, and six tools over the same store REST serves — create_repo, get_repo, create_issue,
// list_issues, create_pull_request, merge_pull_request (github-mcp-server's canonical names).
//
// Details the clients check:
//   - `server/discover` answers a result with valid YYYY-MM-DD supportedVersions, a capabilities
//     record with a tools key, and the server identity under `_meta` (read first) as well as
//     `serverInfo`; the modern era settles on revision 2026-07-28.
//   - tools/list is one precomputed, never-mutated result object, so repeated calls are
//     byte-for-byte identical.
//   - a call result carries its payload as pretty-printed JSON text; tool execution failures are
//     results with isError: true, while unknown tools and missing arguments are JSON-RPC errors
//     (-32602), malformed JSON is an HTTP 400 with a -32700 parse error, and a request with no
//     Authorization header at all is an HTTP 401 decided before dispatch.

import {
  Forge,
  type RepoRec,
  VIEWER,
  createIssue,
  createPull,
  mergePull,
} from './store.ts';
import { HttpError, issueJson, pullJson, repoJson, repoOr404 as requireRepo } from './rest.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
  run: (forge: Forge, args: Record<string, unknown>) => unknown;
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function repoArgs(forge: Forge, args: Record<string, unknown>): RepoRec {
  return requireRepo(forge, str(args, 'owner') || VIEWER.login, str(args, 'repo'));
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    run: (forge, args) => {
      const name = str(args, 'name');
      if (forge.getRepo(VIEWER.login, name)) throw new Error(`Repository "${name}" already exists`);
      const repo = forge.createRepo(name, {
        description: str(args, 'description'),
        private: args.private === true,
      });
      return repoJson(forge, repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => repoJson(forge, repoArgs(forge, args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (forge, args) => {
      const repo = repoArgs(forge, args);
      const issue = createIssue(forge, repo, { title: str(args, 'title'), body: str(args, 'body') });
      return issueJson(forge, repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => {
      const repo = repoArgs(forge, args);
      const state = str(args, 'state') || 'open';
      return [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.number - a.number)
        .map((issue) => issueJson(forge, repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch to merge from.' },
        base: { type: 'string', description: 'The base branch to merge into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (forge, args) => {
      const repo = repoArgs(forge, args);
      const duplicate = [...repo.pulls.values()].find(
        (pull) => pull.state === 'open' && !pull.merged && pull.headRef === str(args, 'head') && pull.baseRef === str(args, 'base'),
      );
      if (duplicate) return pullJson(forge, repo, duplicate);
      const pull = createPull(forge, repo, {
        title: str(args, 'title'),
        body: str(args, 'body'),
        head: str(args, 'head'),
        base: str(args, 'base'),
      });
      return pullJson(forge, repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (forge, args) => {
      const repo = repoArgs(forge, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(str(args, 'pull_number'), 10);
      const pull = repo.pulls.get(number);
      if (!pull) throw new Error(`Pull request #${number} not found`);
      if (!pull.merged) {
        const outcome = mergePull(forge, repo, pull, 'squash');
        if (!outcome.ok) throw new Error(outcome.reason);
        return { number: pull.number, merged: true, sha: outcome.sha, message: 'Pull Request successfully merged' };
      }
      return { number: pull.number, merged: true, sha: pull.mergeCommitSha, message: 'Pull Request successfully merged' };
    },
  },
];

/** The tools/list result: computed once, never mutated — repeated calls are identical. */
const TOOLS_LIST_RESULT = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
};

export interface McpReply {
  status: number;
  /** Serialized JSON body; undefined means an intentionally empty body (notifications). */
  body?: string;
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }) };
}

function rpcError(id: unknown, code: number, message: string): McpReply {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }) };
}

function callTool(forge: Forge, id: unknown, params: Record<string, unknown>): McpReply {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return rpcError(id, -32602, `Unknown tool: ${name || '(missing)'}`);
  const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) return rpcError(id, -32602, `Missing required arguments: ${missing.join(', ')}`);
  try {
    const payload = tool.run(forge, args);
    return rpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      isError: false,
    });
  } catch (err) {
    const message = err instanceof HttpError ? err.message : err instanceof Error ? err.message : 'Tool execution failed';
    return rpcResult(id, { content: [{ type: 'text', text: message }], isError: true });
  }
}

function dispatchOne(forge: Forge, request: Record<string, unknown>): McpReply | null {
  const isNotification = !('id' in request);
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  // Notifications never get a response.
  if (isNotification) return null;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, TOOLS_LIST_RESULT);
    case 'tools/call':
      return callTool(forge, id, params);
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** POST /mcp. Auth (an Authorization header must be present) is enforced by the caller. */
export function handleMcp(forge: Forge, rawBody: Buffer): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  if (Array.isArray(parsed)) {
    const replies: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const reply = dispatchOne(forge, entry as Record<string, unknown>);
      if (reply?.body !== undefined) replies.push(reply.body);
    }
    if (replies.length === 0) return { status: 202 };
    return { status: 200, body: `[${replies.map((body) => body).join(',')}]` };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }),
    };
  }
  const reply = dispatchOne(forge, parsed as Record<string, unknown>);
  if (reply === null || reply.body === undefined) return { status: 202 };
  return reply;
}
