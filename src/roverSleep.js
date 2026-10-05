// Rover-side radio sleep mode - the base commands it with a power frame (see
// protocol.js's encodePower / baseStation.js's sleepFleet/wakeFleet).
//
// While asleep the rover's radio is powered down (radio.setSleeping(true) -
// on real hardware that raises the XBee's SLEEP_RQ pin, in simulation
// SimRadioLink just stops hearing and sending). Every cycleS seconds it
// powers the radio back up for listenMs, listening for a wake frame. A wake
// frame that names this rover (or "all") ends sleep; otherwise the radio
// powers back down for another cycle.
//
//   awake      normal operation
//   asleep     radio off, timer running toward the next listen window
//   listening  radio on for one listen window; still "sleeping" as far as
//              the rest of the app is concerned (no position frames go out -
//              only a wake frame can end it)
//
// Only the radio sleeps: GPS fixes keep arriving and keep logging to the SD
// card (see boatAgent.js), they just aren't transmitted until the rover wakes.

const { EventEmitter } = require('events');

class RoverSleep extends EventEmitter {
  constructor({ radio, listenMs, defaultCycleS }) {
    super();
    this.radio = radio;
    this.listenMs = listenMs;
    this.defaultCycleS = defaultCycleS;
    this._state = 'awake';
    this._cycleS = defaultCycleS;
    this._timer = null;
    this._sleptAt = null;
    this._nextListenAt = null;
    this._sleepCount = 0;
  }

  get state() {
    return this._state;
  }

  // True whenever the rover must not transmit: asleep, or in a listen window
  // (the radio is up then, but only to hear a wake frame).
  isSleeping() {
    return this._state !== 'awake';
  }

  status() {
    return {
      state: this._state,
      supported: !!this.radio.canSleep,
      cycleS: this._cycleS,
      sleptAt: this._sleptAt,
      nextListenAt: this._nextListenAt,
      sleepCount: this._sleepCount,
    };
  }

  // Applies a decoded power frame if it names this rover (or everyone).
  handlePower({ action, sleepS, all, boatIds }, myBoatId) {
    if (!all && !boatIds.includes(myBoatId)) return;
    if (action === 'sleep') this.sleep(sleepS || this.defaultCycleS);
    else if (action === 'wake') this.wake();
  }

  // Returns false (and does nothing) when this rover has no way to power its
  // radio down - e.g. a real rover without RADIO_SLEEP_GPIO set.
  sleep(cycleS) {
    if (!this.radio.canSleep) {
      console.warn('[sleep] sleep command ignored - this radio has no sleep control (set RADIO_SLEEP_GPIO)');
      return false;
    }
    this._clearTimer();
    this._cycleS = cycleS;
    if (this._state === 'awake') {
      this._sleptAt = Date.now();
      this._sleepCount++;
      console.log(`[sleep] radio asleep - listening for a wake frame for ${this.listenMs}ms every ${cycleS}s`);
      this.emit('sleep');
    }
    this._enterAsleep();
    return true;
  }

  wake() {
    if (this._state === 'awake') return;
    this._clearTimer();
    this.radio.setSleeping(false);
    this._state = 'awake';
    this._nextListenAt = null;
    console.log(`[sleep] wake frame heard after ${Math.round((Date.now() - this._sleptAt) / 1000)}s asleep - radio awake`);
    this._sleptAt = null;
    this.emit('wake');
  }

  _enterAsleep() {
    this.radio.setSleeping(true);
    this._state = 'asleep';
    this._nextListenAt = Date.now() + this._cycleS * 1000;
    this._timer = setTimeout(() => this._enterListening(), this._cycleS * 1000);
  }

  _enterListening() {
    this.radio.setSleeping(false);
    this._state = 'listening';
    this._nextListenAt = null;
    this._timer = setTimeout(() => this._enterAsleep(), this.listenMs);
  }

  _clearTimer() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }
}

module.exports = { RoverSleep };
