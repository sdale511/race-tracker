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
    // True once the local serial write buffer has room - see send() below.
    // A fresh SerialPort (initial connect, or any reconnect via _open())
    // always starts with an empty write buffer, so this resets to true
    // there too, not just in the constructor.
    this._writable = true;
    this._open();
  }

  _open() {
    this._writable = true;
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
    // SerialPort is a standard Node Writable stream - 'drain' is the
    // built-in signal that its internal buffer has room again after
    // write() reported it was full (see send() below).
    this.port.on('drain', () => {
      this._writable = true;
    });
  }

  _scheduleReconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true;
    setTimeout(() => {
      this._reconnecting = false;
      this._open();
    }, 3000);
  }

  // Real RF congestion (collisions, a saturated shared channel) doesn't
  // close the serial port - the radio just can't drain what we hand it as
  // fast as we hand it. Checking _writable BEFORE writing (not just
  // write()'s own return value afterward) is what actually matters: without
  // it, every gate-cleared fix keeps getting queued on top of an already-
  // backed-up buffer, so stale data sits ahead of fresh data and gets
  // transmitted first once the radio finally catches up - exactly the wrong
  // priority under congestion. Returning false here instead makes a
  // congested link fail the exact same way a closed port already does, so
  // callers' existing "didn't send, just try again with whatever's current
  // next time" behavior (see boatAgent.js's transmitFix/flushPendingBatch)
  // covers congestion too, not just a literally-disconnected radio.
  send(buf) {
    if (!this.port || !this.port.isOpen) return false;
    if (!this._writable) return false; // still draining a backed-up buffer - don't pile more on top of it
    if (!this.port.write(buf)) this._writable = false; // this write itself filled the buffer - wait for 'drain'
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

  // Five frame types share this one byte stream (position frames,
  // boat->base; mark broadcasts, base->boats; ping requests, base->boats;
  // hello announcements, boat->base; batched position frames, boat->base -
  // see protocol.js's own comment on each) - each with its own sync byte,
  // since a single radio link hears everything broadcast on the network,
  // not just frames addressed to "me". Every type but the batch one has a
  // fixed `len`; the batch frame's length depends on how many fixes it
  // carries, so it supplies `getLen(buf)` instead - see below.
  static FRAME_TYPES = [
    { sync: protocol.SYNC, len: protocol.FRAME_LEN, decode: protocol.decode, event: 'frame' },
    { sync: protocol.MARKS_SYNC, len: protocol.MARKS_FRAME_LEN, decode: protocol.decodeMarks, event: 'marks' },
    { sync: protocol.PING_SYNC, len: protocol.PING_FRAME_LEN, decode: protocol.decodePing, event: 'ping' },
    { sync: protocol.HELLO_SYNC, len: protocol.HELLO_FRAME_LEN, decode: protocol.decodeHello, event: 'hello' },
    { sync: protocol.BATCH_SYNC, getLen: protocol.batchFrameLenFromHeader, decode: protocol.decodeBatch, event: 'frame-batch' },
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

      // Fixed-length types know `len` up front; the batch type has to read
      // a header byte first (getLen returns null if even that isn't in
      // hand yet - wait for more data, same as the plain "wait for the
      // rest of this frame" case below).
      const len = typeof frameType.len === 'number' ? frameType.len : frameType.getLen(this._buf);
      if (len === null || this._buf.length < len) break; // wait for the rest of this frame

      const candidate = this._buf.slice(0, len);
      const decoded = frameType.decode(candidate);
      if (decoded) {
        this.emit(frameType.event, decoded);
        this._buf = this._buf.slice(len);
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
