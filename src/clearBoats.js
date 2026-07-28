const config = require('./config');
const { RedisStore } = require('./redisStore');

// Clears every boat-related key in Redis (tracks, boats:known, start slot
// assignments) so a fresh fleet can race the same course without stale
// boats/tracks left over from earlier runs - deliberately leaves the course
// marks alone. Run with `npm run clear-boats` (respects REDIS_ENV/REDIS_URL
// same as boatAgent/baseStation, see README's "Redis track storage").
(async () => {
  const target = config.redis.url || `${config.redis.connection.host}:${config.redis.connection.port}`;
  console.log(`[clearBoats] connecting to Redis at ${target}`);
  const redisStore = new RedisStore({ url: config.redis.url, connection: config.redis.connection });
  try {
    const cleared = await redisStore.clearBoatData();
    if (cleared.length === 0) {
      console.log('[clearBoats] no boat keys found - nothing to clear (marks left untouched)');
    } else {
      console.log(`[clearBoats] cleared ${cleared.length} key(s):`);
      for (const key of cleared) console.log(`  - ${key}`);
      console.log('[clearBoats] marks left untouched');
    }
  } catch (err) {
    console.error('[clearBoats] failed:', err.message);
    process.exitCode = 1;
  } finally {
    await redisStore.close();
  }
})();
