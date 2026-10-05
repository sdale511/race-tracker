// Base-side radio sleep control - sends the power frames that put rovers to
// sleep and wake them again (see protocol.js's encodePower, and roverSleep.js
// for what a rover does with them), and tracks which rovers it believes are
// asleep for the dashboard.
//
// Sleeping rovers can't be heard from, so "asleep" here is the base's own
// belief: set when it commands sleep, cleared the first time that rover is
// heard from again (any position frame or hello - see noteHeard).
//
// Waking is the awkward half. A sleeping rover only listens for listenMs once
// per cycle, on its own unsynchronised timer, so a single wake frame is
// almost always missed. wake() therefore repeats the frame every
// wakeRepeatMs for a full cycle plus a listen window (plus a margin), which
// guarantees every rover in range gets several chances inside one of its
// listen windows. A wake naming specific rovers stops early once all of them
// have been heard from; "all" runs its full duration, since the base can't
// know whether some rover it has never heard from is also asleep.

const protocol = require('./protocol');

// A rover that was sleeping can't have sent anything since the sleep command,
// but a frame already in flight when the command went out can still arrive -
// ignore anything this soon after the command rather than mistaking it for a
// wake-up.
const IN_FLIGHT_GRACE_MS = 3000;
const WAKE_MARGIN_MS = 1000;

class FleetSleep {
  constructor({ radio, sleepConfig, getKnownBoatIds = () => [], log = console.log }) {
    this.radio = radio;
    this.cfg = sleepConfig;
    this.getKnownBoatIds = getKnownBoatIds;
    this.log = log;
    this.sleeping = new Map(); // boatId -> { commandedAt, cycleS }
    this.wakeJob = null; // { timer, deadline, targets: Set|null, heard: Set }
    this.sleepTimers = [];
    this.maxCycleS = sleepConfig.cycleS; // longest cycle any rover may currently be on
  }

  // Splits a target list into frames of at most MAX_POWER_IDS ids; an empty
  // list is one "all" frame.
  _frames(action, boatIds, sleepS) {
    if (boatIds.length === 0) return [protocol.encodePower(action, { sleepS })];
    const frames = [];
    for (let i = 0; i < boatIds.length; i += protocol.MAX_POWER_IDS) {
      frames.push(protocol.encodePower(action, { sleepS, boatIds: boatIds.slice(i, i + protocol.MAX_POWER_IDS) }));
    }
    return frames;
  }

  _normalizeIds(boatIds) {
    return [...new Set((boatIds || []).map((id) => (/^\d+$/.test(String(id)) ? String(id).padStart(protocol.BOAT_ID_LEN, '0') : String(id))))];
  }

  // boatIds empty = every rover. Returns the boat ids now believed asleep.
  sleep({ boatIds = [], cycleS = this.cfg.cycleS } = {}) {
    const ids = this._normalizeIds(boatIds);
    if (!Number.isInteger(cycleS) || cycleS < 1 || cycleS > 255) throw new Error('cycleS must be a whole number of seconds from 1 to 255');
    const frames = this._frames('sleep', ids, cycleS); // validates ids too
    this._cancelWake();

    // Rovers are awake and listening now, so a few quick repeats cover a lost
    // frame - no need for the long wake-style repeat.
    for (let n = 0; n < this.cfg.sleepRepeats; n++) {
      this.sleepTimers.push(
        setTimeout(() => {
          for (const f of frames) this.radio.broadcast(f);
        }, n * this.cfg.wakeRepeatMs)
      );
    }

    const targets = ids.length ? ids : this.getKnownBoatIds();
    const now = Date.now();
    for (const id of targets) this.sleeping.set(id, { commandedAt: now, cycleS });
    this.maxCycleS = Math.max(this.maxCycleS, cycleS);
    this.log(`[fleetSleep] sleep sent to ${ids.length ? ids.join(', ') : 'ALL rovers'} (listen ${this.cfg.listenMs}ms every ${cycleS}s)`);
    return targets;
  }

  // boatIds empty = every rover in range. Runs for a cycle + listen window.
  wake({ boatIds = [] } = {}) {
    const ids = this._normalizeIds(boatIds);
    const frames = this._frames('wake', ids, 0);
    this._cancelWake();
    this.sleepTimers.forEach(clearTimeout);
    this.sleepTimers = [];

    const durationMs = this.maxCycleS * 1000 + this.cfg.listenMs + WAKE_MARGIN_MS;
    const job = { deadline: Date.now() + durationMs, targets: ids.length ? new Set(ids) : null, heard: new Set(), timer: null };
    const tick = () => {
      if (Date.now() >= job.deadline) return this._finishWake('timed out');
      for (const f of frames) this.radio.broadcast(f);
      job.timer = setTimeout(tick, this.cfg.wakeRepeatMs);
    };
    this.wakeJob = job;
    this.log(`[fleetSleep] waking ${ids.length ? ids.join(', ') : 'ALL rovers'} - repeating for up to ${Math.round(durationMs / 1000)}s`);
    tick();
    return { durationMs };
  }

  // Call for every position frame or hello heard from a boat.
  noteHeard(boatId) {
    const entry = this.sleeping.get(boatId);
    if (entry && Date.now() - entry.commandedAt > IN_FLIGHT_GRACE_MS) {
      this.sleeping.delete(boatId);
      this.log(`[fleetSleep] boat=${boatId} is awake`);
    }
    const job = this.wakeJob;
    if (job && job.targets) {
      job.heard.add(boatId);
      if ([...job.targets].every((id) => job.heard.has(id))) this._finishWake('every named rover answered');
    }
  }

  _finishWake(why) {
    this._cancelWake();
    this.log(`[fleetSleep] wake finished (${why})`);
  }

  _cancelWake() {
    if (this.wakeJob && this.wakeJob.timer) clearTimeout(this.wakeJob.timer);
    this.wakeJob = null;
  }

  status() {
    const sleeping = {};
    for (const [id, e] of this.sleeping) sleeping[id] = { commandedAt: e.commandedAt, cycleS: e.cycleS };
    return {
      cycleS: this.cfg.cycleS,
      sleeping,
      waking: this.wakeJob ? { deadline: this.wakeJob.deadline, targets: this.wakeJob.targets ? [...this.wakeJob.targets] : null } : null,
    };
  }
}

module.exports = { FleetSleep };
