const os = require('os');
const { versionLine } = require('./version');
const config = require('./config');
const { MAP_MARK_ORDER, COURSE_LENGTH_NM, START_LINE_POSITION, START_SIDE_LENGTH_M, FINISH_SIDE_LENGTH_M, COMMITTEE_GAP_M } = require('./course');

// The fully-resolved configuration - every default plus whatever's been
// overridden via environment variables or a .env file - grouped/labeled to
// match config.js's own section comments. Shared source of truth for both
// `npm run print-config` (printConfig.js, console output) and the admin
// dashboards' `GET /config` page (adminServer.js, roverAdminServer.js,
// HTML), so the two presentations can never drift out of sync with each
// other. Rows are objects (label, desc, value, envVar, inverted, unit, note)
// rather than positional arrays - named keys stay readable where
// array-position magic wouldn't. desc is a short "what this controls" line,
// shown under the setting's name on the /config page; note is a remark about
// the value itself, shown under it.
//
// config.js resolves the exact same object structure regardless of which
// process reads it (`npm run base`/`boat`/`rtk`/`basertk`), but each
// process only ever actually READS a subset of it - `roles`, on a row or
// (when every row in it shares the same answer) a whole section, names
// which of 'base', 'boat', 'rtk' actually read that setting; omitted means
// every role does. 'basertk' is deliberately not a tag that appears below
// at all - see renderConfigPage's own comment on why it's derived (base's
// settings union rtk's) rather than duplicated onto every row. That
// function's `role` param uses this to show each dashboard only what that
// process reads, instead of the full list including settings it never
// looks at. `npm run print-config` (printConfig.js) deliberately bypasses
// this and always prints everything, unfiltered - it's a standalone
// diagnostic dump, not run "as" any particular role.
const sections = [
  {
    title: 'Testing switches',
    rows: [
      { label: 'simulate', desc: 'Run with no hardware: a fake GPS and a UDP stand-in for the radio', value: config.simulate, envVar: 'SIMULATE', roles: ['base', 'boat'] },
      { label: 'simulateGps', desc: 'Fake GPS track with the real radio, for bench-testing radios indoors', value: config.simulateGps, envVar: 'SIMULATE_GPS', roles: ['boat'] },
      { label: 'noGps', desc: 'Start no GPS at all, real or simulated; the radio still runs', value: config.noGps, envVar: 'NO_GPS', roles: ['boat'] },
      // testLapNumber doubles as the on/off switch for this test mode (0 =
      // off) and the lap number to report - see config.js's own comment.
      { label: 'testLapBoatId', desc: 'Boat id the TEST_LAP_NUMBER test lap is sent as', value: config.testLapBoatId, envVar: 'TEST_LAP_BOAT_ID', roles: ['base'] },
      { label: 'testLapNumber', desc: 'Send one fake lap with this number to RegattaUp, then exit; 0 = off', value: config.testLapNumber, envVar: 'TEST_LAP_NUMBER', roles: ['base'] },
    ],
  },
  {
    title: 'Simulation settings, used only with simulate=true',
    // Only `port` is read on the base side too (SimRadioLink listens on it
    // for sim frames) - every other sim.* field is specifically about
    // simGps.js's fake race track, boat-only.
    roles: ['base', 'boat'],
    rows: [
      { label: 'port', desc: 'UDP port the simulated radio link uses between boats and base', value: config.sim.port, envVar: 'SIM_PORT', roles: ['base', 'boat'] },
      { label: 'gpsHz', desc: 'Fixes per second from the simulated GPS', value: config.sim.gpsHz, envVar: 'SIM_GPS_HZ', unit: 'Hz', roles: ['boat'] },
      { label: 'upwindSpeedKn', desc: 'Simulated boat speed sailing upwind', value: config.sim.upwindSpeedKn, envVar: 'SIM_UPWIND_SPEED_KN', unit: 'kn', roles: ['boat'] },
      { label: 'downwindSpeedKn', desc: 'Simulated boat speed sailing downwind', value: config.sim.downwindSpeedKn, envVar: 'SIM_DOWNWIND_SPEED_KN', unit: 'kn', roles: ['boat'] },
      { label: 'lapCount', desc: 'Laps each simulated boat sails before stopping', value: config.sim.lapCount, envVar: 'SIM_LAP_COUNT', unit: 'laps', roles: ['boat'] },
      { label: 'centerLat', desc: "Latitude of the simulated course's centre", value: config.sim.centerLat, envVar: 'SIM_CENTER_LAT', unit: '°', roles: ['boat'] },
      { label: 'centerLon', desc: "Longitude of the simulated course's centre", value: config.sim.centerLon, envVar: 'SIM_CENTER_LON', unit: '°', roles: ['boat'] },
      { label: 'packetLossPct', desc: 'Percent of simulated radio frames dropped, to mimic range dropouts', value: config.sim.packetLossPct, envVar: 'SIM_PACKET_LOSS', unit: '%', roles: ['boat'] },
      { label: 'tempest', desc: 'Send the base simulated Tempest wind readings down the course', value: config.sim.tempest, envVar: 'SIM_TEMPEST', roles: ['base'] },
      { label: 'windChangeS', desc: 'How often the simulated wind picks a new speed and direction', value: config.sim.windChangeS, envVar: 'SIM_WIND_CHANGE_S', unit: 's', roles: ['base'] },
      { label: 'windMinMph', desc: 'Slowest simulated wind', value: config.sim.windMinMph, envVar: 'SIM_WIND_MIN_MPH', unit: 'mph', roles: ['base'] },
      { label: 'windMaxMph', desc: 'Fastest simulated wind', value: config.sim.windMaxMph, envVar: 'SIM_WIND_MAX_MPH', unit: 'mph', roles: ['base'] },
      { label: 'windSwingDeg', desc: 'How far the simulated wind direction strays either side of the course axis', value: config.sim.windSwingDeg, envVar: 'SIM_WIND_SWING_DEG', unit: '°', roles: ['base'] },
      { label: 'startOnly', desc: 'Keep simulated boats parked at their start position instead of racing', value: config.sim.startOnly, envVar: 'SIM_START_ONLY', roles: ['boat'] },
      { label: 'prestartDwellS', desc: 'Seconds a simulated boat waits on the start grid before setting off', value: config.sim.prestartDwellS, envVar: 'SIM_PRESTART_DWELL_S', unit: 's', roles: ['boat'] },
      { label: 'holdForStart', desc: 'Hold simulated boats on the grid until you press Space', value: config.sim.holdForStart, envVar: 'SIM_HOLD_FOR_START', roles: ['boat'] },
      { label: 'foulTest', desc: 'Sail one simulated boat back through the lines the wrong way, to test fouls', value: config.sim.foulTest, envVar: 'SIM_FOUL', roles: ['boat'] },
      { label: 'foulWindwardM', desc: 'How far upwind the foul-test boat goes before turning back', value: config.sim.foulWindwardM, envVar: 'SIM_FOUL_WINDWARD_M', unit: 'm', roles: ['boat'] },
      // These live in course.js, not config.sim - only take effect on a
      // fresh course (see "Changing the course" in the README); a published
      // course already in Redis keeps whatever it was created with
      // regardless of what these currently resolve to.
      {
        label: 'courseMarks',
        desc: 'Which pair of marks the simulated boats race around',
        value: config.sim.courseMarks,
        envVar: 'SIM_COURSE_MARKS',
        note: 'which mark pair the simulated boats race: 2 letters, windward first, G = green and B = black each (GG, BB, BG, GB)',
        roles: ['boat'],
      },
      {
        label: 'courseLengthNm',
        desc: 'Length of the simulated course, leeward to windward black mark',
        value: COURSE_LENGTH_NM,
        envVar: 'SIM_COURSE_LENGTH_NM',
        unit: 'nm',
        roles: ['boat'],
      },
      { label: 'startLinePosition', desc: 'Where the start/finish lines sit along the simulated course (0 = leeward, 100 = windward)', value: START_LINE_POSITION, envVar: 'SIM_START_LINE_POSITION', unit: '%', roles: ['boat'] },
      { label: 'startLineLengthM', desc: 'Length of the simulated start line (pin to start committee boat)', value: START_SIDE_LENGTH_M, unit: 'm', roles: ['boat'] },
      { label: 'finishLineLengthM', desc: 'Length of the simulated finish line (finish committee boat to finish mark)', value: FINISH_SIDE_LENGTH_M, unit: 'm', roles: ['boat'] },
      { label: 'committeeGapM', desc: 'Gap between the start and finish committee boats on the simulated course', value: COMMITTEE_GAP_M, envVar: 'SIM_COMMITTEE_GAP_M', unit: 'm', roles: ['boat'] },
    ],
  },
  {
    title: 'Local UDP broadcast',
    roles: ['base', 'boat'],
    rows: [
      { label: 'format', desc: 'Format of the local UDP position re-broadcast: ubx or nmea', value: config.localBroadcast.format, envVar: 'GPS_OUTPUT_FORMAT' },
      { label: 'address', desc: 'Address the local UDP position re-broadcast is sent to', value: config.localBroadcast.address, envVar: 'UDP_BROADCAST_ADDR' },
      { label: 'port', desc: 'Port the local UDP position re-broadcast is sent on', value: config.localBroadcast.port, envVar: 'UDP_PORT' },
    ],
  },
  {
    title: 'GPS receiver',
    rows: [
      // Shared by all three modes: the boat's own GPS, an optional GPS
      // wired directly to the base, and rtkStation.js's entire reason to
      // exist - see config.js's own comment on this section.
      { label: 'port', desc: 'Serial port the GPS receiver is connected to', value: config.gps.port, envVar: 'GPS_PORT', note: 'macOS: /dev/cu.usbmodemXXXX', roles: ['base', 'boat', 'rtk'] },
      { label: 'baud', desc: "Serial speed of the GPS link; must match the receiver's UART setting", value: config.gps.baud, envVar: 'GPS_BAUD', unit: 'baud', roles: ['base', 'boat', 'rtk'] },
      { label: 'logConsole', desc: 'Print each GPS fix to the console', value: config.gps.logConsole, envVar: 'GPS_LOG', roles: ['base', 'boat', 'rtk'] },
      { label: 'logReplace', desc: 'Overwrite the printed fix on one line instead of scrolling', value: config.gps.logReplace, envVar: 'GPS_LOG_REPLACE', roles: ['base', 'boat', 'rtk'] },
      // rtk only - plain `npm run base` opens the same GPS_PORT but never
      // wires the TMODE3/survey-in controls that actually read these (see
      // baseStation.js's rtkControlsEnabled); `basertk` sees them via the
      // rtk half of renderConfigPage's base∪rtk union, not this tag.
      { label: 'svinMinDurS', desc: 'Shortest survey-in before the RTK base accepts its own position', value: config.gps.svinMinDurS, envVar: 'GPS_SVIN_MIN_DUR_S', unit: 's', roles: ['rtk'] },
      { label: 'svinAccLimitMm', desc: 'Accuracy the survey-in position must reach before it is accepted', value: config.gps.svinAccLimitMm, envVar: 'GPS_SVIN_ACC_LIMIT_MM', unit: 'mm', roles: ['rtk'] },
    ],
  },
  {
    title: 'RTCM corrections',
    roles: ['boat'],
    rows: [
      { label: 'log', desc: 'Print RTK correction messages: 1 = a line per second, 2 = every message', value: config.rtcm.log, envVar: 'RTCM_LOG', note: 'old name GPS_LOG_RTCM still works' },
      { label: 'forward', desc: 'Pass RTK corrections heard on the telemetry radio on to the GPS receiver', value: config.rtcm.forward, envVar: 'RTCM_FORWARD' },
    ],
  },
  {
    title: 'Shared-radio transmit scheduling',
    roles: ['base', 'boat'],
    rows: [
      { label: 'enabled', desc: "Hold telemetry sends clear of the base's RTK correction bursts", value: config.txGate.enabled, envVar: 'TX_GATE' },
      { label: 'blockBeforeMs', desc: 'How long before a correction burst sends are held off', value: config.txGate.blockBeforeMs, envVar: 'TX_GATE_BEFORE_MS', unit: 'ms' },
      { label: 'blockAfterMs', desc: 'How long after a correction burst starts sends stay held off', value: config.txGate.blockAfterMs, envVar: 'TX_GATE_AFTER_MS', unit: 'ms' },
      { label: 'guardMs', desc: 'Extra margin either side of the hold, for timing jitter', value: config.txGate.guardMs, envVar: 'TX_GATE_GUARD_MS', unit: 'ms' },
      { label: 'maxQueue', desc: 'Most frames held at once; beyond this the oldest is dropped', value: config.txGate.maxQueue, envVar: 'TX_GATE_MAX_QUEUE' },
      { label: 'maxAgeMs', desc: 'A held frame older than this is dropped rather than sent stale', value: config.txGate.maxAgeMs, envVar: 'TX_GATE_MAX_AGE_MS', unit: 'ms' },
      { label: 'slotMode', desc: 'Give each boat its own time slot in the radio cycle', value: config.txGate.slot.enabled, envVar: 'TX_SLOT_MODE', roles: ['boat', 'base'] },
      { label: 'rtcmWatchdog', desc: "Warn on the console when the base's correction bursts aren't heard", value: config.txGate.rtcmWatch.enabled, envVar: 'RTCM_WATCHDOG', roles: ['boat'] },
      { label: 'rtcmWatchdogWarnS', desc: 'Seconds without correction bursts before that warning', value: config.txGate.rtcmWatch.warnS, envVar: 'RTCM_WATCHDOG_WARN_S', unit: 's', roles: ['boat'] },
      { label: 'slot', desc: 'Pin this boat to a fixed slot instead of one the base assigns', value: config.txGate.slot.index === null ? '(from boat id)' : config.txGate.slot.index, envVar: 'TX_SLOT', roles: ['boat'] },
      { label: 'slotCount', desc: 'Number of boat slots per cycle; unset = worked out from the correction interval', value: config.txGate.slot.count, envVar: 'TX_SLOT_COUNT', roles: ['boat'] },
      { label: 'parkedFirstS', desc: 'Longest random wait before a boat parked on the grid first reports', value: config.txGate.slot.parkedFirstS, envVar: 'TX_PARKED_FIRST_S', unit: 's', roles: ['boat'] },
      { label: 'parkDwellS', desc: 'Seconds inside the start zone before a boat counts as parked', value: config.txGate.slot.parkDwellS, envVar: 'TX_SLOT_PARK_DWELL_S', unit: 's', roles: ['boat', 'base'] },
      { label: 'parkedRepeatS', desc: "Re-send a parked boat's first report after about this long; 0 = no repeat", value: config.txGate.slot.parkedRepeatS, envVar: 'TX_PARKED_REPEAT_S', unit: 's', roles: ['boat'] },
      { label: 'slotWidthMs', desc: 'Width of each time slot', value: config.txGate.slot.widthMs, envVar: 'TX_SLOT_MS', unit: 'ms', roles: ['boat'] },
      { label: 'maxHz', desc: 'Most fixes per second a boat sends on the legs (the rest stay on its SD card)', value: config.txGate.slot.maxHz, envVar: 'TX_SLOT_MAX_HZ', unit: 'Hz', note: '0 = no cap; no cap applies inside markZoneM', roles: ['boat'] },
      { label: 'markZoneM', desc: 'Within this distance of a mark, or of the finish line heading upwind, a boat sends every fix', value: config.txGate.slot.markZoneM, envVar: 'TX_SLOT_MARK_ZONE_M', unit: 'm', note: '0 turns the full-rate zone off', roles: ['boat'] },
    ],
  },
  {
    title: 'Telemetry radio',
    // Not rtk - that mode never opens the telemetry radio at all.
    roles: ['base', 'boat'],
    rows: [
      { label: 'enabled', desc: 'Open the telemetry radio; off runs without one (fixes still log)', value: config.radio.enabled, envVar: 'RADIO_ENABLED' },
      { label: 'port', desc: 'Serial port the telemetry radio (XBee) is connected to', value: config.radio.port, envVar: 'RADIO_PORT', note: 'macOS: /dev/cu.usbserial-XXXX' },
      { label: 'baud', desc: "Serial speed of the radio link; must match the XBee's setting", value: config.radio.baud, envVar: 'RADIO_BAUD', unit: 'baud' },
    ],
  },
  {
    title: 'Identity & timing',
    // Not rtk - none of these apply once there's no telemetry radio/course
    // marks in the picture at all.
    roles: ['base', 'boat'],
    rows: [
      {
        label: 'boatId',
        desc: "This rover's 5-character id, on the radio and in RegattaUp",
        value: config.boatId,
        envVar: 'BOAT_ID',
        // BOAT_ID unset means this value came from this device's own
        // persisted id instead (see boatIdFile.js) - worth saying so, since
        // otherwise "default" reads like a hardcoded constant rather than
        // an id this specific device generated and will keep reusing.
        note:
          process.env.BOAT_ID === undefined
            ? `from ${config.configDir}/boat_id.txt (this device's own persisted id)`
            : undefined,
        roles: ['boat'],
      },
      // markName/markDistanceM/markHeartbeatS only ever DO anything on a
      // mark-mode rover (npm run mark - see README's "Mark mode"), so they're
      // tagged 'mark': a mark rover sees every 'boat' row plus these, a plain
      // boat doesn't see them.
      {
        label: 'markName',
        desc: 'The course mark this mark rover stands for',
        value: config.markName || '(not assigned)',
        envVar: 'MARK_NAME',
        note: `one of: ${MAP_MARK_ORDER.join(', ')}`,
        roles: ['mark'],
      },
      {
        label: 'markDistanceM',
        desc: 'How far the mark must move before its new position is sent',
        value: config.markDistanceM,
        envVar: 'MARK_DISTANCE_M',
        unit: 'm',
        roles: ['mark'],
      },
      {
        label: 'markHeartbeatS',
        desc: "Re-send the mark's position this often even when it hasn't moved",
        value: config.markHeartbeatMs / 1000,
        envVar: 'MARK_HEARTBEAT_S',
        unit: 's',
        note: "so the base's map doesn't show a still mark as stale; 0 turns it off",
        roles: ['mark'],
      },
      { label: 'txDistanceM', desc: 'How far the boat must move before a new position is sent', value: config.txDistanceM, envVar: 'TX_DISTANCE_M', unit: 'm', roles: ['boat'] },
      {
        label: 'txFinishApproachZoneM',
        desc: 'Within this distance of the finish, the tighter finish gate below applies',
        value: config.txFinishApproachZoneM,
        envVar: 'TX_FINISH_APPROACH_ZONE_M',
        unit: 'm',
        note: '0 disables the finish-approach tightening below (txDistanceM applies everywhere)',
        roles: ['boat'],
      },
      {
        label: 'txFinishDistanceM',
        desc: 'How far the boat must move between sends while approaching the finish',
        value: config.txFinishDistanceM,
        envVar: 'TX_FINISH_DISTANCE_M',
        unit: 'm',
        roles: ['boat'],
      },
      {
        label: 'txIntervalMs',
        desc: 'Send a position at least this often, even when not moving',
        value: config.txIntervalMs,
        envVar: 'TX_INTERVAL_S',
        unit: 'ms',
        note: 'env var is in seconds; 0 disables the heartbeat (distance gate only)',
        roles: ['boat'],
      },
      {
        label: 'txDelta',
        desc: 'Pack batched fixes into compact delta-coded radio frames',
        value: config.txDelta,
        envVar: 'TX_DELTA',
        note: 'on (default) = batches go out as delta-coded frames (up to 8 fixes in 83 bytes); off = the older batch frame (4 fixes in 84) - update the base first',
        roles: ['boat'],
      },
      {
        label: 'txBatchSize',
        desc: 'Most fixes sent together in one radio frame',
        value: config.txBatchSize,
        envVar: 'TX_BATCH_SIZE',
        note: '8 (default) = the most one delta frame carries (83 bytes; 4 with TX_DELTA=0); 1 = one frame per fix, unchanged from before batching existed - see README\'s "Batching multiple fixes per send"',
        roles: ['boat'],
      },
      {
        label: 'pingResponseJitterMs',
        desc: 'Longest random delay before answering the base\'s "Ping fleet"',
        value: config.pingResponseJitterMs,
        envVar: 'PING_RESPONSE_JITTER_MS',
        unit: 'ms',
        roles: ['boat'],
      },
      {
        label: 'helloStartupJitterMs',
        desc: 'Longest random delay before the startup hello (and each retry)',
        value: config.helloStartupJitterMs,
        envVar: 'HELLO_STARTUP_JITTER_MS',
        unit: 'ms',
        roles: ['boat'],
      },
      {
        label: 'marksBroadcastIntervalMs',
        desc: 'How often the base re-sends the course marks to every boat',
        value: config.marksBroadcastIntervalMs,
        envVar: 'MARKS_BROADCAST_INTERVAL_MS',
        unit: 'ms',
        roles: ['base'],
      },
      {
        label: 'marksSyncIntervalMs',
        desc: 'How often the base checks Redis for course marks changed outside it (e.g. in RegattaUp); 0 = never',
        value: config.marksSyncIntervalMs,
        envVar: 'MARKS_SYNC_INTERVAL_MS',
        unit: 'ms',
        roles: ['base'],
      },
      { label: 'logMarksBroadcast', desc: 'Print each course-marks broadcast to the console', value: config.logMarksBroadcast, envVar: 'LOG_MARKS_BROADCAST', roles: ['base'] },
      { label: 'logReceivedFrames', desc: 'Print every fix the base receives to the console', value: config.logReceivedFrames, envVar: 'LOG_RECEIVED_FIXES', roles: ['base'] },
    ],
  },
  {
    title: 'Local logging',
    // Not rtk - it writes no CSV logs at all (no telemetry frames, no
    // course, nothing to log).
    roles: ['base', 'boat'],
    rows: [
      { label: 'logDir', desc: "Folder for the base's CSV log of received fixes", value: config.logDir, envVar: 'BASE_LOG_DIR', roles: ['base'] },
      { label: 'boatLogDir', desc: "Folder for the boat's own CSV log (point it at the SD card)", value: config.boatLogDir, envVar: 'BOAT_LOG_DIR', roles: ['boat'] },
      { label: 'logRetentionDays', desc: 'CSV logs older than this are deleted automatically', value: config.logRetentionDays, envVar: 'LOG_RETENTION_DAYS', unit: 'days' },
      { label: 'logChunkMinutes', desc: 'Minutes of fixes per boat log file; a finished file can be uploaded', value: config.logChunkMinutes, envVar: 'LOG_CHUNK_MINUTES', unit: 'min', roles: ['boat'] },
    ],
  },
  {
    title: 'Log upload over WiFi',
    // Not rtk - it has no SD-card logs to upload and doesn't serve uploads.
    roles: ['base', 'boat'],
    rows: [
      { label: 'enabled', desc: 'Upload finished log files to the base when in WiFi range', value: config.upload.enabled, envVar: 'UPLOAD_ENABLED', roles: ['boat'] },
      { label: 'logSuccess', desc: 'Print a console line for each successful upload', value: config.upload.logSuccess, envVar: 'UPLOAD_LOG' },
      { label: 'port', desc: 'Port the base receives log uploads on', value: config.upload.port, envVar: 'UPLOAD_PORT', roles: ['base'] },
      { label: 'dir', desc: "Folder the base saves the boats' uploaded logs in", value: config.upload.dir, envVar: 'BASE_UPLOAD_DIR', roles: ['base'] },
      { label: 'baseIp', desc: "Override the base's LAN address that boats are told to upload to", value: config.upload.baseIp || '(auto-detect)', envVar: 'BASE_IP', roles: ['base'] },
      { label: 'checkIntervalMs', desc: 'How often a boat checks whether the base is reachable to upload', value: config.upload.checkIntervalMs, envVar: 'UPLOAD_CHECK_INTERVAL_MS', unit: 'ms', roles: ['boat'] },
      { label: 'timeoutMs', desc: 'How long a boat waits on the base before giving up an upload attempt', value: config.upload.timeoutMs, envVar: 'UPLOAD_TIMEOUT_MS', unit: 'ms', roles: ['boat'] },
    ],
  },
  {
    title: 'Admin dashboard',
    // Shared by all three - each mode has its own dashboard on this port.
    roles: ['base', 'boat', 'rtk'],
    rows: [{ label: 'port', desc: "Port this machine's admin dashboard is served on", value: config.admin.port, envVar: 'ADMIN_PORT' }],
  },
  {
    title: 'Base discovery',
    roles: ['base', 'viewer'],
    rows: [
      { label: 'enabled', desc: 'Base only: answer discovery probes so a base viewer can find this base without its address', value: config.discovery.enabled, envVar: 'DISCOVERY_ENABLED', roles: ['base'] },
      { label: 'port', desc: 'UDP port the base listens for discovery probes on (the viewer probes the same one)', value: config.discovery.port, envVar: 'DISCOVERY_PORT' },
      { label: 'timeoutMs', desc: 'Viewer only: how long to wait for bases to answer a probe', value: config.discovery.timeoutMs, envVar: 'DISCOVERY_TIMEOUT_MS', unit: 'ms', roles: ['viewer'] },
    ],
  },
  {
    title: 'Base viewer (npm run viewer)',
    roles: ['viewer'],
    rows: [
      { label: 'baseUrl', desc: "The base whose stats the viewer shows (its admin address, e.g. http://pi.local:8092) - or pass it as an argument. Empty: find a base on the local network", value: config.viewer.baseUrl || '(not set)', envVar: 'VIEWER_BASE_URL' },
      { label: 'port', desc: 'Port the viewer page is served on', value: config.viewer.port, envVar: 'VIEWER_PORT' },
      { label: 'host', desc: 'Address the viewer listens on - loopback only unless set (0.0.0.0 lets other machines open it)', value: config.viewer.host, envVar: 'VIEWER_HOST' },
      { label: 'timeoutMs', desc: "How long to wait for the base's stats before showing it as unreachable", value: config.viewer.timeoutMs, envVar: 'VIEWER_TIMEOUT_MS', unit: 'ms' },
    ],
  },
  {
    title: 'Tempest weather station',
    roles: ['base'],
    rows: [
      { label: 'enabled', desc: "Record the Tempest's local UDP wind readings into the regatta's wind data", value: config.tempest.enabled, envVar: 'TEMPEST_ENABLED' },
      { label: 'port', desc: 'UDP port the Tempest hub broadcasts on', value: config.tempest.port, envVar: 'TEMPEST_PORT' },
      { label: 'serial', desc: "Only use this station's readings (its ST-... serial number); unset = any station", value: config.tempest.serial || '(any station)', envVar: 'TEMPEST_SERIAL' },
      { label: 'stationName', desc: 'Station name stored with each reading (shown on the map)', value: config.tempest.stationName || '(its serial number)', envVar: 'TEMPEST_STATION_NAME' },
    ],
  },
  {
    title: 'Redis',
    roles: ['base'],
    rows: [
      { label: 'url', desc: 'Full Redis connection URL; overrides the preset and settings below', value: config.redis.url || '(unset)', envVar: 'REDIS_URL' },
      { label: 'env preset', desc: 'Named Redis connection preset (local or production)', value: process.env.REDIS_ENV || 'local', envVar: 'REDIS_ENV' },
      { label: 'connection.host', desc: 'Redis server host, from the preset', value: config.redis.connection.host },
      { label: 'connection.port', desc: 'Redis server port, from the preset', value: config.redis.connection.port },
      { label: 'connection.username', desc: 'Redis username', value: config.redis.connection.username || '(none)', envVar: 'REDIS_USERNAME' },
      {
        label: 'connection.password',
        desc: 'Redis password (never shown)',
        value: config.redis.connection.password ? '***REDACTED***' : '(none)',
        envVar: 'REDIS_PASSWORD',
      },
      { label: 'connection.tls', desc: 'Connect to Redis over TLS', value: !!config.redis.connection.tls, envVar: 'REDIS_TLS' },
      { label: 'minMovementM', desc: 'Skip storing a fix unless the boat moved at least this far', value: config.redis.minMovementM, envVar: 'REDIS_MIN_MOVEMENT_M', unit: 'm' },
      {
        label: 'trackRetentionHours',
        desc: 'How long fixes are kept in Redis',
        value: config.redis.trackRetentionHours,
        envVar: 'REDIS_TRACK_RETENTION_HOURS',
        unit: 'h',
      },
      {
        label: 'trackMaxMb',
        desc: 'Most memory the track may use in Redis; past it the oldest fixes are dropped',
        value: config.redis.trackMaxMb,
        envVar: 'REDIS_TRACK_MAX_MB',
        unit: 'MB',
        note: '0 = no cap',
      },
      { label: 'memoryLimitMb', desc: "Redis memory size the Data page's memory card measures against", value: config.redis.memoryLimitMb, envVar: 'REDIS_MEMORY_LIMIT_MB', unit: 'MB' },
    ],
  },
  {
    title: 'RegattaUp webhooks',
    roles: ['base'],
    rows: [
      { label: 'webhookUrl', desc: 'RegattaUp address race events (laps, on-grid, roundings, fouls) are posted to', value: config.regattaup.webhookUrl, envVar: 'REGATTAUP_WEBHOOK_URL' },
      { label: 'enabled', desc: 'Post race events to RegattaUp at all', value: config.regattaup.enabled, envVar: 'REGATTAUP_WEBHOOK_ENABLED' },
      { label: 'activeRegattasUrl', desc: 'Where the list of active regattas is fetched from', value: config.regattaup.activeRegattasUrl, envVar: 'REGATTAUP_ACTIVE_REGATTAS_URL' },
      {
        label: 'defaultRegatta',
        desc: 'The regatta this base reports for',
        value: config.regattaup.defaultRegatta ? `${config.regattaup.defaultRegatta.id}${config.regattaup.defaultRegatta.name ? ` (${config.regattaup.defaultRegatta.name})` : ''}` : '(none)',
        envVar: 'REGATTAUP_REGATTA_ID',
        note: 'also persisted to regatta-id.txt by this env var or by picking a regatta from the admin dashboard/startup prompt',
      },
      {
        label: 'activeRegattasRefreshIntervalMs',
        desc: 'How often the regatta list is refreshed',
        value: config.regattaup.activeRegattasRefreshIntervalMs,
        envVar: 'REGATTAUP_REGATTAS_REFRESH_INTERVAL_MS',
        unit: 'ms',
      },
      {
        label: 'logActiveRegattas',
        desc: 'Print each successful regatta-list refresh',
        value: config.regattaup.logActiveRegattas,
        envVar: 'REGATTAUP_LOG_ACTIVE_REGATTAS',
      },
      { label: 'queueDbPath', desc: 'File lap events wait in until RegattaUp accepts them', value: config.regattaup.queueDbPath, envVar: 'REGATTAUP_QUEUE_DB' },
      { label: 'postIntervalMs', desc: 'Shortest gap between webhook posts', value: config.regattaup.postIntervalMs, envVar: 'REGATTAUP_POST_INTERVAL_MS', unit: 'ms' },
      { label: 'maxInFlight', desc: 'Most webhook requests waiting on RegattaUp at once', value: config.regattaup.maxInFlight, envVar: 'REGATTAUP_MAX_IN_FLIGHT' },
      { label: 'requestTimeoutMs', desc: 'Give up on an unanswered webhook request after this long, then retry', value: config.regattaup.requestTimeoutMs, envVar: 'REGATTAUP_REQUEST_TIMEOUT_MS', unit: 'ms' },
      { label: 'maxBackoffMs', desc: 'Longest wait between retries of a failing webhook event', value: config.regattaup.maxBackoffMs, envVar: 'REGATTAUP_MAX_BACKOFF_MS', unit: 'ms' },
      { label: 'onGridZoneM', desc: 'How close to the start line a boat must be to count as on-grid', value: config.regattaup.onGridZoneM, envVar: 'REGATTAUP_ONGRID_ZONE_M', unit: 'm' },
      { label: 'onGridQueueDbPath', desc: 'File on-grid events wait in until RegattaUp accepts them', value: config.regattaup.onGridQueueDbPath, envVar: 'REGATTAUP_ONGRID_QUEUE_DB' },
      {
        label: 'markRoundingEnabled',
        desc: 'Report mark roundings to RegattaUp',
        value: config.regattaup.markRoundingEnabled,
        envVar: 'REGATTAUP_MARK_ROUNDING_ENABLED',
      },
      {
        label: 'markRoundingExtensionM',
        desc: 'How far out past a mark the rounding gate reaches',
        value: config.regattaup.markRoundingExtensionM,
        envVar: 'REGATTAUP_MARK_ROUNDING_EXTENSION_M',
        unit: 'm',
      },
      {
        label: 'markRoundingQueueDbPath',
        desc: 'File mark-rounding events wait in until RegattaUp accepts them',
        value: config.regattaup.markRoundingQueueDbPath,
        envVar: 'REGATTAUP_MARK_ROUNDING_QUEUE_DB',
      },
      { label: 'foulEnabled', desc: 'Report fouls (wrong-way line crossings) to RegattaUp', value: config.regattaup.foulEnabled, envVar: 'REGATTAUP_FOUL_ENABLED' },
      { label: 'foulQueueDbPath', desc: 'File foul events wait in until RegattaUp accepts them', value: config.regattaup.foulQueueDbPath, envVar: 'REGATTAUP_FOUL_QUEUE_DB' },
      { label: 'newCodeEnabled', desc: "Tell RegattaUp the first time each transponder code (boat id) is heard in the regatta, so it shows in its code management", value: config.regattaup.newCodeEnabled, envVar: 'REGATTAUP_NEW_CODE_ENABLED' },
      { label: 'newCodeQueueDbPath', desc: 'File new-code hits wait in until RegattaUp accepts them', value: config.regattaup.newCodeQueueDbPath, envVar: 'REGATTAUP_NEW_CODE_QUEUE_DB' },
    ],
  },
];

