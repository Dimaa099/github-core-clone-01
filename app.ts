// The HTTP server: routing, authentication, request ids and the JSON discipline every surface
// shares. The four surfaces live in their own modules (rest.ts, githttp.ts, graphql.ts, mcp.ts)
// and all work on the one Forge store.
//
// Protocol discipline (the suite's protocol group): every REST reply is application/json (never
// HTML), errors are {"message": string}, every reply carries a non-empty X-GitHub-Request-Id, a
// malformed JSON body is a 400, and a request without the trial token is a 401. Request ids come
// from a counter, never the clock, so a replay emits the same bytes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest, HttpError, type RestRequest } from './rest.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleGraphql } from './graphql.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (status === 204 || body === undefined) {
    res.writeHead(status, { 'x-github-request-id': requestId, ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The bearer-token check: Bearer/token schemes, or HTTP Basic whose password is the token. */
export function authorized(req: IncomingMessage, token: string): boolean {
  if (token === '') return true;
  const header = req.headers.authorization;
  if (!header) return false;
  if (header === `Bearer ${token}` || header === `token ${token}`) return true;
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      return colon >= 0 && decoded.slice(colon + 1) === token;
    } catch {
      return false;
    }
  }
  return false;
}

/** Answer with a raw (non-JSON) body: the git wire replies. */
function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, requestId: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
  });
  res.end(body);
}

function pathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** Build the server. It binds nothing until the caller listens; main.ts binds an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    forge.requestCount += 1;
    const requestId = `req-${forge.requestCount}`;
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const segments = pathSegments(url.pathname);
        const method = req.method ?? 'GET';

        // The env's boot probe: 200 {"ok":true}, no auth.
        if (method === 'GET' && url.pathname === '/healthz') {
          sendJson(res, 200, { ok: true }, requestId);
          return;
        }

        const body = await readBody(req);

        // The REST v3 surface.
        if (segments[0] === 'api' && segments[1] === 'v3') {
          if (!authorized(req, token)) {
            sendJson(res, 401, { message: 'Bad credentials' }, requestId);
            return;
          }
          let parsed: Record<string, unknown> | undefined;
          if (body.length > 0) {
            try {
              const value = JSON.parse(body.toString('utf8')) as unknown;
              parsed = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
            } catch {
              sendJson(res, 400, { message: 'Invalid JSON body' }, requestId);
              return;
            }
          }
          const restReq: RestRequest = {
            method,
            segments: segments.slice(2),
            query: url.searchParams,
            body: parsed,
            origin: `http://${req.headers.host ?? 'localhost'}`,
            path: url.pathname,
          };
          try {
            const reply = handleRest(forge, restReq);
            sendJson(res, reply.status, reply.body, requestId, reply.headers);
          } catch (err) {
            if (err instanceof HttpError) sendJson(res, err.status, { message: err.message }, requestId);
            else throw err;
          }
          return;
        }

        // The git smart-HTTP surface: /{owner}/{repo}.git/...
        if (segments.length >= 3 && segments[1].endsWith('.git')) {
          if (!authorized(req, token)) {
            sendJson(res, 401, { message: 'Bad credentials' }, requestId);
            return;
          }
          const owner = segments[0];
          const repoName = segments[1].slice(0, -'.git'.length);
          const gitProtocol = req.headers['git-protocol'];
          if (method === 'GET' && segments[2] === 'info' && segments[3] === 'refs') {
            const reply = handleInfoRefs(forge, owner, repoName, url.searchParams.get('service'), gitProtocol);
            if (reply.contentType.startsWith('application/json')) sendJson(res, reply.status, JSON.parse(reply.body.toString('utf8')), requestId);
            else sendRaw(res, reply.status, reply.contentType, reply.body, requestId);
            return;
          }
          if (method === 'POST' && (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')) {
            const repo = forge.getRepo(owner, repoName);
            if (!repo) {
              sendJson(res, 404, { message: 'Not Found' }, requestId);
              return;
            }
            try {
              const reply =
                segments[2] === 'git-upload-pack'
                  ? handleUploadPack(repo, body, gitProtocol)
                  : handleReceivePack(repo, body);
              sendRaw(res, reply.status, reply.contentType, reply.body, requestId);
            } catch {
              sendJson(res, 400, { message: 'Bad git request' }, requestId);
            }
            return;
          }
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }

        // The GraphQL v4 surface.
        if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method not allowed' }, requestId);
            return;
          }
          if (!authorized(req, token)) {
            sendJson(res, 401, { message: 'Bad credentials' }, requestId);
            return;
          }
          const reply = handleGraphql(forge, body);
          sendJson(res, reply.status, reply.body, requestId);
          return;
        }

        // Everything else is a JSON 404 for now; the MCP surface lands in its own stage and
        // takes over its route below.
        sendJson(res, 404, { message: 'Not Found' }, requestId);
      } catch (err) {
        if (err instanceof HttpError) {
          sendJson(res, err.status, { message: err.message }, requestId);
        } else if (!res.headersSent) {
          sendJson(res, 500, { message: 'Internal error' }, requestId);
        } else {
          res.destroy();
        }
      }
    })();
  });
  return server;
}
