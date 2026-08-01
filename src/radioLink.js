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

  // Used on the base station side: scans incoming bytes for valid frames.
  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    while (this._buf.length >= protocol.FRAME_LEN) {
      const syncIdx = this._buf.indexOf(protocol.SYNC);
      if (syncIdx === -1) {
        this._buf = Buffer.alloc(0);
        break;
      }
      if (syncIdx > 0) this._buf = this._buf.slice(syncIdx);
      if (this._buf.length < protocol.FRAME_LEN) break;

      const candidate = this._buf.slice(0, protocol.FRAME_LEN);
      const decoded = protocol.decode(candidate);
      if (decoded) {
        this.emit('frame', decoded);
        this._buf = this._buf.slice(protocol.FRAME_LEN);
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
