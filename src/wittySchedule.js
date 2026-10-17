// Witty Pi 4 power schedule for the fleet. The base admin's Witty Pi card sets ONE schedule for every boat and the base sends
// it over the radio (protocol.js's encodeWittySchedule); each boat that has a Witty Pi writes ~/wittypi/schedule.wpi from
// those settings and enables it by running the board's own runScript.sh. This file is what both ends share: validating the
// settings, building the schedule file text, the base's stored copy of the settings, and the boat's apply step.
//
// A schedule is `mode`:
//   'off'   no schedule: schedule.wpi is removed (the Witty Pi stops scheduling; the boat's own "Scheduled shutdown" still works)
//   'daily' the Pi runs from startTime to endTime (local, 24h "HH:MM") every day
//   'sun'   the Pi runs from `beforeMin` minutes before sunrise to `afterMin` minutes after sunset at lat/lon (sunSchedule.js)
// `haltItself`: the ON state ends with WAIT, so the Witty Pi schedules no shutdown and the boat halts itself when idle
// (ROVER_SHUTDOWN_AT) however late the racing runs; otherwise the Witty Pi shuts the Pi down at the end time.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const sun = require('./sunSchedule');

const MODES = ['off', 'daily', 'sun'];
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const configDir = path.join(__dirname, '..', 'race-config');
const DEFAULT_SETTINGS_FILE = path.join(configDir, 'witty-schedule.json'); // the base's copy
const DEFAULT_APPLIED_FILE = path.join(configDir, 'witty-applied.json'); // a boat's record of what it applied

const pad = (n) => String(n).padStart(2, '0');
const toMinutes = (t) => {
  const m = HHMM.exec(String(t).trim());
  return Number(m[1]) * 60 + Number(m[2]);
};

// Where the board's software lives (the installer's default; WITTYPI_DIR overrides) and whether it is there.
function wittyDir() {
  return process.env.WITTYPI_DIR || path.join(os.homedir(), 'wittypi');
}
function isInstalled(dir = wittyDir()) {
  return fs.existsSync(path.join(dir, 'runScript.sh'));
}

// "9:05" -> "09:05"; anything that is not a 24h time gives the fallback.
function normaliseTime(value, fallback) {
  if (!HHMM.test(String(value || '').trim())) return fallback;
  const m = toMinutes(String(value).trim());
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

// Checks and normalises settings from the admin form, a stored file or a decoded radio frame. Throws a plain message on
// anything the schedule cannot be built from. `stamp` (unix seconds the settings were set) is added if missing.
function validateSettings(input, nowMs = Date.now()) {
  const mode = input && input.mode;
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
  const out = { mode, haltItself: !!input.haltItself, stamp: Number.isFinite(Number(input.stamp)) && Number(input.stamp) > 0 ? Math.floor(Number(input.stamp)) : Math.floor(nowMs / 1000) };
  out.startTime = normaliseTime(input.startTime, '09:00');
  out.endTime = normaliseTime(input.endTime, '17:00');
  out.lat = input.lat == null || input.lat === '' ? null : Number(input.lat);
  out.lon = input.lon == null || input.lon === '' ? null : Number(input.lon);
  out.beforeMin = input.beforeMin == null || input.beforeMin === '' ? 30 : Math.round(Number(input.beforeMin));
  out.afterMin = input.afterMin == null || input.afterMin === '' ? 30 : Math.round(Number(input.afterMin));
  out.days = input.days == null || input.days === '' ? 366 : Math.round(Number(input.days));
  if (mode === 'daily') {
    if (!HHMM.test(input.startTime || '') || !HHMM.test(input.endTime || '')) throw new Error('start and end times must be 24h "HH:MM"');
    if (toMinutes(out.startTime) === toMinutes(out.endTime)) throw new Error('start and end times must differ');
  }
  if (mode === 'sun') {
    if (!Number.isFinite(out.lat) || out.lat < -90 || out.lat > 90) throw new Error('latitude must be between -90 and 90');
    if (!Number.isFinite(out.lon) || out.lon < -180 || out.lon > 180) throw new Error('longitude must be between -180 and 180');
    if (!(out.beforeMin >= 0 && out.beforeMin <= 255)) throw new Error('minutes before sunrise must be 0 to 255');
    if (!(out.afterMin >= 0 && out.afterMin <= 255)) throw new Error('minutes after sunset must be 0 to 255');
    if (!(out.days >= 1 && out.days <= 1000)) throw new Error('days must be 1 to 1000');
  }
  return out;
}

// The schedule.wpi text for settings (mode 'daily' or 'sun'), for the given moment (a Date; local time is the Pi's).
function buildScript(settings, now = new Date()) {
  if (settings.mode === 'sun') {
    return sun.buildSchedule({
      lat: settings.lat,
      lon: settings.lon,
      from: now,
      days: settings.days,
      beforeMin: settings.beforeMin,
      afterMin: settings.afterMin,
      hardStop: !settings.haltItself,
    });
  }
  if (settings.mode !== 'daily') throw new Error('no schedule file for mode ' + settings.mode);
  const start = toMinutes(settings.startTime);
  let onMin = toMinutes(settings.endTime) - start;
  if (onMin <= 0) onMin += 1440; // a day that runs past midnight
  const offMin = 1440 - onMin;
  const begin = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${settings.startTime}:00`;
  return [
    `# Witty Pi 4 schedule: the Pi runs ${settings.startTime} to ${settings.endTime} every day${settings.haltItself ? ', then halts itself when idle' : ''}.`,
    '# Written by the boat from the settings the base sent over the radio (wittySchedule.js); the base admin owns it - edits here are overwritten.',
    `BEGIN ${begin}`,
    'END   2099-12-31 23:59:59',
    `ON    ${sun.formatDuration(onMin * 60000)}${settings.haltItself ? ' WAIT' : ''}`,
    `OFF   ${sun.formatDuration(offMin * 60000)}`,
    '',
  ].join('\n');
}

