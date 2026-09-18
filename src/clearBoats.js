const fs = require('fs');
const path = require('path');
const config = require('./config');
const { RedisStore } = require('./redisStore');

// Clears every boat-related key in Redis (tracks, boats:known, start slot
// assignments) so a fresh fleet can race the same course without stale
// boats/tracks left over from earlier runs - deliberately leaves the course
// marks alone. Also clears this base's own local boat-related files: its
// received-fix CSV logs (LOG_DIR/base_station_received_*.csv - every frame
// this base has ever logged, real boats and anything else that ever
// transmitted to it, e.g. a radio-congestion-test run) and every uploaded
// boat log under UPLOAD_DIR (race-uploads/<boatId>/*.csv - nothing else
// ever lives in that directory, see uploadServer.js's own comment, so it's
// safe to clear entirely rather than needing to pick specific boat ids
// out). Run with `npm run clear-boats` (respects REDIS_ENV/REDIS_URL same
// as boatAgent/baseStation, see README's "Redis track storage").
(async () => {
  const target = config.redis.url || `${config.redis.connection.host}:${config.redis.connection.port}`;
  console.log(`[clearBoats] connecting to Redis at ${target}`);
  const redisStore = new RedisStore({ url: config.redis.url, connection: config.redis.connection });
  try {
    const cleared = await redisStore.clearBoatData();
    if (cleared.length === 0) {
      console.log('[clearBoats] no boat keys found in Redis - nothing to clear (marks left untouched)');
    } else {
      console.log(`[clearBoats] cleared ${cleared.length} Redis key(s):`);
      for (const key of cleared) console.log(`  - ${key}`);
      console.log('[clearBoats] marks left untouched');
    }
  } catch (err) {
    console.error('[clearBoats] failed to clear Redis:', err.message);
    process.exitCode = 1;
  } finally {
    await redisStore.close();
  }

  // Same known-filename pattern logRotation.js's own pruning already uses
  // (see baseStation.js's pruneOldLogs call) - matches only this base's own
  // received-fix logs, nothing else that might live in LOG_DIR.
  try {
    const csvPattern = /^base_station_received_.*\.csv$/;
    const csvFiles = fs.readdirSync(config.logDir).filter((f) => csvPattern.test(f));
    for (const file of csvFiles) fs.unlinkSync(path.join(config.logDir, file));
    console.log(
      csvFiles.length > 0
        ? `[clearBoats] removed ${csvFiles.length} received-fix CSV log(s) from ${config.logDir}`
        : `[clearBoats] no received-fix CSV logs found in ${config.logDir} - nothing to clear`
    );
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[clearBoats] failed to clear CSV logs in ${config.logDir}:`, err.message);
      process.exitCode = 1;
    }
  }

  try {
    const boatDirs = fs.readdirSync(config.upload.dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const entry of boatDirs) fs.rmSync(path.join(config.upload.dir, entry.name), { recursive: true, force: true });
    console.log(
      boatDirs.length > 0
        ? `[clearBoats] removed ${boatDirs.length} boat's uploaded log(s) from ${config.upload.dir}`
        : `[clearBoats] no uploaded boat logs found in ${config.upload.dir} - nothing to clear`
    );
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[clearBoats] failed to clear uploads in ${config.upload.dir}:`, err.message);
      process.exitCode = 1;
    }
  }
})();
