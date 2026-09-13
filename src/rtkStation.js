require('./logTimestamps');
const config = require('./config');
const { createBaseGps } = require('./baseGps');
const { getDiskSpace } = require('./diskSpace');
const { startRtkAdminServer } = require('./rtkAdminServer');

// "RTK-only" mode - `npm run rtk`. For a base setup where the only thing
// that needs watching/configuring is the RTK correction source itself (the
// ArduSimpleRTK/ZED-F9P board and its TMODE3/survey-in state): none of
// baseStation.js's telemetry radio, course marks, fleet tracking, uploads,
// Redis, or RegattaUp reporting - just this GPS receiver and a small
// dashboard for it. `npm run base` (baseStation.js) remains the full mode,
// unchanged, for when a single machine is running the whole base station -
// this is for splitting the RTK correction source onto its own machine/
// process instead, so its dashboard isn't cluttered with (and its process
// doesn't depend on) telemetry/course/regatta concerns it has no part in.
//
// Deliberately shares its actual GPS/TMODE3 logic with baseStation.js
// rather than reimplementing it - see baseGps.js - and shares its admin
// cards/client JS with adminServer.js's own "Base GPS" section - see
// rtkAdminCards.js. This file is just the wiring between them.
function main() {
  // Unlike baseStation.js (which only opens a base GPS when GPS_PORT is
  // *explicitly* set, since most base stations have no GPS hardware
  // attached at all), this mode's entire purpose is that GPS - always
  // enabled, falling back to config.gps.port/baud's own defaults same as a
  // boat's own GPS does.
  const gps = createBaseGps({
    enabled: true,
    port: config.gps.port,
    baud: config.gps.baud,
    svinMinDurS: config.gps.svinMinDurS,
    svinAccLimitMm: config.gps.svinAccLimitMm,
    logConsole: config.gps.logConsole,
    logReplace: config.gps.logReplace,
  });

  console.log('[rtkStation] RTK-only mode - base GPS monitoring/config only, no telemetry radio/course/regatta');
  console.log(`[rtkStation] gps=${config.gps.port} @ ${config.gps.baud} svinMinDurS=${config.gps.svinMinDurS} svinAccLimitMm=${config.gps.svinAccLimitMm}`);

  gps.open();

  startRtkAdminServer({
    port: config.admin.port,
    getFix: gps.getFix,
    getSurveyStatus: gps.getSurveyStatus,
    setSurveyIn: gps.setSurveyIn,
    setFixed: gps.setFixed,
    saveConfig: gps.saveConfig,
    gpsPort: { port: config.gps.port, baud: config.gps.baud },
    isConnected: gps.isConnected,
    // This mode writes no logs of its own (no CSV, no webhook queues - see
    // the module comment above), but the underlying machine can still run
    // low on disk space from the OS/other processes, same as any other
    // mode's Pi - worth surfacing here too rather than only on base/boat's
    // dashboards. Reuses LOG_DIR purely as a stand-in path on this same
    // filesystem to stat, not because this mode actually writes there.
    getDisk: () => getDiskSpace(config.logDir),
  });

  console.log(`[rtkStation] dashboard on :${config.admin.port}`);
}

main();
