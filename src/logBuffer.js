// Bounded in-memory ring buffer of this process's own console output - lets
// the admin dashboard show "last N lines" even when running under systemd,
// where stdout goes straight to the journal (see boatAgent.js's/
// baseStation.js's own console.log/warn/error wrapper, which is what
// actually calls push() below) rather than a terminal this app could
// otherwise just re-read directly. A live-debugging convenience, not a log
// store - Redis/CSV/the journal itself already cover that - so capacity is
// fixed, not configurable, and nothing here is persisted across a restart.
const MAX_LINES = 100;
const lines = [];

function push(line) {
  lines.push({ text: line, timestamp: Date.now() });
  if (lines.length > MAX_LINES) lines.shift();
}

function getLines() {
  return lines.slice();
}

module.exports = { push, getLines, MAX_LINES };
