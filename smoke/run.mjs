#!/usr/bin/env node
/**
 * Firecrawl Browser Sandbox — nightly smoke test
 * ----------------------------------------------
 * Drives the deployed proxy end-to-end:
 *   1. POST /api/health      — proxy reachable
 *   2. POST /api/launch      — new sandbox session
 *   3. POST /api/execute/:id — navigate to HN, extract top 5 rows
 *   4. Assert: 5 rows, non-empty titles, numeric points, valid urls
 *   5. DELETE /api/close/:id — release session
 *
 * Exits 0 on success, non-zero with a descriptive JSON report on failure.
 * A GitHub Step Summary is emitted to $GITHUB_STEP_SUMMARY when available.
 *
 * ENV:
 *   PROXY_URL       required  https://firecrawl-sandbox-proxy.<acct>.workers.dev
 *   TIMEOUT_MS      optional  per-request deadline (default 45000)
 *   MIN_ROWS        optional  minimum rows to accept (default 5)
 *   GITHUB_STEP_SUMMARY  optional  path to markdown summary (set by runner)
 */
import fs from 'node:fs';

const PROXY = (process.env.PROXY_URL || '').replace(/\/$/, '');
const TIMEOUT = parseInt(process.env.TIMEOUT_MS || '45000', 10);
const MIN_ROWS = parseInt(process.env.MIN_ROWS || '5', 10);

if (!PROXY) die('PROXY_URL env var is required');

const SANDBOX_CODE = `
  await page.goto('https://news.ycombinator.com', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('tr.athing')
  const hn = await page.$$eval('tr.athing', rows =>
    rows.slice(0, 5).map((row, i) => {
      const link   = row.querySelector('.titleline > a')
      const sub    = row.nextElementSibling
      const domain = row.querySelector('.sitestr')?.innerText ?? null
      const points = parseInt(sub.querySelector('.score')?.innerText) || 0
      const by     = sub.querySelector('.hnuser')?.innerText ?? null
      const cmts   = [...sub.querySelectorAll('a')].map(a => a.innerText)
                       .find(t => /comment/.test(t)) ?? '0'
      const age    = sub.querySelector('.age')?.innerText ?? null
      return { rank: i+1, title: link.innerText, url: link.href,
               domain, points, author: by, comments: parseInt(cmts) || 0, age }
    })
  )
  JSON.stringify(hn)
`;

const report = {
  proxy: PROXY,
  startedAt: new Date().toISOString(),
  steps: {},
  ok: false,
  error: null,
  durationMs: 0,
};

const t0 = Date.now();
let sessionId = null;

