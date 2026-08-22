const path = require('path');
require('dotenv').config();

// Central configuration. Override any of these with environment variables,
// e.g. GPS_PORT=/dev/ttyACM0 BOAT_ID=7 npm run boat
// A git-ignored .env file in the project root is loaded automatically (see
// dotenv above), so secrets like REDIS_PASSWORD can live there instead of
// being typed on the command line or hardcoded in this file.

// SIMULATE=1 replaces the real GPS + radio hardware with a fake GPS track
// and a UDP-based stand-in for the radio link, so boatAgent/baseStation can
// be run and tested with no hardware attached (see simGps.js, simRadioLink.js).
const simulate = process.env.SIMULATE === '1' || process.env.SIMULATE === 'true';

// SIMULATE_GPS=1 fakes just the GPS (a simulated race track), while still
// using the real radio hardware on both ends - useful for bench-testing
// actual radios (range, packet loss) without needing a real GPS fix or
// being outdoors. SIMULATE=1 implies this too (full simulation, no
// hardware at all); this only matters as its own flag when you want
// simulated GPS with real radio specifically.
const simulateGps = simulate || process.env.SIMULATE_GPS === '1' || process.env.SIMULATE_GPS === 'true';

// NO_GPS=1 skips starting any GPS source at all - real or simulated. Useful
// with SIMULATE=1 when you want a working sim radio link (course marks,
// the log upload client, radio bench-testing) without a simulated race
// actually running and generating position frames. Independent of
// simulateGps above: this overrides it, not the other way around (see
// boatAgent.js's GPS startup branch).
const noGps = process.env.NO_GPS === '1' || process.env.NO_GPS === 'true';

// TEST_LAP_NUMBER (npm run base) doubles as both the on/off switch and the
// payload for this test mode - 0 (default) means off; any positive value
// sends one synthetic lap straight into the lap webhook queue and exits,
// reported as that lap number, to check the queue -> RegattaUp path end to
// end without a real or simulated race in progress. TEST_LAP_BOAT_ID picks
// which boat it's sent as - a dedicated var rather than reusing BOAT_ID,
// since that otherwise means nothing to the base station (it's a
// boatAgent-only concept everywhere else).
const testLapBoatId = parseInt(process.env.TEST_LAP_BOAT_ID || '1', 10);
const testLapNumber = parseInt(process.env.TEST_LAP_NUMBER || '0', 10);

// On the boat Pi, override LOG_DIR to point at the SD card mount. Default
// is relative to this package (not the shell's cwd), so it works the same
// whether you're on the Pi or testing on a laptop.
const logDir = process.env.LOG_DIR || path.join(__dirname, '..', 'race-logs');

// Redis connection presets, selected via REDIS_ENV. Hostnames/ports are fine
// to keep in source; credentials are not, so those always come from the
// environment. See "redis" section below for how REDIS_URL can override this
// entirely for ad-hoc use.
const REDIS_CONNECTIONS = {
  local: {
    host: '127.0.0.1',
    port: 6379,
  },
  production: {
    host: 'redis-16266.c60.us-west-1-2.ec2.cloud.redislabs.com',
    port: 16266,
    username: process.env.REDIS_USERNAME || 'default',
    password: process.env.REDIS_PASSWORD,
    ...(process.env.REDIS_TLS === '1' || process.env.REDIS_TLS === 'true' ? { tls: {} } : {}),
  },
};

