// Is a decoded position fix believable? A corrupted radio frame can still pass the frame's checksum (an 8-bit sum lets about 1
// in 256 corrupted frames through), and then carries garbage in every field: a boat id of control characters, a latitude of
// -156, a time in 1994 or 2049. Stored, such a fix sets the map's "latest time" to 2049 and breaks its track drawing. This
// is checked before a fix is recorded anywhere (see baseStation.js's handleDecodedFrame and redisStore.js's recordFix).

const MAX_SPEED_KN = 200; // land yachts reach about 60
const MAX_TIME_SKEW_MS = 48 * 3600 * 1000; // generous: a board's clock can be off, a replay can be days old - but not decades

// Returns null when the fix looks fine, otherwise a short reason.
function implausibleReason(fix, nowMs = Date.now()) {
  if (!fix || typeof fix !== 'object') return 'not a fix';
  if (typeof fix.boatId !== 'string' || !/^[A-Za-z0-9_-]{1,12}$/.test(fix.boatId)) return `boat id ${JSON.stringify(fix.boatId)}`;
  if (!Number.isFinite(fix.lat) || Math.abs(fix.lat) > 90) return `latitude ${fix.lat}`;
  if (!Number.isFinite(fix.lon) || Math.abs(fix.lon) > 180) return `longitude ${fix.lon}`;
  if (fix.speedKnots != null && (!Number.isFinite(fix.speedKnots) || fix.speedKnots < 0 || fix.speedKnots > MAX_SPEED_KN)) return `speed ${fix.speedKnots}`;
  if (fix.timestamp != null && (!Number.isFinite(fix.timestamp) || Math.abs(fix.timestamp - nowMs) > MAX_TIME_SKEW_MS)) {
    return `time ${Number.isFinite(fix.timestamp) ? new Date(fix.timestamp).toISOString() : fix.timestamp}`;
  }
  return null;
}

module.exports = { implausibleReason, MAX_SPEED_KN, MAX_TIME_SKEW_MS };