try {
  /* 1. health */
  await step('health', async () => {
    const { status, body } = await req('GET', '/api/health');
    assert(status === 200, `health returned ${status}`);
    assert(body && body.ok === true, `health body invalid: ${JSON.stringify(body)}`);
    return { status, ok: body.ok };
  });

  /* 2. launch */
  const launch = await step('launch', async () => {
    const { status, body } = await req('POST', '/api/launch', { ttl: 180, activityTtl: 120 });
    assert(status === 200, `launch returned ${status}: ${JSON.stringify(body)}`);
    assert(body && body.id && /^[0-9a-f-]{10,}$/i.test(body.id), `launch missing id: ${JSON.stringify(body)}`);
    return { status, sessionId: body.id, region: body.region, liveView: Boolean(body.liveViewUrl) };
  });
  sessionId = launch.sessionId;

  /* 3. execute */
  const exec = await step('execute', async () => {
    const { status, body } = await req('POST', `/api/execute/${sessionId}`, {
      language: 'node', code: SANDBOX_CODE, timeout: 60,
    });
    assert(status === 200, `execute returned ${status}: ${JSON.stringify(body).slice(0, 400)}`);
    assert(body && typeof body.result === 'string', `execute body missing result string`);
    let rows;
    try { rows = JSON.parse(body.result); }
    catch (e) { throw new Error(`execute result is not JSON: ${String(body.result).slice(0, 200)}`); }
    assert(Array.isArray(rows), `execute result is not an array`);
    assert(rows.length >= MIN_ROWS, `expected >=${MIN_ROWS} rows, got ${rows.length}`);

    rows.forEach((r, i) => {
      assert(r && typeof r.title === 'string' && r.title.trim().length > 0,
        `row ${i} has empty title`);
      assert(typeof r.url === 'string' && /^https?:\/\//.test(r.url),
        `row ${i} has invalid url: ${r.url}`);
      assert(Number.isFinite(r.points) && r.points >= 0,
        `row ${i} has invalid points: ${r.points}`);
    });

    const totalPoints = rows.reduce((s, r) => s + (r.points || 0), 0);
    return {
      status, rows: rows.length, totalPoints,
      exitCode: body.exitCode ?? 0,
      sample: rows.slice(0, 3).map(r => ({ rank: r.rank, title: r.title, points: r.points })),
    };
  });

  /* 4. close */
  await step('close', async () => {
    const { status } = await req('DELETE', `/api/close/${sessionId}`);
    assert(status >= 200 && status < 300, `close returned ${status}`);
    return { status };
  });
  sessionId = null; // cleaned up

  report.ok = true;
  report.summary = {
    rows: exec.rows,
    totalPoints: exec.totalPoints,
    sessionId: launch.sessionId,
    region: launch.region,
    liveView: launch.liveView,
  };
} catch (err) {
  report.ok = false;
  report.error = {
    message: String(err?.message || err),
    step: err?.step || null,
    stack: err?.stack ? String(err.stack).split('\n').slice(0, 4).join('\n') : null,
  };
  // best-effort cleanup
  if (sessionId) {
    try { await req('DELETE', `/api/close/${sessionId}`); } catch {}
  }
} finally {
  report.durationMs = Date.now() - t0;
  report.finishedAt = new Date().toISOString();
}

/* ---- emit JSON on stdout, markdown summary, exit ---- */
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
writeStepSummary(report);
process.exit(report.ok ? 0 : 1);

/* ============================= helpers ============================= */

async function step(name, fn) {
  const s0 = Date.now();
  try {
    const data = await fn();
    report.steps[name] = { ok: true, durationMs: Date.now() - s0, ...data };
    return data;
  } catch (err) {
    report.steps[name] = { ok: false, durationMs: Date.now() - s0, error: String(err?.message || err) };
    err.step = name;
    throw err;
  }
}

async function req(method, path, body) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(`${PROXY}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const text = await r.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    return { status: r.status, body: parsed };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`${method} ${path} timed out after ${TIMEOUT}ms`);
    throw new Error(`${method} ${path} failed: ${e.message}`);
  } finally {
    clearTimeout(to);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function die(msg) { console.error('smoke: ' + msg); process.exit(2); }

function writeStepSummary(r) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const icon = r.ok ? '✅' : '❌';
  const lines = [
    `## ${icon} Firecrawl Sandbox smoke test`,
    '',
    `* proxy: \`${r.proxy}\``,
    `* duration: **${(r.durationMs / 1000).toFixed(2)}s**`,
    `* started: \`${r.startedAt}\``,
    '',
    '### steps',
    '',
    '| step | ok | ms | detail |',
    '| ---- | -- | -- | ------ |',
  ];
  for (const [name, s] of Object.entries(r.steps)) {
    const detail = s.ok
      ? [s.sessionId && `session \`${s.sessionId}\``, s.rows && `${s.rows} rows`, s.totalPoints && `${s.totalPoints} pts`]
          .filter(Boolean).join(' · ')
      : `\`${(s.error || '').slice(0, 160)}\``;
    lines.push(`| ${name} | ${s.ok ? '✅' : '❌'} | ${s.durationMs} | ${detail} |`);
  }
  if (!r.ok) {
    lines.push('', '### error', '', '```', r.error?.message || 'unknown', '```');
  } else {
    lines.push('', '### sample rows', '', '```json', JSON.stringify(r.summary, null, 2), '```');
  }
  try { fs.appendFileSync(path, lines.join('\n') + '\n'); } catch {}
}
