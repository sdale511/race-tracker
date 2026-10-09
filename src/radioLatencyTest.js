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
//   LATENCY_SCHEDULE                   off (default) | gate | slots - send the test frames through the
//                                      real transmit scheduler (txScheduler.js) on the sending radio
//                                      instead of straight to the radio. `gate` keeps writes clear of
//                                      the correction burst; `slots` also gives each of LATENCY_BOATS
//                                      virtual boats its own slot (LATENCY_SLOTS, e.g. 3,7 and
//                                      LATENCY_SLOT_MS, default 40). Compare a run with `off` and one
//                                      with `gate`: same load, same radios - the difference is the
//                                      scheduler's effect on the corrections and on latency
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

// ---- scheduled mode: the same load as above, but sent through the real TxScheduler ----
// The sending radio listens for the correction bursts itself (as a boat would) and each virtual
// boat's frames go through its own scheduler. Measured at the listening radio: when each frame
// was actually WRITTEN relative to the nearest burst, how long it was held, latency after the
// write, loss, and whether the bursts came through complete.
function runScheduledTest({ tx, rx, mode = 'gate', boats = [{ id: 'LAT01', slot: 3 }], frames = 150, gapMs = 250, batch = 1, slotMs = 40, now = () => performance.now() }) {
  const { BurstTracker } = require('./burstTracker');
  const { TxGate } = require('./txGate');
  const { TxScheduler } = require('./txScheduler');
  return new Promise((resolve) => {
    const tracker = new BurstTracker({ now });
    tx.on('rtcm', (f) => tracker.onRtcm(f.type));
    const gate = new TxGate({ tracker, now });

    const rec = new Map(); // `${boat}:${seq}` -> { boat, submittedAt, writtenAt, receivedAt }
    const key = (b, q) => `${b}:${q}`;
    const decodeKey = (buf) => {
      const d = buf[0] === 0xaa ? protocol.decode(buf) : protocol.decodeBatch(buf);
      const first = Array.isArray(d) ? d[0] : d;
      return key(first.boatId, Math.floor(first.timestamp / 1000));
    };

    // bursts as heard by the LISTENER (the reference the conflict window was measured against)
    const bursts = [];
    let lastRtcm = -Infinity;
    rx.on('rtcm', () => {
      const t = now();
      if (t - lastRtcm > 400) bursts.push({ start: t, end: t, msgs: 0 });
      const b = bursts[bursts.length - 1];
      b.end = t;
      b.msgs++;
      lastRtcm = t;
    });
    const onRx = (boatId, seq) => {
      const r = rec.get(key(boatId, seq));
      if (r && r.receivedAt === undefined) r.receivedAt = now();
    };
    rx.on('frame', (f) => onRx(f.boatId, Math.floor(f.timestamp / 1000)));
    rx.on('frame-batch', (fx) => onRx(fx[0].boatId, Math.floor(fx[0].timestamp / 1000)));

    const schedulers = boats.map(
      (b) =>
        new TxScheduler({
          send: (buf) => {
            const r = rec.get(decodeKey(buf));
            if (r) r.writtenAt = now();
            return tx.send(buf);
          },
          tracker,
          gate,
          slot: { enabled: mode === 'slots', index: b.slot, count: Math.max(...boats.map((x) => x.slot)) + 1, widthMs: slotMs },
          maxQueue: 30,
          now,
          log: (m) => console.log(m),
        })
    );

    const build = (id, seq) => {
      const pvt = (extra) => ({ timestamp: seq * 1000 + extra, lat: 40.8898, lon: -118.3821, gSpeedMmS: 5000, headMotDeg: 90, gnssFixOk: true, carrSoln: 2, numSV: 14 });
      return batch <= 1 ? protocol.encode(id, pvt(0)) : protocol.encodeBatch(id, Array.from({ length: batch }, (_, j) => pvt(j * 100)));
    };

    // Don't start until the sender's own tracker has heard a few bursts - before that the scheduler
    // (correctly) holds nothing back, which would put the first seconds of the run outside the test.
    const startSending = () => {
    let done = 0;
    boats.forEach((b, i) => {
      let seq = 0;
      const next = () => {
        if (seq >= frames) {
          if (++done === boats.length) setTimeout(finish, 3000);
          return;
        }
        const buf = build(b.id, seq);
        rec.set(key(b.id, seq), { boat: b.id, submittedAt: now() });
        schedulers[i].submit(buf);
        seq++;
        setTimeout(next, gapMs + Math.random() * 40);
      };
      setTimeout(next, i * (gapMs / boats.length));
    });
    };
    let waited = 0;
    const waitForBursts = () => {
      if (tracker.isActive(now()) && tracker.bursts >= 3) return startSending();
      waited += 250;
      if (waited > 15000) {
        console.error('[radioLatency] the sender radio has not heard correction bursts - is the base running and on this network? Sending anyway; nothing will be held back.');
        return startSending();
      }
      setTimeout(waitForBursts, 250);
    };
    waitForBursts();

    function finish() {
      const all = [...rec.values()];
      const starts = bursts.map((x) => x.start);
      const widths = bursts.map((x) => x.end - x.start).sort((a, c) => a - c);
      const period = (() => {
        const iv = starts.slice(1).map((t, k) => t - starts[k]).filter((p) => p > 400).sort((a, c) => a - c);
        return iv.length ? percentile(iv, 50) : null;
      })();
      const written = all.filter((r) => r.writtenAt !== undefined);
      const phaseOf = (t) => {
        const prior = starts.filter((x) => x <= t).pop();
        return prior === undefined ? null : t - prior;
      };
      const perBoat = boats.map((b) => {
        const mine = all.filter((r) => r.boat === b.id);
        const w = mine.filter((r) => r.writtenAt !== undefined);
        const phases = w.map((r) => phaseOf(r.writtenAt)).filter((p) => p !== null).sort((x, y) => x - y);
        const held = w.map((r) => r.writtenAt - r.submittedAt).sort((x, y) => x - y);
        const lat = w.filter((r) => r.receivedAt !== undefined).map((r) => r.receivedAt - r.writtenAt);
        return {
          id: b.id,
          slot: b.slot,
          submitted: mine.length,
          written: w.length,
          lost: w.length - lat.length,
          phases: phases.length ? { min: phases[0], p50: percentile(phases, 50), max: phases[phases.length - 1] } : null,
          held: held.length ? { p50: percentile(held, 50), p90: percentile(held, 90), max: held[held.length - 1] } : null,
          latency: summarize(lat),
        };
      });
      // frames written inside the measured conflict window (-45..+25 ms around a burst start)
      const inWindow = written.filter((r) => {
        const prior = starts.filter((x) => x <= r.writtenAt).pop();
        const next = starts.find((x) => x > r.writtenAt);
        return (prior !== undefined && r.writtenAt - prior <= 25) || (next !== undefined && next - r.writtenAt <= 45);
      }).length;
      // did the corrections survive? a burst is "hit" if a frame was written in its conflict window
      let hit = 0, hitBad = 0, clean = 0, cleanBad = 0;
      const maxMsgs = bursts.length ? Math.max(...bursts.map((x) => x.msgs)) : 0;
      for (const b of bursts) {
        const isHit = written.some((r) => r.writtenAt >= b.start - 45 && r.writtenAt <= b.start + 25);
        const bad = b.msgs < maxMsgs;
        if (isHit) { hit++; if (bad) hitBad++; } else { clean++; if (bad) cleanBad++; }
      }
      // boats' frames arriving on top of each other (different boats within 25 ms at the listener)
      const arrivals = all.filter((r) => r.receivedAt !== undefined).sort((x, y) => x.receivedAt - y.receivedAt);
      let overlaps = 0;
      for (let k = 1; k < arrivals.length; k++) if (arrivals[k].boat !== arrivals[k - 1].boat && arrivals[k].receivedAt - arrivals[k - 1].receivedAt < 25) overlaps++;
      resolve({
        mode, perBoat, inWindow, written: written.length, slotMs,
        bursts: { n: bursts.length, period, width: widths.length ? percentile(widths, 95) : null, hit, hitBad, clean, cleanBad },
        overlaps, stats: schedulers.map((s) => s.stats()),
      });
    }
  });
}

