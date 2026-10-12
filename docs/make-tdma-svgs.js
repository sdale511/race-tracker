// Draws the two slot-schedule diagrams in docs/ from the real slot-count code, so they cannot drift from the defaults:
//   docs/tdma-cycle-2s.svg   one correction cycle at the default interval (RTCM_INTERVAL_S) and slot width (TX_SLOT_MS)
//   docs/tdma-1s-vs-2s.svg   the 1 s and 2 s intervals at the same time scale, at that slot width
// Run: node docs/make-tdma-svgs.js
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { slotCountForPeriod } = require('../src/slotTable');
const { TxGate } = require('../src/txGate');
const { BurstTracker } = require('../src/burstTracker');

const gate = new TxGate({ tracker: new BurstTracker(), ...config.txGate });
const width = config.txGate.slot.widthMs;
const joinN = config.txGate.slot.joinSlots;
const after = gate.afterMs(); // the burst and its guard, before slot 0
const FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const C = {
  burst: ['#FAECE7', '#993C1D'], boat: ['#E1F5EE', '#0F6E56', '#085041'], join: ['#FAEEDA', '#854F0B', '#633806'],
  base: ['#EEEDFE', '#534AB7', '#3C3489'], blocked: ['#F1EFE8', '#5F5E5A'],
};
const f = (n) => Math.round(n * 100) / 100;
const text = (x, y, s, { anchor = 'start', size = 12, weight = 400, fill = '#2c2c2a', central = false } = {}) =>
  `<text x="${f(x)}" y="${f(y)}" text-anchor="${anchor}" font-size="${size}" font-weight="${weight}" fill="${fill}" font-family="${FONT}"${central ? ' dominant-baseline="central"' : ''}>${s}</text>`;
const rect = (x, y, w, h, [fill, stroke]) => `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${fill}" stroke="${stroke}" stroke-width="0.8"/>`;

function layout(periodMs) {
  const total = slotCountForPeriod(periodMs, width, gate); // slots in all, including the base's
  const boatSlots = total - 1;
  return { total, boatSlots, assignable: boatSlots - joinN, usedMs: after + total * width };
}