// A short description for the card and the logs.
function describe(settings) {
  if (!settings || settings.mode === 'off') return 'no schedule';
  const tail = settings.haltItself ? ', the boat halts itself when idle' : ', the Witty Pi shuts the Pi down at the end';
  if (settings.mode === 'daily') return `on ${settings.startTime} to ${settings.endTime} every day${tail}`;
  return `on ${settings.beforeMin} min before sunrise to ${settings.afterMin} min after sunset at ${settings.lat}, ${settings.lon}${tail}`;
}

// ---- the base's stored copy ----

function loadSettings(file = DEFAULT_SETTINGS_FILE) {
  try {
    return validateSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[witty] failed to read the stored schedule:', err.message);
    return null;
  }
}
function saveSettings(settings, file = DEFAULT_SETTINGS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings));
}

// ---- the boat's apply step ----

function readApplied(file = DEFAULT_APPLIED_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
function writeApplied(record, file = DEFAULT_APPLIED_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record));
  } catch (err) {
    console.error('[witty] could not record the applied schedule:', err.message);
  }
}

// Runs a shell command in `cwd`, resolving { code, output } (never rejecting).
function run(cmd, args, cwd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, output: `${stdout || ''}${stderr || ''}`.trim().slice(-1500) });
    });
  });
}

// The board's own script, as this user first and then through passwordless sudo (the board is on I2C, which a service
// user may not be allowed to use; the Witty Pi daemon itself runs as root).
async function defaultRunner(dir, script) {
  let r = await run('bash', [script], dir);
  if (r.code !== 0) {
    const viaSudo = await run('sudo', ['-n', 'bash', script], dir);
    if (viaSudo.code === 0) r = viaSudo;
    else r.output += viaSudo.output ? `\n(with sudo) ${viaSudo.output}` : '';
  }
  return r;
}

// Removing the schedule file stops the script engine, but the board keeps the startup and shutdown it was last told, so
// clear those too, best effort (the board's own utilities.sh names them clear_startup_time and clear_shutdown_time).
const CLEAR_SCRIPT = '. ./utilities.sh && clear_startup_time && clear_shutdown_time';

// Applies settings on this Pi: writes (or removes) schedule.wpi and has the Witty Pi load it. `deps` is for tests.
// Resolves { ok, installed, wrote, message }; never throws.
async function applySettings(settings, deps = {}) {
  const dir = deps.dir || wittyDir();
  const now = deps.now || new Date();
  const runner = deps.runner || defaultRunner;
  if (!isInstalled(dir)) {
    return { ok: false, installed: false, wrote: false, message: `the Witty Pi software is not in ${dir}` };
  }
  const file = path.join(dir, 'schedule.wpi');
  try {
    if (settings.mode === 'off') {
      fs.rmSync(file, { force: true });
      const cleared = await (deps.clear || ((d) => run('bash', ['-c', CLEAR_SCRIPT], d)))(dir);
      return {
        ok: true,
        installed: true,
        wrote: false,
        message: cleared.code === 0 ? 'schedule removed and the board\'s next startup and shutdown cleared' : `schedule removed; clearing the board's next startup/shutdown failed (${cleared.output || 'exit ' + cleared.code}) - clear them in wittyPi.sh`,
      };
    }
    const text = buildScript(settings, now);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== text && !fs.existsSync(file + '.bak')) fs.copyFileSync(file, file + '.bak');
    fs.writeFileSync(file, text);
  } catch (err) {
    return { ok: false, installed: true, wrote: false, message: err.message };
  }
  const r = await runner(dir, 'runScript.sh');
  return r.code === 0
    ? { ok: true, installed: true, wrote: true, message: `schedule written and enabled: ${describe(settings)}` }
    : { ok: false, installed: true, wrote: true, message: `schedule file written but the Witty Pi did not load it (${r.output || 'exit ' + r.code}); it is loaded the next time the Pi boots` };
}

