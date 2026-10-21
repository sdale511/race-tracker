// A few XBee AT commands over the radio's own UART, for the one setting the boat writes itself: its node identifier
// (NI), set to the boat id so a radio pulled from a boat (or listed by XCTU's network discovery) says which boat it
// belongs to. Everything else on the radio is configured from a computer with xbee_configure_at.py.
//
// Command mode is entered with "+++" surrounded by the module's guard time (GT, 1 s by default) of silence on the
// UART - the same steps xbee_configure_at.py takes. While in command mode the radio sends nothing over the air, so
// the caller must not write telemetry bytes until this resolves (RadioLink holds its sends).
//
// `io` is { write(string), onData(cb) -> unsubscribe }, so this can run on RadioLink's open port (and in tests, a fake).

const GUARD_MS = 1100; // must exceed the module's guard time (GT, 1000 ms by default)
const RESPONSE_TIMEOUT_MS = 2000;
// NI: up to 20 printable ASCII characters (Digi's limit)
const NI_MAX_LEN = 20;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Collects what the radio sends until a reply line ending in "\r" has arrived (or the timeout), and resolves the last
// printable line, or null on a timeout. `until` (optional) is a string the reply must contain before it counts - for
// the "OK" after +++, since until command mode starts the radio is still passing on frames from the air, whose binary
// bytes can include a "\r".
function readReply(io, timeoutMs, until = null) {
  return new Promise((resolve) => {
    let buf = '';
    const done = (text) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(text);
    };
    const unsubscribe = io.onData((chunk) => {
      buf += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : String(chunk);
      if (until ? buf.includes(until) : buf.includes('\r')) {
        const lines = buf.split('\r').map((l) => l.replace(/[^\x20-\x7e]/g, '').trim()).filter(Boolean);
        done(until ? until.trim() : lines.length > 0 ? lines[lines.length - 1] : '');
      }
    });
    const timer = setTimeout(() => done(null), timeoutMs);
  });
}

async function command(io, cmd, timeoutMs) {
  const reply = readReply(io, timeoutMs);
  io.write(`${cmd}\r`);
  return reply;
}

// Sets the radio's NI to `ni` if it isn't already. Resolves { ok: true, previous, changed } or
// { ok: false, error }; never rejects. Saves (ATWR) only on a change, so a boot with the right name writes no flash.
async function setNodeIdentifier(io, ni, { guardMs = GUARD_MS, timeoutMs = RESPONSE_TIMEOUT_MS } = {}) {
  const wanted = String(ni);
  if (!/^[\x20-\x7e]+$/.test(wanted) || wanted.length > NI_MAX_LEN) {
    return { ok: false, error: `"${wanted}" is not a valid node identifier (1-${NI_MAX_LEN} printable characters)` };
  }
  await sleep(guardMs);
  const ok = readReply(io, timeoutMs, 'OK\r');
  io.write('+++');
  if ((await ok) !== 'OK') {
    return { ok: false, error: 'no "OK" after +++ (not an XBee in transparent mode, or the wrong baud?)' };
  }
  try {
    const previous = await command(io, 'ATNI', timeoutMs);
    if (previous === null) return { ok: false, error: 'no reply to ATNI' };
    if (previous === wanted) return { ok: true, previous, changed: false };
    if ((await command(io, `ATNI${wanted}`, timeoutMs)) !== 'OK') return { ok: false, error: `ATNI${wanted} was not accepted` };
    if ((await command(io, 'ATWR', timeoutMs)) !== 'OK') return { ok: false, error: 'ATWR (save) was not accepted' };
    return { ok: true, previous, changed: true };
  } finally {
    // Always leave command mode (it would also time out on its own after CT, 10 s by default)
    await command(io, 'ATCN', timeoutMs);
  }
}

module.exports = { setNodeIdentifier, NI_MAX_LEN };
