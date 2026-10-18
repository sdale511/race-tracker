require('./logTimestamps');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { RedisStore } = require('./redisStore');
const { sequentialBoatId } = require('./boatIdFile');

// Spawns a fleet of independent `boatAgent.js` processes, each simulating
// its own boat (own BOAT_ID, own randomized start slot/speed/course - see
// simGps.js), all racing concurrently against whatever base station is
// already listening (`SIMULATE=1 npm run base` in another terminal - this
// script only ever starts boats, never a base, same separation the rest of
// the README already uses). Each boat is a full OS process, not a thread,
// because boatAgent.js's own state (radio socket, admin dashboard port, SD
// log files) is written to assume there's exactly one boat per process -
// the same reason the README's own multi-boat instructions are "run more
// `npm run boat` terminals with different BOAT_ID values", just automated
// here instead of done by hand.
//
// Run with `npm run fleet` (respects FLEET_SIZE below, plus any of
// boatAgent's own SIM_* env vars - LAP_COUNT, START_ONLY, etc. - all of
// which pass through to every spawned boat unchanged):
//
//   FLEET_SIZE=5 npm run fleet
//
// Every boat is started with SIM_EXIT_ON_FINISH=1 (see config.js), so each
// one's own process exits itself the moment it completes its laps - this
// script doesn't police that from the outside, it just watches the child
// processes exit on their own and reports the fleet done once the last one
// has. Ctrl+C here forwards SIGINT to whichever boats are still racing.

const FLEET_SIZE = parseInt(process.env.FLEET_SIZE || '3', 10);
// RF_BRIDGE=1 (`npm run fleet-rf`): the fleet shares ONE real radio instead of the UDP stand-in, so its boats are heard by a real
// base over the air - the RF test. This process opens the radio (RADIO_PORT/RADIO_BAUD, as a boat would) and relays frames both
// ways over the children's IPC channel (ipcRadioLink.js): everything the radio hears goes to every boat, and every frame a boat
// sends is written to the radio. Each boat has its own id, so each gets its own slot from the base's table. To test with more
// boats than one radio can carry, run this on a second radio (or machine) with FLEET_ID_START so the ids do not repeat.
const RF_BRIDGE = process.env.RF_BRIDGE === '1' || process.env.RF_BRIDGE === 'true';
// Boats start this far apart (FLEET_STAGGER_MS): boat 1 at once, boat 2 after one gap, boat 3 after two, ... Boats that start in the same
// moment all announce themselves, ask for the marks and send their first fix at once, before any of them has a slot - on a shared
// radio that is a pile-up (a cold start of 20 boats put 40 sync errors on the base). Off (0) by default for the UDP fleet, 250 ms
// for RF_BRIDGE; 0 starts everyone together.
const FLEET_STAGGER_MS = parseInt(process.env.FLEET_STAGGER_MS || (RF_BRIDGE ? '250' : '0'), 10);
// First number of this fleet's boat ids (00001, 00002, ...): a second fleet on a second radio starts after the first one's.
const FLEET_ID_START = parseInt(process.env.FLEET_ID_START || '1', 10);
// Matches boatAgent.js's own SIMULATE=1 default admin port (8093) as the
// base - each boat needs its own distinct port (an explicit ADMIN_PORT
// from the parent env would otherwise collide across every child), so this
// is never inherited from process.env, always assigned per boat below.
const ADMIN_PORT_START = parseInt(process.env.FLEET_ADMIN_PORT_START || '8093', 10);
// Off by default - every raw IPC message a boat sends (see boatAgent.js's
// 'waiting-for-fix'/'on-grid') already feeds the aggregated summary line
// below; echoing each one individually is fleet-size-worth of near-
// duplicate lines, only worth it while actually debugging the IPC channel
// itself. Set LOG_IPC=1 to see them.
const LOG_IPC = process.env.LOG_IPC === '1' || process.env.LOG_IPC === 'true';

if (!Number.isInteger(FLEET_ID_START) || FLEET_ID_START < 1) {
  console.error(`[fleetSim] invalid FLEET_ID_START=${process.env.FLEET_ID_START} - must be a positive integer`);
  process.exit(1);
}
if (!Number.isInteger(FLEET_SIZE) || FLEET_SIZE < 1) {
  console.error(`[fleetSim] invalid FLEET_SIZE=${process.env.FLEET_SIZE} - must be a positive integer`);
  process.exit(1);
}

