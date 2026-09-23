const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { getOrCreatePersistentBoatId, ID_LENGTH: BOAT_ID_LENGTH } = require('./boatIdFile');
const { getPersistedRegattaId, persistRegattaId } = require('./regattaIdFile');
const { getPersistedMarkName, persistMarkName } = require('./markNameFile');
const { getPersistedPowerSchedule, persistPowerSchedule } = require('./powerScheduleFile');
const { MARK_NAMES } = require('./course');
const { MAX_BATCH_COUNT } = require('./protocol');

// BOAT_ID always wins outright when set (by hand, or by fleetSim.js for
// every boat it spawns) - only falls back to this device's own persisted id
// (see boatIdFile.js) when BOAT_ID is entirely unset, e.g. a standalone
// `npm run boat` nobody's configured yet. The wire protocol's boatId field
// (protocol.js's BOAT_ID_LEN) is just a fixed-width slot of raw ASCII
// bytes - it doesn't actually require letters, that's only
// getOrCreatePersistentBoatId's own choice of alphabet for its randomly
// generated ids (see boatIdFile.js); fleetSim.js, for one, assigns plain
// zero-padded numbers instead (see its own sequentialBoatId). All this
// checks is the one thing that's actually a hard wire-format requirement -
// the length - and fails loudly rather than silently truncating/padding a
// wrong-length value, since a quietly-altered id is a much worse failure
// mode for fleet identification than a clear error at startup.
function resolveBoatId() {
  if (process.env.BOAT_ID === undefined) return getOrCreatePersistentBoatId();
  if (process.env.BOAT_ID.length !== BOAT_ID_LENGTH) {
    throw new Error(
      `BOAT_ID must be exactly ${BOAT_ID_LENGTH} characters (got "${process.env.BOAT_ID}") - the wire protocol's boatId field is a fixed-width ${BOAT_ID_LENGTH}-byte slot`
    );
  }
  return process.env.BOAT_ID;
}

// REGATTAUP_REGATTA_ID always wins when set - and, unlike BOAT_ID (which is
// only ever read, never written back), setting it here also persists it to
// regatta-id.txt immediately, so it becomes the new remembered default from
// this point on even on a later run that omits the env var entirely - see
// regattaIdFile.js's own comment on why both the env var and the admin
// dashboard's dropdown write to that same file. Falls back to whatever's
// already persisted there when the env var isn't set this run; null (not an
// error) if neither exists yet. Returns { id, name, defaultLat, defaultLon,
// venue, startDate, endDate } (everything but id null when setting via the
// env var, which has no way to also supply a display name, RegattaUp's own
// venue coordinates, or its dates - only ever filled in once the admin
// dashboard/startup prompt actually selects this id against RegattaUp's
// own live list, see baseStation.js's selectRegatta), not just a bare id -
// everything but id is display/course-default/offline-fallback only,
// matching is always by id.
function resolveDefaultRegattaId() {
  if (process.env.REGATTAUP_REGATTA_ID) {
    persistRegattaId(process.env.REGATTAUP_REGATTA_ID);
    return { id: process.env.REGATTAUP_REGATTA_ID, name: null, defaultLat: null, defaultLon: null, venue: null, startDate: null, endDate: null };
  }
  return getPersistedRegattaId();
}

// MARK_NAME - which course mark this device physically represents (see
// README's "Mark mode") - a rover permanently attached to a mark buoy that
// auto-posts that mark's position to Redis as it drifts, instead of an
// operator manually walking between marks and clicking "Set" (markset's own
// normal workflow, see baseStation.js's marksetMode). Same env-wins,
// persist-immediately spirit as resolveDefaultRegattaId above - an
// explicit MARK_NAME becomes the new remembered default from this point on,
// so a later restart that omits it still remembers the assignment. Falls
// back to whatever's already persisted when unset; null (not an error, and
// not a failure to run - see baseStation.js's assignedMarkName) if this
// device has never been assigned one. Validated against MARK_NAMES here
// (unlike BOAT_ID/REGATTAUP_REGATTA_ID, which have no fixed enum to check
// against) so a typo'd env var fails loudly at startup instead of quietly
// never matching any mark this app actually knows about.
function resolveMarkName() {
  const name = process.env.MARK_NAME || getPersistedMarkName();
  if (name && !MARK_NAMES.includes(name)) {
    throw new Error(`MARK_NAME must be one of ${MARK_NAMES.join(', ')} - got "${name}"`);
  }
  if (process.env.MARK_NAME) persistMarkName(name);
  return name || null;
}

