const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const protocol = require('../src/protocol');
const { RadioLink } = require('../src/radioLink');
const roverDiag = require('../src/roverDiag');
const stats = require('../src/stats');

const { FLAGS, POWER } = roverDiag;

// A RadioLink with no serial port behind it - just the byte-stream scanner
function scanner() {
  const link = Object.create(RadioLink.prototype);
  EventEmitter.call(link);
  link._buf = Buffer.alloc(0);
  return link;
}

test('status hello: round trip, and a corrupt one is rejected', () => {
  const buf = protocol.encodeStatusHello({ boatId: '0MM9N', flags: FLAGS.GPS_NO_UBX | FLAGS.NO_BURSTS, power: POWER.UNDERVOLT_SINCE_BOOT, numSV: 0, fixType: null, build: 290, dirty: true });
  assert.strictEqual(buf.length, protocol.STATUS_HELLO_FRAME_LEN);
  assert.deepStrictEqual(protocol.decodeStatusHello(buf), {
    boatId: '0MM9N',
    diag: { flags: FLAGS.GPS_NO_UBX | FLAGS.NO_BURSTS, power: POWER.UNDERVOLT_SINCE_BOOT, numSV: 0, fixType: null, carrSoln: 0, build: 290, dirty: true },
  });
  const withFix = protocol.decodeStatusHello(protocol.encodeStatusHello({ boatId: '0MM9N', numSV: 28, fixType: 3, carrSoln: 1, build: 0 }));
  assert.strictEqual(withFix.diag.fixType, 3);
  assert.strictEqual(withFix.diag.carrSoln, 1);
  assert.strictEqual(withFix.diag.build, null, 'build 0 means the rover could not tell');
  const bad = Buffer.from(buf);
  bad[6] ^= 0xff;
  assert.strictEqual(protocol.decodeStatusHello(bad), null);
});

test('the radio scanner hands both the plain and the status hello on as a hello', () => {
  const link = scanner();
  const heard = [];
  link.on('hello', (h) => heard.push(h));
  link._onData(Buffer.concat([protocol.encodeHello('OLD01'), protocol.encodeStatusHello({ boatId: 'NEW01', flags: FLAGS.NO_BASE_RX, build: 5 })]));
  assert.strictEqual(heard.length, 2);
  assert.deepStrictEqual(heard[0], { boatId: 'OLD01' });
  assert.strictEqual(heard[1].boatId, 'NEW01');
  assert.strictEqual(heard[1].diag.flags, FLAGS.NO_BASE_RX);
});

const T = 1_000_000;
const healthy = {
  since: T - 60_000,
  gpsReal: true,
  gpsAsleep: false,
  gpsPortOpen: true,
  lastGpsBytesAt: T,
  lastUbxAt: T,
  lastPvtAt: T,
  lastRxmRtcmAt: T - 2000,
  watchBursts: true,
  burstsHeard: true,
  lastBaseRxAt: T - 5000,
};

test('a healthy rover reports nothing', () => {
  assert.strictEqual(roverDiag.computeFlags(healthy, T), 0);
});

test('the GPS link reports only the first stage that fails', () => {
  assert.strictEqual(roverDiag.computeFlags({ ...healthy, gpsPortOpen: false }, T), FLAGS.GPS_PORT_CLOSED);
  assert.strictEqual(roverDiag.computeFlags({ ...healthy, lastGpsBytesAt: T - 10_000, lastUbxAt: null, lastPvtAt: null }, T), FLAGS.GPS_NO_DATA);
  // bytes, but at the wrong baud: nothing parses
  assert.strictEqual(roverDiag.computeFlags({ ...healthy, lastUbxAt: null, lastPvtAt: null, lastRxmRtcmAt: null }, T), FLAGS.GPS_NO_UBX);
  assert.strictEqual(roverDiag.computeFlags({ ...healthy, lastPvtAt: T - 10_000 }, T), FLAGS.GPS_NO_PVT);
});

test('nothing is missing until it has had time to arrive', () => {
  const justStarted = { ...healthy, since: T - 1000, lastGpsBytesAt: null, lastUbxAt: null, lastPvtAt: null, lastRxmRtcmAt: null, burstsHeard: false, lastBaseRxAt: null };
  assert.strictEqual(roverDiag.computeFlags(justStarted, T), 0);
});

test('corrections: none heard, or heard but not reaching the receiver', () => {
  assert.strictEqual(roverDiag.computeFlags({ ...healthy, burstsHeard: false }, T), FLAGS.NO_BURSTS);
  assert.strictEqual(roverDiag.computeFlags({ ...healthy, burstsHeard: false, watchBursts: false }, T), 0, 'a rover with a separate correction radio');
  assert.strictEqual(roverDiag.computeFlags({ ...healthy, lastRxmRtcmAt: T - 30_000 }, T), FLAGS.RTCM_NOT_REACHING_GPS);
  // with the GPS link down there's no RXM-RTCM to miss - the GPS flag says why
  assert.strictEqual(roverDiag.computeFlags({ ...healthy, gpsPortOpen: false, lastRxmRtcmAt: null }, T), FLAGS.GPS_PORT_CLOSED);
});

