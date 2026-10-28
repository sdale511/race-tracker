// Decides which transponder codes - a rover's boat id is its code (the webhooks send it as tranCode) - need an "info" hit
// to RegattaUp, which lists the code in its code management for someone to assign to a boat. A code is announced the
// first time the base hears from the boat in the selected regatta - a position fix, or a status hello from a rover that
// has no GPS fix yet - and once more after each base restart. Nothing is remembered on disk or looked up in Redis: a
// code RegattaUp already has is a no-op there, while a boat the base had "already seen" but RegattaUp never heard about
// (heard before this existed, or while RegattaUp could not take the hit) would otherwise never be announced.

// announce(event): queue the hit. getRegattaId(): the selected regatta, falsy when none.
function createCodeAnnouncer({ announce, getRegattaId }) {
  const handled = new Set(); // `${regattaId}:${boatId}`
  // atMs: when the base heard the boat; strength: the signal stand-in the other events carry (0 for a hello, which has
  // no fix). Returns whether this call announced the code.
  return function noteCode(boatId, atMs, strength) {
    const regattaId = getRegattaId();
    if (!regattaId) return false; // not marked handled: the code is announced once a regatta is selected
    const key = `${regattaId}:${boatId}`;
    if (handled.has(key)) return false;
    handled.add(key);
    try {
      announce({
        boatId,
        rtcTime: atMs * 1000, // ms -> microseconds, like the other events
        strength: strength ?? 0,
        receivedAt: new Date().toISOString(),
      });
    } catch (err) {
      handled.delete(key); // try again on the boat's next frame
      throw err;
    }
    return true;
  };
}

module.exports = { createCodeAnnouncer };
