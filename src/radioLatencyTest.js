// Radio latency / guard-time test - `npm run radio-latency`.
//
// Measures how long a frame takes to get from "the app wrote it" to "the other
// radio's app decoded it", and how much that varies, so a time-slot schedule
// can be given a guard time that is measured instead of guessed. Needs TWO radios
// on this machine on the same network: one SENDS, the other LISTENS.
//
//   LATENCY_TX_PORT=/dev/cu.usbserial-5 LATENCY_RX_PORT=/dev/cu.usbserial-0001 npm run radio-latency
//
// Both ports are opened by this one process, so the send time and the receive
// time come from the same clock - no clock sync needed.
//
// If the RTK base is running (so RTCM correction bursts are on the air), the
// listener also times each burst, and every test frame is classified by WHERE in
// the second it was sent: "near the burst" or "clear". That shows (1) whether
// sending close to a burst costs latency or frames, and (2) whether our own test
// transmissions damaged the corrections the listener radio was receiving - the
// evidence for holding telemetry back during a burst.
//
// Settings (environment):
//   LATENCY_TX_PORT, LATENCY_RX_PORT   the two serial ports (required)
//   RADIO_BAUD                         default 115200 - must match both radios
//   LATENCY_FRAMES                     test frames to send (default 300)
//   LATENCY_GAP_MS                     mean gap between frames (default 250; a random
//                                      0-40 ms is added so sends sweep every phase of the second)
//   LATENCY_BATCH                      1 = a 26-byte position frame (default),
//                                      2-4 = a batch frame of that many fixes (up to 84 bytes)
//   LATENCY_FOCUS                      1 = send only in a sweep AROUND the predicted correction
//                                      bursts (80 ms before to 160 ms after, in 10 ms steps, one frame
//                                      per burst) to find exactly where sending hurts; needs the base
//                                      running; default frame count 150 (about 150 s)
//
// What is measured is the one-way time from `send()` to the listener's decoded
// frame event. It includes the serial write, the radio's own packetizing and RF
// time, the serial read at the other end and USB/Node scheduling - i.e. everything
// that makes a slot's start uncertain.

const { performance } = require('perf_hooks');
const protocol = require('./protocol');

const BOAT_ID = 'LAT01';

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(latencies) {
  const s = [...latencies].sort((a, b) => a - b);
  if (!s.length) return null;
  return { n: s.length, min: s[0], p50: percentile(s, 50), p90: percentile(s, 90), p99: percentile(s, 99), max: s[s.length - 1] };
}

function buildFrame(seq, batch) {
  const pvt = (extraMs) => ({
    timestamp: seq * 1000 + extraMs, // the sequence number, not a real time (same trick as radioTest.js)
    lat: 40.8898,
    lon: -118.3821,
    gSpeedMmS: 5000,
    headMotDeg: 90,
    gnssFixOk: true,
    carrSoln: 2,
    numSV: 14,
  });
  if (batch <= 1) return protocol.encode(BOAT_ID, pvt(0));
  return protocol.encodeBatch(BOAT_ID, Array.from({ length: batch }, (_, j) => pvt(j * 100)));
}

