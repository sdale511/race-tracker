// The boat shutdown schedule the base admin sets for the whole fleet. It is the boat's own software shutdown (powerSchedule.js):
// once the local time has passed `time` AND the boat has been stopped (slower than `speedKn`, or no fresh fix) for `idleMinutes`
// it halts. It needs no Witty Pi, so it always works; with a Witty Pi the two combine (the Witty Pi's "let each boat shut itself
// down" option leaves the shutdown to this). Like the Witty Pi schedule (wittySchedule.js) the base stores it, sends it over the
// radio every minute or so, and a boat applies it only when it differs from what it last got from the base.
//
// Settings: { enabled, time 'HH:MM', idleMinutes, speedKn, stamp }. Disabled settings disarm the boat's shutdown.

const fs = require('fs');
const path = require('path');

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const configDir = path.join(__dirname, '..', 'race-config');
const DEFAULT_SETTINGS_FILE = path.join(configDir, 'fleet-shutdown.json'); // the base's copy
const DEFAULT_APPLIED_FILE = path.join(configDir, 'fleet-shutdown-applied.json'); // a boat's record of what the base sent

function validate(input, nowMs = Date.now()) {
  const m = HHMM.exec(String((input && input.time) || '').trim());
  if (!m) throw new Error('shutdown time must be 24h "HH:MM"');
  const idleMinutes = Number(input.idleMinutes === '' || input.idleMinutes == null ? 10 : input.idleMinutes);
  const speedKn = Number(input.speedKn === '' || input.speedKn == null ? 0.5 : input.speedKn);
  if (!Number.isFinite(idleMinutes) || idleMinutes < 0 || idleMinutes > 1440) throw new Error('idle minutes must be 0 to 1440');
  if (!Number.isFinite(speedKn) || speedKn < 0 || speedKn > 600) throw new Error('speed must be 0 to 600 knots');
  const stamp = Number(input.stamp);
  return {
    enabled: !!input.enabled,
    time: `${m[1].padStart(2, '0')}:${m[2]}`,
    idleMinutes: Math.round(idleMinutes),
    speedKn: Math.round(speedKn * 100) / 100,
    stamp: Number.isFinite(stamp) && stamp > 0 ? Math.floor(stamp) : Math.floor(nowMs / 1000),
  };
}

function describe(s) {
  if (!s) return 'not set';
  if (!s.enabled) return 'disabled';
  return `after ${s.time} local time, once stopped (under ${s.speedKn} kn) for ${s.idleMinutes} min`;
}

// ---- the base's stored copy ----

function load(file = DEFAULT_SETTINGS_FILE) {
  try {
    return validate(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[shutdown] failed to read the stored fleet shutdown:', err.message);
    return null;
  }
}
function save(settings, file = DEFAULT_SETTINGS_FILE) {
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

// What the boat's controller is given for these settings: disabled disarms it (no time); the idle and speed values are
// always passed so a later enable already has them.
function toParams(s) {
  return { shutdownAt: s.enabled ? s.time : null, shutdownIdleMinutes: s.idleMinutes, shutdownSpeedKn: s.speedKn };
}

// Does this boat need to apply these settings? Only if they differ from what it last got from the base (or that never
// succeeded). The comparison is against the base's last settings, not the controller's live values, so a local edit on the
// boat's own Scheduled shutdown card stays until the base next changes the settings. When disabled only the fact counts.
function needsApply(settings, applied) {
  if (!applied || !applied.ok || !applied.settings) return true;
  const a = applied.settings;
  if (a.enabled !== settings.enabled) return true;
  if (!settings.enabled) return false;
  return a.time !== settings.time || a.idleMinutes !== settings.idleMinutes || a.speedKn !== settings.speedKn;
}

// A boat has heard the base's shutdown settings (radio 'shutdown-schedule' event). `updateParams` is the boat's
// powerSchedule controller's. Resolves a result for the log, or null when there is nothing to do.
function handleFrame(frame, { updateParams, appliedFile = DEFAULT_APPLIED_FILE, now = Date.now() }) {
  let settings;
  try {
    settings = validate(frame);
  } catch (err) {
    return { ok: false, message: `ignored a shutdown schedule from the base: ${err.message}` };
  }
  const applied = readApplied(appliedFile);
  if (!needsApply(settings, applied)) return null;
  let result;
  try {
    updateParams(toParams(settings));
    result = { ok: true, message: `shutdown schedule from the base: ${describe(settings)}` };
  } catch (err) {
    result = { ok: false, message: `could not apply the base's shutdown schedule: ${err.message}` };
  }
  try {
    fs.mkdirSync(path.dirname(appliedFile), { recursive: true });
    const { stamp, ...withoutStamp } = settings;
    fs.writeFileSync(appliedFile, JSON.stringify({ stamp, ok: result.ok, settings: withoutStamp, appliedAt: now, message: result.message }));
  } catch (err) {
    console.error('[shutdown] could not record the applied schedule:', err.message);
  }
  return result;
}

function boatStatus(appliedFile = DEFAULT_APPLIED_FILE) {
  const applied = readApplied(appliedFile);
  return applied ? { ...applied, description: describe(applied.settings) } : null;
}

module.exports = { validate, describe, load, save, needsApply, handleFrame, boatStatus, toParams };
