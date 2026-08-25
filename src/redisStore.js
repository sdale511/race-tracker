const Redis = require('ioredis');
const { getMarks: computeMarks, METERS_PER_DEG_LAT, MARK_NAMES } = require('./course');

// Flat-earth approximation (same style as course.js's offsetToLatLon) - fine
// at the meter-scale distances this is used for (deciding whether a fix
// moved far enough to be worth recording), not meant for long distances.
function distanceMeters(lat1, lon1, lat2, lon2) {
  const dNorth = (lat2 - lat1) * METERS_PER_DEG_LAT;
  const dEast = (lon2 - lon1) * METERS_PER_DEG_LAT * Math.cos((lat1 * Math.PI) / 180);
  return Math.sqrt(dNorth * dNorth + dEast * dEast);
}

// Records every decoded boat fix into Redis, indexed two ways so both
// query patterns the race committee needs are a single range read rather
// than a fan-out scan:
//
//   - `boat:<id>:track` - one sorted set per boat, for "give me this boat's
//     track" (optionally within a timeframe).
//   - `all:track`        - one sorted set holding every boat's fixes, for
//     "give me all boats' positions within this timeframe" (e.g. replaying
//     the whole fleet at a point in the race) without knowing boat IDs
//     up front.
//
// Both are scored by the fix's own GPS timestamp (ms since epoch) rather
// than when the base station happened to receive it, so a track reflects
// when the boat was actually there even if frames arrive slightly late or
// out of order over the radio.
//
// Stored members use short keys (see packFix/unpackFix) rather than the
// full field names - with a fleet reporting every couple seconds over a
// multi-hour race, the field names alone (`boatId`, `speedKnots`,
// `headingDeg`, `gnssFixOk`, `receivedAt`, ...) would otherwise account for
// close to half of every stored record. `timestamp` isn't stored at all -
// it's already the sorted-set score, so it's recovered via WITHSCORES on
// read instead of being duplicated in the payload. Callers still get back
// full, friendly field names from getBoatTrack/getAllTrack - the shortening
// is purely a storage-format detail.
const FIX_KEYS = { b: 'boatId', la: 'lat', lo: 'lon', s: 'speedKnots', h: 'headingDeg', f: 'gnssFixOk', c: 'carrSoln', n: 'numSV', r: 'receivedAt' };

function packFix(decoded, receivedAt) {
  return JSON.stringify({
    b: decoded.boatId,
    la: decoded.lat,
    lo: decoded.lon,
    s: decoded.speedKnots,
    h: decoded.headingDeg,
    f: decoded.gnssFixOk,
    c: decoded.carrSoln,
    n: decoded.numSV,
    r: receivedAt.getTime(),
  });
}

function unpackFix(member, timestamp) {
  const packed = JSON.parse(member);
  const fix = { timestamp };
  for (const [short, full] of Object.entries(FIX_KEYS)) fix[full] = packed[short];
  fix.receivedAt = new Date(fix.receivedAt).toISOString();
  return fix;
}

// ioredis's WITHSCORES reply is a flat [member, score, member, score, ...]
// array - pair them up and unpack each, recovering the timestamp from its
// score instead of a stored field (see module comment above).
function unpackWithScores(withScores) {
  const fixes = [];
  for (let i = 0; i < withScores.length; i += 2) {
    fixes.push(unpackFix(withScores[i], Number(withScores[i + 1])));
  }
  return fixes;
}

class RedisStore {
  // Accepts either a connection URL string (`url`) or an ioredis connection
  // options object (`connection`, e.g. {host, port, username, password,
  // tls}); `url` wins if both are given. See config.js for how these map to
  // REDIS_URL / REDIS_ENV. `minMovementM` (default 5) is the threshold
  // recordFix uses to skip writes from a boat that hasn't moved far enough
  // to be worth recording - see recordFix.
  constructor({ url, connection, minMovementM = 5 }) {
    // Fixed 3s retry backoff, matching the reconnect cadence used elsewhere
    // in this app (radioLink.js, boatAgent.js's GPS reopen) instead of
    // ioredis's default rapid-fire retry.
    const retryOpts = { lazyConnect: true, retryStrategy: () => 3000 };
    this.client = url ? new Redis(url, retryOpts) : new Redis({ ...connection, ...retryOpts });
    this.client.on('error', (err) => console.error('[redis] error:', err.message));
    this.ready = this.client.connect().catch((err) => {
      console.error('[redis] connect failed:', err.message);
    });
    this.minMovementM = minMovementM;
    // In-memory only (per boatId) - not persisted, so a restarted base
    // station just records the next fix from each boat unconditionally
    // (nothing to compare against yet), which is harmless.
    this.lastRecordedPosition = new Map();
  }

