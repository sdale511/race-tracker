// Battery-saving scheduled shutdown for the boat's own Pi - see config.js's
// own "Scheduled shutdown" comment for the full picture (off by default,
// power-up isn't handled here, etc.) and powerScheduleFile.js for how the
// rover dashboard's power card persists edits across a restart. This file
// is the gate logic + the actual shutdown call + the live controller the
// dashboard drives, kept separate from boatAgent.js so the gate itself
// (evaluateGate) is unit-testable without spawning a real child process or
// needing a live GPS feed.
const { exec } = require('child_process');
const { persistPowerSchedule } = require('./powerScheduleFile');

const KNOTS_PER_MS = 1.943844; // m/s -> knots
// A fix older than this is treated as "not fresh" - the boat's ground speed
// from it can't be trusted as CURRENT (the GPS could have lost lock while
// still moving), so a stale fix counts as idle time by default rather than
// silently freezing the idle clock at whatever the last known speed was.
const FIX_STALE_MS = 120000;

// Only ever refuses to arm - never throws - so an unexpected platform
// doesn't crash the whole boat process over a battery-saving feature that
// just won't apply there. `shutdown -h now` is a real command on macOS too
// (a developer's own laptop, testing locally with ROVER_SHUTDOWN_AT set by
// habit from a Pi .env) - this exists specifically to stop that from
// actually shutting down someone's laptop.
function isShutdownCapablePlatform() {
  return process.platform === 'linux';
}

// Pure decision function - given the gate's current idleSince and the most
// recent pvt (or null), returns the next idleSince and whether THIS call is
// the transition into "shut down now." Exported mainly so a test can drive
// it directly without the setInterval/exec wiring below. `now` is
// injectable (defaults to Date.now()) purely for tests; production callers
// never pass it.
function evaluateGate({ shutdownAt, shutdownSpeedKn, shutdownIdleMinutes, idleSince, lastFix, now = Date.now() }) {
  const [h, m] = shutdownAt.split(':').map(Number);
  const scheduledToday = new Date(now);
  scheduledToday.setHours(h, m, 0, 0);
  if (now < scheduledToday.getTime()) return { idleSince: null, shouldShutDown: false }; // not yet time today

  const fixIsFresh = lastFix && lastFix.timestamp != null && now - lastFix.timestamp < FIX_STALE_MS;
  const speedKn = fixIsFresh ? ((lastFix.gSpeedMmS || 0) / 1000) * KNOTS_PER_MS : null;
  const isIdleNow = !fixIsFresh || speedKn < shutdownSpeedKn;
  if (!isIdleNow) return { idleSince: null, shouldShutDown: false };

  const startedAt = idleSince ?? now;
  const shouldShutDown = now - startedAt >= shutdownIdleMinutes * 60000;
  return { idleSince: startedAt, shouldShutDown };
}

