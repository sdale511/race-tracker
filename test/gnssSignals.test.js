const test = require('node:test');
const assert = require('node:assert');
const { UbxParser, encodePollRequest, CLASS_NAV, ID_NAV_SIG } = require('../src/ubxParser');
const { summarizeSignals } = require('../src/gnssSignals');
const { renderGpsSignalsCard } = require('../src/roverAdminServer');

const GPS = 0;
const GALILEO = 2;
const L1CA = 0;
const L2CL = 3;
const E1C = 0;
const E1B = 1;
const E5BI = 5;
const LOCKED = 7;

const sig = (gnssId, svId, sigId, cno, qualityInd = LOCKED) => ({ gnssId, svId, sigId, cno, qualityInd });

// count GPS satellites, each heard on L1 at l1Cno and on L2 at l2Cno
function gpsSats(count, l1Cno, l2Cno) {
  const out = [];
  for (let sv = 1; sv <= count; sv++) {
    out.push(sig(GPS, sv, L1CA, l1Cno));
    if (l2Cno != null) out.push(sig(GPS, sv, L2CL, l2Cno));
  }
  return out;
}

function navSigFrame(signals, { claimCount = signals.length } = {}) {
  const payload = Buffer.alloc(8 + signals.length * 16);
  payload.writeUInt8(claimCount, 5);
  signals.forEach((s, i) => {
    const at = 8 + i * 16;
    payload.writeUInt8(s.gnssId, at);
    payload.writeUInt8(s.svId, at + 1);
    payload.writeUInt8(s.sigId, at + 2);
    payload.writeUInt8(s.cno, at + 6);
    payload.writeUInt8(s.qualityInd, at + 7);
  });
  const body = Buffer.concat([Buffer.from([CLASS_NAV, ID_NAV_SIG, payload.length & 0xff, payload.length >> 8]), payload]);
  let ckA = 0;
  let ckB = 0;
  for (const byte of body) {
    ckA = (ckA + byte) & 0xff;
    ckB = (ckB + ckA) & 0xff;
  }
  return Buffer.concat([Buffer.from([0xb5, 0x62]), body, Buffer.from([ckA, ckB])]);
}

function parse(frame) {
  const parser = new UbxParser();
  const seen = [];
  parser.on('nav-sig', (signals) => seen.push(signals));
  parser.write(frame);
  return seen;
}

test('the NAV-SIG poll is the exact frame the receiver expects', () => {
  assert.strictEqual(encodePollRequest(CLASS_NAV, ID_NAV_SIG).toString('hex'), 'b5620143000044cd');
});

test('the parser decodes each signal from a NAV-SIG', () => {
  const signals = [sig(GPS, 5, L1CA, 44), sig(GALILEO, 12, E5BI, 38, 4)];
  assert.deepStrictEqual(parse(navSigFrame(signals)), [signals]);
});

test('the parser ignores a NAV-SIG whose count disagrees with its length', () => {
  assert.deepStrictEqual(parse(navSigFrame([sig(GPS, 5, L1CA, 44)], { claimCount: 2 })), []);
});

test('both bands strong: ok, with the gap measured', () => {
  const s = summarizeSignals(gpsSats(6, 44, 38));
  assert.strictEqual(s.verdict, 'ok');
  assert.deepStrictEqual(s.l1, { sats: 6, meanCno: 44 });
  assert.deepStrictEqual(s.l2, { sats: 6, meanCno: 38 });
  assert.strictEqual(s.bothBands, 6);
  assert.strictEqual(s.gapDb, 6);
  assert.deepStrictEqual(s.constellations.map((c) => c.name), ['GPS']);
});

test('no L2 anywhere: l1-only', () => {
  const s = summarizeSignals(gpsSats(8, 44, null));
  assert.strictEqual(s.verdict, 'l1-only');
  assert.strictEqual(s.gapDb, null);
});

test('L2 far below L1, faint, or on few satellites: weak-l2', () => {
  assert.strictEqual(summarizeSignals(gpsSats(6, 46, 34)).verdict, 'weak-l2', 'gap over 10 dB');
  assert.strictEqual(summarizeSignals(gpsSats(6, 34, 28)).verdict, 'weak-l2', 'faint');
  const fewL2 = [...gpsSats(3, 44, 38), ...gpsSats(6, 44, null).slice(3)];
  assert.strictEqual(summarizeSignals(fewL2).verdict, 'weak-l2', 'few satellites');
});

test('too few satellites says nothing about the antenna', () => {
  assert.strictEqual(summarizeSignals([]).verdict, 'too-few');
  assert.strictEqual(summarizeSignals(gpsSats(3, 44, null)).verdict, 'too-few');
});

test('a satellite counts once per band, at its strongest signal', () => {
  const signals = [sig(GALILEO, 7, E1C, 40), sig(GALILEO, 7, E1B, 42)];
  assert.deepStrictEqual(summarizeSignals(signals).l1, { sats: 1, meanCno: 42 });
});

test('signals the receiver has not locked, and SBAS, are not counted', () => {
  const signals = [sig(GPS, 1, L1CA, 40, 3), sig(GPS, 2, L1CA, 0), sig(1, 133, 0, 40)];
  assert.strictEqual(summarizeSignals(signals).l1.sats, 0);
});

test('the gap ignores satellites heard on only one band', () => {
  const s = summarizeSignals([...gpsSats(5, 40, 35), sig(GPS, 20, L1CA, 20)]);
  assert.strictEqual(s.bothBands, 5);
  assert.strictEqual(s.gapDb, 5);
});

test('card: no real receiver renders nothing', () => {
  assert.strictEqual(renderGpsSignalsCard(null), '');
});

test('card: shows the verdict and per-band figures from a fresh answer', () => {
  const html = renderGpsSignalsCard({ asleep: false, requestedAt: Date.now(), receivedAt: Date.now(), summary: summarizeSignals(gpsSats(6, 44, 38)) });
  assert.match(html, /L1 \+ L2/);
  assert.match(html, /6 sats, 44 dB-Hz/);
  assert.match(html, /6 sats, 38 dB-Hz/);
  assert.match(html, /6\.0 dB on 6 sats/);
});

test('card: a sleeping GPS, a pending question and silence each say so', () => {
  const now = Date.now();
  assert.match(renderGpsSignalsCard({ asleep: true, requestedAt: null, receivedAt: null, summary: null }), /GPS asleep/);
  assert.match(renderGpsSignalsCard({ asleep: false, requestedAt: now, receivedAt: null, summary: null }), /asking/);
  assert.match(renderGpsSignalsCard({ asleep: false, requestedAt: now - 5000, receivedAt: null, summary: null }), /no reply/);
});

test('card: an old answer is not shown as current', () => {
  const summary = summarizeSignals(gpsSats(6, 44, 38));
  const html = renderGpsSignalsCard({ asleep: false, requestedAt: Date.now() - 5000, receivedAt: Date.now() - 60000, summary });
  assert.match(html, /no reply/);
  assert.doesNotMatch(html, /L1 \+ L2/);
});
