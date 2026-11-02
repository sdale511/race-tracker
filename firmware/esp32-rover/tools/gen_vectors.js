#!/usr/bin/env node
// Writes test/vectors/node_vectors.h: what the Node code (src/protocol.js, radioLink.js, ubxParser.js, burstTracker.js, txGate.js,
// slotTable.js, thinFixes.js, course.js) produces for a fixed set of inputs. The C++ host tests (test/test_core) feed lib/rover_core
// the same inputs and require the same outputs, which is what keeps the ESP32 rover and the Node rover on one wire format.
//
//   node firmware/esp32-rover/tools/gen_vectors.js           regenerate (after changing any of those files)
//   node firmware/esp32-rover/tools/gen_vectors.js --check   exit 1 if the checked-in header is out of date (test/firmwareVectors.test.js)

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const src = path.join(__dirname, '..', '..', '..', 'src');
const protocol = require(path.join(src, 'protocol'));
const { RadioLink } = require(path.join(src, 'radioLink'));
const { UbxParser, encodeNavPvt, encodePmreq, encodePollRequest } = require(path.join(src, 'ubxParser'));
const { BurstTracker } = require(path.join(src, 'burstTracker'));
const { TxGate } = require(path.join(src, 'txGate'));
const { autoSlotCount, JoinBackoff } = require(path.join(src, 'slotTable'));
const { thinForTurns, thinBackfill } = require(path.join(src, 'thinFixes'));
const { distanceMeters, distanceToSegmentM } = require(path.join(src, 'course'));
const roverDiag = require(path.join(src, 'roverDiag'));

const OUT = path.join(__dirname, '..', 'test', 'vectors', 'node_vectors.h');

// encodePing stamps the time: pin it, so the header comes out the same on every run (--check compares it byte for byte)
Date.now = () => 1793638800000;

// ---- deterministic inputs ----

let seed = 12345;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const BOAT = 'QXZRA';

// fixes chosen to hit the rounding edges: negative coordinates, a heading just under 360, a speed that rounds on .5, no fix
const PVTS = [
  { timestamp: 1793638793123, lat: 40.7891234, lon: -119.2034567, gSpeedMmS: 5144, headMotDeg: 12.34, gnssFixOk: true, carrSoln: 2, numSV: 28 },
  { timestamp: 1793638793223, lat: -33.86785, lon: 151.20732, gSpeedMmS: 0, headMotDeg: 359.97, gnssFixOk: true, carrSoln: 1, numSV: 40 },
  { timestamp: 1793638793999, lat: 0.00000005, lon: -0.00000005, gSpeedMmS: 2572, headMotDeg: -10, gnssFixOk: false, carrSoln: 0, numSV: 3 },
  { timestamp: 1700000000000, lat: 40.78912345, lon: -119.20345675, gSpeedMmS: 40000000, headMotDeg: 720.05, gnssFixOk: true, carrSoln: 3, numSV: 5 },
  { timestamp: 1793638794000, lat: 89.9999999, lon: -179.9999999, gSpeedMmS: 25720, headMotDeg: 180, gnssFixOk: true, carrSoln: 2, numSV: 31 },
];

// a boat sailing: 10 Hz, a tack in the middle, then a GPS jump and a gap - so delta frames split the ways they can
function track() {
  const fixes = [];
  let lat = 40.7864, lon = -119.2066, head = 45, t = 1793638800000;
  for (let i = 0; i < 40; i++) {
    if (i === 15) head = 315; // a tack
    if (i === 25) lat += 0.01; // a jump the int16 delta cannot carry
    if (i === 32) t += 700; // a gap over 510 ms
    const speedMmS = 3000 + Math.round(rand() * 400);
    lat += Math.cos((head * Math.PI) / 180) * 0.0000027;
    lon += Math.sin((head * Math.PI) / 180) * 0.0000035;
    fixes.push({ timestamp: t, lat: Math.round(lat * 1e9) / 1e9, lon: Math.round(lon * 1e9) / 1e9, gSpeedMmS: speedMmS, headMotDeg: head + rand() * 4 - 2, gnssFixOk: true, carrSoln: 2, numSV: 30 });
    t += 100 + Math.round(rand() * 6);
  }
  return fixes;
}
const TRACK = track();

