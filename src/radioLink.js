const { SerialPort } = require('serialport');
const { EventEmitter } = require('events');
const protocol = require('./protocol');

// Wraps the telemetry radio's UART. Assumes a transparent-serial radio
// (RFD900x/SiK-style): bytes written here are transmitted over the air and
// arrive byte-for-byte at the matching radio on the other end. No radio-
// specific framing needed on our side; we handle framing at the app layer
// with protocol.js.
class RadioLink extends EventEmitter {
  constructor({ port, baud }) {
    super();
    this.portPath = port;
    this.baud = baud;
    this._buf = Buffer.alloc(0);
    this._open();
  }

  _open() {
    this.port = new SerialPort({ path: this.portPath, baudRate: this.baud }, (err) => {
      if (err) {
        this.emit('error', err);
        this._scheduleReconnect();
      }
    });

    // Standard serialport event, fired once the port has actually opened
    // successfully - distinct from the constructor callback above, which
    // only ever fires on the *error* path. Lets a caller (see
    // baseStation.js's dashboard connection-status tracking) tell "opened
    // fine" apart from "still trying" without polling anything.
    this.port.on('open', () => this.emit('connected'));
    this.port.on('data', (chunk) => this._onData(chunk));
    this.port.on('close', () => {
      this.emit('disconnected');
      this._scheduleReconnect();
    });
    this.port.on('error', (err) => this.emit('error', err));
  }

  _scheduleReconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true;
    setTimeout(() => {
      this._reconnecting = false;
      this._open();
    }, 3000);
  }

  send(buf) {
    if (!this.port || !this.port.isOpen) return false;
    this.port.write(buf);
    return true;
  }

  // A real radio's transmission already reaches every other radio on the
  // network - that's what "broadcast" means at this layer (see the class
  // comment) - so this is just send() under another name. It exists so
  // call sites (e.g. baseStation.js's mark broadcast) can use the same
  // method name on either a real RadioLink or a SimRadioLink, where send()
  // and broadcast() are genuinely different operations (see simRadioLink.js).
  broadcast(buf) {
    return this.send(buf);
  }

  // Three frame types share this one byte stream (position frames,
  // boat->base; mark broadcasts, base->boats; ping requests, base->boats -
  // see protocol.js's own comment) - each with its own sync byte and
  // length, since a single radio link hears everything broadcast on the
  // network, not just frames addressed to "me".
  static FRAME_TYPES = [
    { sync: protocol.SYNC, len: protocol.FRAME_LEN, decode: protocol.decode, event: 'frame' },
    { sync: protocol.MARKS_SYNC, len: protocol.MARKS_FRAME_LEN, decode: protocol.decodeMarks, event: 'marks' },
    { sync: protocol.PING_SYNC, len: protocol.PING_FRAME_LEN, decode: protocol.decodePing, event: 'ping' },
  ];

  // Used on both ends: scans incoming bytes for valid frames of either type.
  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    while (this._buf.length > 0) {
      // Whichever known sync byte appears earliest decides which frame type
      // we're expecting next.
      let syncIdx = -1;
      let frameType = null;
      for (const type of RadioLink.FRAME_TYPES) {
        const idx = this._buf.indexOf(type.sync);
        if (idx !== -1 && (syncIdx === -1 || idx < syncIdx)) {
          syncIdx = idx;
          frameType = type;
        }
      }
      if (syncIdx === -1) {
        this._buf = Buffer.alloc(0);
        break;
      }
      if (syncIdx > 0) this._buf = this._buf.slice(syncIdx);
      if (this._buf.length < frameType.len) break; // wait for the rest of this frame

      const candidate = this._buf.slice(0, frameType.len);
      const decoded = frameType.decode(candidate);
      if (decoded) {
        this.emit(frameType.event, decoded);
        this._buf = this._buf.slice(frameType.len);
      } else {
        // Bad checksum/false sync match - drop one byte and resync. Emitted
        // as its own event (not just silently dropped) since a rising rate
        // of these is a real, passive signal-quality indicator: a
        // corrupted-but-still-sync-byte-shaped frame here usually means bit
        // errors from a degrading RF link, without needing to interrupt the
        // data stream to query the radio directly for RSSI.
        this.emit('sync-error');
        this._buf = this._buf.slice(1);
      }
    }
  }
}

module.exports = { RadioLink };