// Sequential (00001, 00002, ...) rather than boatIdFile.js's random
// generateBoatId - this process assigns every id in the fleet itself, so
// there's nothing to coordinate against and no reason to draw randomly;
// a plain incrementing number is easier to track across a console full of
// interleaved per-boat log lines than random ids would be.
const fleetBoatIds = Array.from({ length: FLEET_SIZE }, (_, i) => sequentialBoatId(FLEET_ID_START + i));

console.log(`[fleetSim] starting ${FLEET_SIZE} boat(s)${FLEET_STAGGER_MS > 0 ? ` ${FLEET_STAGGER_MS} ms apart` : ''}, BOAT_ID: ${fleetBoatIds.join(', ')}${RF_BRIDGE ? ` - over the real radio on ${config.radio.port}` : ''}`);

// This script's whole purpose is a fleet of SIMULATED boats - defaults
// SIMULATE=1 so `npm run fleet` works with no other env vars set, but
// leaves an explicit SIMULATE/SIMULATE_GPS from the parent env alone (e.g.
// SIMULATE_GPS=1 with real radio hardware, bench-testing several actual
// radios at once).
const baseEnv = { ...process.env };
if (RF_BRIDGE) {
  // Boats are fully simulated (GPS and race) but their radio is the bridge below. Marks come over the air from the base, the
  // same way a real boat gets them - nothing here reads Redis.
  baseEnv.SIMULATE = '1';
  baseEnv.RF_BRIDGE = '1';
}
if (baseEnv.SIMULATE !== '1' && baseEnv.SIMULATE !== 'true' && baseEnv.SIMULATE_GPS !== '1' && baseEnv.SIMULATE_GPS !== 'true') {
  baseEnv.SIMULATE = '1';
}

const boatAgentPath = path.join(__dirname, 'boatAgent.js');

// Every boat this script spawns shares this exact path (none of them get a
// per-boat LOG_DIR override below), the same one boatAgent.js's own
// marksFilePath resolves to - so fetching the course ONCE here and writing
// it here means every child finds it already sitting on disk the instant it
// starts, instead of each of the FLEET_SIZE boats independently pinging the
// (already-running) base station over its own simulated radio link and
// waiting out MARKS_PING_RETRY_MS retries for an answer this process could
// just look up directly.
const marksFilePath = path.join(config.configDir, 'course_marks.json');

// Fetches (or creates, if truly missing - same getOrCreateMarks() guarantee
// resetCourse.js/baseStation.js already rely on, so this never clobbers a
// course an operator already set up) the CURRENT course straight from
// Redis and writes it to marksFilePath above. Every boat this script spawns
// then gets SIM_TRUST_CACHED_MARKS=1 (see boatAgent.js), so it trusts this
// freshly-written file immediately on startup rather than waiting on a
// radio broadcast for information this process already has in hand.
async function ensureFreshMarksCached() {
  const redisStore = new RedisStore({ url: config.redis.url, connection: config.redis.connection });
  try {
    const marks = await redisStore.getOrCreateMarks(config.sim.centerLat, config.sim.centerLon);
    // getOrCreateMarks only ever returns the MARK_NAMES set - the pin
    // boundary gate (see course.js's own comment on PIN_BOUNDARY_MARK) is a
    // separate on/off flag, not one of those marks, so it has to be fetched
    // here explicitly too. Without this, every boat this script spawns
    // trusts this cache file unconditionally (SIM_TRUST_CACHED_MARKS=1,
    // see below) and never falls back to a radio broadcast to pick it up -
    // an omitted flag here was silently racing every fleet boat straight
    // through a gate the base station had actually turned on.
    marks.pinBoundaryEnabled = await redisStore.getPinBoundaryEnabled();
    // Same defensive mkdir every other writer under logDir already does
    // (see baseStation.js/sdLogger.js) - normally already created by the
    // base station this fleet is racing against, but this script has no
    // real dependency on startup order for this particular file.
    fs.mkdirSync(config.logDir, { recursive: true });
    fs.writeFileSync(marksFilePath, JSON.stringify(marks));
    console.log(`[fleetSim] fetched current course marks from Redis: ${Object.keys(marks).join(', ')}`);
  } finally {
    await redisStore.close();
  }
}