const MARKS = {
  windwardGreen: { lat: 40.79, lon: -119.2 },
  windwardBlack: { lat: 40.7912, lon: -119.2005 },
  leewardGreen: { lat: 40.7801, lon: -119.2101 },
  leewardBlack: { lat: 40.7799, lon: -119.2111 },
  pin: { lat: 40.7805, lon: -119.205 },
  committeeStart: { lat: 40.7806, lon: -119.2035 },
  committeeFinish: { lat: 40.7807, lon: -119.2033 },
  finish: { lat: 40.7809, lon: -119.2049 },
  pinBoundaryEnabled: true,
};

// a fake RTCM3 frame of `length` payload bytes, message type `type`
function rtcmFrame(type, length) {
  const buf = Buffer.alloc(3 + length + 3);
  buf[0] = 0xd3;
  buf[1] = (length >> 8) & 0x03;
  buf[2] = length & 0xff;
  buf[3] = type >> 4;
  buf[4] = (type & 0x0f) << 4;
  for (let i = 5; i < 3 + length; i++) buf[i] = Math.floor(rand() * 256);
  const crc = protocol.crc24q(buf, 3 + length);
  buf[3 + length] = crc >> 16;
  buf[4 + length] = (crc >> 8) & 0xff;
  buf[5 + length] = crc & 0xff;
  return buf;
}

// ---- C++ emitting ----

const lines = [];
const out = (s = '') => lines.push(s);
const num = (v) => (Number.isInteger(v) ? String(v) : String(v)); // shortest round-trip form - a valid C++ double literal
const bytes = (buf) => `{${[...buf].join(',')}}`;
const pvtInit = (p) =>
  `{${p.timestamp}LL, ${num(p.lat)}, ${num(p.lon)}, ${p.gSpeedMmS}, ${num(p.headMotDeg)}, ${p.gnssFixOk}, ${p.carrSoln}, ${p.numSV}}`;
const pvtArray = (name, list) => {
  out(`static const PvtV ${name}[] = {`);
  for (const p of list) out(`  ${pvtInit(p)},`);
  out('};');
};
const bytesArray = (name, list) => {
  out(`static const std::vector<std::vector<uint8_t>> ${name} = {`);
  for (const b of list) out(`  ${bytes(b)},`);
  out('};');
};

out('// GENERATED by firmware/esp32-rover/tools/gen_vectors.js from the Node code in src/ - do not edit by hand.');
out('// Regenerate after changing protocol.js (or the other modules the script reads): node firmware/esp32-rover/tools/gen_vectors.js');
out('#pragma once');
out('#include <cstdint>');
out('#include <vector>');
out('namespace vec {');
out('struct PvtV { int64_t ts; double lat, lon; int32_t speed; double head; bool fixOk; uint8_t carr, numSV; };');
out(`static const char* const BOAT = "${BOAT}";`);
out();

// 1. position frames
pvtArray('PVTS', PVTS);
bytesArray('ENCODE', PVTS.map((p) => protocol.encode(BOAT, p)));
out();

// 2. status hello
const HELLOS = [
  { boatId: BOAT, flags: 0, power: 0, numSV: 0, fixType: null, carrSoln: 0, build: 0, dirty: false },
  { boatId: BOAT, flags: 0x52, power: 0, numSV: 27, fixType: 3, carrSoln: 2, build: 312, dirty: true },
  { boatId: BOAT, flags: 0x7f, power: 0, numSV: 255, fixType: 15, carrSoln: 1, build: 40000, dirty: false },
];
out('struct HelloV { uint8_t flags, power, numSV; bool hasPvt; uint8_t fixType, carrSoln; uint16_t build; bool dirty; };');
out('static const HelloV HELLOS[] = {');
for (const h of HELLOS) out(`  {${h.flags}, ${h.power}, ${h.numSV}, ${h.fixType != null}, ${h.fixType || 0}, ${h.carrSoln}, ${Math.min(h.build, 0x7fff)}, ${h.dirty}},`);
out('};');
bytesArray('HELLO_FRAMES', HELLOS.map((h) => protocol.encodeStatusHello(h)));
out();

