// Shared "Console" page for both admin dashboards (adminServer.js on the
// base station, roverAdminServer.js on the boat) - same idea as
// configReport.js's renderConfigPage, one implementation both routes to.
// Reads directly from logBuffer (a per-process singleton - see its own
// comment for why this works correctly across two different processes
// sharing this one file, same as configReport.js already does with
// config.js) rather than needing the caller to pass lines through.
const logBuffer = require('./logBuffer');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// title: e.g. "boat 3 console" / "base station console" - shown in the
// page's own <title>/<h1> so it's obvious which process this is if you've
// got more than one of these tabs open at once.
function renderConsoleLogPage(title) {
  const lines = logBuffer.getLines();
  const rows = lines
    .map((l) => {
      const time = new Date(l.timestamp).toISOString().slice(11, 23);
      return `<div class="line"><span class="time">${time}</span>${escapeHtml(l.text)}</div>`;
    })
    .join('');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta http-equiv="refresh" content="5">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    background: #0f1216;
    color: #e6e9ef;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .subtitle { color: #8b94a3; font-size: 13px; margin-bottom: 16px; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .log {
    background: #161b22;
    border: 1px solid #262c36;
    border-radius: 10px;
    padding: 14px 16px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
  }
  .line + .line { border-top: 1px solid #1c222b; padding-top: 2px; margin-top: 2px; }
  .time { color: #5a6270; margin-right: 10px; font-variant-numeric: tabular-nums; }
  .empty { color: #8b94a3; }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="subtitle">
    last ${lines.length} of up to ${logBuffer.MAX_LINES} lines &middot; refreshes every 5s &middot; <a href="/">&larr; back to dashboard</a>
  </div>
  <div class="log">${rows || '<span class="empty">nothing logged yet</span>'}</div>
  <script>
    // The meta refresh above is a full page reload, not a live-patching
    // view - browsers don't reliably keep scroll position across that, so
    // without this, watching the log past one screenful means manually
    // re-scrolling to the bottom every 5s. Runs fresh on every reload,
    // landing on whatever's newest each time.
    window.scrollTo(0, document.body.scrollHeight);
  </script>
</body>
</html>`;
}

module.exports = { renderConsoleLogPage };