// Prefixes every line a child writes with its own boat ID, so N boats'
// interleaved output stays attributable - a raw pipe-through would
// otherwise interleave partial lines from different boats into an
// unreadable mess the instant more than one boat logs around the same
// moment.
function pipeWithPrefix(stream, prefix, out) {
  let buffered = '';
  stream.on('data', (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split('\n');
    buffered = lines.pop(); // last element is either '' (ended on \n) or a partial line - held for the next chunk
    for (const line of lines) out.write(`${prefix}${line}\n`);
  });
  stream.on('end', () => {
    if (buffered) out.write(`${prefix}${buffered}\n`);
  });
}

// Populated once startFleet() actually spawns the children below - declared
// up here (not inside startFleet) so shutdown() can always find it,
// including during the brief async window (see ensureFreshMarksCached
// above) before any boat has actually been spawned yet.
const children = [];

// Everything past this point used to just run top-to-bottom as soon as this
// module loaded; now it waits on ensureFreshMarksCached() first (see the
// call at the bottom of this file), so it's wrapped in a function instead -
// the logic itself is unchanged.
function startFleet() {
  let remaining = FLEET_SIZE;
  let anyFailed = false;

  for (let i = 0; i < FLEET_SIZE; i++) {
    const boatId = fleetBoatIds[i];
    const adminPort = ADMIN_PORT_START + i;
    const prefix = `[boat ${boatId}] `;

    // A delayed start is a one-line wrapper that waits and then loads the boat agent as normal - the boat's own code has no idea
    const startDelayMs = i * FLEET_STAGGER_MS;
    const nodeArgs = startDelayMs > 0 ? ['-e', `setTimeout(() => require(${JSON.stringify(boatAgentPath)}), ${startDelayMs})`] : [boatAgentPath];
    const child = spawn('node', nodeArgs, {
      // SIM_START_SLOT/SIM_FLEET_SIZE let boatAgent.js space this boat evenly
      // along the start line (index/fleetSize) instead of an independent
      // random draw - random placement across the whole fleet looks clustered
      // by chance far more often than it looks evenly spread (that's just how
      // randomness works, not a bug), and this process already knows both the
      // total fleet size and each child's own index for free.
      env: {
        ...baseEnv,
        BOAT_ID: String(boatId),
        ADMIN_PORT: String(adminPort),
        SIM_EXIT_ON_FINISH: '1',
        SIM_START_SLOT: String(i),
        SIM_FLEET_SIZE: String(FLEET_SIZE),
        // See ensureFreshMarksCached above - this process already confirmed
        // marksFilePath is current, so this boat doesn't need to wait on its
        // own radio round-trip to find that out too.
        SIM_TRUST_CACHED_MARKS: '1',
      },
      // 'ipc' (4th slot) lets this process forward the operator's own
      // "start the race" signal (SIM_HOLD_FOR_START's spacebar press, read
      // below - this process is the one with the real terminal, none of its
      // children have their own TTY stdin) to every boat via child.send() -
      // see the HOLD_FOR_START block below.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.boatId = boatId; // tagged for the message-echo loop below, which only has `child` in scope
    children.push(child);

    pipeWithPrefix(child.stdout, prefix, process.stdout);
    pipeWithPrefix(child.stderr, prefix, process.stderr);

    child.on('exit', (code, signal) => {
      remaining--;
      if (code !== 0 && signal === null) anyFailed = true;
      console.log(`[fleetSim] boat ${boatId} exited (${signal ? `signal ${signal}` : `code ${code}`}) - ${remaining} boat(s) still running`);
      if (remaining === 0) {
        console.log('[fleetSim] all boats finished');
        process.exit(anyFailed ? 1 : 0);
      }
    });
  }

  // Aggregates each boat's "still waiting for a GPS fix" heartbeat (see
  // boatAgent.js) into one combined line instead of the whole fleet's worth of
  // identical per-boat messages scrolling by independently - unconditional
  // (not just under SIM_HOLD_FOR_START below), since every boat waits on
  // marks/its first fix regardless of whether the fleet holds at the grid
  // afterward. Stops itself once every boat that ever reported waiting has
  // gone quiet (gotten its fix), rather than running for the rest of the
  // process's life.
  const boatsWaitingForFix = new Set();
  let sawAnyWaitingForFix = false;
  for (const child of children) {
    child.on('message', (msg) => {
      if (LOG_IPC) console.log(`[fleetSim] IPC from boat ${child.boatId}: ${JSON.stringify(msg)}`);
      if (msg === 'waiting-for-fix') {
        boatsWaitingForFix.add(child.pid);
        sawAnyWaitingForFix = true;
      } else if (msg === 'on-grid') {
        boatsWaitingForFix.delete(child.pid);
      }
    });
  }
  const waitingForFixIntervalId = setInterval(() => {
    if (boatsWaitingForFix.size > 0) {
      console.log(`[fleetSim] ${boatsWaitingForFix.size}/${FLEET_SIZE} boat(s) still waiting for a GPS fix`);
    } else if (sawAnyWaitingForFix) {
      clearInterval(waitingForFixIntervalId);
    }
  }, 10000);

  // SIM_HOLD_FOR_START holds every boat at its start position (see
  // simGps.js's holdForStart/release()) until told to actually start racing -
  // this process is the one with the real terminal (every child's own stdin
  // is 'ignore' above), so it's the one that reads the operator's spacebar
  // and forwards a single 'start-race' IPC message to each boat's own
  // SIM_HOLD_FOR_START listener (see boatAgent.js) over the 'ipc' channel set
  // up above. On by default - mirrors config.js's own default-on check
  // (opted out with SIM_HOLD_FOR_START=0/false), not the old opt-in one.
  const HOLD_FOR_START = baseEnv.SIM_HOLD_FOR_START !== '0' && baseEnv.SIM_HOLD_FOR_START !== 'false';
  if (HOLD_FOR_START) {
    if (process.stdin.isTTY) {
      console.log(`[fleetSim] ${FLEET_SIZE} boat(s) will hold at the grid; press SPACE here once ready to start the race`);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      let started = false;

      // Each boat notifies this process ('on-grid', see boatAgent.js) once it
      // has actually reached its start position - tracked so the prompt below
      // can announce the whole fleet ready, rather than the operator having to
      // guess from N boats' worth of interleaved, prefixed log lines.
      let boatsOnGrid = 0;
      for (const child of children) {
        child.on('message', (msg) => {
          if (msg !== 'on-grid') return;
          boatsOnGrid++;
          if (boatsOnGrid === FLEET_SIZE && !started) {
            console.log(`\n[fleetSim] *** all ${FLEET_SIZE} boat(s) are on the grid - press SPACE to start the race! ***\n`);
          }
        });
      }

      // The prompt above is easy to miss under N boats' worth of scrolling GPS
      // output - repeats a reminder on a slow timer until actually released,
      // so it doesn't get lost.
      const reminderIntervalId = setInterval(() => {
        if (!started && boatsOnGrid > 0) {
          console.log(
            `[fleetSim] *** ${boatsOnGrid}/${FLEET_SIZE} boat(s) on the grid - press SPACE to start the race ***`
          );
        }
      }, 15000);

      process.stdin.on('data', (data) => {
        if (data.includes(0x03)) {
          // Ctrl+C - raw mode intercepts this before it ever becomes a real
          // SIGINT, so re-raise it by hand to reach the ordinary SIGINT
          // handler below (which stops every boat, same as always).
          clearInterval(reminderIntervalId);
          process.stdin.setRawMode(false);
          process.kill(process.pid, 'SIGINT');
          return;
        }
        // Raw mode shows no Return, so echo it as a blank line: a marker to separate what comes next in the log
        if (data.includes(0x0d) || data.includes(0x0a)) console.log('');
        if (started || !data.includes(0x20)) return;
        started = true;
        clearInterval(reminderIntervalId);
        process.stdin.setRawMode(false);
        console.log('[fleetSim] SPACE pressed - starting the race');
        for (const child of children) {
          if (child.connected) child.send('start-race');
        }
      });
    } else {
      console.warn(
        '[fleetSim] SIM_HOLD_FOR_START is on but stdin is not a TTY - nothing can send the start signal, boats will hold at the grid forever'
      );
    }
  }
}

// RF_BRIDGE: the one real radio behind every boat of this fleet. Frames the radio hears go to all boats (the base's slot table,
// RTCM bursts, marks, pings and power frames - and, as on air, other boats' frames); a boat's frame is written to the radio
// as one piece, in the order it arrives, so the boats' own slot timing is what spaces them on air.
let rfRadio = null;
const bridgeStats = { heard: 0, rtcm: 0, sent: 0, sentBytes: 0, refused: 0, queuedMax: 0 };
// Frames from the boats are written to the radio at least this far apart (RF_BRIDGE_GAP_MS, 0 = no pacing). Boats that send in the
// same instant - heartbeats of boats started together, or any time the correction bursts are not being heard so nothing slot-times
// them - would otherwise reach the radio glued together as one blob: the radio sends them as one or two RF packets, and the base
// (which cannot receive while it transmits, e.g. its marks update for a new boat) loses everything after the first frame.
const BRIDGE_GAP_MS = parseInt(process.env.RF_BRIDGE_GAP_MS || '20', 10);
const BRIDGE_QUEUE_MAX = 500;
function startRfBridge() {
  const { RadioLink } = require('./radioLink');
  const protocol = require('./protocol');
  rfRadio = new RadioLink({ port: config.radio.port, baud: config.radio.baud });
  rfRadio.on('error', (err) => console.error('[rfBridge] radio error:', err.message));
  rfRadio.on('connected', () => console.log(`[rfBridge] radio open on ${config.radio.port} @ ${config.radio.baud}`));
  rfRadio.on('disconnected', () => console.warn('[rfBridge] radio disconnected, retrying...'));
  rfRadio.on('raw-frame', (buf) => {
    bridgeStats.heard++;
    if (buf[0] === protocol.RTCM_SYNC) bridgeStats.rtcm++;
    const message = { radioRx: buf.toString('base64') };
    for (const child of children) if (child.connected) child.send(message);
  });
  const txQueue = [];
  let draining = false;
  function writeOne(buf) {
    if (rfRadio.send(buf)) {
      bridgeStats.sent++;
      bridgeStats.sentBytes += buf.length;
    } else {
      bridgeStats.refused++; // radio closed or its write buffer backed up: the frame is not sent, as a real boat's would not be
    }
  }
  function drain() {
    const buf = txQueue.shift();
    if (!buf) {
      draining = false;
      return;
    }
    writeOne(buf);
    setTimeout(drain, BRIDGE_GAP_MS);
  }
  for (const child of children) {
    child.on('message', (msg) => {
      if (!msg || typeof msg.radioTx !== 'string') return;
      const buf = Buffer.from(msg.radioTx, 'base64');
      if (BRIDGE_GAP_MS <= 0) return writeOne(buf);
      if (txQueue.length >= BRIDGE_QUEUE_MAX) txQueue.shift(); // far behind: drop the oldest, as a backed-up radio would
      txQueue.push(buf);
      bridgeStats.queuedMax = Math.max(bridgeStats.queuedMax, txQueue.length);
      if (!draining) {
        draining = true;
        drain();
      }
    });
  }
  setInterval(() => {
    const b = bridgeStats;
    console.log(
      `[rfBridge] last 10 s: radio heard ${b.heard} frames (${b.rtcm} RTCM), boats sent ${b.sent} frames (${b.sentBytes} bytes)` +
        (b.refused ? `, ${b.refused} refused by the radio` : '') +
        (b.queuedMax > 1 ? `, at most ${b.queuedMax} waiting to be paced out` : '')
    );
    b.heard = b.rtcm = b.sent = b.sentBytes = b.refused = b.queuedMax = 0;
  }, 10000).unref();
}

// Stops the fleet as a whole rather than leaving orphaned boats racing on
// their own with nothing watching them - each child gets its own SIGINT,
// same as if it had been started by hand in its own terminal (see
// boatAgent.js's own SIGINT handler), and this process waits for the
// 'exit' handlers above to fire before it exits itself. Handles SIGTERM the
// same way as SIGINT (Ctrl+C), not just SIGINT alone - `kill <pid>` (no
// signal named) and most process managers' "stop" both send SIGTERM by
// default, and without a handler for it Node's default action is to just
// exit THIS process immediately, leaving every already-spawned boat process
// running (and holding its own radio/admin/log-upload ports) with nothing
// left watching it - regardless of whether SIM_HOLD_FOR_START ever actually
// released them. Also the only thing that needs to happen if a signal
// arrives during the ensureFreshMarksCached() wait below, before any boat
// has actually been spawned yet - `children` is empty then, so this is
// already a no-op past the log line.
function shutdown(signal) {
  if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
  console.log(`\n[fleetSim] ${signal} received - stopping all boats`);
  for (const child of children) child.kill('SIGINT');
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

(RF_BRIDGE ? Promise.resolve() : ensureFreshMarksCached())
  .then(() => {
    startFleet();
    if (RF_BRIDGE) startRfBridge();
  })
  .catch((err) => {
    console.error('[fleetSim] failed to fetch course marks from Redis - not starting any boats:', err.message);
    process.exit(1);
  });
