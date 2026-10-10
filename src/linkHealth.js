// Link health (base): turns the fixes the base is already receiving into "is the radio link working?" -
// per boat and for the fleet - for the dashboard's Link health card and a console warning when something
// goes bad. No extra radio traffic: it only looks at what arrives.
//
// What it measures, per boat, over the last 60 s:
//   RTK fixed / float %   from each fix's carrier solution - the outcome that matters: a boat sliding to float
//                         has incomplete corrections.
//   gaps                  fixes that skip more than GAP_MS of GPS time while the boat is moving (both fixes
//                         at MOVING_KN or faster, not parked on the start grid) - a missed frame or more.
//                         Not counted past MAX_GAP_MS: that is out of range, asleep or stopped, not a loss.
//   silence               how long since the last fix, for a boat that was moving.
// and for the fleet: the share of radio frames that failed their checksum (sync errors).
//
// Levels: ok / warn / bad (or quiet for a boat that is idle or parked and not expected to be talking).

const WINDOW_MS = 60 * 1000;
const RATE_WINDOW_MS = 10 * 1000;
const SEEN_MS = 2 * 60 * 1000; // boats not heard for longer than this drop off the card
const GAP_MS = 2000; // a moving boat sends at least about once a second; more than this between fixes is a gap
const MAX_GAP_MS = 60 * 1000;
const MOVING_KN = 2;
const MIN_RTK_SAMPLES = 5;

const THRESHOLDS = {
  rtkWarnPct: 90,
  rtkBadPct: 50,
  gapsWarn: 1,
  gapsBad: 3,
  silentWarnS: 5,
  silentBadS: 10,
  syncWarnPct: 1,
  syncBadPct: 3,
  syncMinFrames: 20,
};

const LEVEL_RANK = { quiet: 0, ok: 1, warn: 2, bad: 3 };
const worse = (a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a);