function formatValue(v, unit) {
  const formatted = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
  // Units only make sense tacked onto an actual number - a boolean/string
  // value with a unit attached (shouldn't happen given the table above,
  // but stay defensive) would just read as nonsense.
  return unit && typeof v === 'number' ? `${formatted} ${unit}` : formatted;
}

// `inverted` is for a flag whose env var name is the *negation* of the
// resolved config value shown next to it (an old-style `_DISABLED`/`NO_*`
// var, like NO_RADIO and REGATTAUP_WEBHOOK_DISABLED used to be, before
// both were renamed to RADIO_ENABLED/REGATTAUP_WEBHOOK_ENABLED) - no row
// currently needs it. Prefer naming a new env var so its own polarity
// already matches the field it controls instead (an `_ENABLED` var,
// defaulting on - see REGATTAUP_WEBHOOK_ENABLED/markRoundingEnabled/
// RADIO_ENABLED); reach for `inverted` only if a var genuinely can't be
// renamed that way.
//
// The env var name is shown unconditionally (not just once overridden) -
// same reasoning as renderConfigPage's HTML table below: it's the actual
// command-line/`.env` knob for this setting, so it should be visible right
// next to its current value even while still at the default, not just
// after you've already gone and set it once.
function overrideTag(envVar, inverted) {
  if (!envVar) return '';
  const isSet = process.env[envVar] !== undefined;
  if (!inverted) return isSet ? `(${envVar}, overridden)` : `(${envVar}, default)`;
  // An inverted flag names the env var the OPPOSITE of the resolved value
  // printed next to this tag - "enabled  true  (NO_RADIO, default)" (back
  // when NO_RADIO was still spelled that way) reads like the no-radio flag
  // itself is true. Spelling out the env var's own raw state - always, not
  // just once overridden, since the confusion is just as real at the
  // default - is what actually resolves that.
  const rawState = isSet ? `${envVar}=${process.env[envVar]}` : `${envVar} not set`;
  return `(${rawState}, ${isSet ? 'overridden' : 'default'})`;
}

