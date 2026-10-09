// Decides when it is safe to write a frame to the shared radio without hitting a
// correction burst. The radio can't transmit and receive at once, and a telemetry
// frame sent into a burst both gets delayed and leaves the corrections incomplete.
//
// The conflict window was MEASURED (see docs/radio-latency-findings-2026-10-09.pdf,
// radio-latency focus sweep, 26-byte frames): frames written from about 40 ms before
// the burst start, as the listening radio decodes it, to about 10-20 ms after it were
// delayed by 20-35 ms (rarely lost) and left 46% of bursts incomplete; outside it,
// delay was normal. A bigger frame is on the air later after the write (about 0.087 ms
// per byte more at 115200 baud), so its window starts earlier. A guard on each side
// covers the jitter.

const { performance } = require('perf_hooks');

const REFERENCE_BYTES = 26; // the frame size the window was measured with
const SERIAL_MS_PER_BYTE = 0.087; // 115200 baud, 8N1

class TxGate {
  constructor({ tracker, blockBeforeMs = 40, blockAfterMs = 20, guardMs = 10, now = () => performance.now() }) {
    this.tracker = tracker;
    this.blockBeforeMs = blockBeforeMs;
    this.blockAfterMs = blockAfterMs;
    this.guardMs = guardMs;
    this.now = now;
  }

  // How long before a write of `bytes` starts being unsafe ahead of a burst, and how long after
  // the burst start it stays unsafe.
  beforeMs(bytes) {
    return this.blockBeforeMs + Math.max(0, bytes - REFERENCE_BYTES) * SERIAL_MS_PER_BYTE + this.guardMs;
  }
  afterMs() {
    return this.blockAfterMs + this.guardMs;
  }

  // Milliseconds to wait before writing a frame of `bytes` (0 = go now). Always 0 while no
  // bursts are being heard - nothing is held back for a base that isn't there.
  waitMs(bytes, t = this.now()) {
    const tr = this.tracker;
    if (!tr.isActive(t)) return 0;
    const p = tr.period;
    const prev = tr.startAtOrBefore(t);
    const next = prev + p;
    if (t <= prev + this.afterMs()) return prev + this.afterMs() - t; // inside the burst's wake
    if (t >= next - this.beforeMs(bytes)) return next + this.afterMs() - t; // too close to the next burst
    return 0;
  }
}

module.exports = { TxGate };
