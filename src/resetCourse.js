const config = require('./config');
const { RedisStore } = require('./redisStore');
const { zonePolygon } = require('./onGridWatcher');
const {
  COURSE_LENGTH_NM,
  START_LINE_POSITION,
  START_SIDE_LENGTH_M,
  FINISH_SIDE_LENGTH_M,
  COMMITTEE_GAP_M,
  NM_TO_M,
  deriveGeometry,
  resolveCourseCenter,
} = require('./course');

// Clears the course, then immediately republishes a fresh one from current
// defaults (SIM_CENTER_LAT/SIM_CENTER_LON/SIM_COURSE_LENGTH_NM/
// SIM_START_LINE_POSITION/SIM_COMMITTEE_GAP_M - see config.js/course.js) -
// one command, not two. There's no real
// scenario where an operator wants the course marks simply gone with
// nothing to replace them (a boat or the admin dashboard querying in that
// window would see no course at all) - this replaces the old `npm run
// clear-course` (clearCourse.js), which only did the delete half and left
// republishing to whatever ran `npm run base` next, whenever that happened
// to be. Run with `npm run reset-course` (respects REDIS_ENV/REDIS_URL same
// as boatAgent/baseStation, see README's "Redis track storage"). Boat
// tracks are left untouched - see `npm run clear-base-logs` for those.
(async () => {
  const target = config.redis.url || `${config.redis.connection.host}:${config.redis.connection.port}`;
  console.log(`[resetCourse] connecting to Redis at ${target}`);
  // An operator's explicit SIM_CENTER_LAT/SIM_CENTER_LON always wins,
  // otherwise defaults to the persisted regatta's own venue coordinates
  // (RegattaUp's default_lat/default_lon, persisted alongside the id/name
  // in regatta-id.txt by selectRegatta/resetRegatta.js - see
  // regattaIdFile.js) rather than the hardcoded Black Rock Desert fallback,
  // same reasoning/rule as baseStation.js's own resolveMarks. See
  // resolveCourseCenter's own comment (course.js).
  const explicitCenterOverride = process.env.SIM_CENTER_LAT !== undefined || process.env.SIM_CENTER_LON !== undefined;
  const { lat: centerLat, lon: centerLon } = resolveCourseCenter(
    explicitCenterOverride ? undefined : config.regattaup.defaultRegatta && config.regattaup.defaultRegatta.defaultLat,
    explicitCenterOverride ? undefined : config.regattaup.defaultRegatta && config.regattaup.defaultRegatta.defaultLon,
    config.sim.centerLat,
    config.sim.centerLon
  );
  // Every parameter that actually shapes the geometry being published below
  // - printed up front so it's obvious exactly what's about to replace the
  // old course, not just that *something* got reset. Each one's env var is
  // shown alongside it, same reasoning as configReport.js's own table: the
  // knob to change it should be visible right next to its current value.
  console.log('[resetCourse] course parameters:');
  console.log(
    `  centerLat / centerLon:     ${centerLat} / ${centerLon}  ${
      explicitCenterOverride ? '(SIM_CENTER_LAT / SIM_CENTER_LON)' : '(regatta default, or SIM_CENTER_LAT / SIM_CENTER_LON fallback if none)'
    }`
  );
  console.log(
    `  courseLengthNm (${config.sim.courseMarks}):       ${COURSE_LENGTH_NM} nm  - overall leewardBlack<->windwardBlack; green is always half this, ` +
      `no separate knob  (SIM_COURSE_LENGTH_NM / SIM_COURSE_MARKS)`
  );
  console.log(`  startLinePosition:         ${START_LINE_POSITION}%  - 0=leeward end, 100=windward end  (SIM_START_LINE_POSITION)`);
  console.log(`  startLineLengthM:          ${START_SIDE_LENGTH_M.toFixed(1)}m  - pin<->committeeStart`);
  console.log(`  finishLineLengthM:         ${FINISH_SIDE_LENGTH_M.toFixed(1)}m  - committeeFinish<->finish`);
  console.log(`  committeeGapM:             ${COMMITTEE_GAP_M}m  - committeeStart<->committeeFinish  (SIM_COMMITTEE_GAP_M)`);
  console.log(`  onGridZoneM:               ${config.regattaup.onGridZoneM}m  (REGATTAUP_ONGRID_ZONE_M)`);
  const redisStore = new RedisStore({ url: config.redis.url, connection: config.redis.connection });
  try {
    // Every mark/on-grid-zone/pin-boundary key now lives under
    // `regattas:<id>:...` (see redisStore.js's own module comment) - this
    // has to pick the same regatta the base station would, before touching
    // anything, or it could silently reset a DIFFERENT regatta's course (or
    // the empty "none" namespace) instead of the one an operator actually
    // means. Regatta selection is never stored in Redis (see redisStore.js's
    // own comment on why - it's local to each base station process), so the
    // only source available to a standalone script like this one is
    // REGATTAUP_REGATTA_ID/regatta-id.txt (config.regattaup.defaultRegatta) -
    // pass REGATTAUP_REGATTA_ID explicitly if this needs to target a
    // regatta other than whatever's currently persisted locally.
    if (config.regattaup.defaultRegatta) {
      redisStore.setCurrentRegatta(config.regattaup.defaultRegatta.id);
    }
    console.log(
      `[resetCourse] resetting course for regatta: ${redisStore.currentRegattaId || 'none (no regatta selected - see REGATTAUP_REGATTA_ID or the admin dashboard)'}`
    );

    const cleared = await redisStore.clearCourseMarks();
    if (cleared.length > 0) {
      console.log(`[resetCourse] cleared ${cleared.length} key(s):`);
      for (const key of cleared) console.log(`  - ${key}`);
    } else {
      console.log('[resetCourse] no course marks found - publishing fresh anyway');
    }

    const marks = await redisStore.getOrCreateMarks(centerLat, centerLon);
    console.log(`[resetCourse] published fresh course marks: ${Object.keys(marks).join(', ')}`);
    // Sanity-check: measured fresh off the real just-published marks (same
    // as simGps.js's own deriveGeometry call), not just echoing the
    // courseLengthNm constant above - confirms what actually got published
    // matches what was requested, correct for a mixed pair ('BG'/'GB') too.
    const { courseLengthM } = deriveGeometry(marks, config.sim.courseMarks);
    console.log(`[resetCourse] active course length (${config.sim.courseMarks}): ${(courseLengthM / NM_TO_M).toFixed(3)} nm`);

    await redisStore.setOnGridZone(zonePolygon(marks, config.regattaup.onGridZoneM));
    console.log('[resetCourse] published fresh on-grid zone');

    // Never auto-enabled here - clearCourseMarks (above) already turned it
    // off along with everything else, and getOrCreateMarks has no concept
    // of it at all (it's a checkbox, not one of the marks that function
    // fills in) - stays off until an operator explicitly turns it back on
    // from the admin map.
    console.log('[resetCourse] pin boundary gate is off (toggle it from the admin map if you want it)');

    console.log('[resetCourse] boat tracks left untouched');
  } catch (err) {
    console.error('[resetCourse] failed:', err.message);
    process.exitCode = 1;
  } finally {
    await redisStore.close();
  }
})();