// Every mode this app runs as (one npm run script each - see README's "Running"), listed first on both the /config
// page and print-config, with the one running marked.
const MODES = [
  { mode: 'boat', command: 'npm run boat', what: "a boat's Pi: reads GPS, sends fixes over the radio, logs to SD" },
  { mode: 'mark', command: 'npm run mark', what: "a rover left on one course mark: re-sends that mark's position as it drifts" },
  { mode: 'base', command: 'npm run base', what: 'shore/committee base: receives the fleet, tracks the course, reports to RegattaUp' },
  { mode: 'basertk', command: 'npm run basertk', what: 'base plus the RTK correction GPS controls, on one machine' },
  { mode: 'rtk', command: 'npm run rtk', what: 'the RTK correction GPS on its own (survey-in / fixed position), no fleet' },
];

// Two sections: the mode running, then every mode with the running one marked. running: what to show as the running
// mode; runningModes: which MODES entries to mark; source: how it was worked out.
function modesSections(running, runningModes, source) {
  return [
    {
      title: 'Running mode',
      rows: [
        { label: 'mode', value: running, note: source },
        { label: 'host', value: os.hostname(), note: "this machine's hostname" },
        { label: 'version', value: versionLine(), note: "package.json's major.minor, then the commit count - every commit bumps it" },
      ],
    },
    {
      title: 'Available modes',
      rows: MODES.map(({ mode, command, what }) => ({
        label: mode,
        value: command + (runningModes.includes(mode) ? '  ← running' : ''),
        note: what,
      })),
    },
  ];
}

