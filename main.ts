// Entry point for the trial harness.
//
// Lifecycle, in order:
//   1. Find the harness ("env") origin in MAKEFUN_ENV_URL.
//   2. Boot the forge HTTP server on an ephemeral port.
//   3. Tell the env which port we landed on (POST /register).
//   4. Wait until the env signals the trial is over (GET /done).
//   5. Shut the server down and exit cleanly.
//
// Both env calls are retried with a small exponential backoff, because the
// env may still be coming up when this process starts.

import { createApp } from './app.ts';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 30_000; // per-request ceiling for env calls
const BACKOFF_FIRST_MS = 250; // first retry wait
const BACKOFF_LIMIT_MS = 2_000; // retries never wait longer than this
const BACKOFF_MAX_SHIFT = 8; // stop doubling the exponent past 2^8

function envOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  const origin = raw.replace(/\/+$/, '');
  if (origin === '') {
    console.error('main: MAKEFUN_ENV_URL is not set; nowhere to register.');
    process.exit(1);
  }
  return origin;
}

// ---------------------------------------------------------------------------
// Retry timing
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A tiny stateful backoff: each call to wait() sleeps for the current delay
// and then grows it (250ms, 500ms, 1000ms, then pinned at the 2000ms cap).
function makeBackoff() {
  let failures = 0;
  return {
    async wait(): Promise<void> {
      const shift = Math.min(failures, BACKOFF_MAX_SHIFT);
      const delay = Math.min(BACKOFF_FIRST_MS * 2 ** shift, BACKOFF_LIMIT_MS);
      failures += 1;
      await sleep(delay);
    },
  };
}

// ---------------------------------------------------------------------------
// Env HTTP helper
// ---------------------------------------------------------------------------

// Every env call goes through here so the per-request timeout is applied
// the same way everywhere.
function envFetch(
  origin: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

// ---------------------------------------------------------------------------
// Step 1: register our port with the env
// ---------------------------------------------------------------------------

// POSTs {"port": N} to /register until the env accepts it.
//   200 -> registered; 409 -> someone else registered first, also fine.
//   400 / 405 -> the env rejected the shape of the request: a contract bug,
//                so fail loudly instead of retrying forever.
//   anything else (including network errors) -> back off and try again.
async function registerWithEnv(origin: string, port: number): Promise<void> {
  const backoff = makeBackoff();
  for (;;) {
    let response: Response;
    try {
      response = await envFetch(origin, '/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
    } catch {
      await backoff.wait();
      continue;
    }

    if (response.status === 200 || response.status === 409) {
      console.log(`main: registered with env at ${origin}`);
      return;
    }
    if (response.status === 400 || response.status === 405) {
      const body = await response.text();
      throw new Error(
        `main: /register contract error (HTTP ${response.status}): ${body}`,
      );
    }
    // Any other status is retryable, but read the body to its end first so
    // the underlying connection is released back to the pool.
    await response.text().catch(() => '');
    await backoff.wait();
  }
}

// ---------------------------------------------------------------------------
// Step 2: wait for the env to finish the trial
// ---------------------------------------------------------------------------

// Polls GET /done until it answers {"done": true}. Every other outcome —
// an error, a non-OK status, or done:false — just means "not yet".
async function awaitCompletion(origin: string): Promise<void> {
  const backoff = makeBackoff();
  for (;;) {
    try {
      const response = await envFetch(origin, '/done');
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) {
          return;
        }
      } else {
        // Non-OK answer: consume the body so the socket can be reused.
        await response.text().catch(() => '');
      }
    } catch {
      // Network hiccup or a malformed body: fall through and poll again.
    }
    await backoff.wait();
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const origin = envOrigin();

  const server = createApp();
  // The suite drives the whole trial over pooled keep-alive connections, with pauses
  // between phases while it builds its next fixture (the push payloads, the clone
  // history). Node's default 5 s keep-alive can drop those sockets mid-trial on a
  // loaded pod and force reconnects into the timed rounds; hold them for the trial.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  await new Promise<void>((resolve) => {
    server.listen(0, resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('main: server did not bind to a TCP port.');
  }
  console.log(`main: forge listening on port ${address.port}`);

  await registerWithEnv(origin, address.port);
  await awaitCompletion(origin);

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  console.log('main: trial complete; server closed.');
}

try {
  await run();
  process.exit(0);
} catch (error) {
  console.error('main: fatal error:', error);
  process.exit(1);
}
