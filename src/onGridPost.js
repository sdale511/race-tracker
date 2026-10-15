// Whether the base should tell RegattaUp "this boat is on the grid" for a fix inside the on-grid zone.
//
// Normally on entry, and again every ONGRID_RESEND_INTERVAL_MS while the boat stays. But a boat that is racing (it has crossed the start
// line and has not stopped since) and passes through the zone - clipping the pin end on its way round, or sailing back through the line -
// is not staged for a start, and an "on grid" event mid-race puts a racing boat back on the grid in RegattaUp. For such a boat the event is
// held: if it leaves the zone the event is dropped, and if it stays long enough to be parked (the slot table's dwell) the event goes then.
//
//   mode: the on-grid watcher's answer for this fix ('ongrid' | 'offgrid'); wasOnGrid: the watcher's state before this fix;
//   dueForResend: the resend latch has run out; racing: the boat has started and is not parked; held: an event is being held for it.
// Returns { action: 'post' | 'hold' | 'none', held } where held is the new held flag.
function decideOnGridPost({ mode, wasOnGrid, dueForResend, racing, held }) {
  if (mode !== 'ongrid') return { action: 'none', held: false }; // off the grid: nothing to send, and nothing to hold
  if (racing) return held ? { action: 'none', held: true } : !wasOnGrid ? { action: 'hold', held: true } : { action: 'none', held: false };
  if (!wasOnGrid || dueForResend || held) return { action: 'post', held: false };
  return { action: 'none', held: false };
}

module.exports = { decideOnGridPost };