// Which roles (row/section `roles` tags) each mode reads. Two modes are unions rather than tags of their own: a mark
// rover is boatAgent.js, so it reads every 'boat' row plus the 'mark' ones; basertk is the base with the RTK controls
// wired in, so it reads every 'base' and 'rtk' row.
const MODE_ROLES = { boat: ['boat'], mark: ['boat', 'mark'], base: ['base'], basertk: ['base', 'rtk'], rtk: ['rtk'] };

// Whether a row or section is read in this mode - untagged means every mode.
function visibleTo(item, mode) {
  return !item.roles || item.roles.some((role) => MODE_ROLES[mode].includes(role));
}

// The modes that read a row (inside its section), in MODES order.
function modesFor(row, section) {
  return MODES.map((m) => m.mode).filter((mode) => visibleTo(section, mode) && visibleTo(row, mode));
}

// "all modes", or the modes listed ("base, basertk"). mark formats each mode name - the callers use it to bold the
// active mode.
function modesText(modes, mark = (mode) => mode) {
  return modes.length === MODES.length ? 'all modes' : modes.map(mark).join(', ');
}

// The modes that read anything in a section: the union of its rows' modes.
function sectionModes(section) {
  return MODES.map((m) => m.mode).filter((mode) => section.rows.some((row) => modesFor(row, section).includes(mode)));
}