// 3. batch and delta frames
pvtArray('TRACK', TRACK);
bytesArray('BATCH_FRAMES', [protocol.encodeBatch(BOAT, TRACK.slice(0, 4)), protocol.encodeBatch(BOAT, TRACK.slice(10, 11))]);
// delta: the whole track in one call (split by the jump, the gap and the 8-fix limit), and short runs
const deltaCases = [TRACK, TRACK.slice(0, 1), TRACK.slice(12, 20), TRACK.slice(24, 27)];
out('struct DeltaCase { int from, to; };');
out(`static const DeltaCase DELTA_CASES[] = {{0, ${TRACK.length}}, {0, 1}, {12, 20}, {24, 27}};`);
out('static const std::vector<std::vector<std::vector<uint8_t>>> DELTA_FRAMES = {');
for (const c of deltaCases) out(`  {${protocol.encodeDeltaFrames(BOAT, c).map((f) => bytes(f.buf)).join(', ')}},`);
out('};');
out('static const std::vector<std::vector<int>> DELTA_COUNTS = {');
for (const c of deltaCases) out(`  {${protocol.encodeDeltaFrames(BOAT, c).map((f) => f.count).join(', ')}},`);
out('};');
out();

// 4. base -> boat frames, and what they decode to
const marksFrame = protocol.encodeMarks(MARKS, { ip: '192.168.4.10', port: 8091, adminPort: 8092, regattaName: 'Playa Cup 2026 Long Name' });
const dm = protocol.decodeMarks(marksFrame);
out(`static const std::vector<uint8_t> MARKS_FRAME = ${bytes(marksFrame)};`);
const { MARK_NAMES } = require(path.join(src, 'course'));
out(`static const double MARKS_LATLON[] = {${MARK_NAMES.map((name) => `${num(dm.marks[name].lat)}, ${num(dm.marks[name].lon)}`).join(', ')}};`);
out(`static const char* const MARKS_REGATTA = "${dm.regattaName}";`);
out(`static const uint16_t MARKS_PORTS[] = {${dm.basePort}, ${dm.baseAdminPort}};`);
out(`static const std::vector<uint8_t> PING_FRAME = ${bytes(protocol.encodePing())};`);
const powerFrames = [
  protocol.encodePower('sleep', { sleepS: 30 }),
  protocol.encodePower('wake', { boatIds: ['AAAAA', BOAT, 'ZZZZZ'] }),
  protocol.encodePower('sleep', { sleepS: 0, boatIds: ['BBBBB'] }),
];
bytesArray('POWER_FRAMES', powerFrames);
out('struct PowerV { bool sleep; uint8_t sleepS; bool all; int ids; };');
out(`static const PowerV POWERS[] = {${powerFrames.map((f) => protocol.decodePower(f)).map((p) => `{${p.action === 'sleep'}, ${p.sleepS}, ${p.all}, ${p.boatIds.length}}`).join(', ')}};`);
const tables = [
  protocol.encodeSlotTable({ version: 5, slotCount: 41, slotWidthMs: 45, joinSlots: 2, practice: false, entries: [{ boatId: 'AAAAA', slot: 0 }, { boatId: BOAT, slot: 20 }] }),
  protocol.encodeSlotTable({ version: 127, slotCount: 25, slotWidthMs: 35, joinSlots: 2, practice: true, entries: [] }),
];
bytesArray('SLOT_TABLE_FRAMES', tables);
out('struct TableV { uint8_t version; bool practice; uint8_t slotCount, slotWidthMs, joinSlots; int entries; };');
out(`static const TableV TABLES[] = {${tables.map((f) => protocol.decodeSlotTable(f)).map((t) => `{${t.version}, ${t.practice}, ${t.slotCount}, ${t.slotWidthMs}, ${t.joinSlots}, ${t.entries.length}}`).join(', ')}};`);
const schedule = protocol.encodePowerSchedule({ stamp: 1793600000, witty: { mode: 'daily', haltItself: false, startTime: '09:00', endTime: '17:30' }, shutdown: { enabled: true, whenIdle: true, time: '21:00', idleMinutes: 10, speedKn: 0.5 } });
out(`static const std::vector<uint8_t> POWER_SCHEDULE_FRAME = ${bytes(schedule)};`);
out(`static const uint32_t POWER_SCHEDULE_STAMP = ${protocol.decodePowerSchedule(schedule).stamp};`);
const rtcms = [rtcmFrame(1077, 140), rtcmFrame(1005, 19), rtcmFrame(1230, 8)];
bytesArray('RTCM_FRAMES', rtcms);
out(`static const uint16_t RTCM_TYPES[] = {${rtcms.map((f) => protocol.decodeRtcm(f).type).join(', ')}};`);
out(`static const uint32_t CRC24Q_OF_MARKS = ${protocol.crc24q(marksFrame, marksFrame.length)};`);
out();

