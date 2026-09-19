const dgram = require('dgram');
const { EventEmitter } = require('events');
const protocol = require('./protocol');

const BROADCAST_ADDR = '255.255.255.255';

// Decode a whole datagram as whichever known frame type it matches - unlike
// radioLink.js's byte-stream scanner, UDP already delivers a whole datagram
// atomically, so there's no buffering/resync to do, just "which shape is
// this." Returns { event, decoded } or null.
function decodeDatagram(msg) {
  const frame = protocol.decode(msg);
  if (frame) return { event: 'frame', decoded: frame };
  const marks = protocol.decodeMarks(msg);
  if (marks) return { event: 'marks', decoded: marks };
  const ping = protocol.decodePing(msg);
  if (ping) return { event: 'ping', decoded: ping };
  const hello = protocol.decodeHello(msg);
  if (hello) return { event: 'hello', decoded: hello };
  const batch = protocol.decodeBatch(msg);
  if (batch) return { event: 'frame-batch', decoded: batch };
  return null;
}

// Stand-in for RadioLink when running in simulation mode (SIMULATE=1):
// mirrors what the real telemetry radio actually does - every transmission
// is broadcast, every radio on the shared channel hears every other one,
// with no per-node addressing or discovery at this layer at all (boatId
// lives in the application-level frame payload, same as on real hardware -
// see protocol.js). A shared UDP broadcast socket is the natural stand-in
// for that: `reuseAddr` lets every simulated boat and the base - even
// several boats on one machine - bind the identical port and each get
// their own copy of every broadcast, and it works the same way across a
// real LAN as it does on localhost, no per-boat host/port bookkeeping
// needed anywhere (earlier versions of this tracked peer addresses and
// unicast individually to each one - that broke down as soon as boat and
// base were on different machines, since it depended on guessing the right
// host up front; broadcast doesn't have that problem).
class SimRadioLink extends EventEmitter {
  constructor({ port, packetLossPct = 0 }) {
    super();
    this.port = port;
    this.packetLossPct = packetLossPct;
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('error', (err) => this.emit('error', err));

    this.socket.on('message', (msg) => {
      const result = decodeDatagram(msg);
      if (result) this.emit(result.event, result.decoded);
      // Same 'sync-error' event as RadioLink, for interface consistency -
      // in practice a whole UDP datagram either arrives intact or not at
      // all over local/LAN UDP, so this essentially never fires here
      // (unlike the real radio's byte-stream framing, which can pick up
      // partial/corrupted frames).
      else this.emit('sync-error');
    });

    // Same 'connected' event RadioLink emits once its serial port actually
    // opens (see radioLink.js) - lets callers (see boatAgent.js's startup
    // marks-ping) wait for the socket to genuinely be ready to send,
    // rather than racing ahead of bind()'s own async completion. Sending
    // to the broadcast address before setBroadcast(true) has actually run
    // can silently fail depending on the OS - bind() and its callback
    // aren't synchronous with the constructor returning.
    this.socket.bind(this.port, () => {
      this.socket.setBroadcast(true);
      this.emit('connected');
    });
  }

  send(buf) {
    if (this.packetLossPct > 0 && Math.random() * 100 < this.packetLossPct) {
      return true; // simulate a frame lost over the air; still "sent" from the caller's perspective
    }
    this.socket.send(buf, this.port, BROADCAST_ADDR);
    return true;
  }

  // A real radio's transmission already reaches every other radio on the
  // network - this is just send() under another name, so call sites (e.g.
  // baseStation.js's mark broadcast) can use the same method name
  // regardless of whether they're talking to a real RadioLink or this.
  broadcast(buf) {
    return this.send(buf);
  }
}

module.exports = { SimRadioLink };