module.exports = {
  simulate,
  simulateGps,
  noGps,
  testLapBoatId,
  testLapNumber,

  // --- Simulation mode settings (only used when simulate=true) ---
  sim: {
    // Every simulated boat and the base share this port, broadcasting to
    // it (see simRadioLink.js) the same way a real radio broadcasts on its
    // shared RF channel - no per-boat host/address to configure.
    port: parseInt(process.env.SIM_PORT || '41234', 10),
    gpsHz: parseFloat(process.env.SIM_GPS_HZ || '2'),
    // Landsailers, unlike water boats, go much faster downwind than up -
    // low rolling resistance lets apparent wind build well past true wind
    // speed on a reach/run.
    upwindSpeedKn: parseFloat(process.env.SIM_UPWIND_SPEED_KN || '30'),
    downwindSpeedKn: parseFloat(process.env.SIM_DOWNWIND_SPEED_KN || '55'),
    // How many laps (start/finish line crossings, finish direction) each
    // simulated boat sails before it stops.
    lapCount: parseInt(process.env.SIM_LAP_COUNT || '2', 10),
    centerLat: parseFloat(process.env.SIM_CENTER_LAT || '40.8898'),
    centerLon: parseFloat(process.env.SIM_CENTER_LON || '-118.3821'),
    // % chance (0-100) each frame is dropped, to simulate radio range dropouts.
    packetLossPct: parseFloat(process.env.SIM_PACKET_LOSS || '0'),
    // Off by default - set to 1 to skip the simulated race entirely and
    // just sit the boat at its start position (see simGps.js's _tick())
    // forever, emitting a stationary but otherwise normal fix stream.
    // Useful for testing start-line-adjacent features (on-grid detection,
    // the map's "edit marks" column) without waiting for a boat to sail
    // off the line seconds after simulation start, or fighting the sim's
    // own movement to keep it near the line.
    startOnly: process.env.SIM_START_ONLY === '1' || process.env.SIM_START_ONLY === 'true',
    // Which windward/leeward mark pair the simulated boat actually races -
    // two letters, windward first, each 'G' (green, short course) or 'B'
    // (black, long course): 'GG' (default, the plain short course), 'BB'
    // (plain long course), or a mixed 'BG'/'GB' (see course.js's
    // parseCourseMarks/deriveGeometry for how a mixed pair's beat length
    // comes out). Validated eagerly here, not deep inside boatAgent.js's
    // async marks-received callback, so a typo fails fast at startup with a
    // clear message instead of surfacing later mid-race.
    courseMarks: (() => {
      const raw = (process.env.SIM_COURSE_MARKS || 'GG').toUpperCase();
      if (!/^[GB]{2}$/.test(raw)) {
        throw new Error(
          `SIM_COURSE_MARKS must be 2 letters, each G (green) or B (black) - e.g. GG, BB, BG, GB. Got "${process.env.SIM_COURSE_MARKS}"`
        );
      }
      return raw;
    })(),
    // How long (seconds) a normal (non-SIM_START_ONLY) simulated race sits
    // stationary at its start position before actually departing upwind -
    // without this, a normal race launches on its very first tick with no
    // pre-start dwell modeled at all, so on-grid detection (which is
    // specifically about that dwell) never gets a real window to fire in
    // an ordinary test race, only under SIM_START_ONLY's permanent version
    // of the same stationary state. 0 disables the dwell (departs
    // immediately, the old behavior).
    prestartDwellS: parseFloat(process.env.SIM_PRESTART_DWELL_S || '15'),
    // On by default - holds every simulated boat at its start position
    // indefinitely (like SIM_START_ONLY, but releasable) until told to
    // actually start racing: a spacebar press in whichever terminal owns
    // the operator's keyboard (npm run boat's own terminal when run
    // standalone, or npm run fleet's terminal, which forwards the press to
    // every boat it spawned - see boatAgent.js/fleetSim.js). Overrides
    // prestartDwellS (which auto-departs after a fixed time) - the whole
    // point here is a manual release instead of a timer, so the boat gets
    // all sailors/boats on the grid before the race committee actually
    // starts the race server-side. Set SIM_HOLD_FOR_START=0 to go back to
    // the old auto-departing-after-prestartDwellS behavior.
    holdForStart: process.env.SIM_HOLD_FOR_START !== '0' && process.env.SIM_HOLD_FOR_START !== 'false',
    // Off by default - a single `npm run boat` session stays alive after
    // finishing its laps (see boatAgent.js's 'finished' handler) so any
    // still-pending log uploads get a chance to go out. Set to 1 to instead
    // exit the process the moment the simulated race ends - what
    // fleetSim.js wants for every boat it spawns, so a multi-boat run winds
    // itself down on its own instead of leaving every finished boat's
    // process sitting there idle.
    exitOnFinish: process.env.SIM_EXIT_ON_FINISH === '1' || process.env.SIM_EXIT_ON_FINISH === 'true',
  },

  // --- GPS (simpleRTK2B LR, ZED-F9P) ---
  // Default port is the Pi's own hardware UART (GPIO 14/15, see "Wiring
  // notes" in the README - requires disabling Bluetooth on Pis that have
  // it, or these pins default to the glitch-prone mini-UART instead) -
  // frees up the Pi's one USB/OTG port for the radio instead of a hub.
  // Override GPS_PORT back to the module's own USB CDC-ACM device (usually
  // `/dev/ttyACM0`) if you'd rather wire it that way instead. This link is
  // Pi<->GPS only, so baud/bandwidth here is NOT the constraint (the radio
  // link is) - default baud is whatever this UART was actually found
  // running at on real hardware (see README's "GPS configuration"), not
  // the ZED-F9P's factory default (38400) - each UART configures
  // independently, so the two aren't guaranteed to match on a given unit.
  // Also doubles as the base station's own optional GPS (a module wired
  // directly to whatever machine runs the base, e.g. the same simpleRTK2B
  // LR hardware a boat uses) - not for tracking the base itself, but so
  // an operator setting up the course (see adminServer.js's "edit marks"
  // column) can plant marks at their own position with real RTK
  // precision, not just a phone's much coarser Geolocation API. Base and
  // boat are always separate processes, so there's no actual conflict in
  // sharing one var - baseStation.js only opens a port at all when
  // GPS_PORT is *explicitly* set (see its own comment), unlike the boat
  // which always opens one (falling back to this same default) since a
  // boat is assumed to always have real GPS hardware unless told
  // otherwise (SIMULATE/NO_GPS). A base's GPS is commonly wired over USB
  // instead (e.g. straight into the machine running `npm run base`), in
  // which case both GPS_PORT and GPS_BAUD will usually need overriding to
  // match that connection instead of this GPIO-tuned default.
  gps: {
    port: process.env.GPS_PORT || '/dev/ttyAMA0',
    baud: parseInt(process.env.GPS_BAUD || '115200', 10),
    // On by default (matches existing behavior on both roles) - set
    // GPS_LOG=0 to silence the per-fix [gps]/[baseGps] console line, e.g.
    // once you've confirmed a good fix and don't want it scrolling by
    // during an actual race.
    logConsole: process.env.GPS_LOG !== '0' && process.env.GPS_LOG !== 'false',
    // On by default, and only actually matters when stdout is a real
    // terminal (see boatAgent.js's handlePvt and baseStation.js's
    // openBaseGps) - that's when a fix overwrites the same console line
    // instead of scrolling. Both boat and base show every fix this way
    // (not gated by TX_DISTANCE_M - that gate is only about what's worth
    // transmitting/recording, not what's worth watching), except a boat
    // fix that actually clears TX_DISTANCE_M, which commits to scrollback
    // instead of being overwritten, since that's a real event (a radio
    // send) worth keeping. Set GPS_LOG_REPLACE=0 to always scroll (one
    // line per logged fix) instead, e.g. if something downstream is
    // tailing/grepping this process's own terminal output directly rather
    // than a piped/redirected copy (where the in-place escape codes never
    // applied in the first place - see isTTY check).
    logReplace: process.env.GPS_LOG_REPLACE !== '0' && process.env.GPS_LOG_REPLACE !== 'false',
    // Off by default, boat only (see boatAgent.js's openGps) - logs a
    // `[rtcm]` line for every UBX-RXM-RTCM message the receiver reports
    // (RTCM message type, whether it was applied, CRC failures), the only
    // direct evidence this app can show that correction data is actually
    // reaching the receiver. Defaults off since UBX-RXM-RTCM is itself off
    // on the receiver by default too (a separate enable step - see
    // README's "Wiring notes") - without this flag, turning that message
    // on for a one-off diagnostic check would otherwise start scrolling
    // unwanted lines on every ordinary run afterward. Still gated by
    // logConsole above (GPS_LOG=0 silences this too).
    logRtcm: process.env.GPS_LOG_RTCM === '1' || process.env.GPS_LOG_RTCM === 'true',
    // Base station only - parameters sent along with a UBX-CFG-TMODE3
    // survey-in request (see adminServer.js's "Start survey-in" button).
    // svinMinDurS is the minimum time the receiver must spend surveying
    // before it can call the result valid, regardless of how quickly the
    // accuracy estimate converges; svinAccLimitMm is the accuracy the mean
    // position has to reach before it's accepted, regardless of how long
    // that takes - survey-in only completes once BOTH are satisfied. 60s /
    // 2000mm are gentle defaults for testing; a real fixed installation
    // typically wants both tightened (longer duration, tighter accuracy)
    // for cm-level RTK base precision.
    svinMinDurS: parseInt(process.env.GPS_SVIN_MIN_DUR_S || '60', 10),
    svinAccLimitMm: parseInt(process.env.GPS_SVIN_ACC_LIMIT_MM || '2000', 10),
  },

  // --- Telemetry radio (transparent-serial style, e.g. Digi XBee-PRO S3B) ---
  // Whatever bytes you write to this port are transmitted over the air and
  // appear byte-for-byte on the matching radio at the base station. Default
  // is 115200, NOT the radio's factory default (9600 for XBee, 57600 for
  // RFD900x/SiK) - at fleet sizes beyond a couple boats, the serial link to
  // the base station's own radio is the actual bottleneck (all boats' frames
  // funnel through that one port), well below the radio's real RF capacity.
  // Every radio (base + every boat) must be reconfigured via XCTU/RFD Modem
  // Tools to actually run at this baud before you change this value to
  // match - a mismatch here just means the port opens but nothing decodes.
  radio: {
    // NO_RADIO=1 skips opening the radio port entirely (e.g. bench-testing
    // GPS alone, no radio hardware attached) - fixes still log to SD.
    enabled: process.env.NO_RADIO !== '1' && process.env.NO_RADIO !== 'true',
    port: process.env.RADIO_PORT || '/dev/ttyUSB0',
    baud: parseInt(process.env.RADIO_BAUD || '115200', 10),
  },

  // --- Identity & timing ---
  boatId: parseInt(process.env.BOAT_ID || '1', 10),
  // How far the boat has to actually move before we transmit a new
  // position frame over the radio - distance-based, not time-based, so a
  // stopped boat doesn't keep re-sending the same fix and a fast-moving one
  // gets updates as often as its own movement warrants. GPS fixes can
  // arrive at 1-10Hz; this throttles radio TX independently to conserve
  // airtime/bandwidth over long range.
  txDistanceM: parseFloat(process.env.TX_DISTANCE_M || '1'),

  // Boat only - how long (max, milliseconds) a boat waits after hearing a
  // ping request (see protocol.js's encodePing/boatAgent.js's radio.on
  // ('ping', ...)) before actually transmitting its response - a random
  // delay drawn fresh per ping, uniform between 0 and this value, so an
  // entire fleet doesn't all key up over each other on the same shared
  // channel at the same instant the moment they hear the request. 3s is
  // generous relative to a single frame's own airtime, cheap even for a
  // large fleet, and short enough that an operator isn't left waiting long
  // for the dashboard to reflect a stationary boat's current position.
  pingResponseJitterMs: parseInt(process.env.PING_RESPONSE_JITTER_MS || '3000', 10),

  // How often the base station re-broadcasts the course marks to every boat
  // (base station only) - marks essentially never change mid-race, so this
  // is just a slow heartbeat for boats that missed an earlier broadcast or
  // powered on late, not a tight sync loop. Broadcast is best-effort (no
  // ACK/retry - see "Radio configuration" in the README), so a boat that
  // misses one still gets the next one a minute later.
  marksBroadcastIntervalMs: parseInt(process.env.MARKS_BROADCAST_INTERVAL_MS || '60000', 10),

  // --- Local logging (microSD) ---
  logDir,
  // CSV logs (boat SD card, base station's received-fix log) older than
  // this many days are deleted automatically - see logRotation.js. Keeps
  // an always-running base station laptop or a boat's microSD card from
  // filling up over a season of races instead of just one.
  logRetentionDays: parseInt(process.env.LOG_RETENTION_DAYS || '7', 10),
  // Boat only - how wide a slice of time each SD-card CSV covers (see
  // sdLogger.js's chunkBucket) before starting a new one. Smaller chunks
  // mean each one finishes (and becomes upload-eligible - see "upload"
  // below) sooner, at the cost of more, smaller files.
  logChunkMinutes: parseInt(process.env.LOG_CHUNK_MINUTES || '10', 10),

  // --- Log upload over WiFi (base station serves, boat sends) ---
  // Whenever a boat's own WiFi happens to reach the base station (no
  // guarantee of when, or for how long - see uploadClient.js), it pushes
  // its completed hourly SD-card logs there as a second, off-boat copy.
  // The base's address for this is broadcast alongside the course marks
  // (see protocol.js's encodeMarks) so a boat never needs to be told it
  // directly.
  upload: {
    // Base station only - port its upload-receiving HTTP server listens
    // on, and publishes in the marks broadcast.
    port: parseInt(process.env.UPLOAD_PORT || '8090', 10),
    // Base station only - where uploaded logs land, deliberately separate
    // from LOG_DIR/race-logs (that's this machine's own received-fix log,
    // not a dumping ground for every boat's SD card backup). Defaults to
    // a `race-uploads` directory next to LOG_DIR.
    dir: process.env.UPLOAD_DIR || path.join(path.dirname(logDir), 'race-uploads'),
    // Base station only - override auto-detecting this machine's own LAN
    // IP (see uploadServer.js's detectLocalIp) if it picks the wrong
    // interface, or none at all.
    baseIp: process.env.BASE_IP || null,
    // Boat only - set UPLOAD_DISABLED=1 to skip attempting log uploads
    // entirely (e.g. a boat with no WiFi radio at all, or one you'd rather
    // not have phoning home) - the base's own upload server is unaffected,
    // it just never hears from this boat.
    enabled: process.env.UPLOAD_DISABLED !== '1' && process.env.UPLOAD_DISABLED !== 'true',
    // Boat only - how often to check whether the base is currently
    // reachable and, if so, try sending one pending log file. A boat is
    // expected to drift in and out of WiFi range, so this is a cheap
    // periodic retry, not a persistent connection to maintain.
    checkIntervalMs: parseInt(process.env.UPLOAD_CHECK_INTERVAL_MS || '15000', 10),
    // Boat only - how long to wait for the base to respond (health check
    // or the upload itself) before giving up on this attempt and retrying
    // next check - keeps a boat that's just driven out of range from
    // hanging on a dead connection instead of just trying again shortly.
    timeoutMs: parseInt(process.env.UPLOAD_TIMEOUT_MS || '5000', 10),
  },

  // --- Admin dashboard (base station only) ---
  // A small live-stats web UI (src/adminServer.js) - boats seen, tracks
  // recorded, lap counts, upload activity, radio link quality. In-memory
  // only (see stats.js), so it resets on restart; not a substitute for
  // Redis/race-uploads as the durable record, just a "what's happening
  // right now" view for whoever's running the base station.
  admin: {
    port: parseInt(process.env.ADMIN_PORT || '8092', 10),
  },

  // --- Redis (base station only) ---
  // Where baseStation.js records every decoded fix, so tracks can be queried
  // per-boat or across the whole fleet for a timeframe. See redisStore.js.
  //
  // REDIS_ENV picks a connection preset below (default 'local'). Credentials
  // are never hardcoded here - set REDIS_USERNAME/REDIS_PASSWORD/REDIS_TLS
  // in the environment (or a git-ignored .env) when pointing at production.
  // REDIS_URL, if set, overrides everything below for one-off/ad-hoc use.
  redis: {
    url: process.env.REDIS_URL,
    connection: REDIS_CONNECTIONS[process.env.REDIS_ENV || 'local'] || REDIS_CONNECTIONS.local,
    // A stopped/slow-moving boat reporting every couple seconds would
    // otherwise write a nearly-identical fix over and over - skip a Redis
    // write (SD/console logging is unaffected) unless the boat has moved at
    // least this far since the last one that was actually recorded.
    minMovementM: parseFloat(process.env.REDIS_MIN_MOVEMENT_M || '5'),
  },

  // --- RegattaUp lap webhook (base station only) ---
  // Whenever finishLineWatcher.js (running inside baseStation.js) detects
  // an actual finish line crossing from a boat's position frames - real
  // hardware or simulated, doesn't matter - this triggers a POST so
  // RegattaUp counts the lap. Override the URL to point at a mock endpoint
  // for testing; set REGATTAUP_WEBHOOK_DISABLED=1 to skip sending entirely
  // (crossings are still detected and logged).
  //
  // Every lap is durably queued (see lapWebhookQueue.js) before the first
  // send attempt and only removed once RegattaUp actually accepts it - a
  // failed attempt (RegattaUp down, network blip, a base station restart
  // mid-retry) gets retried with capped exponential backoff rather than
  // silently dropped.
  regattaup: {
    webhookUrl: process.env.REGATTAUP_WEBHOOK_URL || 'https://regattaup.com/api/functions/mylapsWebhook',
    enabled: process.env.REGATTAUP_WEBHOOK_DISABLED !== '1' && process.env.REGATTAUP_WEBHOOK_DISABLED !== 'true',
    // Base station only - the admin dashboard's regatta selector (see
    // baseStation.js's refreshActiveRegattas) fetches this list so an
    // operator can pick which regatta this base station is reporting for.
    // No auth, no body - see RegattaUp's own API docs for the response
    // shape. Deliberately NOT derived from webhookUrl above - REGATTAUP_
    // WEBHOOK_URL commonly gets overridden to a mock/staging endpoint for
    // testing the lap webhook path, and that shouldn't also redirect the
    // regatta list (real setup data an operator needs to pick from) away
    // from the real RegattaUp host. Override REGATTAUP_ACTIVE_REGATTAS_URL
    // explicitly if the regatta list itself needs to be mocked too.
    activeRegattasUrl: process.env.REGATTAUP_ACTIVE_REGATTAS_URL || 'https://regattaup.com/api/functions/getActiveRegattas',
    // How often that list is refreshed in the background - regattas
    // essentially never change mid-race, so this is just a slow heartbeat
    // (pick up a newly published regatta, notice the selected one has
    // ended) rather than a tight sync loop.
    activeRegattasRefreshIntervalMs: parseInt(process.env.REGATTAUP_REGATTAS_REFRESH_INTERVAL_MS || '300000', 10), // 5 minutes
    queueDbPath: process.env.REGATTAUP_QUEUE_DB || path.join(logDir, 'lap_webhook_queue.sqlite'),
    // Every lap/on-grid/mark-rounding event is always queued first (see
    // baseStation.js's enqueueLap/OnGrid/MarkRounding), never POSTed
    // straight away - a single shared loop then drains at most one POST
    // per tick of this interval, across all three queues combined. Without
    // this, a burst of events arriving close together (a full fleet all
    // going on-grid within the same second, or a backlog of failed sends
    // all becoming retry-eligible at once) would fire that many concurrent
    // requests at RegattaUp with nothing pacing them. Same approach as the
    // sister p3-bridge project's own PostQueue (500ms default there too).
    // Replaces the old REGATTAUP_RETRY_INTERVAL_MS, which only paced
    // re-attempts of already-failed sends - this paces EVERY send,
    // including each event's very first attempt.
    postIntervalMs: parseInt(process.env.REGATTAUP_POST_INTERVAL_MS || '500', 10),
    maxBackoffMs: parseInt(process.env.REGATTAUP_MAX_BACKOFF_MS || '300000', 10), // 5 minutes
    // On-grid detection (see onGridWatcher.js): how close a boat has to be
    // to the pin<->committee (start) line, while still between the two
    // marks, to count as "on-grid" - an ongrid/offgrid webhook fires on
    // each transition. Same enabled/retry/backoff settings as laps above
    // (REGATTAUP_WEBHOOK_DISABLED also disables this), but its own queue
    // file - see onGridWebhookQueue.js's module comment for why it can't
    // just share lap_webhook_queue.sqlite.
    onGridZoneM: parseFloat(process.env.REGATTAUP_ONGRID_ZONE_M || '10'),
    onGridQueueDbPath: process.env.REGATTAUP_ONGRID_QUEUE_DB || path.join(logDir, 'ongrid_webhook_queue.sqlite'),
    // Mark-rounding detection (see markRoundingWatcher.js): reports a
    // 'mark' webhook whenever a boat crosses the virtual gate extending
    // markRoundingExtensionM beyond a windward/leeward mark. On by default,
    // same as laps and on-grid - set REGATTAUP_MARK_ROUNDING_ENABLED=0 to
    // turn it off, independent of the overall REGATTAUP_WEBHOOK_DISABLED
    // switch (which still gates it too - both must allow it for it to send).
    markRoundingEnabled: process.env.REGATTAUP_MARK_ROUNDING_ENABLED !== '0' && process.env.REGATTAUP_MARK_ROUNDING_ENABLED !== 'false',
    // Generous by default - there's no real downside to a longer gate (see
    // markRoundingWatcher.js's module comment: it only extends *along the
    // course axis*, so it stays far too short to be crossed by ordinary
    // tacking/gybing well short of the mark, no matter how long).
    markRoundingExtensionM: parseFloat(process.env.REGATTAUP_MARK_ROUNDING_EXTENSION_M || '50'),
    markRoundingQueueDbPath:
      process.env.REGATTAUP_MARK_ROUNDING_QUEUE_DB || path.join(logDir, 'mark_rounding_webhook_queue.sqlite'),
  },

  // --- Local UDP broadcast (base and boat both) ---
  // Every fix each process itself decodes/produces is also re-broadcast on
  // the local LAN, unthrottled (every fix, not gated by txDistanceM like
  // the long-range radio TX) - meant for onboard/dockside instruments
  // (chartplotters, a laptop running OpenCPN, u-center) to pick up
  // directly, independent of the race-tracking path above. Base and boat
  // share these settings so anything listening doesn't need to know which
  // one it's hearing from.
  localBroadcast: {
    // 'ubx' (default) re-emits a synthetic UBX-NAV-PVT message (see
    // ubxParser.js's encodeNavPvt) - the same format the GPS receiver
    // itself speaks, so anything that already parses UBX (u-center, this
    // app) can read it directly, and it carries fields (fix type, DOP,
    // accuracy estimates) plain NMEA GGA can't. Set
    // GPS_OUTPUT_FORMAT=nmea for a standard $GPGGA sentence instead, for
    // tools that only speak NMEA.
    format: (process.env.GPS_OUTPUT_FORMAT || 'ubx').toLowerCase(),
    address: process.env.UDP_BROADCAST_ADDR || '255.255.255.255',
    port: parseInt(process.env.UDP_PORT || '10110', 10), // 10110 is the conventional NMEA-over-UDP port
  },
};
