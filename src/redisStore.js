const Redis = require('ioredis');

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
  constructor({ url }) {
    // Fixed 3s retry backoff, matching the reconnect cadence used elsewhere
    // in this app (radioLink.js, boatAgent.js's GPS reopen) instead of
    // ioredis's default rapid-fire retry.
    this.client = new Redis(url, { lazyConnect: true, retryStrategy: () => 3000 });
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

  async close() {
    await this.client.quit();
  }
}

module.exports = { RedisStore };
