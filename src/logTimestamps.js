// Prefixes every console.log/warn/error line with an ISO timestamp,
// process-wide - required first thing (before any other requires) by each
// entry-point process (baseStation.js, boatAgent.js, fleetSim.js) so every
// line any module in that process logs gets one automatically, including
// ones nobody thought to add `${new Date().toISOString()}` to by hand.
// Some call sites already build their own timestamp into the log string
// (a leftover from before this existed) - that's harmless, just a second,
// now-redundant timestamp on those specific lines, not worth hunting down
// and removing one by one.
const originalLog = console.log.bind(console);
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);

function timestamp() {
  return new Date().toISOString();
}

console.log = (...args) => originalLog(timestamp(), ...args);
console.warn = (...args) => originalWarn(timestamp(), ...args);
console.error = (...args) => originalError(timestamp(), ...args);