// Same env-wins spirit as resolveBoatId/resolveDefaultRegattaId above, but
// per-field rather than all-or-nothing: each of the four ROVER_SHUTDOWN_*
// vars independently overrides whatever's persisted, since an operator
// might reasonably set just ROVER_SHUTDOWN_AT in a systemd unit and leave
// the rest to their previous dashboard-set values (or the hardcoded
// defaults). Whatever the effective combination ends up being this boot -
// some fields from env vars, the rest from the last persisted schedule or
// their defaults - gets persisted right back, so a later restart with NO
// env vars at all (the normal case once an operator's using the rover
// dashboard's own power card - see roverAdminServer.js/powerSchedule.js)
// remembers exactly what was in effect last, not just whatever a stale env
// var says.
function resolveDefaultPowerSchedule() {
  const persisted = getPersistedPowerSchedule() || {};
  const schedule = {
    shutdownAt:
      process.env.ROVER_SHUTDOWN_AT !== undefined ? process.env.ROVER_SHUTDOWN_AT || null : persisted.shutdownAt ?? null,
    shutdownIdleMinutes:
      process.env.ROVER_SHUTDOWN_IDLE_MIN !== undefined
        ? parseFloat(process.env.ROVER_SHUTDOWN_IDLE_MIN)
        : persisted.shutdownIdleMinutes ?? 10,
    shutdownSpeedKn:
      process.env.ROVER_SHUTDOWN_SPEED_KN !== undefined
        ? parseFloat(process.env.ROVER_SHUTDOWN_SPEED_KN)
        : persisted.shutdownSpeedKn ?? 0.5,
    shutdownCheckIntervalMs:
      process.env.ROVER_SHUTDOWN_CHECK_INTERVAL_MS !== undefined
        ? parseInt(process.env.ROVER_SHUTDOWN_CHECK_INTERVAL_MS, 10)
        : persisted.shutdownCheckIntervalMs ?? 30000,
  };
  persistPowerSchedule(schedule);
  return schedule;
}

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

// The BASE's own received-fix CSV log (see baseStation.js's ensureCsvFile).
// Override to point at wherever a long-running base station's disk should
// hold it. Default is relative to this package (not the shell's cwd), so it
// works the same on a Pi or a laptop. BASE_LOG_DIR/BASE_UPLOAD_DIR (this and
// upload.dir below) are named to match this app's own run-mode names
// (`npm run base`/`npm run boat`), same as BOAT_LOG_DIR - so which var
// controls which role's directory is obvious from the name alone, not
// something you have to remember.
const logDir = process.env.BASE_LOG_DIR || path.join(__dirname, '..', 'base-logs');

// The BOAT's own chunked SD-card log (see sdLogger.js) - deliberately a
// completely separate directory from BASE_LOG_DIR above, not a
// subdirectory of it, so the two never end up sharing one directory even
// when both roles happen to run from the same checkout on the same machine
// (a boat's own track history and a base's received-fix log are different
// data with different retention/pruning, and mixing them under one shared
// directory was genuinely confusing - see README's "File layout"). On the
// boat Pi, override BOAT_LOG_DIR to point at the SD card mount.
const boatLogDir = process.env.BOAT_LOG_DIR || path.join(__dirname, '..', 'boat-logs');