// The settings that decide what the schedule file says (not the stamp, which only says when the base last saved them).
const relevant = (s) => {
  const keys = s.mode === 'daily' ? ['mode', 'haltItself', 'startTime', 'endTime'] : s.mode === 'sun' ? ['mode', 'haltItself', 'lat', 'lon', 'beforeMin', 'afterMin', 'days'] : ['mode'];
  return Object.fromEntries(keys.map((k) => [k, s[k]]));
};
const SUN_RENEW_MS = 14 * 86400000; // a sunrise-to-sunset file that ends within two weeks is written again

// Does this boat need to apply these settings? Only if they differ from what it applied last, its schedule file is gone, a
// failed apply needs another try, or a sunrise-to-sunset file is about to run out - never just because the base saved the
// same settings again (a new stamp) or repeats the frame. `fileExists` says whether schedule.wpi is there.
function needsApply(settings, applied, fileExists, nowMs = Date.now()) {
  if (!applied || !applied.ok || !applied.settings) return true;
  if (JSON.stringify(relevant(applied.settings)) !== JSON.stringify(relevant(settings))) return true;
  if (settings.mode !== 'off' && !fileExists) return true;
  if (settings.mode === 'sun' && applied.coversUntil && applied.coversUntil - nowMs < SUN_RENEW_MS) return true;
  return false;
}

// A boat has heard the base's settings (radio 'witty-schedule' event); the base repeats them every minute or so. Applies
// them only if they differ from what this boat last applied (see needsApply), so the repeats and a re-save of the same
// settings cost nothing. A boat with no Witty Pi software ignores them without recording anything, so installing the board
// later still picks the schedule up on the next repeat. Resolves a result for the log, or null when there is nothing to do.
let warnedNotInstalledStamp = null;
async function handleScheduleFrame(frame, deps = {}) {
  const appliedFile = deps.appliedFile || DEFAULT_APPLIED_FILE;
  let settings;
  try {
    settings = validateSettings(frame);
  } catch (err) {
    return { ok: false, message: `ignored a schedule from the base: ${err.message}` };
  }
  const dir = deps.dir || wittyDir();
  const now = deps.now || new Date();
  const applied = readApplied(appliedFile);
  if (isInstalled(dir) && !needsApply(settings, applied, fs.existsSync(path.join(dir, 'schedule.wpi')), now.getTime())) return null;
  const result = await applySettings(settings, deps);
  if (!result.installed) {
    // say so once per version of the schedule, not on every repeat of the frame
    if (warnedNotInstalledStamp === frame.stamp) return null;
    warnedNotInstalledStamp = frame.stamp;
    return { ...result, notInstalled: true };
  }
  const { stamp, ...withoutStamp } = settings;
  writeApplied(
    {
      stamp,
      ok: result.ok,
      settings: withoutStamp,
      appliedAt: now.getTime(),
      coversUntil: settings.mode === 'sun' ? now.getTime() + settings.days * 86400000 : null,
      message: result.message,
    },
    appliedFile
  );
  return result;
}

// What a boat dashboard shows: whether the board's software is here, what the base last had this boat apply (with a plain
// description of it), and the start of the schedule file as it is on disk now (read only).
function boatStatus(deps = {}) {
  const dir = deps.dir || wittyDir();
  const applied = readApplied(deps.appliedFile || DEFAULT_APPLIED_FILE);
  const installed = isInstalled(dir);
  let file = null;
  if (installed) {
    try {
      file = fs.readFileSync(path.join(dir, 'schedule.wpi'), 'utf8').split('\n').slice(0, 40).join('\n').trim() || null;
    } catch {
      file = null; // no schedule file
    }
  }
  return { dir, installed, applied, description: applied && applied.settings ? describe(applied.settings) : null, file };
}

module.exports = {
  MODES,
  validateSettings,
  buildScript,
  describe,
  loadSettings,
  saveSettings,
  applySettings,
  handleScheduleFrame,
  needsApply,
  boatStatus,
  wittyDir,
  isInstalled,
};