  // Skips the write (SD/console/UDP logging elsewhere are unaffected,
  // this only governs what lands in Redis) unless this is the first fix
  // seen for the boat, or it's moved at least minMovementM since the last
  // fix that WAS recorded - a stopped or barely-drifting boat reporting
  // every couple seconds would otherwise write a nearly-identical fix over
  // and over for no benefit.
  async recordFix(decoded, receivedAt) {
    await this.ready;
    const last = this.lastRecordedPosition.get(decoded.boatId);
    if (last && distanceMeters(last.lat, last.lon, decoded.lat, decoded.lon) < this.minMovementM) return;

    const member = packFix(decoded, receivedAt);
    const score = decoded.timestamp;
    await Promise.all([
      this.client.zadd(`boat:${decoded.boatId}:track`, score, member),
      this.client.zadd('all:track', score, member),
      this.client.sadd('boats:known', String(decoded.boatId)),
    ]);
    this.lastRecordedPosition.set(decoded.boatId, { lat: decoded.lat, lon: decoded.lon });
  }

  // fromMs/toMs are inclusive; omit either for an open-ended range.
  async getBoatTrack(boatId, fromMs, toMs) {
    await this.ready;
    const withScores = await this.client.zrangebyscore(
      `boat:${boatId}:track`,
      fromMs ?? '-inf',
      toMs ?? '+inf',
      'WITHSCORES'
    );
    return unpackWithScores(withScores);
  }

  async getAllTrack(fromMs, toMs) {
    await this.ready;
    const withScores = await this.client.zrangebyscore('all:track', fromMs ?? '-inf', toMs ?? '+inf', 'WITHSCORES');
    return unpackWithScores(withScores);
  }

  async knownBoatIds() {
    await this.ready;
    return this.client.smembers('boats:known');
  }

  // Course marks: one entry per MARK_NAMES (`mark:windwardGreen`,
  // `mark:pin`, `mark:committeeStart`, `mark:committeeFinish`, ...), each a
  // Redis hash with lat/lon fields - so boats can be checked against where
  // the marks actually are (e.g. confirming a rounding), and so anything
  // else (a dashboard, race software, another simulator) has one shared
  // place to look up the course.
  async setMark(name, { lat, lon }) {
    await this.ready;
    await this.client.hset(`mark:${name}`, { lat: String(lat), lon: String(lon) });
  }

  async getMark(name) {
    await this.ready;
    const h = await this.client.hgetall(`mark:${name}`);
    if (!h || h.lat === undefined) return null;
    return { lat: parseFloat(h.lat), lon: parseFloat(h.lon) };
  }

  async getMarks() {
    const values = await Promise.all(MARK_NAMES.map((name) => this.getMark(name)));
    return Object.fromEntries(MARK_NAMES.map((name, i) => [name, values[i]]));
  }

  async setMarks(marks) {
    await Promise.all(Object.entries(marks).map(([name, pos]) => this.setMark(name, pos)));
  }

  // Reads the course marks from Redis if all five are already set - so
  // multiple simulators (or a restarted base station) racing the same
  // course agree on identical mark positions instead of each computing its
  // own. Otherwise computes them from the given center point (see
  // course.js) and publishes them, so whichever process asks first defines
  // the course for everyone after it. Not atomic (a get-then-set race is
  // possible if two processes start at the exact same instant), which is
  // an acceptable tradeoff for a test/simulation tool.
  async getOrCreateMarks(centerLat, centerLon) {
    const existing = await this.getMarks();
    if (MARK_NAMES.every((name) => existing[name])) return existing;
    const computed = computeMarks(centerLat, centerLon);
    await this.setMarks(computed);
    return computed;
  }

  // Deletes the five `mark:*` keys (plus the derived on-grid zone, so a
  // reader mid-transition sees "no zone" rather than one computed from
  // marks that no longer exist), so the next getOrCreateMarks call
  // recomputes and republishes the course from scratch instead of reusing
  // whatever's already there - needed any time the course geometry itself
  // changes (e.g. SIM_COURSE_LENGTH_NM), since getOrCreateMarks otherwise
  // has no way to tell "marks exist" from "marks exist but are stale".
  // Leaves boat tracks/start slots untouched (see clearBoatData for those).
  async clearCourseMarks() {
    await this.ready;
    const keys = [...MARK_NAMES.map((name) => `mark:${name}`), 'course:on_grid_zone'];
    const existingKeys = [];
    for (const key of keys) {
      if (await this.client.exists(key)) existingKeys.push(key);
    }
    if (existingKeys.length > 0) await this.client.del(...existingKeys);
    return existingKeys;
  }