// "HH:MM" 24h local time, or null/undefined to disable the whole feature.
// Thrown errors here are what turn into a 400 from roverAdminServer's
// POST /api/power - worth validating strictly, since evaluateGate's own
// `shutdownAt.split(':').map(Number)` silently produces an Invalid Date
// (and therefore `now < scheduledToday` = false, i.e. "always past
// schedule") on garbage input rather than failing loudly.
function validateShutdownAt(value) {
  if (value == null || value === '') return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value).trim());
  if (!m) throw new Error(`shutdownAt must be 24h "HH:MM" (got ${JSON.stringify(value)})`);
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function validateNumber(name, value, min) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be a number >= ${min} (got ${JSON.stringify(value)})`);
  return n;
}

// getLastFix: () => the most recent pvt object (or null) - passed as a
// function rather than a value so each tick reads whatever's current at
// that moment, same reasoning as roverStats' own snapshot() pattern.
// runShutdown: injectable for tests; production default actually shuts the
// machine down.
//
// Always returns a live controller ({ getStatus, updateParams, stop }),
// even when the feature starts out disabled (shutdownAt null) or this
// platform can't ever arm it (non-Linux) - the rover dashboard's power card
// (see roverAdminServer.js) needs one consistent thing to call regardless
// of how this boat happened to boot, including turning the feature ON for
// the first time without a restart. The check interval just runs for the
// life of the process; when disabled/incapable, each tick is a cheap no-op
// rather than something started/stopped on the fly.
function startShutdownScheduler({
  shutdownAt,
  shutdownIdleMinutes,
  shutdownSpeedKn,
  shutdownCheckIntervalMs,
  getLastFix,
  runShutdown = defaultRunShutdown,
}) {
  const capable = isShutdownCapablePlatform();
  const state = {
    shutdownAt: shutdownAt || null,
    shutdownIdleMinutes,
    shutdownSpeedKn,
    shutdownCheckIntervalMs,
    idleSince: null,
    triggered: false,
  };
  let timer = null;

  function logArmedState() {
    if (!state.shutdownAt) {
      console.log('[power] scheduled shutdown disabled');
    } else if (!capable) {
      console.warn(
        `[power] shutdownAt=${state.shutdownAt} is set but this isn't Linux (platform=${process.platform}) - scheduled shutdown disabled here to avoid shutting down the wrong machine`
      );
    } else {
      console.log(
        `[power] scheduled shutdown armed: after ${state.shutdownAt} local time, once stationary (<${state.shutdownSpeedKn}kn or no fresh fix) for ${state.shutdownIdleMinutes} continuous minutes`
      );
    }
  }

  function tick() {
    if (state.triggered || !state.shutdownAt || !capable) return;
    const result = evaluateGate({
      shutdownAt: state.shutdownAt,
      shutdownSpeedKn: state.shutdownSpeedKn,
      shutdownIdleMinutes: state.shutdownIdleMinutes,
      idleSince: state.idleSince,
      lastFix: getLastFix(),
    });
    state.idleSince = result.idleSince;
    if (result.shouldShutDown) {
      state.triggered = true;
      clearInterval(timer);
      console.log(`[power] past ${state.shutdownAt} and stationary for ${state.shutdownIdleMinutes}+ min - shutting down now`);
      runShutdown();
    }
  }

  function armTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(tick, state.shutdownCheckIntervalMs);
  }

  logArmedState();
  armTimer();

  // Applied by the rover dashboard's power card (see roverAdminServer.js's
  // POST /api/power) - any subset of these four fields, merged onto
  // whatever's currently in effect, validated, then persisted (see
  // powerScheduleFile.js) so a later restart remembers it. idleSince resets
  // on any change - a just-edited threshold shouldn't inherit idle time
  // that was measured against the OLD one.
  function updateParams(partial) {
    if (state.triggered) throw new Error('already shutting down - restart the boat to rearm');
    const next = { ...state };
    if ('shutdownAt' in partial) next.shutdownAt = validateShutdownAt(partial.shutdownAt);
    if ('shutdownIdleMinutes' in partial) next.shutdownIdleMinutes = validateNumber('shutdownIdleMinutes', partial.shutdownIdleMinutes, 0);
    if ('shutdownSpeedKn' in partial) next.shutdownSpeedKn = validateNumber('shutdownSpeedKn', partial.shutdownSpeedKn, 0);
    if ('shutdownCheckIntervalMs' in partial)
      next.shutdownCheckIntervalMs = validateNumber('shutdownCheckIntervalMs', partial.shutdownCheckIntervalMs, 1000);

    state.shutdownAt = next.shutdownAt;
    state.shutdownIdleMinutes = next.shutdownIdleMinutes;
    state.shutdownSpeedKn = next.shutdownSpeedKn;
    state.shutdownCheckIntervalMs = next.shutdownCheckIntervalMs;
    state.idleSince = null;

    persistPowerSchedule({
      shutdownAt: state.shutdownAt,
      shutdownIdleMinutes: state.shutdownIdleMinutes,
      shutdownSpeedKn: state.shutdownSpeedKn,
      shutdownCheckIntervalMs: state.shutdownCheckIntervalMs,
    });
    logArmedState();
    armTimer();
  }

  function getStatus() {
    return {
      shutdownAt: state.shutdownAt,
      shutdownIdleMinutes: state.shutdownIdleMinutes,
      shutdownSpeedKn: state.shutdownSpeedKn,
      shutdownCheckIntervalMs: state.shutdownCheckIntervalMs,
      capable,
      armed: !!state.shutdownAt && capable,
      idleSince: state.idleSince,
      triggered: state.triggered,
    };
  }

  return { updateParams, getStatus, stop: () => clearInterval(timer) };
}

function defaultRunShutdown() {
  exec('sudo shutdown -h now', (err) => {
    // If this fails, the device stays up - not silently, at least: the
    // most common cause is the running user lacking a passwordless sudo
    // rule for shutdown specifically (see README's "Scheduled shutdown").
    if (err) console.error('[power] shutdown command failed (device is still running):', err.message);
  });
}

module.exports = { startShutdownScheduler, evaluateGate, isShutdownCapablePlatform };