test('a simulated or sleeping GPS is not reported as broken', () => {
  const dead = { lastGpsBytesAt: null, lastUbxAt: null, lastPvtAt: null, lastRxmRtcmAt: null, gpsPortOpen: false };
  assert.strictEqual(roverDiag.computeFlags({ ...healthy, ...dead, gpsReal: false }, T), 0);
  assert.strictEqual(roverDiag.computeFlags({ ...healthy, ...dead, gpsAsleep: true }, T), 0);
});

test('one-way radio: the base is not heard for 2.5 minutes', () => {
  assert.strictEqual(roverDiag.computeFlags({ ...healthy, lastBaseRxAt: T - 200_000 }, T), FLAGS.NO_BASE_RX);
  assert.strictEqual(roverDiag.computeFlags({ ...healthy, since: T - 200_000, lastBaseRxAt: null }, T), FLAGS.NO_BASE_RX);
});

test('power bits come from the Pi\'s get_throttled value', () => {
  assert.strictEqual(roverDiag.powerFromThrottled(0x50005), POWER.UNDERVOLT_NOW | POWER.UNDERVOLT_SINCE_BOOT | POWER.THROTTLED_NOW | POWER.THROTTLED_SINCE_BOOT);
  assert.strictEqual(roverDiag.powerFromThrottled(0x10000), POWER.UNDERVOLT_SINCE_BOOT);
  assert.strictEqual(roverDiag.readPower({ readFile: () => '0x10000\n' }), POWER.UNDERVOLT_SINCE_BOOT);
  const notAPi = () => {
    throw new Error('ENOENT');
  };
  assert.strictEqual(roverDiag.readPower({ readFile: notAPi, run: notAPi }), 0);
  assert.strictEqual(roverDiag.readPower({ readFile: notAPi, run: () => 'throttled=0x1\n' }), POWER.UNDERVOLT_NOW);
});

test('describe: worst first, satellites, power and an out-of-date build', () => {
  const items = roverDiag.describe({ flags: FLAGS.NO_BURSTS | FLAGS.GPS_NO_UBX, power: POWER.UNDERVOLT_SINCE_BOOT, numSV: 0, fixType: null, build: 288, dirty: false }, { baseBuild: 290 });
  assert.deepStrictEqual(
    items.map((i) => [i.level, i.text]),
    [
      ['bad', 'GPS wrong baud?'],
      ['warn', 'no corrections heard'],
      ['warn', 'under-voltage since boot'],
      ['warn', 'build 288 (behind)'],
    ]
  );
  assert.deepStrictEqual(roverDiag.describe({ flags: 0, power: 0, numSV: 0, fixType: 0, build: null }).map((i) => i.text), ['no satellites']);
  assert.deepStrictEqual(roverDiag.describe({ flags: 0, power: 0, numSV: 7, fixType: 0, build: null }).map((i) => i.text), ['no fix yet, 7 sv']);
  assert.deepStrictEqual(roverDiag.describe({ flags: 0, power: 0, numSV: 7, fixType: 0, build: null }, { hasPosition: true }), []);
});

test('problemKey changes when a problem starts or clears, not with the satellite count', () => {
  const base = { flags: 0, power: 0, numSV: 12, fixType: 3 };
  assert.strictEqual(roverDiag.problemKey(base), roverDiag.problemKey({ ...base, numSV: 20 }));
  assert.notStrictEqual(roverDiag.problemKey(base), roverDiag.problemKey({ ...base, flags: FLAGS.NO_BURSTS }));
  assert.notStrictEqual(roverDiag.problemKey(base), roverDiag.problemKey({ ...base, numSV: 0 }));
  assert.strictEqual(roverDiag.hasProblem(base), false);
  assert.strictEqual(roverDiag.hasProblem({ ...base, numSV: 0 }), true);
});

test('the base keeps a rover\'s report for 3 minutes', () => {
  const t0 = Date.now();
  stats.recordRoverDiag('DIAG1', { flags: FLAGS.NO_BURSTS, power: 0, numSV: 9, fixType: 3, carrSoln: 0, build: 290, dirty: false }, t0);
  stats.recordFrame('DIAG1', null, null);
  assert.strictEqual(stats.snapshot(t0 + 1000).boats.DIAG1.diag.flags, FLAGS.NO_BURSTS);
  assert.strictEqual(stats.snapshot(t0 + 4 * 60 * 1000).boats.DIAG1.diag, null);
});
