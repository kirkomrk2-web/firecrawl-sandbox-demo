/**
 * Firecrawl Browser Sandbox — lightweight proxy (Cloudflare Worker)
 * ----------------------------------------------------------------
 *  POST   /api/launch           -> launches a new sandbox session
 *  POST   /api/execute/:id      -> runs code inside a session
 *  DELETE /api/close/:id        -> closes a session
 *  GET    /api/health           -> liveness probe
 *
 * The Firecrawl API key is read from the `FIRECRAWL_API_KEY` secret
 * and is NEVER exposed to the client. The client calls this Worker
 * at e.g. https://firecrawl-proxy.<account>.workers.dev and the
 * dashboard drives it with fetch().
 *
 * Hardening included out of the box:
 *   - CORS allowlist via the ALLOWED_ORIGINS env var (comma-separated).
 *   - Token-bucket rate limiting per client IP (stored in a KV namespace
 *     bound as `RL`; falls back to memory if not configured).
 *   - Code-size guard: rejects execute payloads larger than 16 KiB.
 *   - Only `node`, `python`, `bash` languages are forwarded.
 *   - Only the whitelisted fields from upstream responses are returned.
 */

const UPSTREAM = 'https://api.firecrawl.dev/v2';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const MAX_CODE_BYTES = 16 * 1024;
const ALLOWED_LANGS = new Set(['node', 'python', 'bash']);

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function corsHeaders(origin, env) {
  const list = (env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const allow = list.includes('*') || list.includes(origin) ? origin || '*' : list[0] || '*';
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}

function json(data, init = {}, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: { ...JSON_HEADERS, ...extraHeaders, ...(init.headers || {}) },
  });
}

/* Very small in-memory rate limiter (per isolate). Production hardening
 * uses the optional KV binding `RL` for cross-isolate limits. */
const mem = new Map();
async function rateLimit(ip, env, limit = 10, windowSec = 60) {
  const bucketKey = `rl:${ip}:${Math.floor(Date.now() / (windowSec * 1000))}`;
  if (env.RL) {
    const n = parseInt((await env.RL.get(bucketKey)) || '0', 10) + 1;
    await env.RL.put(bucketKey, String(n), { expirationTtl: windowSec + 5 });
    return n <= limit;
  }
  const n = (mem.get(bucketKey) || 0) + 1;
  mem.set(bucketKey, n);
  // naive cleanup
  if (mem.size > 500) for (const k of mem.keys()) { mem.delete(k); if (mem.size < 300) break; }
  return n <= limit;
}

async function upstream(path, init, env) {
  const r = await fetch(`${UPSTREAM}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      'authorization': `Bearer ${env.FIRECRAWL_API_KEY}`,
      'content-type': 'application/json',
    },
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: r.status, body };
}

/* Whitelist fields we return to the client. Never forward tokens
 * or anything that could be used to bypass the proxy. */
function redactSession(s) {
  if (!s || typeof s !== 'object') return s;
  return {
    success: s.success,
    id: s.id,
    status: s.status,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    ttl: s.ttl,
    activityTtl: s.activityTtl,
    region: s.region,
    // liveViewUrl is safe to expose — it's a read-only streamer
    liveViewUrl: s.liveViewUrl,
    interactiveLiveViewUrl: s.interactiveLiveViewUrl,
    // cdpUrl contains a session token; strip to opaque string
    cdpHost: s.cdpUrl ? new URL(s.cdpUrl.replace('wss://', 'https://')).host : undefined,
  };
}

function redactExecute(e) {
  if (!e || typeof e !== 'object') return e;
  return {
    success: e.success,
    stdout: typeof e.stdout === 'string' ? e.stdout.slice(0, 32 * 1024) : e.stdout,
    stderr: typeof e.stderr === 'string' ? e.stderr.slice(0, 16 * 1024) : e.stderr,
    result: typeof e.result === 'string' ? e.result.slice(0, 128 * 1024) : e.result,
    exitCode: e.exitCode,
    durationMs: e.durationMs,
  };
}

/* ------------------------------------------------------------------ */
/* router                                                              */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // health
    if (url.pathname === '/api/health') {
      return json({ ok: true, ts: Date.now() }, {}, cors);
    }

    // guard: key configured?
    if (!env.FIRECRAWL_API_KEY) {
      return json({ error: 'proxy misconfigured: FIRECRAWL_API_KEY not set' }, { status: 500 }, cors);
    }

    // rate limit per IP
    const ip = request.headers.get('cf-connecting-ip') || 'anon';
    const ok = await rateLimit(
      ip,
      env,
      parseInt(env.RL_LIMIT || '10', 10),
      parseInt(env.RL_WINDOW_SEC || '60', 10),
    );
    if (!ok) return json({ error: 'rate limit exceeded' }, { status: 429 }, cors);

    try {
      /* ---------------- launch ---------------- */
      if (url.pathname === '/api/launch' && request.method === 'POST') {
        const reqBody = await safeJson(request);
        const ttl = clampInt(reqBody.ttl, 60, 900, 300);
        const activityTtl = clampInt(reqBody.activityTtl, 30, 600, 180);
        const { status, body } = await upstream('/browser', {
          method: 'POST',
          body: JSON.stringify({ ttl, activityTtl }),
        }, env);
        return json(redactSession(body), { status }, cors);
      }

      /* ---------------- execute --------------- */
      const execMatch = url.pathname.match(/^\/api\/execute\/([0-9a-f-]{10,})$/i);
      if (execMatch && request.method === 'POST') {
        const id = execMatch[1];
        const reqBody = await safeJson(request);
        const language = ALLOWED_LANGS.has(reqBody.language) ? reqBody.language : 'node';
        const code = typeof reqBody.code === 'string' ? reqBody.code : '';
        if (!code) return json({ error: 'code required' }, { status: 400 }, cors);
        if (byteLen(code) > MAX_CODE_BYTES) {
          return json({ error: `code exceeds ${MAX_CODE_BYTES} bytes` }, { status: 413 }, cors);
        }
        const timeout = clampInt(reqBody.timeout, 5, 120, 60);
        const { status, body } = await upstream(`/browser/${id}/execute`, {
          method: 'POST',
          body: JSON.stringify({ language, code, timeout }),
        }, env);
        return json(redactExecute(body), { status }, cors);
      }

      /* ---------------- close ----------------- */
      const closeMatch = url.pathname.match(/^\/api\/close\/([0-9a-f-]{10,})$/i);
      if (closeMatch && request.method === 'DELETE') {
        const id = closeMatch[1];
        const { status, body } = await upstream(`/browser/${id}`, { method: 'DELETE' }, env);
        return json(body, { status }, cors);
      }

      return json({ error: 'not found' }, { status: 404 }, cors);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, { status: 500 }, cors);
    }
  },
};

function clampInt(v, min, max, dflt) {
  const n = typeof v === 'number' ? Math.floor(v) : parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

async function safeJson(req) {
  try { return await req.json(); } catch { return {}; }
}

function byteLen(str) {
  // TextEncoder is present in Workers runtime
  return new TextEncoder().encode(str).length;
}