function reportScheduled(r) {
  const f = (v) => (v === null || v === undefined ? '  -  ' : v.toFixed(0).padStart(5));
  console.log(`\nMode: ${r.mode}${r.mode === 'slots' ? `  (slot width ${r.slotMs} ms)` : ''}   frames written: ${r.written}`);
  for (const b of r.perBoat) {
    console.log(`\nBoat ${b.id}${r.mode === 'slots' ? ` (slot ${b.slot})` : ''}: submitted ${b.submitted}, written ${b.written}, lost ${b.lost}`);
    if (b.phases) console.log(`  written ms after a burst start:  min ${f(b.phases.min)}  median ${f(b.phases.p50)}  max ${f(b.phases.max)}${r.mode === 'slots' ? `   (slot opens at ${30 + b.slot * r.slotMs} ms)` : ''}`);
    if (b.held) console.log(`  held before the write (ms):      p50 ${f(b.held.p50)}  p90 ${f(b.held.p90)}  max ${f(b.held.max)}`);
    if (b.latency) console.log(`  latency after the write (ms):    p50 ${f(b.latency.p50)}  p90 ${f(b.latency.p90)}  p99 ${f(b.latency.p99)}  max ${f(b.latency.max)}`);
  }
  console.log(`\nFrames written inside the conflict window (-45..+25 ms around a burst start): ${r.inWindow} of ${r.written}`);
  if (r.mode === 'slots') console.log(`Frames from different boats arriving within 25 ms of each other: ${r.overlaps}`);
  const b = r.bursts;
  if (b.n) {
    console.log(`\nRTCM bursts heard by the listener: ${b.n}, every ${b.period ? b.period.toFixed(0) : '?'} ms`);
    console.log(`  bursts with a frame written in their conflict window: ${b.hit}, incomplete: ${b.hitBad}`);
    console.log(`  bursts with none:                                      ${b.clean}, incomplete: ${b.cleanBad}`);
  } else {
    console.log('\nNo RTCM bursts heard - start the base so there are corrections to protect.');
  }
  const s = r.stats[0];
  console.log(`\nScheduler (first boat): ${s.passedThrough} sent at once, ${s.held} held (longest ${s.heldMsMax.toFixed(0)} ms), ${s.dropped} dropped, ${s.expired} expired, ${s.spilled} slot spills; bursts tracked: ${s.tracker.bursts}${s.tracker.active ? '' : '  (tracker NOT active - nothing was held)'}`);
}