  // The on-grid detection zone's own boundary - the exact quadrilateral
  // OnGridWatcher.check tests against (see onGridWatcher.js's zonePolygon),
  // published so anything outside this process (RegattaUp, another
  // dashboard, a course-review tool) can draw or reason about the same
  // zone without re-deriving the geometry itself and risking it drift out
  // of sync with what actually gets detected. A single JSON-array key
  // (`course:on_grid_zone`), not a hash per point like mark:* - this is one
  // ordered polygon, not named fields.
  async setOnGridZone(polygon) {
    await this.ready;
    await this.client.set('course:on_grid_zone', JSON.stringify(polygon));
  }

  async getOnGridZone() {
    await this.ready;
    const raw = await this.client.get('course:on_grid_zone');
    return raw ? JSON.parse(raw) : null;
  }

  // Assigns each boat a 0-based start-line slot by registration order (the
  // first boat to ask gets slot 0, the next gets slot 1, etc.) - NOT derived
  // from the boat's own ID/sail number, which could be any value (51, 52,
  // ...) and isn't a small sequential count, so using it directly would
  // place boats however far off the line their ID happens to imply. The
  // mapping is persisted (`boats:start_slots`, a hash of boatId -> slot) so
  // a boat that reconnects gets the same slot back rather than a new one.
  // The increment + HSETNX pair makes this safe if two boats register at
  // the same instant: whichever loses the HSETNX race re-reads the slot the
  // winner actually got, rather than both ending up on the same slot.
  async getOrAssignStartSlot(boatId) {
    await this.ready;
    const key = String(boatId);
    const existing = await this.client.hget('boats:start_slots', key);
    if (existing !== null) return parseInt(existing, 10);
    const slot = (await this.client.incr('boats:start_slot_counter')) - 1;
    const added = await this.client.hsetnx('boats:start_slots', key, slot);
    if (added) return slot;
    const assigned = await this.client.hget('boats:start_slots', key);
    return parseInt(assigned, 10);
  }

  // Deletes every boat-related key (tracks, the known-boats set, and start
  // slot assignments) - deliberately leaves the course marks untouched, so
  // the same course can keep being raced by a fresh fleet without
  // recomputing/republishing marks. Returns the keys that were deleted, for
  // whatever's calling this to report back.
  async clearBoatData() {
    await this.ready;
    const boatIds = await this.client.smembers('boats:known');
    const keys = [
      ...boatIds.map((id) => `boat:${id}:track`),
      'all:track',
      'boats:known',
      'boats:start_slots',
      'boats:start_slot_counter',
    ];
    const existingKeys = [];
    for (const key of keys) {
      if (await this.client.exists(key)) existingKeys.push(key);
    }
    if (existingKeys.length > 0) await this.client.del(...existingKeys);
    return existingKeys;
  }

  // Which regatta (from RegattaUp's own getActiveRegattas list - see
  // baseStation.js) this base station is currently reporting for - a
  // single key (`regatta:selected`), the whole regatta object as JSON, not
  // just its id. Storing the full object (not just the id) means the
  // end-date expiry check in baseStation.js can run without a live
  // RegattaUp call, and survives that regatta later dropping out of
  // RegattaUp's own "active" list before its own end_date arrives.
  async setSelectedRegatta(regatta) {
    await this.ready;
    await this.client.set('regatta:selected', JSON.stringify(regatta));
  }

  async getSelectedRegatta() {
    await this.ready;
    const raw = await this.client.get('regatta:selected');
    return raw ? JSON.parse(raw) : null;
  }

  async clearSelectedRegatta() {
    await this.ready;
    await this.client.del('regatta:selected');
  }

  // For the admin dashboard's connection indicator - ioredis's own
  // connection state machine, exposed here rather than reaching into
  // .client directly from outside this class.
  isConnected() {
    return this.client.status === 'ready';
  }

  // Cheap counts for the admin dashboard (adminServer.js) - ZCARD instead
  // of fetching full tracks (getBoatTrack/getAllTrack), so this stays fast
  // regardless of how much data has accumulated over a race day.
  async getStats() {
    await this.ready;
    const boatIds = await this.client.smembers('boats:known');
    const [totalTracks, perBoatCounts] = await Promise.all([
      this.client.zcard('all:track'),
      Promise.all(boatIds.map((id) => this.client.zcard(`boat:${id}:track`))),
    ]);
    const tracksByBoat = Object.fromEntries(boatIds.map((id, i) => [id, perBoatCounts[i]]));
    return { totalTracks, boatsKnown: boatIds.length, tracksByBoat };
  }

  async close() {
    await this.client.quit();
  }
}

module.exports = { RedisStore };