// 5. the radio byte stream: every frame type, noise, a corrupted frame and frames split across writes - and the events radioLink.js emits
const other = [
  protocol.encode('AAAAA', PVTS[0]),
  protocol.encodeHello('BBBBB'),
  protocol.encodeStatusHello(HELLOS[1]),
  protocol.encodeBatch('CCCCC', TRACK.slice(0, 3)),
  protocol.encodeSetMark('DDDDD', 'pin', 40.78, -119.2),
  protocol.encodeMarkLog('EEEEE', 'antenna moved'),
  protocol.encodeDeltaFrames('FFFFF', TRACK.slice(0, 8))[0].buf,
];
const corrupt = Buffer.from(tables[0]);
corrupt[10] ^= 0x55;
const noise = Buffer.from([0x00, 0x12, 0xaa, 0x01, 0xee, 0x09, 0x99, 0x7f, 0x34]);
const stream = Buffer.concat([noise, marksFrame, other[0], rtcms[0], corrupt, other[1], powerFrames[1], other[2], tables[0], rtcms[1], other[3], noise, schedule, other[4], protocol.encodePing(), other[5], rtcms[2], other[6], tables[1], noise.subarray(0, 3)]);
const link = Object.create(RadioLink.prototype);
EventEmitter.call(link);
link._buf = Buffer.alloc(0);
const events = [];
let jsFrames = 0;
let jsSyncErrors = 0;
const watched = { marks: 1, ping: 2, power: 3, 'slot-table': 4, 'power-schedule': 5, rtcm: 6 };
for (const evt of ['frame', 'marks', 'ping', 'power-schedule', 'hello', 'frame-batch', 'set-mark', 'mark-log', 'power', 'slot-table', 'rtcm']) {
  link.on(evt, () => {
    jsFrames++;
    if (watched[evt]) events.push(watched[evt]);
  });
}
link.on('sync-error', () => jsSyncErrors++);
// in uneven chunks, so frames arrive split across writes
const chunks = [];
for (let at = 0, k = 0; at < stream.length; k++) {
  const n = [1, 7, 33, 2, 120, 5][k % 6];
  chunks.push(stream.subarray(at, at + n));
  at += n;
}
for (const c of chunks) link._onData(c);
out(`static const std::vector<uint8_t> RADIO_STREAM = ${bytes(stream)};`);
out(`static const std::vector<int> RADIO_CHUNKS = {${chunks.map((c) => c.length).join(',')}};`);
out('// 1 marks, 2 ping, 3 power, 4 slot table, 5 power schedule, 6 rtcm - in the order radioLink.js emitted them');
out(`static const std::vector<int> RADIO_EVENTS = {${events.join(',')}};`);
out(`static const uint32_t RADIO_FRAMES = ${jsFrames};`);
out(`static const uint32_t RADIO_SYNC_ERRORS = ${jsSyncErrors};`);
out();