// tx/rx: anything with send(buf) and on('frame'|'frame-batch'|'rtcm', ...) - a RadioLink,
// or a SimRadioLink in tests. Returns the result object; prints nothing.
function runLatencyTest({ tx, rx, frames = 300, gapMs = 250, batch = 1, focus = false, now = () => performance.now() }) {
  return new Promise((resolve) => {
    const sentAt = new Map(); // seq -> ms
    const results = new Map(); // seq -> { latency, sentAt }
    let notSent = 0;

    // RTCM bursts as heard by the listener: a burst starts at the first RTCM frame after a quiet gap
    const bursts = []; // { start, end, msgs }
    let lastRtcm = -Infinity;
    rx.on('rtcm', () => {
      const t = now();
      if (t - lastRtcm > 400) bursts.push({ start: t, end: t, msgs: 0 });
      const b = bursts[bursts.length - 1];
      b.end = t;
      b.msgs++;
      lastRtcm = t;
    });

    const onFrame = (seq) => {
      const t = now();
      if (sentAt.has(seq) && !results.has(seq)) results.set(seq, { latency: t - sentAt.get(seq), sentAt: sentAt.get(seq) });
    };
    rx.on('frame', (f) => onFrame(Math.floor(f.timestamp / 1000)));
    rx.on('frame-batch', (fixes) => onFrame(Math.floor(fixes[0].timestamp / 1000)));

    let seq = 0;
    const FOCUS_OFFSETS = []; // ms relative to a burst's start
    for (let o = -80; o <= 160; o += 10) FOCUS_OFFSETS.push(o);
    let focusWaited = 0;

    const sendFrame = () => {
      const frame = buildFrame(seq, batch);
      const t = now();
      sentAt.set(seq, t);
      if (!tx.send(frame)) {
        notSent++;
        sentAt.delete(seq);
      }
      seq++;
    };

    const sendNext = () => {
      if (seq >= frames) {
        setTimeout(finish, 2000); // let the last frames and one more burst arrive
        return;
      }
      if (!focus) {
        sendFrame();
        setTimeout(sendNext, gapMs + Math.random() * 40);
        return;
      }
      // focus mode: aim each frame at an offset around a PREDICTED burst start
      if (bursts.length < 3) {
        focusWaited += 200;
        if (focusWaited > 15000) {
          console.error('[radioLatency] no RTCM bursts heard - focus mode needs the base running; falling back to even spacing');
          focus = false;
          return sendNext();
        }
        return setTimeout(sendNext, 200);
      }
      const starts = bursts.map((b) => b.start);
      const periods = starts.slice(1).map((t, i) => t - starts[i]).filter((p) => p > 400).sort((a, b) => a - b);
      const period = percentile(periods, 50);
      const last = starts[starts.length - 1];
      const t0 = now();
      let next = last + period;
      while (next < t0 + 250) next += period;
      const offset = FOCUS_OFFSETS[seq % FOCUS_OFFSETS.length];
      setTimeout(() => {
        sendFrame();
        setTimeout(sendNext, 300);
      }, Math.max(0, next + offset - t0));
    };

    function finish() {
      const all = [...sentAt.entries()].map(([s, t]) => ({ seq: s, sentAt: t, ...(results.get(s) || { latency: null }) }));
      const lat = all.filter((x) => x.latency !== null).map((x) => x.latency);

      // burst timing
      const starts = bursts.map((b) => b.start);
      const periods = starts.slice(1).map((t, i) => t - starts[i]).filter((p) => p > 400).sort((a, b) => a - b);
      const period = periods.length ? percentile(periods, 50) : null;
      // The burst width used to classify frames is a robust one (95th percentile), NOT the
      // widest burst seen: one straggling burst (a late message) would otherwise make the
      // "near burst" window huge and swamp the near/clear comparison.
      const widths = bursts.map((b) => b.end - b.start).sort((a, b) => a - b);
      const width = widths.length ? percentile(widths, 95) : null;
      const widthStats = widths.length ? { p50: percentile(widths, 50), p95: width, max: widths[widths.length - 1] } : null;
      const maxMsgs = bursts.length ? Math.max(...bursts.map((b) => b.msgs)) : 0;

      // classify each test frame by where it was sent relative to the most recent burst start
      // Where a send conflicts with a burst, measured relative to the burst's START as the listener
      // sees it (first RTCM frame decoded): the focus-mode sweep of 8 Oct 2026 found frames written from
      // about 40 ms before to 10-20 ms after that moment were delayed (20-35 ms) or lost, and frames
      // written 20+ ms after it were normal again - even though the burst runs on for ~30 ms (the
      // listener's first decoded frame lags the burst's first byte on the air). So the conflict window is
      // far shorter than the burst's width plus guards.
      const NEAR_BEFORE = 45; // ms before a burst's start
      const NEAR_AFTER = 25; // ms after a burst's start
      const near = [];
      const clear = [];
      let classified = 0;
      if (period && width !== null) {
        for (const x of all) {
          const prior = starts.filter((s) => s <= x.sentAt).pop();
          if (prior === undefined) continue;
          const phase = (x.sentAt - prior) % period;
          const isNear = phase <= NEAR_AFTER || phase >= period - NEAR_BEFORE;
          (isNear ? near : clear).push(x);
          classified++;
        }
      }
      const lost = (xs) => xs.filter((x) => x.latency === null).length;

      // phase table: where each frame was sent relative to the NEAREST burst start, in 10 ms buckets
      const phaseRows = new Map();
      if (starts.length) {
        for (const x of all) {
          let d = Infinity;
          for (const st of starts) if (Math.abs(x.sentAt - st) < Math.abs(d)) d = x.sentAt - st;
          if (d < -100 || d >= 200) continue;
          const key = Math.floor(d / 10) * 10;
          if (!phaseRows.has(key)) phaseRows.set(key, []);
          phaseRows.get(key).push(x);
        }
      }
      const clearP50 = summarize(clear.filter((x) => x.latency !== null).map((x) => x.latency));
      const phaseTable = [...phaseRows.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([key, xs]) => {
          const got = xs.filter((x) => x.latency !== null).map((x) => x.latency).sort((a, b) => a - b);
          const p50 = got.length ? percentile(got, 50) : null;
          return { from: key, n: xs.length, lost: xs.length - got.length, p50, unsafe: xs.length - got.length > 0 || (p50 !== null && clearP50 && p50 > clearP50.p50 + 5) };
        });

      // did our own frames hurt the corrections? a burst is "hit" if a test frame was sent inside its span
      let hitBursts = 0;
      let hitIncomplete = 0;
      let cleanBursts = 0;
      let cleanIncomplete = 0;
      for (const b of bursts) {
        const hit = all.some((x) => x.sentAt >= b.start - NEAR_BEFORE && x.sentAt <= b.start + NEAR_AFTER);
        const incomplete = b.msgs < maxMsgs;
        if (hit) {
          hitBursts++;
          if (incomplete) hitIncomplete++;
        } else {
          cleanBursts++;
          if (incomplete) cleanIncomplete++;
        }
      }

      resolve({
        sent: all.length,
        notSent,
        received: lat.length,
        lost: all.length - lat.length,
        all: summarize(lat),
        near: { n: near.length, lost: lost(near), stats: summarize(near.filter((x) => x.latency !== null).map((x) => x.latency)) },
        clear: { n: clear.length, lost: lost(clear), stats: summarize(clear.filter((x) => x.latency !== null).map((x) => x.latency)) },
        bursts: { n: bursts.length, period, width, widthStats, maxMsgs, hitBursts, hitIncomplete, cleanBursts, cleanIncomplete, classified },
        phaseTable,
      });
    }

    sendNext();
  });
}

