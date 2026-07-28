const Redis = require('ioredis');
const { getMarks: computeMarks } = require('./course');

const MARK_NAMES = ['windward', 'leeward', 'pin', 'committee', 'finish'];

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
class RedisStore {
  // Accepts either a connection URL string (`url`) or an ioredis connection
  // options object (`connection`, e.g. {host, port, username, password,
  // tls}); `url` wins if both are given. See config.js for how these map to
  // REDIS_URL / REDIS_ENV.
  constructor({ url, connection }) {
    // Fixed 3s retry backoff, matching the reconnect cadence used elsewhere
    // in this app (radioLink.js, boatAgent.js's GPS reopen) instead of
    // ioredis's default rapid-fire retry.
    const retryOpts = { lazyConnect: true, retryStrategy: () => 3000 };
    this.client = url ? new Redis(url, retryOpts) : new Redis({ ...connection, ...retryOpts });
    this.client.on('error', (err) => console.error('[redis] error:', err.message));
    this.ready = this.client.connect().catch((err) => {
      console.error('[redis] connect failed:', err.message);
    });
  }

  async recordFix(decoded, receivedAt) {
    await this.ready;
    const member = JSON.stringify({ ...decoded, receivedAt: receivedAt.toISOString() });
    const score = decoded.timestamp;
    await Promise.all([
      this.client.zadd(`boat:${decoded.boatId}:track`, score, member),
      this.client.zadd('all:track', score, member),
      this.client.sadd('boats:known', String(decoded.boatId)),
    ]);
  }

  // fromMs/toMs are inclusive; omit either for an open-ended range.
  async getBoatTrack(boatId, fromMs, toMs) {
    await this.ready;
    const members = await this.client.zrangebyscore(
      `boat:${boatId}:track`,
      fromMs ?? '-inf',
      toMs ?? '+inf'
    );
    return members.map((m) => JSON.parse(m));
  }

  async getAllTrack(fromMs, toMs) {
    await this.ready;
    const members = await this.client.zrangebyscore('all:track', fromMs ?? '-inf', toMs ?? '+inf');
    return members.map((m) => JSON.parse(m));
  }

  async knownBoatIds() {
    await this.ready;
    return this.client.smembers('boats:known');
  }

  // Course marks: five entries (`mark:windward`, `mark:leeward`, `mark:pin`,
  // `mark:committee`, `mark:finish`), each a Redis hash with lat/lon fields -
  // so boats can be checked against where the marks actually are (e.g.
  // confirming a rounding), and so anything else (a dashboard, race software, another
  // simulator) has one shared place to look up the course.
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

  async close() {
    await this.client.quit();
  }
}

module.exports = { RedisStore };
