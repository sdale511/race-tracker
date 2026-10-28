require('./logTimestamps');
const http = require('http');
const config = require('./config');
const { renderDashboard } = require('./adminServer');
const { formatDuration } = require('./dashboardFormat');
const { versionLine } = require('./version');
const baseDiscovery = require('./baseDiscovery');

// A read-only, radio-less view of a running base station's fleet page, for monitoring a race remotely. It polls the base's
// GET /api/stats over HTTP and draws the base's own dashboard from it (adminServer.js's renderDashboard with readOnly),
// so the table and cards are exactly what the base shows - minus every control. It opens no radio, no serial port and no
// Redis, and only ever sends GETs, so it can run on any machine that can reach the base's admin port.
//
//   npm run viewer -- http://pi.local:8092      (or VIEWER_BASE_URL=...)   then open http://localhost:8094
//   npm run viewer                              finds a base on the local network by UDP broadcast (baseDiscovery.js)

// A fetched snapshot is reused this long: a few browsers (each reloading every 5 s) then cost the base one /api/stats
// between them - that call reads Redis - and an unreachable base is not hammered either.
const CACHE_MS = 2000;
// A base found by discovery that stops answering is looked for again at most this often (it may have a new DHCP address).
const REDISCOVER_MS = 10000;

// http://pi.local:8092, pi.local:8092 or a bare pi.local (the base's admin port is then assumed) -> the base's origin.
function normalizeBaseUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('no base address given');
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  const url = new URL(hasScheme ? text : `http://${text}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`unsupported address "${text}" (use http:// or https://)`);
  const explicitPort = /:\d+(?:[/?#]|$)/.test(text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''));
  if (!explicitPort && url.protocol === 'http:') url.port = String(config.admin.port);
  return url.origin;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Why a fetch failed, in a few words an operator can act on.
function describeError(err, timeoutMs) {
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return `no answer in ${timeoutMs} ms`;
  const code = err && err.cause && err.cause.code;
  return code ? `${code}` : (err && err.message) || String(err);
}

const MESSAGE_STYLE = 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif';

function waitingPage(baseUrl, lastError, candidates) {
  const looking = baseUrl
    ? `Waiting for the base at <strong>${escapeHtml(baseUrl)}</strong>`
    : 'Looking for a base station on the local network';
  const choices = candidates.length
    ? `<div style="margin-top:12px">Start the viewer with the address of the one you want:</div><ul style="margin:6px 0 0;padding-left:20px">${candidates
        .map((b) => `<li><code>npm run viewer -- ${escapeHtml(b.url)}</code>${b.host || b.regatta ? ` <span style="color:#8b94a3">&mdash; ${escapeHtml([b.host, b.regatta].filter(Boolean).join(', '))}</span>` : ''}</li>`)
        .join('')}</ul>`
    : '';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>race-tracker base viewer</title>
</head>
<body style="background:#161b22;color:#e6e9ef;${MESSAGE_STYLE};padding:24px">
  <h1 style="font-size:20px;margin:0 0 12px">race-tracker base viewer</h1>
  <div>${looking}${lastError ? ` &mdash; <span style="color:#ff7b72">${escapeHtml(lastError)}</span>` : ''}</div>${choices}
  <div style="color:#8b94a3;margin-top:8px">Trying again every few seconds.</div>
</body>
</html>`;
}

function staleBanner(baseUrl, lastError, ageMs) {
  return `<div style="background:#3a1416;color:#ff7b72;border:1px solid #6e2a2c;border-radius:6px;padding:8px 14px;margin:0 0 12px;font-size:14px;${MESSAGE_STYLE}">Base unreachable at ${escapeHtml(baseUrl)} (${escapeHtml(lastError)}) &mdash; showing what it last reported ${escapeHtml(formatDuration(ageMs))} ago.</div>`;
}

// baseUrl is the base's address; with none, `discover` (() => Promise<[{ host, regatta, address, url }]>, see
// baseDiscovery.js) finds it, and finds it again if it stops answering. fetchImpl/now/log are swappable for the tests.
function createViewer({ baseUrl = null, discover = null, timeoutMs = config.viewer.timeoutMs, cacheMs = CACHE_MS, fetchImpl = fetch, now = Date.now, log = console.log } = {}) {
  let snapshot = null; // { stats, at } - the last good response
  let lastError = null; // null while the base is answering
  let inflight = null;
  let attemptedAt = -Infinity;
  let baseHost = null; // the hostname of the base discovery picked, to pick the same one again if its address changes
  let candidates = []; // several bases answered and none can be told to be the one: shown for the operator to choose
  let discoveredAt = -Infinity;

  function fail(message) {
    if (message !== lastError) log(`[baseViewer] ${baseUrl ? `base unreachable at ${baseUrl}` : 'no base yet'}: ${message}`);
    lastError = message;
  }

  // Broadcasts for a base and settles on one: the one with the hostname already in use, else the only one that answered.
  // Returns whether baseUrl is now set.
  async function findBase() {
    discoveredAt = now();
    let found = [];
    try {
      found = await discover();
    } catch (err) {
      found = [];
    }
    const pick = (baseHost && found.find((b) => b.host === baseHost)) || (found.length === 1 ? found[0] : null);
    if (pick) {
      baseHost = pick.host;
      candidates = [];
      if (pick.url !== baseUrl) {
        log(`[baseViewer] found base${pick.host ? ` ${pick.host}` : ''} at ${pick.url}${baseUrl ? ` (was ${baseUrl})` : ''}`);
        baseUrl = pick.url;
        lastError = null;
      }
      return true;
    }
    if (!baseUrl) {
      candidates = found.length > 1 ? found : [];
      fail(found.length > 1 ? `${found.length} bases answered` : 'no base answered on the network');
    }
    return false;
  }

  async function refresh() {
    if (inflight) return inflight;
    if (now() - attemptedAt < cacheMs) return undefined;
    inflight = (async () => {
      try {
        if (!baseUrl && !(await findBase())) return;
        const res = await fetchImpl(`${baseUrl}/api/stats`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const stats = await res.json();
        if (!stats || typeof stats !== 'object' || !stats.boats) throw new Error('not a base station /api/stats response');
        snapshot = { stats, at: now() };
        if (lastError) log(`[baseViewer] base reachable again at ${baseUrl}`);
        lastError = null;
      } catch (err) {
        fail(describeError(err, timeoutMs));
        if (discover && now() - discoveredAt >= REDISCOVER_MS) await findBase();
      } finally {
        attemptedAt = now();
        inflight = null;
      }
    })();
    return inflight;
  }

  function renderPage() {
    if (!snapshot) return waitingPage(baseUrl, lastError, candidates);
    const html = renderDashboard(snapshot.stats, false, 'home', { readOnly: true }).replace('<title>race-tracker admin</title>', '<title>race-tracker base viewer</title>');
    if (!lastError) return html;
    return html.replace('<body>', () => `<body>\n${staleBanner(baseUrl, lastError, now() - snapshot.at)}`);
  }

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    const pathOnly = req.url.split('?')[0];
    if (pathOnly !== '/' && pathOnly !== '') {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      await refresh();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(renderPage());
    } catch (err) {
      res.writeHead(500);
      res.end(`<pre>${escapeHtml(err.message)}</pre>`);
    }
  });

  return { server, refresh, renderPage };
}

function main() {
  let baseUrl = null;
  const given = process.argv[2] || config.viewer.baseUrl;
  if (given) {
    try {
      baseUrl = normalizeBaseUrl(given);
    } catch (err) {
      console.error(`[baseViewer] ${err.message}`);
      console.error('usage: npm run viewer [-- <base address>]     e.g. npm run viewer -- http://pi.local:8092');
      console.error('       (no address: look for a base on the local network; or set VIEWER_BASE_URL; VIEWER_PORT and VIEWER_HOST choose where the viewer page is served)');
      process.exit(1);
    }
  }

  const { server } = createViewer({
    baseUrl,
    discover: baseUrl ? null : () => baseDiscovery.discover({ port: config.discovery.port, timeoutMs: config.discovery.timeoutMs }),
  });
  server.on('error', (err) => {
    console.error(`[baseViewer] cannot listen on ${config.viewer.host}:${config.viewer.port}: ${err.message}`);
    process.exit(1);
  });
  server.listen(config.viewer.port, config.viewer.host, () => {
    console.log(`[baseViewer] race-tracker ${versionLine()}`);
    console.log(
      baseUrl
        ? `[baseViewer] read-only view of the base at ${baseUrl}`
        : `[baseViewer] read-only view of a base found on the local network (UDP :${config.discovery.port}; pass an address to name one)`
    );
    console.log(`[baseViewer] open http://${config.viewer.host === '0.0.0.0' ? 'localhost' : config.viewer.host}:${config.viewer.port}`);
    if (config.viewer.host !== '127.0.0.1' && config.viewer.host !== 'localhost') {
      console.log('[baseViewer] listening beyond this machine - the page has no login, so anyone who can reach it sees the fleet');
    }
  });
}

if (require.main === module) main();

module.exports = { createViewer, normalizeBaseUrl };