function report(r, batch) {
  const f = (v) => (v === null || v === undefined ? '  -  ' : v.toFixed(1).padStart(6));
  const row = (label, s) => (s ? `  ${label.padEnd(12)} n=${String(s.n).padStart(4)}  min ${f(s.min)}  p50 ${f(s.p50)}  p90 ${f(s.p90)}  p99 ${f(s.p99)}  max ${f(s.max)}` : `  ${label.padEnd(12)} no frames`);
  console.log(`\nFrames sent: ${r.sent}${r.notSent ? ` (+${r.notSent} the port refused)` : ''}  received: ${r.received}  lost: ${r.lost} (${r.sent ? ((r.lost / r.sent) * 100).toFixed(1) : '0.0'}%)   frame size: ${batch > 1 ? 8 + 19 * batch : 26} bytes`);
  console.log('\nOne-way latency in ms (send -> decoded at the listener):');
  console.log(row('all', r.all));
  if (r.all) console.log(`  jitter (p99 - p50): ${(r.all.p99 - r.all.p50).toFixed(1)} ms   spread (max - min): ${(r.all.max - r.all.min).toFixed(1)} ms`);

  const b = r.bursts;
  if (!b.n) {
    console.log('\nNo RTCM bursts heard by the listener (base off, or not on this network) - skipping the near-burst comparison.');
  } else {
    console.log(`\nRTCM bursts heard: ${b.n}, every ${b.period ? b.period.toFixed(0) : '?'} ms, up to ${b.maxMsgs} messages; width median ${b.widthStats.p50.toFixed(0)} ms, 95th percentile ${b.widthStats.p95.toFixed(0)} ms, widest ${b.widthStats.max.toFixed(0)} ms`);
    console.log(`  (frames are classed "near" a burst if sent from 45 ms before its start to 25 ms after it - the conflict window measured on 8 Oct 2026; see the table below)`);
    console.log(row('near burst', r.near.stats) + `   lost ${r.near.lost} of ${r.near.n}`);
    console.log(row('clear', r.clear.stats) + `   lost ${r.clear.lost} of ${r.clear.n}`);
    if (r.phaseTable && r.phaseTable.length) {
      console.log('\nBy when the frame was SENT, relative to the nearest burst start (10 ms buckets):');
      console.log('  from..to ms     n   lost   p50 ms');
      for (const row of r.phaseTable) {
        console.log(`  ${String(row.from).padStart(4)}..${String(row.from + 10).padEnd(4)}   ${String(row.n).padStart(4)}  ${String(row.lost).padStart(4)}   ${f(row.p50)}${row.unsafe ? '   <- lost or delayed' : ''}`);
      }
      const bad = r.phaseTable.filter((row) => row.unsafe);
      if (bad.length) {
        console.log(`  Sends from ${Math.min(...bad.map((x) => x.from))} ms to ${Math.max(...bad.map((x) => x.from + 10))} ms around a burst start were lost or delayed - hold telemetry out of that range, plus a guard.`);
      }
    }
    console.log(`\nDid our test frames hurt the corrections the listener was receiving?`);
    console.log(`  bursts with a test frame sent in/near them: ${b.hitBursts}, of which incomplete: ${b.hitIncomplete}`);
    console.log(`  bursts with none:                           ${b.cleanBursts}, of which incomplete: ${b.cleanIncomplete}`);
  }

  const basis = r.clear.stats && r.clear.n >= 20 ? r.clear.stats : r.all;
  if (basis) {
    const jitter = basis.p99 - basis.p50;
    const anchor = 3; // ms: two radios hearing the same burst agreed within 0-3 ms on one host (see README)
    const margin = 5;
    const guard = Math.ceil(jitter + anchor + margin);
    console.log(`\nSuggested slot guard: about ${guard} ms  (= jitter ${jitter.toFixed(1)} + anchor disagreement ${anchor} + margin ${margin};`);
    console.log(`  based on the ${basis === r.all ? 'whole run' : '"clear" frames'}). Treat it as a starting point: one host, two adapters, ${r.sent} frames.`);
    console.log(`  Typical delay before a frame is heard: p50 ${basis.p50.toFixed(1)} ms - a slot's first byte reaches the other end about that long after the write.`);
  }
}

