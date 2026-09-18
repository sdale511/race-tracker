const fs = require('fs');
const path = require('path');
const config = require('./config');
const { RedisStore } = require('./redisStore');
const { VALID_FILENAME } = require('./uploadServer');

// Clears every boat-related key in Redis (tracks, boats:known, start slot
// assignments) so a fresh fleet can race the same course without stale
// boats/tracks left over from earlier runs - deliberately leaves the course
// marks alone. Also clears this base's own local boat-related files for the
// active regatta: its received-fix CSV logs
// (BASE_LOG_DIR/<regattaId>/base_station_received_*.csv - BASE_LOG_DIR is
// base-only, see config.js's own boatLogDir comment for why a boat's SD log
// lives in a completely separate directory and is never touched here) and
// every uploaded boat log under BASE_UPLOAD_DIR/<regattaId>/<boatId>/*.csv
// (see baseStation.js's ensureCsvFile/uploadServer.js's own regatta-nested
// boatDir) - both now nested under whichever regatta they were recorded
// during, the same regatta scoping Redis boat data already uses, so this
// only ever touches the active regatta's own history, never another
// regatta's. Also removes anything still sitting in the OLD flat layout
// from before that nesting existed (base_station_received_*.csv directly in
// BASE_LOG_DIR, boat-id directories directly in BASE_UPLOAD_DIR) - not
// regatta-scoped, since those predate the whole regatta-nesting concept and
// there's no regatta to scope them to. Run with `npm run clear-base-logs`
// (respects REDIS_ENV/REDIS_URL same as boatAgent/baseStation, see README's
// "Redis track storage"). To clear a boat's own SD log instead, see
// `npm run clear-boat-logs`.
(async () => {
  // Regatta selection is never stored in Redis itself (see
  // regattaIdFile.js), so the only source available to a standalone script
  // like this one is REGATTAUP_REGATTA_ID/regatta-id.txt
  // (config.regattaup.defaultRegatta) - pass REGATTAUP_REGATTA_ID explicitly
  // to target a different regatta. Computed once, up front, so every
  // section below agrees on the same regatta context. regattaKey ('none'
  // when nothing's selected) is the literal directory-name form - matches
  // baseStation.js's own `currentRegattaId || 'none'` convention exactly.
  const regattaKey = config.regattaup.defaultRegatta ? config.regattaup.defaultRegatta.id : 'none';
  const regattaLabel = config.regattaup.defaultRegatta
    ? `${config.regattaup.defaultRegatta.id}${config.regattaup.defaultRegatta.name ? ` (${config.regattaup.defaultRegatta.name})` : ''}`
    : 'none (no regatta selected - see REGATTAUP_REGATTA_ID or the admin dashboard)';
  console.log(`[clearBaseLogs] regatta: ${regattaLabel}`);

  const target = config.redis.url || `${config.redis.connection.host}:${config.redis.connection.port}`;
  console.log(`[clearBaseLogs] connecting to Redis at ${target}`);
  const redisStore = new RedisStore({ url: config.redis.url, connection: config.redis.connection });
  try {
    // Every boat key lives under regattas:<id>:... (see redisStore.js's own
    // module comment) - without this, clearBoatData falls back to the
    // regattas:none: namespace instead of whichever regatta is actually
    // selected, which is almost always empty and clears nothing real. Same
    // fix resetCourse.js already applies for the same reason.
    if (config.regattaup.defaultRegatta) {
      redisStore.setCurrentRegatta(config.regattaup.defaultRegatta.id);
    }
    const cleared = await redisStore.clearBoatData();
    if (cleared.length === 0) {
      console.log('[clearBaseLogs] no boat keys found in Redis - nothing to clear (marks left untouched)');
    } else {
      console.log(`[clearBaseLogs] cleared ${cleared.length} Redis key(s):`);
      for (const key of cleared) console.log(`  - ${key}`);
      console.log('[clearBaseLogs] marks left untouched');
    }
  } catch (err) {
    console.error('[clearBaseLogs] failed to clear Redis:', err.message);
    process.exitCode = 1;
  } finally {
    await redisStore.close();
  }

  // Removes a directory if present, silent no-op if it never existed -
  // shared by every section below instead of repeating the same
  // try/ENOENT-swallow four times.
  function removeDirIfPresent(dirPath) {
    if (!fs.existsSync(dirPath)) return false;
    fs.rmSync(dirPath, { recursive: true, force: true });
    return true;
  }

  console.log(`[clearBaseLogs] clearing local files for regatta: ${regattaLabel}`);
  // BASE_LOG_DIR is base-only (see config.js's own boatLogDir comment) - a
  // boat's SD log lives in a completely separate directory (BOAT_LOG_DIR)
  // this script never touches.
  const baseCsvDir = path.join(config.logDir, regattaKey);
  const removedCsvDir = removeDirIfPresent(baseCsvDir);
  console.log(
    removedCsvDir
      ? `[clearBaseLogs] removed ${baseCsvDir}`
      : `[clearBaseLogs] no received-fix CSV logs found for this regatta - nothing to clear`
  );
  const removedUploadDir = removeDirIfPresent(path.join(config.upload.dir, regattaKey));
  console.log(
    removedUploadDir
      ? `[clearBaseLogs] removed ${path.join(config.upload.dir, regattaKey)}`
      : `[clearBaseLogs] no uploaded boat logs found for this regatta - nothing to clear`
  );

  // Leftovers from before CSV logs/uploads were nested under a regatta id -
  // not regatta-scoped (there's no regatta to scope them to), so this
  // always runs regardless of regattaKey above. See this file's own module
  // comment for why these aren't migrated, just removed.
  try {
    const csvPattern = /^base_station_received_.*\.csv$/;
    const legacyCsvFiles = fs.readdirSync(config.logDir).filter((f) => csvPattern.test(f));
    for (const file of legacyCsvFiles) fs.unlinkSync(path.join(config.logDir, file));
    if (legacyCsvFiles.length > 0) {
      console.log(`[clearBaseLogs] removed ${legacyCsvFiles.length} old-structure received-fix CSV log(s) from ${config.logDir}`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[clearBaseLogs] failed to clear old-structure CSV logs in ${config.logDir}:`, err.message);
      process.exitCode = 1;
    }
  }

  try {
    // A directory sitting directly under BASE_UPLOAD_DIR that itself
    // directly contains boat CSV files (VALID_FILENAME) is the OLD layout
    // (BASE_UPLOAD_DIR/<boatId>/*.csv) - the NEW layout has an extra regattaId
    // level in between (UPLOAD_DIR/<regattaId>/<boatId>/*.csv), so a
    // regatta directory's own immediate children are further directories,
    // never CSV files directly. That structural check is what tells the
    // two apart, not guessing at what a boat id vs. a regatta id looks like.
    const entries = fs.readdirSync(config.upload.dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    let legacyBoatDirs = 0;
    for (const entry of entries) {
      const entryPath = path.join(config.upload.dir, entry.name);
      const isLegacyBoatDir = fs.readdirSync(entryPath).some((f) => VALID_FILENAME.test(f));
      if (isLegacyBoatDir) {
        fs.rmSync(entryPath, { recursive: true, force: true });
        legacyBoatDirs++;
      }
    }
    if (legacyBoatDirs > 0) {
      console.log(`[clearBaseLogs] removed ${legacyBoatDirs} old-structure boat upload dir(s) from ${config.upload.dir}`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[clearBaseLogs] failed to clear old-structure uploads in ${config.upload.dir}:`, err.message);
      process.exitCode = 1;
    }
  }
})();
