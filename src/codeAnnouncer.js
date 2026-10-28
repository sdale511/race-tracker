// Decides which transponder codes - a rover's boat id is its code (the webhooks send it as tranCode) - are new to the
// selected regatta and so need an "info" hit to RegattaUp, which lists the code in its code management for someone to
// assign to a boat. Each code is announced once: remembered in memory for this run, and - so a base restart does not
// announce every boat on the water again - skipped when the regatta's Redis boats:known set already has it (a boat
// heard before, by this run or an earlier one).

// isKnown(boatId) -> Promise<boolean>: the regatta already has a track for this code.
// announce(event): queue the hit. getRegattaId(): the selected regatta, falsy when none.
function createCodeAnnouncer({ isKnown, announce, getRegattaId }) {
  const handled = new Set(); // `${regattaId}:${boatId}`
  // Called with every accepted fix, BEFORE it is written to Redis (which is what adds the boat to boats:known).
  // Resolves to whether this fix made the code count as new.
  return async function noteCode(decoded) {
    const regattaId = getRegattaId();
    if (!regattaId) return false;
    const key = `${regattaId}:${decoded.boatId}`;
    if (handled.has(key)) return false;
    handled.add(key);
    try {
      if (await isKnown(decoded.boatId)) return false;
    } catch (err) {
      // Redis unreachable: announce anyway. A code RegattaUp already has is a no-op there; a code it never hears about
      // is one nobody can assign.
    }
    announce({
      boatId: decoded.boatId,
      rtcTime: decoded.timestamp * 1000, // ms -> microseconds, like the other events
      strength: decoded.carrSoln,
      receivedAt: new Date().toISOString(),
    });
    return true;
  };
}

module.exports = { createCodeAnnouncer };
