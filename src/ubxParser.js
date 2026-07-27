const { EventEmitter } = require('events');

// Minimal UBX binary protocol parser, specialized for NAV-PVT (class 0x01,
// id 0x07), which the ZED-F9P (on the simpleRTK2B) can emit at 1-10Hz.
// NAV-PVT bundles position, velocity, heading, fix type and RTK carrier
// solution status into a single 92-byte payload, so we don't need to stitch
// together multiple NMEA sentences.
//
// Enable this message and disable NMEA chatter on the GPS's UART using
// u-center or ubxtool, e.g.:
//   ubxtool -P 27.11 -p CFG-VALSET -z CFG-MSGOUT-UBX_NAV_PVT_UART1,1
//   ubxtool -P 27.11 -p CFG-VALSET -z CFG-UART1OUTPROT-NMEA,0

const SYNC1 = 0xb5;
const SYNC2 = 0x62;
const CLASS_NAV = 0x01;
const ID_NAV_PVT = 0x07;
const PVT_LENGTH = 92;

class UbxParser extends EventEmitter {
  constructor() {
    super();
    this._buf = Buffer.alloc(0);
  }

  write(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    this._process();
  }

  _process() {
    // Find sync bytes, then make sure we have a full frame before consuming.
    while (true) {
      const syncIdx = this._buf.indexOf(Buffer.from([SYNC1, SYNC2]));
      if (syncIdx === -1) {
        // Keep at most 1 trailing byte in case it's a split sync marker.
        if (this._buf.length > 1) this._buf = this._buf.slice(this._buf.length - 1);
        return;
      }
      if (syncIdx > 0) this._buf = this._buf.slice(syncIdx);

      // Need at least header(6) + checksum(2) to know the length field.
      if (this._buf.length < 6) return;

      const msgClass = this._buf[2];
      const msgId = this._buf[3];
      const length = this._buf.readUInt16LE(4);
      const frameLen = 6 + length + 2;

      if (this._buf.length < frameLen) return; // wait for more data

      const frame = this._buf.slice(0, frameLen);
      this._buf = this._buf.slice(frameLen);

      if (this._checksumOk(frame)) {
        if (msgClass === CLASS_NAV && msgId === ID_NAV_PVT && length === PVT_LENGTH) {
          const payload = frame.slice(6, 6 + length);
          this.emit('nav-pvt', this._decodePvt(payload));
        }
      } else {
        this.emit('checksum-error');
      }
      // loop again in case multiple frames arrived in one chunk
    }
  }

  _checksumOk(frame) {
    let ckA = 0;
    let ckB = 0;
    // checksum covers class, id, length, payload (everything after the 2 sync bytes,
    // up to but not including the checksum bytes)
    for (let i = 2; i < frame.length - 2; i++) {
      ckA = (ckA + frame[i]) & 0xff;
      ckB = (ckB + ckA) & 0xff;
    }
    return ckA === frame[frame.length - 2] && ckB === frame[frame.length - 1];
  }

  _decodePvt(p) {
    const flags = p.readUInt8(21);
    const carrSoln = (flags >> 6) & 0x03; // 0=none 1=float 2=fixed
    return {
      fixType: p.readUInt8(20),          // 0 no fix, 2 2D, 3 3D
      gnssFixOk: !!(flags & 0x01),
      diffSoln: !!(flags & 0x02),        // true as soon as RTCM corrections are being applied
      carrSoln,                          // RTK status
      numSV: p.readUInt8(23),
      lon: p.readInt32LE(24) * 1e-7,     // degrees
      lat: p.readInt32LE(28) * 1e-7,     // degrees
      heightMm: p.readInt32LE(32),
      hAccMm: p.readUInt32LE(40),
      gSpeedMmS: p.readInt32LE(60),      // ground speed
      headMotDeg: p.readInt32LE(64) * 1e-5, // heading of motion
      timestamp: Date.now(),
    };
  }
}

module.exports = { UbxParser, PVT_LENGTH };