// 6. UBX: NAV-PVT frames built by encodeNavPvt, the fixes ubxParser.js decodes from them, and the commands a rover sends
const navPvts = [
  { ...PVTS[0], fixType: 3, diffSoln: true, hAccMm: 14, utcValid: true, utcYear: 2026, utcMonth: 11, utcDay: 2, utcHour: 17, utcMin: 39, utcSec: 53 },
  { ...PVTS[1], fixType: 3, diffSoln: false, hAccMm: 2500, utcValid: true, utcYear: 2024, utcMonth: 2, utcDay: 29, utcHour: 0, utcMin: 0, utcSec: 0 },
  { ...PVTS[4], fixType: 2, diffSoln: false, hAccMm: 0, utcValid: true, utcYear: 1999, utcMonth: 12, utcDay: 31, utcHour: 23, utcMin: 59, utcSec: 59 },
];
const ubxStream = Buffer.concat([Buffer.from([0xb5, 0x00, 0x62]), ...navPvts.map((p) => encodeNavPvt(p)), Buffer.from([0xb5, 0x62, 0x01, 0x07, 0x00])]);
const parser = new UbxParser();
const decoded = [];
parser.on('nav-pvt', (p) => decoded.push(p));
parser.write(ubxStream);
out(`static const std::vector<uint8_t> UBX_STREAM = ${bytes(ubxStream)};`);
out('struct UbxPvtV { int64_t ts; double lat, lon; int32_t speed; double head; bool fixOk, diff; uint8_t carr, numSV, fixType; uint32_t hAcc; };');
out('static const UbxPvtV UBX_PVTS[] = {');
for (const p of decoded) out(`  {${p.timestamp}LL, ${num(p.lat)}, ${num(p.lon)}, ${p.gSpeedMmS}, ${num(p.headMotDeg)}, ${p.gnssFixOk}, ${p.diffSoln}, ${p.carrSoln}, ${p.numSV}, ${p.fixType}, ${p.hAccMm}},`);
out('};');
out(`static const std::vector<uint8_t> PMREQ = ${bytes(encodePmreq({ durationMs: 0, force: false }))};`);
out(`static const std::vector<uint8_t> PMREQ_FORCE = ${bytes(encodePmreq({ durationMs: 0, force: true }))};`);
out(`static const std::vector<uint8_t> POLL_NAV_SIG = ${bytes(encodePollRequest(0x01, 0x43))};`);
out();

// 7. burst timing: a base sending a burst every 2 s (first message lost now and then), and what the tracker and gate say
const tracker = new BurstTracker({ now: () => 0 });
const bursts = [];
let t0 = 1000;
for (let b = 0; b < 12; b++) {
  const lose = b === 7;
  const msgs = [[1077, 0, 160], [1087, 18, 120], [1097, 33, 130], [1127, 50, 110], [1230, 64, 20]];
  for (const [type, off, size] of msgs) {
    if (lose && type === 1077) continue;
    const t = t0 + off + Math.round(rand() * 3);
    tracker.onRtcm(type, t, size);
    bursts.push([type, t, size]);
  }
  t0 += 2000 + Math.round(rand() * 4 - 2);
}
const gate = new TxGate({ tracker, now: () => 0 });
const probes = [];
for (let t = t0 - 2600; t < t0 + 1600; t += 37) probes.push(t);
out('struct RtcmMsg { uint16_t type; double t; int size; };');
out(`static const RtcmMsg BURSTS[] = {${bursts.map(([type, t, size]) => `{${type}, ${t}, ${size}}`).join(', ')}};`);
out(`static const double BURST_PERIOD = ${num(tracker.period)};`);
out(`static const uint32_t BURST_ANCHOR_CORRECTIONS = ${tracker.anchorCorrections};`);
out('struct GateProbe { double t; bool active; double startAtOrBefore; double wait26; double wait83; };');
out('static const GateProbe GATE_PROBES[] = {');
for (const t of probes) out(`  {${t}, ${tracker.isActive(t)}, ${num(tracker.startAtOrBefore(t) ?? -1)}, ${num(gate.waitMs(26, t))}, ${num(gate.waitMs(83, t))}},`);
out('};');
const defaultGate = new TxGate({ tracker: new BurstTracker(), blockBeforeMs: 40, blockAfterMs: 20, guardMs: 10 });
out(`static const int AUTO_SLOT_COUNT_2S = ${autoSlotCount({ joinSlots: 2, rtcmIntervalS: 2, widthMs: 45 }, defaultGate)};`);
out(`static const int AUTO_SLOT_COUNT_1S = ${autoSlotCount({ joinSlots: 2, rtcmIntervalS: 1, widthMs: 35 }, defaultGate)};`);
out();