module.exports = { runLatencyTest, report, summarize, percentile, buildFrame, runScheduledTest, reportScheduled };

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
  const schedule = (process.env.LATENCY_SCHEDULE || 'off').toLowerCase();
  const tx = new RadioLink({ port: txPort, baud });
  const rx = new RadioLink({ port: rxPort, baud });
  for (const [name, radio] of [['tx', tx], ['rx', rx]]) {
    radio.on('error', (err) => console.error(`[radioLatency] ${name} radio error: ${err.message}`));
  }
  let connected = 0;
  const start = () => {
    if (++connected < 2) return;
    if (schedule === 'gate' || schedule === 'slots') {
      const slots = (process.env.LATENCY_SLOTS || '3,7').split(',').map((x) => parseInt(x, 10));
      const nBoats = Math.max(1, parseInt(process.env.LATENCY_BOATS || (schedule === 'slots' ? String(slots.length) : '1'), 10));
      const boats = Array.from({ length: nBoats }, (_, i) => ({ id: `LAT${String(i + 1).padStart(2, '0')}`, slot: slots[i % slots.length] }));
      const slotMs = parseInt(process.env.LATENCY_SLOT_MS || '40', 10);
      const defFrames = parseInt(process.env.LATENCY_FRAMES || '150', 10);
      console.log(`[radioLatency] scheduled mode "${schedule}": ${nBoats} virtual boat(s), ${defFrames} frames each, about ${Math.round((defFrames * (gapMs + 20)) / 1000)}s ...`);
      console.log('[radioLatency] the sender radio listens for the correction bursts itself, as a boat would - the base must be running.');
      runScheduledTest({ tx, rx, mode: schedule, boats, frames: defFrames, gapMs, batch, slotMs }).then((r) => {
        reportScheduled(r);
        process.exit(0);
      });
      return;
    }
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
