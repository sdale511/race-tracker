const { spawn } = require('child_process');
const path = require('path');

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
// Run with `npm run fleet` (respects FLEET_SIZE/BOAT_ID_START below, plus
// any of boatAgent's own SIM_* env vars - LAP_COUNT, START_ONLY, etc. - all
// of which pass through to every spawned boat unchanged):
//
//   FLEET_SIZE=5 npm run fleet
//
// Every boat is started with SIM_EXIT_ON_FINISH=1 (see config.js), so each
// one's own process exits itself the moment it completes its laps - this
// script doesn't police that from the outside, it just watches the child
// processes exit on their own and reports the fleet done once the last one
// has. Ctrl+C here forwards SIGINT to whichever boats are still racing.

const FLEET_SIZE = parseInt(process.env.FLEET_SIZE || '3', 10);
// First BOAT_ID handed out; subsequent boats get BOAT_ID_START+1,
// BOAT_ID_START+2, ... - not necessarily 1, so a fleet can be added
// alongside boats already started by hand without ID collisions.
const BOAT_ID_START = parseInt(process.env.BOAT_ID_START || '1', 10);
// Matches boatAgent.js's own SIMULATE=1 default admin port (8093) as the
// base - each boat needs its own distinct port (an explicit ADMIN_PORT
// from the parent env would otherwise collide across every child), so this
// is never inherited from process.env, always assigned per boat below.
const ADMIN_PORT_START = parseInt(process.env.FLEET_ADMIN_PORT_START || '8093', 10);

if (!Number.isInteger(FLEET_SIZE) || FLEET_SIZE < 1) {
  console.error(`[fleetSim] invalid FLEET_SIZE=${process.env.FLEET_SIZE} - must be a positive integer`);
  process.exit(1);
}

console.log(`[fleetSim] starting ${FLEET_SIZE} boat(s), BOAT_ID ${BOAT_ID_START}-${BOAT_ID_START + FLEET_SIZE - 1}`);

// This script's whole purpose is a fleet of SIMULATED boats - defaults
// SIMULATE=1 so `npm run fleet` works with no other env vars set, but
// leaves an explicit SIMULATE/SIMULATE_GPS from the parent env alone (e.g.
// SIMULATE_GPS=1 with real radio hardware, bench-testing several actual
// radios at once).
const baseEnv = { ...process.env };
if (baseEnv.SIMULATE !== '1' && baseEnv.SIMULATE !== 'true' && baseEnv.SIMULATE_GPS !== '1' && baseEnv.SIMULATE_GPS !== 'true') {
  baseEnv.SIMULATE = '1';
}

const boatAgentPath = path.join(__dirname, 'boatAgent.js');

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

let remaining = FLEET_SIZE;
let anyFailed = false;
const children = [];

for (let i = 0; i < FLEET_SIZE; i++) {
  const boatId = BOAT_ID_START + i;
  const adminPort = ADMIN_PORT_START + i;
  const prefix = `[boat ${boatId}] `;

  const child = spawn('node', [boatAgentPath], {
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
    },
    // 'ipc' (4th slot) lets this process forward the operator's own
    // "start the race" signal (SIM_HOLD_FOR_START's spacebar press, read
    // below - this process is the one with the real terminal, none of its
    // children have their own TTY stdin) to every boat via child.send() -
    // see the HOLD_FOR_START block below.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
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
// released them.
function shutdown(signal) {
  if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
  console.log(`\n[fleetSim] ${signal} received - stopping all boats`);
  for (const child of children) child.kill('SIGINT');
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