// Where every small piece of persisted config/state lives - the webhook
// retry queues' sqlite files and the boat's course_marks.json cache below,
// plus (independently redeclared in each of their own modules, to avoid a
// circular require back into this file - see boatIdFile.js's own comment)
// boat_id.txt/regatta-id.txt/mark-name.txt/power-schedule.txt. Deliberately
// NOT redirectable via BASE_LOG_DIR - unlike base-logs (raw track data,
// fine to point at a swappable SD card), this is small, low-write-volume
// state that should survive independently of wherever BASE_LOG_DIR happens
// to be pointed this run, same reasoning boatIdFile.js already used for
// its own identity file before this directory existed.
const configDir = path.join(__dirname, '..', 'race-config');
fs.mkdirSync(configDir, { recursive: true });

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
    centerLat: parseFloat(process.env.SIM_CENTER_LAT || '40.8970'), // ~0.5mi north of the original 40.8898
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
    // Off by default - diagnostic override for foulWatcher.js (base station
    // side) and RegattaUp's own foul handling: instead of racing normally,
    // the boat holds at its start position exactly like any other boat
    // (still respects prestartDwellS/holdForStart), then on start sails
    // foulWindwardM upwind before turning around and sailing straight back
    // through the finish line, the committee gap, and the start line, all
    // in the downwind (illegal) direction - see simGps.js's
    // _foulWaypoints/_tickFoulTest. A real, repeatable foul event on
    // demand, without needing a human pilot to sail the illegal path by
    // hand. Only meaningful set on ONE boat at a time (see boatAgent.js) -
    // setting it fleet-wide would have every boat drive the same scripted
    // path instead of racing, which isn't useful for anything.
    foulTest: process.env.SIM_FOUL === '1' || process.env.SIM_FOUL === 'true',
    // "A bit windward" - how far upwind (meters) the boat sails before
    // turning back for the illegal return leg. Modest by default: this only
    // needs to look like a real departure, not actually get anywhere near
    // the windward mark.
    foulWindwardM: parseFloat(process.env.SIM_FOUL_WINDWARD_M || '150'),
    // Which windward/leeward mark pair the simulated boat actually races -
    // two letters, windward first, each 'G' (green, short course) or 'B'
    // (black, long course): 'BB' (default, the plain long course), 'GG'
    // (plain short course), or a mixed 'BG'/'GB' (see course.js's
    // parseCourseMarks/deriveGeometry for how a mixed pair's beat length
    // comes out). Validated eagerly here, not deep inside boatAgent.js's
    // async marks-received callback, so a typo fails fast at startup with a
    // clear message instead of surfacing later mid-race.
    courseMarks: (() => {
      const raw = (process.env.SIM_COURSE_MARKS || 'BB').toUpperCase();
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
    // Off by default (both roles) - a fleet of any real size floods the
    // console with a per-fix line each, drowning out anything else worth
    // watching. Set GPS_LOG=1 to turn the [gps]/[baseGps] console line back
    // on, e.g. while confirming a fix is actually coming through.
    logConsole: process.env.GPS_LOG === '1' || process.env.GPS_LOG === 'true',
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
  // Tried bumping this to 230400 after a 100-boat radio-congestion run
  // measured the SERIAL link saturating at ~11.2 KB/s (almost exactly
  // 115200's own 8N1 ceiling, 115200/10 bits-per-byte = 11,520 B/s) - but
  // that just exposed a lower ceiling one level up: at 230400 the same test
  // pushed 15.4 KB/s and sync errors jumped from 0.2% to 10.4% (see
  // radioLink.js's own sync-error comment - that's real bit corruption on
  // the RF link, not local buffering, since bandwidth used was still well
  // under 230400's own ~23 KB/s ceiling). This fleet's XBee-PRO 900HP 200K
  // radios' real sustainable RF throughput tops out around ~11-12 KB/s
  // regardless of serial baud - 115200 was accidentally already throttling
  // right at that ceiling, not artificially limiting it. Don't raise this
  // without re-running that same congestion test and checking sync-error
  // rate, not just bandwidth headroom - use TX_BATCH_SIZE instead if you
  // need more real fix throughput (reduces actual RF bytes-per-fix, not
  // just how fast the serial link can be fed). Every radio (base + every
  // boat) must be reconfigured via XCTU (see xbee_configure_at.py) or RFD
  // Modem Tools to actually run at this baud before you change this value
  // to match - a mismatch here just means the port opens but nothing
  // decodes.
  radio: {
    // RADIO_ENABLED=0 skips opening the radio port entirely (e.g. bench-testing
    // GPS alone, no radio hardware attached) - fixes still log to SD.
    enabled: process.env.RADIO_ENABLED !== '0' && process.env.RADIO_ENABLED !== 'false',
    port: process.env.RADIO_PORT || '/dev/ttyUSB0',
    baud: parseInt(process.env.RADIO_BAUD || '115200', 10),
  },

  // --- Scheduled shutdown (boat only) ---
  // Battery-saving: shuts THIS device down (not the boat's own power/GPS
  // hardware, just this Pi) once both a configured clock time has passed
  // AND the boat has been genuinely stationary for a sustained window - see
  // powerSchedule.js for the actual logic. The idle gate exists specifically
  // so a race running late doesn't get killed mid-track just because the
  // clock crossed shutdownAt; it waits for a real lull instead.
  // Off by default (shutdownAt null) - this is real hardware shutting
  // itself off, not something to happen without an operator deliberately
  // opting in, either via ROVER_SHUTDOWN_AT or the rover dashboard's own
  // power card. Power-up is NOT handled here - this repo has no way to know
  // what (if any) RTC-alarm/relay/smart-switch hardware a given Pi has
  // wired up to bring it back; that's on whatever's actually controlling
  // this device's power rail. Without such hardware, someone has to
  // physically re-power it before the next session either way.
  //
  // See resolveDefaultPowerSchedule above for exactly how these four
  // fields resolve between the ROVER_SHUTDOWN_* env vars and whatever's
  // persisted from a previous run/dashboard edit (power-schedule.txt, via
  // powerScheduleFile.js) - boatAgent.js only ever reads this snapshot at
  // startup; from then on the running scheduler (see powerSchedule.js's
  // startShutdownScheduler) holds the live, dashboard-editable values.
  power: resolveDefaultPowerSchedule(),

  // --- Identity & timing ---
  boatId: resolveBoatId(),
  // Boat only (`npm run markset`/`npm run mark` - see markSetStation.js) -
  // an ordinary boatAgent.js process in every other respect (still
  // transmits its own position, still tracked as a regular boat), except
  // its own roverAdminServer.js /map page also shows a "Set" button per
  // course mark (see boatAgent.js's sendSetMark). Deliberately NOT shown
  // on an ordinary boat's map - an accidental tap during racing shouldn't
  // be able to move a live course mark, so this capability only appears on
  // a device an operator explicitly launched for mark-setting duty. No
  // continuous auto-post, no "this rover represents X" assignment - just
  // the button, sent once, using whatever this device's own GPS says right
  // now (see README's "Setting a mark over the radio").
  marksetMode: process.env.MARKSET_MODE === '1',
  // Which mark this device represents, if any (see README's "Mark mode") -
  // null is the overwhelmingly common case (plain base/boat/markset, never
  // assigned to a mark at all).
  markName: resolveMarkName(),
  // How far the assigned mark has to actually move before this device
  // posts a new position to Redis for it - same distance-gated spirit as
  // txDistanceM below, just for a stationary/slow-drifting mark buoy
  // instead of a moving boat, so ordinary GPS jitter on an anchored mark
  // doesn't write to Redis on every single fix.
  markDistanceM: parseFloat(process.env.MARK_DISTANCE_M || '1'),
  // How far the boat has to actually move before we transmit a new
  // position frame over the radio - distance-based, not time-based, so a
  // stopped boat doesn't keep re-sending the same fix and a fast-moving one
  // gets updates as often as its own movement warrants. GPS fixes can
  // arrive at 1-10Hz; this throttles radio TX independently to conserve
  // airtime/bandwidth over long range.
  txDistanceM: parseFloat(process.env.TX_DISTANCE_M || '1'),

  // Tightens the distance gate above to txFinishDistanceM (below) whenever
  // this boat is within this many meters of the finish line AND closing on
  // it while sailing upwind - see finishApproach.js's own module comment
  // for the exact "upwind" convention (the same committee-boat-on-the-
  // left one FinishLineWatcher already uses, so the two never disagree
  // about which side is upwind). A close finish is exactly the moment an
  // operator most wants frequent position updates, not whatever coarser
  // txDistanceM they set for the rest of the race. 0 disables this
  // entirely (txDistanceM applies everywhere, unchanged from before this
  // existed) - same "0 means off" convention as txIntervalMs below. Off by
  // default for now (0) - this fleet's actual GPS fix rate at real finish
  // speeds hasn't been validated in the field yet (see the 30mph/0.3m
  // sizing discussion - the achievable floor depends entirely on the
  // rover's own CFG-RATE-MEAS), so this stays opt-in until that's settled
  // rather than silently enabling a distance target the hardware might not
  // actually be able to hit.
  txFinishApproachZoneM: parseFloat(process.env.TX_FINISH_APPROACH_ZONE_M || '0'),
  // The tightened distance gate itself, only in effect inside
  // txFinishApproachZoneM above.
  txFinishDistanceM: parseFloat(process.env.TX_FINISH_DISTANCE_M || '0.3'),

  // How many consecutive fixes to pack into one radio transmission instead
  // of sending each as its own frame - see protocol.js's own comment on the
  // batch frame type and boatAgent.js's queueFixForTx/flushPendingBatch.
  // Trades a little latency (fixes wait to fill a batch, bounded by
  // txIntervalMs below so a slow-moving boat still can't go silent longer
  // than that) for fewer, larger over-the-air transmissions - worth trying
  // only if per-transmission overhead, not per-byte airtime, turns out to be
  // the real bottleneck at your fleet size (see "Congestion-testing the
  // radio" in the README). 1 (the default) means "one frame per fix,"
  // exactly this app's original behavior - boatAgent.js never even touches
  // the batch frame type at that setting. Clamped to protocol.js's own
  // MAX_BATCH_COUNT (the largest batch frame stays comfortably under this
  // fleet's actual, read-only NP=100 max RF payload - see MAX_BATCH_COUNT's
  // own comment), not just trusted from the environment, since encodeBatch
  // throws on anything larger.
  txBatchSize: Math.max(1, Math.min(MAX_BATCH_COUNT, parseInt(process.env.TX_BATCH_SIZE || '1', 10) || 1)),

  // Heartbeat alongside txDistanceM above: even a boat that hasn't moved
  // far enough to clear the distance gate still transmits at least once
  // every this many seconds, so a stationary boat (sitting at a mooring,
  // holding on the grid) doesn't go completely silent on the base's
  // dashboard for as long as it stays still. Distance-gated sends still
  // reset this timer (see boatAgent.js's transmitFix) - it only ever fires
  // when NEITHER gate has cleared in this long, not on top of every
  // distance-triggered send too. 0 disables it (distance gate only, the
  // old behavior).
  txIntervalMs: parseFloat(process.env.TX_INTERVAL_S || '60') * 1000,

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

  // Boat only - max random delay (ms, uniform between 0 and this value)
  // before the FIRST hello announcement once the radio connects (see
  // boatAgent.js's startHelloAnnounce) - same reasoning as
  // pingResponseJitterMs above, applied at startup instead of per-request:
  // a whole fleet's radios connecting together (every boat powered on
  // right before a start, or npm run fleet spawning every boat process in
  // the same instant) would otherwise announce - and keep retrying every
  // HELLO_RETRY_MS - in perfect lockstep. The retry interval only starts
  // counting once this one jittered delay elapses, so each boat's own
  // retries stay offset from every other boat's indefinitely, not just on
  // the very first send.
  helloStartupJitterMs: parseInt(process.env.HELLO_STARTUP_JITTER_MS || '3000', 10),

  // How often the base station re-broadcasts the course marks to every boat
  // (base station only) - marks essentially never change mid-race, so this
  // is just a slow heartbeat for boats that missed an earlier broadcast or
  // powered on late, not a tight sync loop. Broadcast is best-effort (no
  // ACK/retry - see "Radio configuration" in the README), so a boat that
  // misses one still gets the next one a minute later.
  marksBroadcastIntervalMs: parseInt(process.env.MARKS_BROADCAST_INTERVAL_MS || '60000', 10),
  // Base station only - off by default (see baseStation.js's
  // broadcastMarksNow), set LOG_MARKS_BROADCAST=1 to log every broadcast.
  logMarksBroadcast: process.env.LOG_MARKS_BROADCAST === '1' || process.env.LOG_MARKS_BROADCAST === 'true',
  // Base station only - off by default, gates the `[base] boat=... lat,lon
  // ...` console line baseStation.js's logToConsole prints for every single
  // received radio frame from every boat - a full fleet at a normal GPS
  // rate floods the console fast, so this stays quiet unless asked for (set
  // LOG_RECEIVED_FIXES=1 to turn it on, e.g. while confirming frames are
  // actually arriving). Deliberately independent of everything else that
  // frame still does regardless of this flag: it's still written to this
  // base's own CSV log (logToCsv), still recorded to Redis, and still
  // checked for laps/on-grid/mark-roundings/fouls (detectRaceEvents) - this
  // only silences the routine per-fix console echo, not the actual
  // race-event detection those fixes drive.
  logReceivedFrames: process.env.LOG_RECEIVED_FIXES === '1' || process.env.LOG_RECEIVED_FIXES === 'true',

  // --- Local logging (microSD) ---
  logDir,
  // Boat's own SD-card log directory - a completely separate directory from
  // logDir above, see this const's own comment.
  boatLogDir,
  // See this const's own comment above - persisted config/state, not raw
  // log data, deliberately NOT redirectable via BASE_LOG_DIR.
  configDir,
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
    // from BASE_LOG_DIR/base-logs (that's this machine's own received-fix
    // log, not a dumping ground for every boat's SD card backup). Defaults
    // to a `base-uploads` directory next to BASE_LOG_DIR.
    dir: process.env.BASE_UPLOAD_DIR || path.join(path.dirname(logDir), 'base-uploads'),
    // Base station only - override auto-detecting this machine's own LAN
    // IP (see uploadServer.js's detectLocalIp) if it picks the wrong
    // interface, or none at all.
    baseIp: process.env.BASE_IP || null,
    // Boat only - on by default. Only gates the actual file transfer -
    // uploadClient.js's periodic health-check ping (which is how the base
    // ever learns this boat's IP/admin port at all, see
    // adminServer.js's dashboard link) always runs regardless, so turning
    // this off doesn't also make a boat invisible to the base's dashboard.
    // Set UPLOAD_ENABLED=0 to turn off just the file transfer, e.g. a
    // simulated fleet with no real SD-card logs worth pushing over WiFi.
    enabled: process.env.UPLOAD_ENABLED !== '0' && process.env.UPLOAD_ENABLED !== 'false',
    // Both roles - off by default. Gates only the one-line "uploaded"/
    // "received" console message on a successful transfer (uploadClient.js/
    // uploadServer.js) - a boat uploads a chunk every LOG_CHUNK_MINUTES for
    // the whole race, so this would otherwise print on its own timer
    // regardless of anything actually being wrong. Failures stay visible
    // either way (console.error in both files) - those are worth knowing
    // about even with this off. Set UPLOAD_LOG=1 to turn it back on.
    logSuccess: process.env.UPLOAD_LOG === '1' || process.env.UPLOAD_LOG === 'true',
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
  // Redis/base-uploads as the durable record, just a "what's happening
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
    minMovementM: parseFloat(process.env.REDIS_MIN_MOVEMENT_M || '1'),
    // How long a boat:<id>:track/all:track:<regattaId> key sticks around
    // before Redis drops it on its own - set once, the first time that key
    // is written on a given day (see redisStore.js's recordFix), not
    // refreshed on every later write, so a full day's worth of races all
    // still expire together roughly a day after the FIRST fix of the day,
    // not a rolling day after the last one. 48h by default - covers
    // reviewing a race day into the next, without tracks piling up in Redis
    // forever (there's no other cleanup for these besides `npm run
    // clear-base-logs`, which is manual).
    trackRetentionHours: parseFloat(process.env.REDIS_TRACK_RETENTION_HOURS || '48'),
    // The admin dashboard's "Redis memory" card divides usedBytes by this to
    // show a percentage/ALERT status, the same way the disk-space card does
    // for the filesystem - but unlike disk space, Redis has no OS syscall to
    // ask "how much room is actually left," and a managed instance (Redis
    // Cloud and similar) commonly won't even report its own configured
    // maxmemory via CONFIG GET (see redisStore.js's getMemoryInfo) - that
    // limit lives in the platform's own plan size, not a queryable Redis
    // setting. Defaults to 250 - this app's own smallest realistic Redis
    // Cloud plan size - so the card shows a real percentage out of the box;
    // override with the actual plan size if it's not 250MB.
    memoryLimitMb: parseFloat(process.env.REDIS_MEMORY_LIMIT_MB || '250'),
    // How often redisStore.js sends an idle-connection keepalive PING.
    // Without real traffic, a managed instance (Redis Cloud and similar -
    // see memoryLimitMb's own comment) or whatever network sits between
    // this base and it (a NAT/firewall on the base's own WiFi/cellular link
    // included) silently drops the TCP connection after some idle period -
    // observed in production as a `read ETIMEDOUT` roughly every 12-36
    // minutes, varying with how much real Redis traffic happened to be
    // flowing (see redisStore.js's own comment on the keepalive timer for
    // the full diagnosis). ioredis's retryStrategy already recovers from
    // this cleanly (reconnects within ~3s - see redisStore.js's own
    // 'close'/'ready' logging), so this isn't fixing a failure, just
    // avoiding causing one: keeping real Redis protocol traffic flowing
    // often enough that neither end (nor anything in between) ever sees the
    // connection go idle long enough to reap it. Comfortably under the
    // shortest observed idle-to-drop window above.
    keepaliveIntervalMs: parseInt(process.env.REDIS_KEEPALIVE_INTERVAL_MS || '60000', 10),
  },

  // --- RegattaUp lap webhook (base station only) ---
  // Whenever finishLineWatcher.js (running inside baseStation.js) detects
  // an actual finish line crossing from a boat's position frames - real
  // hardware or simulated, doesn't matter - this triggers a POST so
  // RegattaUp counts the lap. Override the URL to point at a mock endpoint
  // for testing; set REGATTAUP_WEBHOOK_ENABLED=0 to skip sending entirely
  // (crossings are still detected and logged). On by default, same
  // unset-means-on convention as markRoundingEnabled/foulEnabled below.
  //
  // Every lap is durably queued (see lapWebhookQueue.js) before the first
  // send attempt and only removed once RegattaUp actually accepts it - a
  // failed attempt (RegattaUp down, network blip, a base station restart
  // mid-retry) gets retried with capped exponential backoff rather than
  // silently dropped.
  regattaup: {
    webhookUrl: process.env.REGATTAUP_WEBHOOK_URL || 'https://regattaup.com/api/functions/mylapsWebhook',
    enabled: process.env.REGATTAUP_WEBHOOK_ENABLED !== '0' && process.env.REGATTAUP_WEBHOOK_ENABLED !== 'false',
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
    // Which regatta to auto-select at startup if none is already active in
    // Redis (see baseStation.js's own startup block and selectRegatta) - an
    // { id, name, defaultLat, defaultLon, venue, startDate, endDate } object,
    // or null. REGATTAUP_REGATTA_ID always wins when
    // set, and gets persisted to regatta-id.txt right away so it becomes
    // the new default even without the env var on later runs; otherwise
    // falls back to whatever's already in that file (see regattaIdFile.js),
    // most recently written either by a prior REGATTAUP_REGATTA_ID or by an
    // operator's own pick from the admin dashboard's dropdown or the
    // startup terminal prompt. null (not an error) when neither exists -
    // the existing "no regatta selected" startup behavior (now: prompt
    // interactively, or warn if not possible) is unchanged in that case.
    // This is a DEFAULT, not a hard override - it's only ever applied when
    // Redis has nothing currently selected, never used to clobber an
    // already-active selection (e.g. one still valid from this same base's
    // last run).
    defaultRegatta: resolveDefaultRegattaId(),
    // How often that list is refreshed in the background - regattas
    // essentially never change mid-race, so this is just a slow heartbeat
    // (pick up a newly published regatta, notice the selected one has
    // ended) rather than a tight sync loop.
    activeRegattasRefreshIntervalMs: parseInt(process.env.REGATTAUP_REGATTAS_REFRESH_INTERVAL_MS || '300000', 10), // 5 minutes
    // Off by default - a successful fetch is the expected, ordinary
    // outcome of a background heartbeat that runs indefinitely (every
    // activeRegattasRefreshIntervalMs), so logging one every time is just
    // scroll, not signal. A failed fetch still always logs (see
    // refreshActiveRegattas' own console.error) regardless of this flag -
    // that's the actual actionable case. Set REGATTAUP_LOG_ACTIVE_REGATTAS=1
    // to see the routine success line too, e.g. while confirming a mocked
    // REGATTAUP_ACTIVE_REGATTAS_URL is actually being hit on schedule.
    logActiveRegattas: process.env.REGATTAUP_LOG_ACTIVE_REGATTAS === '1' || process.env.REGATTAUP_LOG_ACTIVE_REGATTAS === 'true',
    queueDbPath: process.env.REGATTAUP_QUEUE_DB || path.join(configDir, 'lap_webhook_queue.sqlite'),
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
    // to the pin<->committeeStart (start) line, while still between the two
    // marks, to count as "on-grid" - an ongrid/offgrid webhook fires on
    // each transition. Same enabled/retry/backoff settings as laps above
    // (REGATTAUP_WEBHOOK_ENABLED=0 also disables this), but its own queue
    // file - see onGridWebhookQueue.js's module comment for why it can't
    // just share lap_webhook_queue.sqlite.
    onGridZoneM: parseFloat(process.env.REGATTAUP_ONGRID_ZONE_M || '10'),
    onGridQueueDbPath: process.env.REGATTAUP_ONGRID_QUEUE_DB || path.join(configDir, 'ongrid_webhook_queue.sqlite'),
    // Mark-rounding detection (see markRoundingWatcher.js): reports a
    // 'mark' webhook whenever a boat crosses the virtual gate extending
    // markRoundingExtensionM beyond a windward/leeward mark. On by default,
    // same as laps and on-grid - set REGATTAUP_MARK_ROUNDING_ENABLED=0 to
    // turn it off, independent of the overall REGATTAUP_WEBHOOK_ENABLED
    // switch (which still gates it too - both must allow it for it to send).
    markRoundingEnabled: process.env.REGATTAUP_MARK_ROUNDING_ENABLED !== '0' && process.env.REGATTAUP_MARK_ROUNDING_ENABLED !== 'false',
    // Generous by default - there's no real downside to a longer gate (see
    // markRoundingWatcher.js's module comment: it only extends *along the
    // course axis*, so it stays far too short to be crossed by ordinary
    // tacking/gybing well short of the mark, no matter how long).
    markRoundingExtensionM: parseFloat(process.env.REGATTAUP_MARK_ROUNDING_EXTENSION_M || '50'),
    markRoundingQueueDbPath:
      process.env.REGATTAUP_MARK_ROUNDING_QUEUE_DB || path.join(configDir, 'mark_rounding_webhook_queue.sqlite'),
    // Foul detection (see foulWatcher.js): reports a 'foul' webhook whenever
    // a boat's path crosses the start line, the finish line the wrong way
    // (downwind), or passes between the two committee boats at all. On by
    // default, same as laps/on-grid/mark-rounding - set
    // REGATTAUP_FOUL_ENABLED=0 to turn it off, independent of the overall
    // REGATTAUP_WEBHOOK_ENABLED switch (which still gates it too - both
    // must allow it for it to send).
    foulEnabled: process.env.REGATTAUP_FOUL_ENABLED !== '0' && process.env.REGATTAUP_FOUL_ENABLED !== 'false',
    foulQueueDbPath: process.env.REGATTAUP_FOUL_QUEUE_DB || path.join(configDir, 'foul_webhook_queue.sqlite'),
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
