// GPS board sleep for rover sleep mode (see roverSleep.js). While the rover
// sleeps its GPS board is put into u-blox software backup mode (about 1.4 mA
// instead of tens of mA) and woken only when the rover wakes - not on every
// radio listen window, since every wake costs a reacquisition.
//
//   sleep  Real GPS: send UBX-RXM-PMREQ (see ubxParser.js's encodePmreq),
//          backup mode with the UART RX pin as the wake source. Simulated
//          GPS: the simulated boat keeps moving, but its fixes are dropped.
//   wake   Real GPS: write a byte to the receiver; any edge on its RX pin
//          wakes it. Simulated GPS: fixes resume after a hot-start delay.
//
// Staying hot: software backup keeps the receiver's main supply on, so its
// backup RAM (ephemeris, almanac, position, time) is kept as long as the
// board's V_BCKP pin is supplied - see README's "GPS sleep and cold starts".
// This module measures the result instead of assuming it: after every wake
// it logs the time to the first valid fix and to the first RTK-fixed fix.
// A time to first fix beyond roughly 10-30 s means the receiver cold-started.

const { encodePmreq } = require('./ubxParser');

// A receiver that really entered backup mode stops producing fixes within
// this long; one that is still sending after it refused (typically because
// its USB port is connected - see config.sleep.gps.forceUsb).
const SLEEP_ENTRY_GRACE_MS = 2500;
const WAKE_RETRY_MS = 5000;
const WAKE_MAX_RETRIES = 3;

class GpsSleep {
  // mode: 'real' | 'simulated' | 'none' (boatAgent.js's gpsMode)
  // write: (Buffer) => bool - writes to the real GPS's serial port
  constructor({ mode, write, forceUsb = false, simWakeDelayMs = 3000, log = console }) {
    this.mode = mode;
    this.write = write;
    this.forceUsb = forceUsb;
    this.simWakeDelayMs = simWakeDelayMs;
    this.log = log;
    this._asleep = false;
    this._sleptAt = null;
    this._warmUntil = 0; // simulated hot-start window after a wake
    this._wakeAt = null; // set from wake() until the first valid fix arrives
    this._firstFixMs = null;
    this._rtkFixMs = null;
    this._retryTimer = null;
    this._retries = 0;
    this._warnedStillSending = false;
  }

  get supported() {
    return this.mode !== 'none';
  }

  isAsleep() {
    return this._asleep;
  }

  sleep() {
    if (!this.supported || this._asleep) return;
    this._asleep = true;
    this._sleptAt = Date.now();
    this._wakeAt = null;
    this._firstFixMs = null;
    this._rtkFixMs = null;
    this._warnedStillSending = false;
    this._clearRetry();
    if (this.mode === 'real') {
      const sent = this.write(encodePmreq({ durationMs: 0, force: this.forceUsb }));
      if (!sent) this.log.warn('[gps] could not send the backup (sleep) command - GPS port not open');
    }
    this.log.log(`[gps] ${this.mode === 'real' ? 'sleeping (software backup)' : 'simulated GPS asleep'}`);
  }

  wake() {
    if (!this.supported || !this._asleep) return;
    this._asleep = false;
    this._wakeAt = Date.now();
    this._warmUntil = this._wakeAt + (this.mode === 'simulated' ? this.simWakeDelayMs : 0);
    this._retries = 0;
    this.log.log('[gps] waking');
    if (this.mode === 'real') this._sendWakeByte();
    this._armRetry();
  }

  // Safe no-op for a GPS that is already awake: a stray byte on a UBX stream
  // is ignored. Called at startup so a rover that restarted while its GPS
  // was still asleep (the Pi rebooted, the app crashed) wakes it.
  wakeOnStartup() {
    if (this.mode === 'real') this._sendWakeByte();
  }

  _sendWakeByte() {
    if (!this.write(Buffer.from([0xff]))) this.log.warn('[gps] could not send the wake byte - GPS port not open');
  }

  // A wake edge can be missed (the receiver may still be entering backup
  // when it arrives), so resend until a fix shows up.
  _armRetry() {
    this._clearRetry();
    this._retryTimer = setTimeout(() => {
      if (this._wakeAt === null || this._firstFixMs !== null) return;
      if (++this._retries > WAKE_MAX_RETRIES) {
        this.log.warn(`[gps] no fix ${Math.round((Date.now() - this._wakeAt) / 1000)}s after waking - giving up resending the wake byte`);
        return;
      }
      this.log.warn(`[gps] no fix yet after waking - resending wake byte (${this._retries}/${WAKE_MAX_RETRIES})`);
      if (this.mode === 'real') this._sendWakeByte();
      this._armRetry();
    }, WAKE_RETRY_MS);
  }

  _clearRetry() {
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._retryTimer = null;
  }

  // Called for every fix the GPS source produces. Returns true if the caller
  // should DROP it (asleep, or inside the simulated reacquisition window).
  // `valid` = the fix is usable (boatAgent.js's hasValidFix); `rtkFixed` =
  // carrier solution is fixed. Also records time-to-first-fix after a wake.
  shouldDrop(pvt, { valid, rtkFixed }) {
    const now = Date.now();
    if (this._asleep) {
      if (this.mode === 'real' && now - this._sleptAt > SLEEP_ENTRY_GRACE_MS && !this._warnedStillSending) {
        this._warnedStillSending = true;
        this.log.warn('[gps] still producing fixes while "asleep" - the receiver refused backup mode (USB connected? try GPS_SLEEP_FORCE_USB=1)');
      }
      return true;
    }
    if (now < this._warmUntil) return true;
    if (this._wakeAt !== null) {
      if (valid && this._firstFixMs === null) {
        this._firstFixMs = now - this._wakeAt;
        this._clearRetry();
        this.log.log(
          `[gps] first valid fix ${(this._firstFixMs / 1000).toFixed(1)}s after waking` +
            (this._firstFixMs > 15000 ? ' - slow, the receiver probably cold-started (see README "GPS sleep and cold starts")' : '')
        );
      }
      if (rtkFixed && this._rtkFixMs === null) {
        this._rtkFixMs = now - this._wakeAt;
        this.log.log(`[gps] RTK fixed ${(this._rtkFixMs / 1000).toFixed(1)}s after waking`);
        this._wakeAt = null; // both measurements taken
      }
    }
    return false;
  }

  status() {
    return {
      supported: this.supported,
      asleep: this._asleep,
      sleptAt: this._asleep ? this._sleptAt : null,
      lastFirstFixMs: this._firstFixMs,
      lastRtkFixMs: this._rtkFixMs,
    };
  }
}

module.exports = { GpsSleep };
