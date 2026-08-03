const dgram = require('dgram');
const { EventEmitter } = require('events');
const protocol = require('./protocol');

// Decode a whole datagram as whichever known frame type it matches - unlike
// radioLink.js's byte-stream scanner, UDP already delivers a whole datagram
// atomically, so there's no buffering/resync to do, just "which shape is
// this." Returns { event, decoded } or null.
function decodeDatagram(msg) {
  const frame = protocol.decode(msg);
  if (frame) return { event: 'frame', decoded: frame };
  const marks = protocol.decodeMarks(msg);
  if (marks) return { event: 'marks', decoded: marks };
  return null;
}

// Stand-in for RadioLink when running in simulation mode (SIMULATE=1): the
// real telemetry radio is "transparent serial" (bytes written on one end
// arrive byte-for-byte on the other), so a UDP socket carrying the same
// protocol.js frames is a reasonable stand-in - it exercises the real
// encode/decode/checksum path without any hardware, and boatAgent/
// baseStation don't need to know the difference from RadioLink.
//
// Both directions actually work both ways: a 'send' radio (boat) also
// listens for replies (e.g. the base's mark broadcasts), and a 'listen'
// radio (base) can send back too - not to one fixed address (it doesn't
// have one), but to every peer address it's actually heard from. That's
// the UDP stand-in for a real radio's broadcast: a real radio's
// transmission inherently reaches every other radio on the network; over
// unicast UDP we have to track who's said hello first instead.
class SimRadioLink extends EventEmitter {
  // mode: 'send' (boat side) or 'listen' (base station side)
  constructor({ mode, host, port, packetLossPct = 0 }) {
    super();
    this.mode = mode;
    this.host = host;
    this.port = port;
    this.packetLossPct = packetLossPct;
    this.peers = new Map(); // "host:port" -> {host, port}, listen mode only
    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', (err) => this.emit('error', err));

    this.socket.on('message', (msg, rinfo) => {
      if (mode === 'listen') this.peers.set(`${rinfo.address}:${rinfo.port}`, { host: rinfo.address, port: rinfo.port });
      const result = decodeDatagram(msg);
      if (result) this.emit(result.event, result.decoded);
      // Same 'sync-error' event as RadioLink, for interface consistency -
      // in practice a whole UDP datagram either arrives intact or not at
      // all over local/LAN UDP, so this essentially never fires here
      // (unlike the real radio's byte-stream framing, which can pick up
      // partial/corrupted frames).
      else this.emit('sync-error');
    });

    if (mode === 'listen') {
      this.socket.bind(this.port);
    } else {
      // Bind to an OS-assigned ephemeral port so replies (e.g. mark
      // broadcasts from the base) have somewhere to land - the 'message'
      // listener above needs to already be active before that can happen,
      // rather than relying on send()'s implicit bind-on-first-send.
      this.socket.bind();

      // A real rover now waits to hear the base's mark broadcast before it
      // starts producing (and therefore sending) any position frames - but
      // the base only broadcasts to peers it's actually heard from, and a
      // boat that's sent nothing yet isn't one. Without this, base and boat
      // would deadlock waiting on each other. A real radio doesn't have
      // this problem (broadcast reaches every radio on the network
      // inherently, no peer discovery needed) - this "hello" is purely UDP
      // simulation plumbing to register this boat's address with the base,
      // not a real protocol frame (an empty datagram fails to decode as
      // either frame type, so it's harmless besides a single 'sync-error'
      // tick on the base's passive signal-quality counter). Repeated, not
      // just sent once, in case the base starts later or restarts mid-race
      // and forgets who it's heard from.
      this._helloInterval = setInterval(() => this.socket.send(Buffer.alloc(0), this.port, this.host), 2000);
      this.socket.send(Buffer.alloc(0), this.port, this.host);
    }
  }

  // Sends to the one configured host:port (boat -> base).
  send(buf) {
    if (this.mode !== 'send') return false;
    if (this.packetLossPct > 0 && Math.random() * 100 < this.packetLossPct) {
      return true; // simulate a frame lost over the air; still "sent" from the caller's perspective
    }
    this.socket.send(buf, this.port, this.host);
    return true;
  }

  // Sends to every peer this radio has heard from (base -> all boats).
  // Returns false (not true-but-lost, since there's no packetLossPct model
  // here) if no boat has said anything yet, so the caller can tell "nobody
  // to broadcast to" apart from "sent OK."
  broadcast(buf) {
    if (this.mode !== 'listen') return false;
    for (const { host, port } of this.peers.values()) this.socket.send(buf, port, host);
    return this.peers.size > 0;
  }
}

module.exports = { SimRadioLink };
