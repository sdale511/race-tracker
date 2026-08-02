const config = require('./config');
const { RadioLink } = require('./radioLink');
const protocol = require('./protocol');

// Standalone bench test for the real telemetry radios - no GPS, no Redis,
// no simulated anything. Uses the exact same RadioLink/protocol.js code
// boatAgent.js and baseStation.js use in production, so a clean result here
// is a real signal about the actual RF link (framing, checksum, range),
// not just "can bytes get through at all". Point two radios at this Mac
// (or one at each end of a real range test) via USB-to-serial adapters and
// run one instance per radio:
//
//   RADIO_TEST_MODE=send   RADIO_PORT=/dev/cu.usbserial-A npm run radio-test
//   RADIO_TEST_MODE=listen RADIO_PORT=/dev/cu.usbserial-B npm run radio-test
//
// `ls /dev/cu.*` before/after plugging in each radio to find its device
// path. RADIO_BAUD must match what's actually configured on both radios
// (9600 for a factory-default XBee SX, see README's "Radio configuration").
// For XBee, also confirm both share the same Network ID (ATID) via XCTU
// first - this test can't get through if they're not paired.
//
// The sequence number is piggybacked on the frame's own timestamp field
// (seq*1000 always lands on a whole second with zero ms remainder, so it
// round-trips cleanly through protocol.js's seconds+ms split) rather than
// needing any protocol.js changes - this is a test-only convention, not a
// real GPS timestamp.

const mode = process.env.RADIO_TEST_MODE;
if (mode !== 'send' && mode !== 'listen') {
  console.error('[radioTest] set RADIO_TEST_MODE=send or RADIO_TEST_MODE=listen');
  process.exit(1);
}

console.log(`[radioTest] ${mode} mode on ${config.radio.port} @ ${config.radio.baud}, boatId=${config.boatId}`);
const radio = new RadioLink({ port: config.radio.port, baud: config.radio.baud });
radio.on('error', (err) => console.error('[radio] error:', err.message));
radio.on('disconnected', () => console.warn('[radio] disconnected, retrying...'));

if (mode === 'send') {
  const intervalMs = parseInt(process.env.RADIO_TEST_INTERVAL_MS || '500', 10);
  let seq = 0;
  console.log(`[radioTest] sending one frame every ${intervalMs}ms - Ctrl+C to stop`);
  setInterval(() => {
    const pvt = {
      timestamp: seq * 1000, // seq number, not a real time - see module comment
      lat: 40.8744,
      lon: -119.2024,
      gSpeedMmS: 5000,
      headMotDeg: 90,
      gnssFixOk: true,
      carrSoln: 2,
      numSV: 14,
    };
    const frame = protocol.encode(config.boatId, pvt);
    const sent = radio.send(frame);
    console.log(`[radioTest] sent seq=${seq}${sent ? '' : ' (port not open - not actually sent)'}`);
    seq++;
  }, intervalMs);
} else {
  let received = 0;
  let missed = 0;
  let syncErrors = 0; // bytes that looked like a frame but failed checksum - see radioLink.js
  let lastSeq = null;
  const startedAt = Date.now();

  radio.on('frame', (decoded) => {
    const seq = decoded.timestamp / 1000;
    received++;
    let note = '';
    if (lastSeq !== null && seq > lastSeq + 1) {
      const gap = seq - lastSeq - 1;
      missed += gap;
      note = ` (missed ${gap})`;
    }
    lastSeq = seq;
    console.log(`[radioTest] received seq=${seq} from boatId=${decoded.boatId} carrSoln=${decoded.carrSoln}${note}`);
  });

  // Distinct from `missed` above: a missed seq means a frame never arrived
  // at all (dropped over the air), while a sync error means bytes arrived
  // but got corrupted in transit (bad checksum) - both matter for judging
  // link quality, but they point at different failure modes.
  radio.on('sync-error', () => syncErrors++);

  setInterval(() => {
    const elapsedS = (Date.now() - startedAt) / 1000;
    const total = received + missed;
    const lossPct = total > 0 ? ((missed / total) * 100).toFixed(1) : '0.0';
    console.log(
      `[radioTest] --- ${received} received, ${missed} missed (${lossPct}% loss), ` +
        `${syncErrors} sync errors, ${elapsedS.toFixed(0)}s elapsed ---`
    );
  }, 10000);
}

process.on('SIGINT', () => {
  console.log('\n[radioTest] shutting down');
  process.exit(0);
});
