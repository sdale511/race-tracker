const config = require('./config');
const { RedisStore } = require('./redisStore');

// Clears the five `mark:*` keys in Redis so the next boatAgent/baseStation
// run recomputes and republishes the course from scratch (e.g. after
// changing SIM_COURSE_LENGTH_NM or SIM_CENTER_LAT/LON) instead of reusing
// whatever course is already there - deliberately leaves boat tracks alone
// (see `npm run clear-boats` for those). Run with `npm run clear-course`
// (respects REDIS_ENV/REDIS_URL same as boatAgent/baseStation, see README's
// "Redis track storage").
(async () => {
  const target = config.redis.url || `${config.redis.connection.host}:${config.redis.connection.port}`;
  console.log(`[clearCourse] connecting to Redis at ${target}`);
  const redisStore = new RedisStore({ url: config.redis.url, connection: config.redis.connection });
  try {
    const cleared = await redisStore.clearCourseMarks();
    if (cleared.length === 0) {
      console.log('[clearCourse] no course marks found - nothing to clear (boat tracks left untouched)');
    } else {
      console.log(`[clearCourse] cleared ${cleared.length} key(s):`);
      for (const key of cleared) console.log(`  - ${key}`);
      console.log('[clearCourse] boat tracks left untouched');
    }
  } catch (err) {
    console.error('[clearCourse] failed:', err.message);
    process.exitCode = 1;
  } finally {
    await redisStore.close();
  }
})();
