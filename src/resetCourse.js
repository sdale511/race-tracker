const config = require('./config');
const { RedisStore } = require('./redisStore');
const { zonePolygon } = require('./onGridWatcher');
const { COURSE_LENGTH_NM, LONG_COURSE_EXTRA_NM, FINISH_OFFSET_NORTH_M, FINISH_OFFSET_EAST_M, NM_TO_M, deriveGeometry } = require('./course');

// Clears the course, then immediately republishes a fresh one from current
// defaults (SIM_CENTER_LAT/SIM_CENTER_LON/SIM_COURSE_LENGTH_NM/
// SIM_LONG_COURSE_EXTRA_NM/SIM_FINISH_OFFSET_NORTH_M/SIM_FINISH_OFFSET_EAST_M
// - see config.js/course.js) - one command, not two. There's no real
// scenario where an operator wants the course marks simply gone with
// nothing to replace them (a boat or the admin dashboard querying in that
// window would see no course at all) - this replaces the old `npm run
// clear-course` (clearCourse.js), which only did the delete half and left
// republishing to whatever ran `npm run base` next, whenever that happened
// to be. Run with `npm run reset-course` (respects REDIS_ENV/REDIS_URL same
// as boatAgent/baseStation, see README's "Redis track storage"). Boat
// tracks are left untouched - see `npm run clear-boats` for those.
(async () => {
  const target = config.redis.url || `${config.redis.connection.host}:${config.redis.connection.port}`;
  console.log(`[resetCourse] connecting to Redis at ${target}`);
  // Every parameter that actually shapes the geometry being published below
  // - printed up front so it's obvious exactly what's about to replace the
  // old course, not just that *something* got reset. Each one's env var is
  // shown alongside it, same reasoning as configReport.js's own table: the
  // knob to change it should be visible right next to its current value.
  console.log('[resetCourse] course parameters:');
  console.log(`  centerLat / centerLon:     ${config.sim.centerLat} / ${config.sim.centerLon}  (SIM_CENTER_LAT / SIM_CENTER_LON)`);
  console.log(`  courseMarks:               ${config.sim.courseMarks}  - which pair a boat actually races  (SIM_COURSE_MARKS)`);
  console.log(`  courseLengthNm (green):    ${COURSE_LENGTH_NM} nm  - leewardGreen<->windwardGreen  (SIM_COURSE_LENGTH_NM)`);
  console.log(`  longCourseExtraNm:         ${LONG_COURSE_EXTRA_NM} nm  - how much further out each black mark sits  (SIM_LONG_COURSE_EXTRA_NM)`);
  console.log(`  finishOffsetNorth / East:  ${FINISH_OFFSET_NORTH_M}m / ${FINISH_OFFSET_EAST_M}m  (SIM_FINISH_OFFSET_NORTH_M / SIM_FINISH_OFFSET_EAST_M)`);
  console.log(`  onGridZoneM:               ${config.regattaup.onGridZoneM}m  (REGATTAUP_ONGRID_ZONE_M)`);
  const redisStore = new RedisStore({ url: config.redis.url, connection: config.redis.connection });
  try {
    const cleared = await redisStore.clearCourseMarks();
    if (cleared.length > 0) {
      console.log(`[resetCourse] cleared ${cleared.length} key(s):`);
      for (const key of cleared) console.log(`  - ${key}`);
    } else {
      console.log('[resetCourse] no course marks found - publishing fresh anyway');
    }

    const marks = await redisStore.getOrCreateMarks(config.sim.centerLat, config.sim.centerLon);
    console.log(`[resetCourse] published fresh course marks: ${Object.keys(marks).join(', ')}`);
    // The beat length a boat actually sails is courseLengthNm above ONLY for
    // the plain green course ('GG') - measured fresh off the real marks
    // (same as simGps.js's own deriveGeometry call) so this is always
    // correct for whichever pair courseMarks picked, mixed ('BG'/'GB')
    // included, not just assumed from the raw constants.
    const { courseLengthM } = deriveGeometry(marks, config.sim.courseMarks);
    console.log(`[resetCourse] active course length (${config.sim.courseMarks}): ${(courseLengthM / NM_TO_M).toFixed(3)} nm`);

    await redisStore.setOnGridZone(zonePolygon(marks, config.regattaup.onGridZoneM));
    console.log('[resetCourse] published fresh on-grid zone');

    console.log('[resetCourse] boat tracks left untouched');
  } catch (err) {
    console.error('[resetCourse] failed:', err.message);
    process.exitCode = 1;
  } finally {
    await redisStore.close();
  }
})();