// A section's heading with the modes it applies to, worked out from its rows' tags: "Redis (base, basertk)".
// A section no mode reads (the base viewer's, which is its own program) is just its title.
function sectionHeading(section, mark) {
  const modes = sectionModes(section);
  return modes.length ? `${section.title} (${modesText(modes, mark)})` : section.title;
}

// A row's own modes when fewer modes read it than its section as a whole, else null (the heading already says).
function rowModesText(row, section, mark) {
  const modes = modesFor(row, section);
  return modes.length === sectionModes(section).length ? null : modesText(modes, mark);
}

// The sections and rows one mode reads; a section left with no rows is dropped.
function sectionsFor(mode, list = sections) {
  return list
    .filter((section) => visibleTo(section, mode))
    .map((section) => ({ ...section, rows: section.rows.filter((row) => visibleTo(row, mode)) }))
    .filter((section) => section.rows.length > 0);
}

// HTML rendering shared by all three admin dashboards' GET /config (see
// adminServer.js, roverAdminServer.js, rtkAdminServer.js) - same dark theme
// as the rest of the admin UI. No stats snapshot needed here (unlike
// renderDashboard/renderMap elsewhere) - config is resolved once at process
// startup from env vars, not something that changes while the process
// runs, so there's nothing to poll/refresh.
//
// role (one of MODES' modes) is the dashboard's own mode: it is marked as
// running, and the settings it reads come first. Every setting is still
// listed - the ones only other modes read follow, dimmed - so one page shows
// what each mode would use. Omit role for a plain list with no mode marked.
// navHtml/navCss (optional): the admin's tab bar, shown instead of the plain back link.
function renderConfigPage({ role, navHtml = '', navCss = '' } = {}) {
  const modes = role
    ? modesSections(role === 'base' && config.markMode ? 'base (MARK_MODE=1)' : role, [role], 'the npm run script this process was started as')
    : [];
  // Every setting is listed: the sections this mode reads first, then the ones only other modes read, dimmed. Headings
  // say which modes read each section; a row read by fewer modes than its section says so itself, and a row this mode
  // doesn't read (in a section it otherwise does) is dimmed.
  const used = (section) => !role || sectionModes(section).includes(role);
  const mark = (mode) => (mode === role ? `<strong class="active-mode">${mode}</strong>` : mode);
  const renderSection = (section, { isModes = false } = {}) => {
      const rows = section.rows
        .map((row) => {
          const { label, desc, value, envVar, inverted, unit, note } = row;
          const rowModes = isModes ? null : rowModesText(row, section, mark);
          // A section this mode doesn't read is dimmed as a whole, so its rows aren't dimmed again.
          const rowUsed = isModes || !role || !used(section) || modesFor(row, section).includes(role);
          // Env Var is shown unconditionally (not just once overridden) -
          // this is the actual command-line/`.env` knob for this setting,
          // so it should be visible right next to its current value even
          // while still at the default, not just after you've already
          // gone and set it once.
          const envVarHtml = envVar ? `<code>${envVar}</code>` : '<span class="muted">&mdash;</span>';
          const isSet = envVar && process.env[envVar] !== undefined;
          const statusHtml = !envVar
            ? '<span class="muted">&mdash;</span>'
            : isSet
              ? '<span class="overridden">overridden</span>'
              : '<span class="muted">default</span>';
          // A platform-specific hint (e.g. what this path looks like on
          // macOS vs the Linux paths used as the actual defaults) - shown
          // as a small muted line under the value, not part of the
          // resolved value itself.
          const extraLines = [];
          if (note) extraLines.push(note);
          if (rowModes) extraLines.push(`only ${rowModes}${rowUsed ? '' : ` - not used in ${role} mode`}`);
          // An inverted flag names the env var the OPPOSITE of the resolved
          // setting shown here - "enabled: true" sitting next to a bare
          // `_DISABLED`-style var name reads like that flag itself is true.
          // Spelling out the env var's own raw state right under the value
          // (not just in the Status column, and not just once overridden -
          // the confusion is just as real at the default) is what actually
          // resolves that: "true" next to "SOME_FLAG not set" can't be
          // misread the way "true" next to the bare env var name can. No
          // row currently sets `inverted` - see overrideTag's own module
          // comment above.
          if (inverted && envVar) {
            extraLines.push(isSet ? `${envVar}=${process.env[envVar]}` : `${envVar} not set`);
          }
          const valueHtml =
            extraLines.length > 0
              ? `${formatValue(value, unit)}${extraLines.map((line) => `<div class="muted" style="font-size:11px;">${line}</div>`).join('')}`
              : formatValue(value, unit);
          return `<tr${rowUsed ? '' : ' class="other-mode"'}>
            <td>${label}${desc ? `<div class="desc">${desc}</div>` : ''}</td>
            <td>${envVarHtml}</td>
            <td>${valueHtml}</td>
            <td>${statusHtml}</td>
          </tr>`;
        })
        .join('');
      return `<section${used(section) || isModes ? '' : ' class="other-mode"'}>
        <h2>${isModes ? section.title : sectionHeading(section, mark)}</h2>
        <table>
          <thead><tr><th>Setting</th><th>Env Var</th><th>Value</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
  };
  const otherModes = sections.filter((section) => !used(section));
  const sectionsHtml = [
    ...modes.map((section) => renderSection(section, { isModes: true })),
    ...sections.filter(used).map((section) => renderSection(section)),
    ...(otherModes.length
      ? [`<div class="other-heading">Settings only other modes use - not used in ${role} mode</div>`, ...otherModes.map((section) => renderSection(section))]
      : []),
  ].join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>race-tracker config</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    background: #0f1216;
    color: #e6e9ef;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .subtitle { color: #8b94a3; font-size: 13px; margin-bottom: 24px; }
  ${navCss}
  section { margin-bottom: 24px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.04em; color: #8b94a3; margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #262c36; border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 14px; font-size: 13px; font-variant-numeric: tabular-nums; }
  th { color: #8b94a3; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid #262c36; }
  tr:not(:last-child) td { border-bottom: 1px solid #1c222b; }
  .muted { color: #8b94a3; }
  .overridden { color: #e3b341; font-weight: 600; }
  .other-mode { opacity: 0.45; }
  .active-mode { color: #e6e9ef; font-weight: 700; }
  .desc { color: #8b94a3; font-size: 11px; margin-top: 2px; max-width: 340px; }
  .other-heading { margin: 36px 0 14px; padding-top: 14px; border-top: 1px solid #262c36; color: #8b94a3; font-size: 13px; }
  code { background: #1c222b; padding: 1px 6px; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <h1>Resolved configuration</h1>
  ${navHtml}
  <div class="subtitle">
    ${navHtml ? '' : '<a href="/">&larr; back to dashboard</a> &nbsp;·&nbsp; '}every default plus whatever's actually been overridden via environment variables or .env - same data as <code>npm run print-config</code>
    &nbsp;·&nbsp; "Env Var" is the command-line/.env variable that sets each value; yellow "Status" means it's been overridden from its default
    ${role ? `<br>The modes in brackets after each heading are the ones that read those settings; <strong class="active-mode">${role}</strong> in bold is the mode this dashboard is running. Dimmed settings aren't used in ${role} mode - they're listed so one page shows every mode's settings.` : ''}
  </div>
  ${sectionsHtml}
</body>
</html>`;
}

module.exports = { sections, MODES, formatValue, overrideTag, modesSections, modesFor, sectionHeading, rowModesText, sectionsFor, renderConfigPage };
