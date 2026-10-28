const dgram = require('dgram');
const os = require('os');

// Lets a base viewer (baseViewer.js) find a running base on the local network without being told its address. The viewer
// broadcasts a small UDP probe; every base that hears it answers the sender directly with who it is and where its admin
// dashboard lives. The viewer takes the address from the packet's source, so the answer is the address that actually
// reached it (not whichever of the base's interfaces it thinks is primary). Broadcasts stay on the local network
// segment - across a router or a VPN, give the viewer the base's address instead.

const SERVICE = 'race-tracker-base';
const PROBE = JSON.stringify({ probe: SERVICE, v: 1 });
// A reply is bigger than the probe that asks for it, so a spoofed probe could be used to bounce traffic at someone; this
// caps what a base will send in any one second.
const MAX_REPLIES_PER_SECOND = 10;

// Every IPv4 broadcast address this machine can send to: the directed broadcast of each external interface (so a
// machine on both WiFi and ethernet probes both), plus the limited broadcast 255.255.255.255 the OS routes itself.
function broadcastTargets(interfaces = os.networkInterfaces(), limited = '255.255.255.255') {
  const targets = new Set([limited]);
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal || !addr.netmask) continue;
      const ip = addr.address.split('.').map(Number);
      const mask = addr.netmask.split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4) continue;
      targets.add(ip.map((octet, i) => (octet | (~mask[i] & 255)) & 255).join('.'));
    }
  }
  return [...targets];
}

function isProbe(buf) {
  try {
    const msg = JSON.parse(buf.toString('utf8'));
    return !!msg && msg.probe === SERVICE;
  } catch (err) {
    return false;
  }
}

// The base's side: listens on `port` and answers every probe with getInfo() - { host, version, adminPort, regatta } -
// sent straight back to whoever asked. Resolves to { socket, port } once bound; rejects if the port can't be bound.
// `address` is only for tests (bind to loopback).
function startResponder({ port, getInfo, address, now = Date.now }) {
  return new Promise((resolve, reject) => {
    // reuseAddr: a second base (or the viewer, on the same machine) can bind the port as well and still hears the probe.
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let windowStart = 0;
    let sentInWindow = 0;
    socket.on('message', (buf, rinfo) => {
      if (!isProbe(buf)) return;
      const t = now();
      if (t - windowStart >= 1000) {
        windowStart = t;
        sentInWindow = 0;
      }
      if (sentInWindow >= MAX_REPLIES_PER_SECOND) return;
      sentInWindow++;
      let info;
      try {
        info = getInfo();
      } catch (err) {
        return;
      }
      socket.send(JSON.stringify({ service: SERVICE, v: 1, ...info }), rinfo.port, rinfo.address, () => {});
    });
    socket.once('error', reject);
    socket.bind(port, address, () => {
      socket.removeListener('error', reject);
      // A later socket error (the interface going away) must not take the base down; discovery just stops answering.
      socket.on('error', () => {});
      resolve({ socket, port: socket.address().port });
    });
  });
}

// One reply -> { host, version, regatta, adminPort, address, url }, or null when it isn't a base's answer.
function parseReply(buf, address) {
  let msg;
  try {
    msg = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    return null;
  }
  if (!msg || msg.service !== SERVICE || !Number.isInteger(msg.adminPort) || msg.adminPort < 1 || msg.adminPort > 65535) return null;
  return {
    host: typeof msg.host === 'string' ? msg.host : null,
    version: typeof msg.version === 'string' ? msg.version : null,
    regatta: typeof msg.regatta === 'string' ? msg.regatta : null,
    adminPort: msg.adminPort,
    address,
    url: `http://${address}:${msg.adminPort}`,
  };
}

// The viewer's side: broadcasts a probe to each of `targets` on `port` (again every `intervalMs`, since a single UDP
// datagram can be lost) and collects the distinct bases that answer within `timeoutMs`. Resolves to an array, empty when
// none did - never rejects, so an unusable network just looks like "no base found".
function discover({ port, targets = broadcastTargets(), timeoutMs = 2000, intervalMs = 500 } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let timer = null;
    let ticker = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(ticker);
      try {
        socket.close();
      } catch (err) {
        // never opened
      }
      resolve([...found.values()]);
    };
    const probe = () => {
      for (const target of targets) socket.send(PROBE, port, target, () => {});
    };
    socket.on('error', finish);
    socket.on('message', (buf, rinfo) => {
      const base = parseReply(buf, rinfo.address);
      if (base) found.set(base.url, base);
    });
    // Bound to an ephemeral port: the replies come back to wherever the probe came from.
    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
      } catch (err) {
        return finish();
      }
      probe();
      ticker = setInterval(probe, intervalMs);
      timer = setTimeout(finish, timeoutMs);
    });
  });
}

module.exports = { SERVICE, broadcastTargets, startResponder, discover, parseReply };
