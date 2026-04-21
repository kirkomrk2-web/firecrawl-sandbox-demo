/**
 * Identical proxy, as a plain Node HTTP server.
 * Handy for local dev on Railway/Render/Fly/Hostinger VPS.
 *
 *   export FIRECRAWL_API_KEY=fc-...
 *   export ALLOWED_ORIGINS=https://your-site.example,http://localhost:5050
 *   node server-node.mjs
 *
 * Exposes the same routes as the Cloudflare Worker at /api/*.
 */
import http from 'node:http';

const PORT = parseInt(process.env.PORT || '8787', 10);
const UPSTREAM = 'https://api.firecrawl.dev/v2';
const MAX_CODE_BYTES = 16 * 1024;
const ALLOWED_LANGS = new Set(['node', 'python', 'bash']);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
const RL_LIMIT = parseInt(process.env.RL_LIMIT || '10', 10);
const RL_WINDOW = parseInt(process.env.RL_WINDOW_SEC || '60', 10);

const mem = new Map();
function rateLimit(ip) {
  const bucket = `${ip}:${Math.floor(Date.now() / (RL_WINDOW * 1000))}`;
  const n = (mem.get(bucket) || 0) + 1;
  mem.set(bucket, n);
  if (mem.size > 1000) mem.clear();
  return n <= RL_LIMIT;
}

function corsHeaders(origin) {
  const allow =
    ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin) ? origin || '*' : ALLOWED_ORIGINS[0] || '*';
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

async function upstream(path, init) {
  const key = process.env.FIRECRAWL_API_KEY;
  const r = await fetch(`${UPSTREAM}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: r.status, body };
}

function redactSession(s) {
  if (!s || typeof s !== 'object') return s;
  return {
    success: s.success, id: s.id, status: s.status,
    createdAt: s.createdAt, expiresAt: s.expiresAt,
    ttl: s.ttl, activityTtl: s.activityTtl, region: s.region,
    liveViewUrl: s.liveViewUrl, interactiveLiveViewUrl: s.interactiveLiveViewUrl,
    cdpHost: s.cdpUrl ? new URL(s.cdpUrl.replace('wss://', 'https://')).host : undefined,
  };
}

function redactExecute(e) {
  if (!e || typeof e !== 'object') return e;
  const clip = (x, n) => (typeof x === 'string' ? x.slice(0, n) : x);
  return {
    success: e.success, stdout: clip(e.stdout, 32 * 1024),
    stderr: clip(e.stderr, 16 * 1024), result: clip(e.result, 128 * 1024),
    exitCode: e.exitCode, durationMs: e.durationMs,
  };
}

function clampInt(v, min, max, dflt) {
  const n = typeof v === 'number' ? Math.floor(v) : parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const origin = req.headers.origin || '';
  const cors = corsHeaders(origin);

  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, ts: Date.now() }, cors);

  if (!process.env.FIRECRAWL_API_KEY) {
    return sendJson(res, 500, { error: 'proxy misconfigured: FIRECRAWL_API_KEY not set' }, cors);
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'anon';
  if (!rateLimit(ip)) return sendJson(res, 429, { error: 'rate limit exceeded' }, cors);

  try {
    if (url.pathname === '/api/launch' && req.method === 'POST') {
      const b = await readBody(req);
      const ttl = clampInt(b.ttl, 60, 900, 300);
      const activityTtl = clampInt(b.activityTtl, 30, 600, 180);
      const { status, body } = await upstream('/browser', { method: 'POST', body: JSON.stringify({ ttl, activityTtl }) });
      return sendJson(res, status, redactSession(body), cors);
    }

    const em = url.pathname.match(/^\/api\/execute\/([0-9a-f-]{10,})$/i);
    if (em && req.method === 'POST') {
      const b = await readBody(req);
      const language = ALLOWED_LANGS.has(b.language) ? b.language : 'node';
      const code = typeof b.code === 'string' ? b.code : '';
      if (!code) return sendJson(res, 400, { error: 'code required' }, cors);
      if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES)
        return sendJson(res, 413, { error: `code exceeds ${MAX_CODE_BYTES} bytes` }, cors);
      const timeout = clampInt(b.timeout, 5, 120, 60);
      const { status, body } = await upstream(`/browser/${em[1]}/execute`,
        { method: 'POST', body: JSON.stringify({ language, code, timeout }) });
      return sendJson(res, status, redactExecute(body), cors);
    }

    const cm = url.pathname.match(/^\/api\/close\/([0-9a-f-]{10,})$/i);
    if (cm && req.method === 'DELETE') {
      const { status, body } = await upstream(`/browser/${cm[1]}`, { method: 'DELETE' });
      return sendJson(res, status, body, cors);
    }

    sendJson(res, 404, { error: 'not found' }, cors);
  } catch (err) {
    sendJson(res, 500, { error: String(err?.message || err) }, cors);
  }
});

server.listen(PORT, () => console.log(`firecrawl-sandbox proxy listening on :${PORT}`));