module.exports = { runLatencyTest, report, summarize, percentile, buildFrame };

if (require.main === module) {
  const { RadioLink } = require('./radioLink');
  const txPort = process.env.LATENCY_TX_PORT;
  const rxPort = process.env.LATENCY_RX_PORT;
  const baud = parseInt(process.env.RADIO_BAUD || '115200', 10);
  const focus = process.env.LATENCY_FOCUS === '1' || process.env.LATENCY_FOCUS === 'true';
  const frames = parseInt(process.env.LATENCY_FRAMES || (focus ? '150' : '300'), 10);
  const gapMs = parseInt(process.env.LATENCY_GAP_MS || '250', 10);
  const batch = Math.max(1, Math.min(protocol.MAX_BATCH_COUNT, parseInt(process.env.LATENCY_BATCH || '1', 10) || 1));
  if (!txPort || !rxPort) {
    console.error('[radioLatency] set LATENCY_TX_PORT and LATENCY_RX_PORT (the two radios, e.g. /dev/cu.usbserial-5 and /dev/cu.usbserial-0001)');
    process.exit(1);
  }
  if (txPort === rxPort) {
    console.error('[radioLatency] the sender and listener must be two different radios');
    process.exit(1);
  }
  const tx = new RadioLink({ port: txPort, baud });
  const rx = new RadioLink({ port: rxPort, baud });
  for (const [name, radio] of [['tx', tx], ['rx', rx]]) {
    radio.on('error', (err) => console.error(`[radioLatency] ${name} radio error: ${err.message}`));
  }
  let connected = 0;
  const start = () => {
    if (++connected < 2) return;
    const secs = focus ? Math.round(frames * 1.3) : Math.round((frames * (gapMs + 20)) / 1000);
    console.log(`[radioLatency] sending ${frames} ${batch > 1 ? `${batch}-fix batch` : 'position'} frames from ${txPort}, listening on ${rxPort} (about ${secs}s)${focus ? ', focus mode: sweeping around the correction bursts' : ''} ...`);
    runLatencyTest({ tx, rx, frames, gapMs, batch, focus }).then((r) => {
      report(r, batch);
      process.exit(0);
    });
  };
  tx.on('connected', start);
  rx.on('connected', start);
  process.on('SIGINT', () => process.exit(0));
}
