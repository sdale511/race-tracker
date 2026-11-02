#!/usr/bin/env node
// The simulated GPS for host_rover (host/host_rover.cpp): runs src/simGps.js - the race the Node rover sails with SIMULATE_GPS=1 - and
// writes each fix to stdout as a UBX NAV-PVT frame, the bytes a ZED-F9P sends. Like boatAgent.js it waits for the course marks the
// SIMULATE=1 base broadcasts (on SIM_PORT, 41234), and holds on the grid until SPACE is pressed (SIM_HOLD_FOR_START=0 to go at once).
// The SIM_* settings in src/config.js apply. Logs go to stderr.
//
//   node tools/sim_gps.js | .pio/build/mac/program --radio udp --gps -

const path = require('path');
const src = path.join(__dirname, '..', '..', '..', 'src');
const config = require(path.join(src, 'config'));
const { SimRadioLink } = require(path.join(src, 'simRadioLink'));
const { SimGpsSource } = require(path.join(src, 'simGps'));
const { deriveGeometry, getRaceMarks } = require(path.join(src, 'course'));
const { encodeNavPvt } = require(path.join(src, 'ubxParser'));

const log = (m) => process.stderr.write(`[sim_gps] ${m}\n`);

// encodeNavPvt leaves nano at 0; a 10 Hz track needs the sub-second part, or every fix in a second gets the same timestamp
function navPvtFrame(pvt) {
  const ts = pvt.timestamp ?? Date.now();
  const frame = encodeNavPvt({ ...pvt, timestamp: ts, utcValid: true });
  frame.writeInt32LE((ts % 1000) * 1e6, 6 + 16);
  let a = 0;
  let b = 0;
  for (let i = 2; i < frame.length - 2; i++) {
    a = (a + frame[i]) & 0xff;
    b = (b + a) & 0xff;
  }
  frame[frame.length - 2] = a;
  frame[frame.length - 1] = b;
  return frame;
}

let gps = null;
let released = !config.sim.holdForStart;

// Listen only: host_rover asks the base for the marks, as a rover does
const radio = new SimRadioLink({ port: config.sim.port });
radio.setSleeping(false);
radio.on('marks', ({ marks }) => {
  if (gps) return;
  const geometry = deriveGeometry(marks, config.sim.courseMarks);
  const raceMarks = getRaceMarks(marks, config.sim.courseMarks);
  log(`marks received, racing ${raceMarks.windwardName}/${raceMarks.leewardName}`);
  gps = new SimGpsSource({
    centerLat: raceMarks.leeward.lat,
    centerLon: raceMarks.leeward.lon,
    upwindSpeedKn: config.sim.upwindSpeedKn,
    downwindSpeedKn: config.sim.downwindSpeedKn,
    hz: config.sim.gpsHz,
    startFrac: Math.random(),
    lapCount: config.sim.lapCount,
    geometry,
    startOnly: config.sim.startOnly,
    prestartDwellS: config.sim.prestartDwellS,
    holdForStart: config.sim.holdForStart,
    foulTest: config.sim.foulTest,
    foulWindwardM: config.sim.foulWindwardM,
    pin: marks.pin,
    committeeStart: marks.committeeStart,
    committeeFinish: marks.committeeFinish,
    finish: marks.finish,
    pinBoundaryEnabled: marks.pinBoundaryEnabled,
  });
  gps.on('nav-pvt', (pvt) => process.stdout.write(navPvtFrame(pvt)));
  gps.on('lap', ({ lap }) => log(`lap ${lap}`));
  gps.on('finished', ({ laps }) => log(`finished after ${laps} lap(s) - the boat now sits still; Ctrl+C to stop`));
  gps.emitInitialFixIfDwelling();
  if (released) gps.release();
  else log('on the grid - press SPACE to start the race');
});
log(`waiting for the course marks from the base on UDP ${config.sim.port}`);

process.stdout.on('error', () => process.exit(0));  // host_rover went away

if (config.sim.holdForStart && process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (data) => {
    if (data.includes(0x03)) process.exit(0);  // Ctrl+C (raw mode swallows the signal); host_rover exits when its stdin closes
    if (data.includes(0x20) && !released) {
      released = true;
      log('SPACE pressed - starting the race');
      if (gps) gps.release();
    }
  });
}