class LinkHealth {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.boats = new Map(); // boatId -> { samples: [{ t, rtk, float }], gaps: [{ t, ms }], last: { ts, speed, t, parked } }
    this.frames = []; // times of frames that decoded
    this.syncErrors = []; // times of checksum failures
  }

  // One decoded fix from a boat (each fix in a batch frame separately). `parked` = the boat is on the start
  // grid and reports only now and then.
  recordFix(boatId, fix, { parked = false } = {}) {
    const t = this.now();
    let b = this.boats.get(boatId);
    if (!b) {
      b = { samples: [], gaps: [], last: null };
      this.boats.set(boatId, b);
    }
    const rtk = !!fix.gnssFixOk && fix.carrSoln === 2;
    const float = !!fix.gnssFixOk && fix.carrSoln === 1;
    b.samples.push({ t, rtk, float, ok: !!fix.gnssFixOk });
    const prev = b.last;
    if (prev && !parked && !prev.parked) {
      const gapMs = fix.timestamp - prev.ts;
      if (gapMs > GAP_MS && gapMs <= MAX_GAP_MS && Math.min(prev.speed, fix.speedKnots) >= MOVING_KN) b.gaps.push({ t, ms: gapMs });
    }
    b.last = { ts: fix.timestamp, speed: fix.speedKnots, t, parked };
    this._prune(b, t);
  }

  recordFrame() {
    this.frames.push(this.now());
  }

  recordSyncError() {
    this.syncErrors.push(this.now());
  }

  _prune(b, t) {
    while (b.samples.length && t - b.samples[0].t > WINDOW_MS) b.samples.shift();
    while (b.gaps.length && t - b.gaps[0].t > WINDOW_MS) b.gaps.shift();
  }

  boatStatus(boatId) {
    const b = this.boats.get(boatId);
    if (!b || !b.last) return null;
    const t = this.now();
    this._prune(b, t);
    const silentMs = t - b.last.t;
    if (silentMs > SEEN_MS) return null;
    const n = b.samples.length;
    const recent = b.samples.filter((s) => t - s.t <= RATE_WINDOW_MS).length;
    const rtkPct = n >= MIN_RTK_SAMPLES ? Math.round((b.samples.filter((s) => s.rtk).length / n) * 100) : null;
    const floatPct = n >= MIN_RTK_SAMPLES ? Math.round((b.samples.filter((s) => s.float).length / n) * 100) : null;
    const longestGapS = b.gaps.length ? Math.round(Math.max(...b.gaps.map((g) => g.ms)) / 100) / 10 : 0;
    const wasMoving = b.last.speed >= MOVING_KN && !b.last.parked;

    let level = 'ok';
    const why = [];
    if (!wasMoving && !b.last.parked && b.last.speed < 1 && silentMs > 20 * 1000) {
      level = 'quiet'; // sitting still, sending its heartbeat - not expected to be chatty
    } else {
      if (rtkPct !== null && rtkPct < THRESHOLDS.rtkBadPct) { level = worse(level, 'bad'); why.push(`RTK fixed only ${rtkPct}%`); }
      else if (rtkPct !== null && rtkPct < THRESHOLDS.rtkWarnPct) { level = worse(level, 'warn'); why.push(`RTK fixed ${rtkPct}%`); }
      if (b.gaps.length >= THRESHOLDS.gapsBad) { level = worse(level, 'bad'); why.push(`${b.gaps.length} gaps in the last minute (longest ${longestGapS} s)`); }
      else if (b.gaps.length >= THRESHOLDS.gapsWarn) { level = worse(level, 'warn'); why.push(`${b.gaps.length} gap in the last minute`); }
      if (wasMoving && silentMs >= THRESHOLDS.silentBadS * 1000) { level = worse(level, 'bad'); why.push(`silent for ${Math.round(silentMs / 1000)} s`); }
      else if (wasMoving && silentMs >= THRESHOLDS.silentWarnS * 1000) { level = worse(level, 'warn'); why.push(`silent for ${Math.round(silentMs / 1000)} s`); }
    }
    return {
      boatId,
      level,
      why,
      fixesPerSec: Math.round((recent / (RATE_WINDOW_MS / 1000)) * 10) / 10,
      rtkPct,
      floatPct,
      gaps: b.gaps.length,
      longestGapS,
      silentS: Math.round(silentMs / 1000),
      moving: wasMoving,
      parked: !!b.last.parked,
    };
  }

  status() {
    const t = this.now();
    this.frames = this.frames.filter((x) => t - x <= WINDOW_MS);
    this.syncErrors = this.syncErrors.filter((x) => t - x <= WINDOW_MS);
    const boats = [];
    for (const id of this.boats.keys()) {
      const s = this.boatStatus(id);
      if (s) boats.push(s);
      else if (this.boats.get(id).last && t - this.boats.get(id).last.t > SEEN_MS) this.boats.delete(id);
    }
    boats.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || (a.rtkPct ?? 101) - (b.rtkPct ?? 101) || (a.boatId < b.boatId ? -1 : 1));
    const total = this.frames.length + this.syncErrors.length;
    const syncPct = total >= THRESHOLDS.syncMinFrames ? Math.round((this.syncErrors.length / total) * 1000) / 10 : null;
    let syncLevel = 'ok';
    if (syncPct !== null && syncPct >= THRESHOLDS.syncBadPct) syncLevel = 'bad';
    else if (syncPct !== null && syncPct >= THRESHOLDS.syncWarnPct) syncLevel = 'warn';
    let level = syncLevel;
    for (const b of boats) level = worse(level, b.level === 'quiet' ? 'ok' : b.level);
    return {
      level,
      syncPct,
      syncLevel,
      syncErrors: this.syncErrors.length,
      frames: this.frames.length,
      boats,
      counts: {
        ok: boats.filter((b) => b.level === 'ok').length,
        warn: boats.filter((b) => b.level === 'warn').length,
        bad: boats.filter((b) => b.level === 'bad').length,
        quiet: boats.filter((b) => b.level === 'quiet').length,
      },
      thresholds: THRESHOLDS,
    };
  }
}

// Console alerts: call check() now and then (the base does it every 10 s); it returns the lines to log -
// one when a boat or the fleet turns bad (with the reasons), one when it recovers - never a repeat while it
// stays bad.
class LinkHealthAlerter {
  constructor(health) {
    this.health = health;
    this.bad = new Set();
    this.syncBad = false;
  }

  check() {
    const s = this.health.status();
    const lines = [];
    const nowBad = new Set(s.boats.filter((b) => b.level === 'bad').map((b) => b.boatId));
    for (const b of s.boats) if (b.level === 'bad' && !this.bad.has(b.boatId)) lines.push(`[health] WARNING: boat ${b.boatId}: ${b.why.join('; ')}`);
    for (const id of this.bad) if (!nowBad.has(id)) lines.push(`[health] boat ${id} recovered`);
    this.bad = nowBad;
    const syncBad = s.syncLevel === 'bad';
    if (syncBad && !this.syncBad) lines.push(`[health] WARNING: ${s.syncPct}% of radio frames are failing their checksum (${s.syncErrors} of ${s.syncErrors + s.frames} in the last minute)`);
    if (!syncBad && this.syncBad) lines.push('[health] radio frame errors back to normal');
    this.syncBad = syncBad;
    return lines;
  }
}

module.exports = { LinkHealth, LinkHealthAlerter, THRESHOLDS };