// 8. thinning and geometry
const protect = (f) => f.lat > 40.7962;
const idx = (list, kept) => kept.map((k) => list.indexOf(k));
out('struct ThinCase { int from, to, cap, anchor; bool protect; std::vector<int> kept; };');
out('static const ThinCase THIN_CASES[] = {');
out(`  {0, 20, 4, -1, false, {${idx(TRACK.slice(0, 20), thinForTurns(TRACK.slice(0, 20), 4)).join(',')}}},`);
out(`  {5, 30, 8, 4, false, {${idx(TRACK.slice(5, 30), thinForTurns(TRACK.slice(5, 30), 8, { anchor: TRACK[4] })).join(',')}}},`);
out(`  {20, 30, 3, -1, true, {${idx(TRACK.slice(20, 30), thinForTurns(TRACK.slice(20, 30), 3, { protect })).join(',')}}},`);
out('};');
out('static const double THIN_PROTECT_LAT = 40.7962;');
out(`static const std::vector<int> BACKFILL_KEPT = {${idx(TRACK.slice(0, 12), thinBackfill(TRACK.slice(0, 12))).join(',')}};`);
const geo = [[MARKS.pin, MARKS.windwardGreen], [MARKS.leewardBlack, { lat: -33.8, lon: 151.2 }], [{ lat: 0, lon: 179.9 }, { lat: 0.1, lon: -179.9 }]];
out(`static const double DISTANCES[] = {${geo.map(([a, b]) => num(distanceMeters(a, b))).join(', ')}};`);
out(`static const double SEG_DIST = ${num(distanceToSegmentM(MARKS.windwardGreen, MARKS.committeeFinish, MARKS.finish))};`);
out();

// 9. the diagnosis flags
const diagCases = [
  { since: 0, gpsReal: true, gpsAsleep: false, gpsPortOpen: false, lastGpsBytesAt: null, lastUbxAt: null, lastPvtAt: null, lastRxmRtcmAt: null, lastBaseRxAt: null, watchBursts: true, burstsHeard: false, now: 1000 },
  { since: 0, gpsReal: true, gpsAsleep: false, gpsPortOpen: true, lastGpsBytesAt: 90000, lastUbxAt: 50000, lastPvtAt: null, lastRxmRtcmAt: null, lastBaseRxAt: 10000, watchBursts: true, burstsHeard: false, now: 100000 },
  { since: 0, gpsReal: true, gpsAsleep: false, gpsPortOpen: true, lastGpsBytesAt: 199000, lastUbxAt: 199000, lastPvtAt: 199500, lastRxmRtcmAt: 150000, lastBaseRxAt: 190000, watchBursts: true, burstsHeard: true, now: 200000 },
  { since: 0, gpsReal: true, gpsAsleep: true, gpsPortOpen: true, lastGpsBytesAt: null, lastUbxAt: null, lastPvtAt: null, lastRxmRtcmAt: null, lastBaseRxAt: null, watchBursts: false, burstsHeard: false, now: 300000 },
];
const n = (v) => (v == null ? -1 : v);
out('struct DiagCase { double since; bool gpsReal, gpsAsleep, gpsPortOpen; double bytes, ubx, pvt, rxm, base; bool watch, heard; double now; uint8_t flags; };');
out('static const DiagCase DIAG_CASES[] = {');
for (const d of diagCases) {
  out(`  {${d.since}, ${d.gpsReal}, ${d.gpsAsleep}, ${d.gpsPortOpen}, ${n(d.lastGpsBytesAt)}, ${n(d.lastUbxAt)}, ${n(d.lastPvtAt)}, ${n(d.lastRxmRtcmAt)}, ${n(d.lastBaseRxAt)}, ${d.watchBursts}, ${d.burstsHeard}, ${d.now}, ${roverDiag.computeFlags(d, d.now)}},`);
}
out('};');

// 10. join back-off with a fixed random sequence
let jbT = 0;
const jbRand = [0.1, 0.9, 0.5, 0.25, 0.75, 0.0, 0.99];
let jbI = 0;
const jb = new JoinBackoff({ maxMs: 15000, now: () => jbT, rand: () => jbRand[jbI++ % jbRand.length] });
const jbNext = [];
for (let k = 0; k < 7; k++) {
  jb.sent();
  jbNext.push(jb.nextAt);
}
out(`static const double JOIN_RANDS[] = {${jbRand.join(', ')}};`);
out(`static const double JOIN_NEXT_AT[] = {${jbNext.map(num).join(', ')}};`);
out('}  // namespace vec');
out();

const text = lines.join('\n');
if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== text) {
    console.error(`${path.relative(process.cwd(), OUT)} is out of date with src/ - run: node firmware/esp32-rover/tools/gen_vectors.js, then rebuild the firmware tests`);
    process.exit(1);
  }
  console.log('firmware test vectors are up to date');
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
}