function cycleSvg(periodMs) {
  const L = layout(periodMs);
  const x0 = 40, W = 600, k = W / periodMs; // px per ms
  const cell = width * k, y = 100, h = 36;
  const out = [];
  const n = (i) => x0 + (after + i * width) * k;
  out.push(text(x0, 62, `RTCM burst + guard (0–${after} ms)`));
  out.push(`<line x1="${f(x0 + after * k / 2)}" y1="68" x2="${f(x0 + after * k / 2)}" y2="${y}" stroke="#888780" stroke-width="0.8"/>`);
  out.push(rect(x0, y, after * k, h, C.burst));
  const show = (i, colors, label) => {
    out.push(rect(n(i), y, cell, h, colors));
    out.push(text(n(i) + cell / 2, y + h / 2, label, { anchor: 'middle', fill: colors[2], central: true, size: cell < 14 ? 9 : 12 }));
  };
  const head = 4, tail = 3;
  for (let i = 0; i < head; i++) show(i, C.boat, String(i));
  const gapFrom = head, gapTo = L.assignable - tail; // slots gapFrom..gapTo-1 drawn as one block
  out.push(rect(n(gapFrom), y, (gapTo - gapFrom) * cell, h, C.boat));
  out.push(text(n(gapFrom) + (gapTo - gapFrom) * cell / 2, y + h / 2, `${gapTo - gapFrom} more boat slots`, { anchor: 'middle', fill: C.boat[2], central: true }));
  for (let i = gapTo; i < L.assignable; i++) show(i, C.boat, String(i));
  for (let i = L.assignable; i < L.boatSlots; i++) show(i, C.join, String(i));
  show(L.boatSlots, C.base, 'B');
  const endX = n(L.total);
  out.push(rect(endX, y, x0 + W - endX, h, C.blocked));
  out.push(text(n(L.assignable) + cell, 62, `${joinN} shared join slots: boats with no slot yet`, { anchor: 'end' }).replace(`x="${f(n(L.assignable) + cell)}"`, `x="${f(n(L.assignable) - 6)}"`));
  out.push(`<line x1="${f(n(L.assignable) + cell)}" y1="68" x2="${f(n(L.assignable) + cell)}" y2="${y}" stroke="#888780" stroke-width="0.8"/>`);
  out.push(text(x0 + W, 156, `next burst at ${periodMs} ms`, { anchor: 'end' }));
  out.push(text(x0 + W, 174, 'B = the base\'s own slot (table, marks, pings)', { anchor: 'end', size: 11, fill: '#5F5E5A' }));
  out.push(text(x0, 200, `${L.assignable} boat slots + ${joinN} shared + 1 base = ${L.total} slots of ${width} ms; the slots take ${L.usedMs} ms of the ${periodMs} ms cycle,`, { size: 12 }));
  out.push(text(x0, 218, `the rest is blocked time before the next burst. Each boat sends once per cycle, in its own slot.`, { size: 12 }));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="680" height="230" viewBox="0 0 680 230" role="img"><title>One ${periodMs / 1000} second cycle of the transmit slot schedule</title><desc>A timeline from one RTCM correction burst to the next: a burst and guard, ${L.assignable} boat slots, ${joinN} shared join slots, the base slot, then a blocked period before the next burst.</desc><rect width="680" height="230" fill="#ffffff"/>\n${out.join('\n')}\n</svg>\n`;
}

function compareSvg() {
  const scale = 600 / 2000;
  const x0 = 40;
  const out = [];
  [[1000, 44], [2000, 160]].forEach(([p, y], idx) => {
    const L = layout(p);
    const nOf = (i) => x0 + (after + i * width) * scale;
    out.push(text(x0, y - 12, `${p / 1000} s interval${p === config.txGate.slot.rtcmIntervalS * 1000 ? ' (default)' : ''}`, { size: 14, weight: 500 }));
    out.push(text(x0 + 150, y - 12, `${L.total} slots: ${L.assignable} boats + ${joinN} join + 1 base`));
    out.push(rect(x0, y, after * scale, 34, C.burst));
    out.push(rect(nOf(0), y, L.assignable * width * scale, 34, C.boat));
    out.push(text(nOf(0) + L.assignable * width * scale / 2, y + 17, `${L.assignable} boat slots`, { anchor: 'middle', fill: C.boat[2], size: 14, weight: 500, central: true }));
    out.push(rect(nOf(L.assignable), y, joinN * width * scale, 34, C.join));
    out.push(rect(nOf(L.boatSlots), y, width * scale, 34, C.base));
    out.push(rect(nOf(L.total), y, x0 + p * scale - nOf(L.total), 34, C.blocked));
    out.push(text(x0 + p * scale, y + 52, `next burst at ${p} ms`, { anchor: 'end', size: 11, fill: '#5F5E5A' }));
  });
  out.push(text(x0, 262, `Same time scale; slots are ${width} ms wide at both intervals.`, { size: 12 }));
  out.push(text(x0, 280, 'Each boat sends once per cycle: once a second at 1 s, once every 2 s at 2 s.', { size: 12 }));
  const a = layout(1000), b = layout(2000);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="680" height="300" viewBox="0 0 680 300" role="img"><title>1 second versus 2 second RTCM interval, same scale</title><desc>Two timelines at the same scale. With corrections every 1 second there are ${a.total} slots: ${a.assignable} for boats, ${joinN} join and 1 base. With corrections every 2 seconds there are ${b.total}: ${b.assignable} for boats, ${joinN} join and 1 base.</desc><rect width="680" height="300" fill="#ffffff"/>\n${out.join('\n')}\n</svg>\n`;
}

fs.writeFileSync(path.join(__dirname, 'tdma-cycle-2s.svg'), cycleSvg(config.txGate.slot.rtcmIntervalS * 1000));
fs.writeFileSync(path.join(__dirname, 'tdma-1s-vs-2s.svg'), compareSvg());
const a = layout(1000), b = layout(2000);
console.log(`wrote docs/tdma-cycle-2s.svg and docs/tdma-1s-vs-2s.svg: 1 s = ${a.total} slots (${a.assignable} boats), 2 s = ${b.total} slots (${b.assignable} boats), ${width} ms slots`);
