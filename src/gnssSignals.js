// Turns one UBX-NAV-SIG (every signal the receiver is looking at) into the
// answer the rover dashboard wants: is this antenna really delivering both
// bands? Dual-band RTK needs L2 as well as L1, and an antenna that only
// passes L1 still gives a normal-looking fix, so NAV-PVT alone can't tell.
// Pure - see boatAgent.js's pollGpsSignals for where the message comes from.
//
// "L2" here means the ZED-F9P's whole second band, so Galileo E5b and BeiDou
// B2I count: they sit next to L2 and pass through the same antenna element.

// gnssId -> sigId -> band, from the u-blox F9 interface description. SBAS is
// left out on purpose: it is L1 only, so counting it would make every antenna
// look a little worse on L2.
const CONSTELLATIONS = {
  0: { name: 'GPS', bands: { 0: 'l1', 3: 'l2', 4: 'l2' } }, // L1C/A, L2 CL, L2 CM
  2: { name: 'Galileo', bands: { 0: 'l1', 1: 'l1', 5: 'l2', 6: 'l2' } }, // E1 C, E1 B, E5b I, E5b Q
  3: { name: 'BeiDou', bands: { 0: 'l1', 1: 'l1', 2: 'l2', 3: 'l2' } }, // B1I D1/D2, B2I D1/D2
  5: { name: 'QZSS', bands: { 0: 'l1', 1: 'l1', 4: 'l2', 5: 'l2' } }, // L1C/A, L1S, L2 CM, L2 CL
  6: { name: 'GLONASS', bands: { 0: 'l1', 2: 'l2' } }, // L1OF, L2OF
};

// NAV-SIG qualityInd 4 and up: code locked. Below that the receiver is only
// searching, so its C/N0 says nothing about the antenna.
const MIN_QUALITY_IND = 4;

// Rules of thumb, not u-blox figures. L2 normally reads a few dB under L1, so
// the gap only counts as weak when it is well past that. MIN_SATS keeps a
// blocked sky or a cold start from being blamed on the antenna.
const MIN_SATS = 4;
const WEAK_L2_GAP_DB = 10;
const WEAK_L2_CNO_DBHZ = 30;

function mean(values) {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

function bandSummary(cnos) {
  return { sats: cnos.length, meanCno: mean(cnos) };
}

// signals: nav-sig's decoded array (see ubxParser.js's _decodeNavSig).
// Counts satellites, not signals - Galileo reports E1 B and E1 C separately,
// and one satellite shouldn't count twice - using each one's strongest signal
// in that band.
function summarizeSignals(signals) {
  const sats = new Map(); // "gnssId:svId" -> { gnssId, l1, l2 }
  for (const sig of signals) {
    const band = CONSTELLATIONS[sig.gnssId] && CONSTELLATIONS[sig.gnssId].bands[sig.sigId];
    if (!band || sig.qualityInd < MIN_QUALITY_IND || sig.cno <= 0) continue;
    const key = `${sig.gnssId}:${sig.svId}`;
    if (!sats.has(key)) sats.set(key, { gnssId: sig.gnssId, l1: null, l2: null });
    const sat = sats.get(key);
    sat[band] = Math.max(sat[band] ?? 0, sig.cno);
  }

  const all = [...sats.values()];
  const cnosOf = (list, band) => list.map((sat) => sat[band]).filter((cno) => cno != null);
  const l1 = bandSummary(cnosOf(all, 'l1'));
  const l2 = bandSummary(cnosOf(all, 'l2'));

  // Compared only on satellites heard on both bands, so an older GPS satellite
  // with no civil L2 signal doesn't skew the gap.
  const both = all.filter((sat) => sat.l1 != null && sat.l2 != null);
  const gapDb = both.length ? mean(both.map((sat) => sat.l1 - sat.l2)) : null;

  const constellations = Object.entries(CONSTELLATIONS)
    .map(([gnssId, { name }]) => {
      const own = all.filter((sat) => sat.gnssId === Number(gnssId));
      return { name, l1: bandSummary(cnosOf(own, 'l1')), l2: bandSummary(cnosOf(own, 'l2')) };
    })
    .filter((c) => c.l1.sats > 0 || c.l2.sats > 0);

  let verdict = 'ok';
  if (l1.sats < MIN_SATS) verdict = 'too-few';
  else if (l2.sats === 0) verdict = 'l1-only';
  else if (l2.sats < MIN_SATS || l2.meanCno < WEAK_L2_CNO_DBHZ || (gapDb != null && gapDb > WEAK_L2_GAP_DB)) verdict = 'weak-l2';

  return { verdict, l1, l2, bothBands: both.length, gapDb, constellations };
}

module.exports = { summarizeSignals };
