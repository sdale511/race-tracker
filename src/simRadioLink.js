const dgram = require('dgram');
const { EventEmitter } = require('events');
const protocol = require('./protocol');

// Stand-in for RadioLink when running in simulation mode (SIMULATE=1): the
// real telemetry radio is "transparent serial" (bytes written on one end
// arrive byte-for-byte on the other), so a UDP socket carrying the same
// protocol.js frames is a reasonable stand-in - it exercises the real
// encode/decode/checksum path without any hardware, and boatAgent/
// baseStation don't need to know the difference from RadioLink.
class SimRadioLink extends EventEmitter {
  // mode: 'send' (boat side) or 'listen' (base station side)
  constructor({ mode, host, port, packetLossPct = 0 }) {
    super();
    this.mode = mode;
    this.host = host;
    this.port = port;
    this.packetLossPct = packetLossPct;
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', (err) => this.emit('error', err));

    if (mode === 'listen') {
      this.socket.on('message', (msg) => {
        const decoded = protocol.decode(msg);
        // Same 'sync-error' event as RadioLink, for interface consistency -
        // in practice a whole UDP datagram either arrives intact or not at
        // all over local/LAN UDP, so this essentially never fires here
        // (unlike the real radio's byte-stream framing, which can pick up
        // partial/corrupted frames).
        if (decoded) this.emit('frame', decoded);
        else this.emit('sync-error');
      });
      this.socket.bind(this.port);
    }
  }

  send(buf) {
    if (this.mode !== 'send') return false;
    if (this.packetLossPct > 0 && Math.random() * 100 < this.packetLossPct) {
      return true; // simulate a frame lost over the air; still "sent" from the caller's perspective
    }
    this.socket.send(buf, this.port, this.host);
    return true;
  }
}

module.exports = { SimRadioLink };
