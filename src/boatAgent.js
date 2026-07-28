const { SerialPort } = require('serialport');
const config = require('./config');
const { UbxParser } = require('./ubxParser');
const { RadioLink } = require('./radioLink');
const { SdLogger } = require('./sdLogger');
const protocol = require('./protocol');

console.log(`[boatAgent] starting, boatId=${config.boatId}`);
if (config.simulate) {
  console.log('[boatAgent] SIMULATE=1 - using a fake GPS track + UDP-simulated radio (no hardware)');
  console.log(`[boatAgent] sim radio -> ${config.sim.host}:${config.sim.port}`);
} else {
  console.log(`[boatAgent] GPS  ${config.gps.port} @ ${config.gps.baud}`);
  if (config.radio.enabled) {
    console.log(`[boatAgent] Radio ${config.radio.port} @ ${config.radio.baud}`);
  } else {
    console.log('[boatAgent] Radio disabled (NO_RADIO=1) - fixes still log to SD');
  }
}

const sdLogger = new SdLogger({ logDir: config.logDir, boatId: config.boatId });

let radio;
if (config.simulate) {
  const { SimRadioLink } = require('./simRadioLink');
  radio = new SimRadioLink({
    mode: 'send',
    host: config.sim.host,
    port: config.sim.port,
    packetLossPct: config.sim.packetLossPct,
  });
  radio.on('error', (err) => console.error('[radio] error:', err.message));
  radio.on('disconnected', () => console.warn('[radio] disconnected, retrying...'));
} else if (config.radio.enabled) {
  radio = new RadioLink({ port: config.radio.port, baud: config.radio.baud });
  radio.on('error', (err) => console.error('[radio] error:', err.message));
  radio.on('disconnected', () => console.warn('[radio] disconnected, retrying...'));
} else {
  radio = { send: () => false };
}

// Jitter TX timing (+/-20%) so a fleet of boats powering on together (e.g.
// at a race start) doesn't transmit in lockstep and collide on the shared
// radio channel. The first interval is a full random draw so boats don't
// even start out synchronized.
function jitteredTxIntervalMs() {
  const jitter = config.txIntervalMs * 0.2;
  return config.txIntervalMs + (Math.random() * 2 - 1) * jitter;
}

let lastTx = Date.now();
let nextTxIntervalMs = Math.random() * config.txIntervalMs;
let lastPvt = null;

function handlePvt(pvt) {
  lastPvt = pvt;
  sdLogger.logPvt(pvt); // log every fix, full rate
  console.log(
    `[gps] ${pvt.lat.toFixed(6)},${pvt.lon.toFixed(6)} ` +
      `fixType=${pvt.fixType} diffSoln=${pvt.diffSoln} carrSoln=${pvt.carrSoln} numSV=${pvt.numSV} ` +
      `hAcc=${(pvt.hAccMm / 1000).toFixed(2)}m`
  );

  const now = Date.now();
  if (now - lastTx >= nextTxIntervalMs) {
    lastTx = now;
    nextTxIntervalMs = jitteredTxIntervalMs();
    const frame = protocol.encode(config.boatId, pvt);
    const sent = radio.send(frame);
    if (!sent && config.radio.enabled) console.warn('[radio] not connected, dropped a frame (still logged to SD)');
  }
}

function openGps() {
  const gpsPort = new SerialPort({ path: config.gps.port, baudRate: config.gps.baud }, (err) => {
    if (err) {
      console.error('[gps] open failed:', err.message, '- retrying in 3s');
      setTimeout(openGps, 3000);
    }
  });

  const parser = new UbxParser();

  gpsPort.on('data', (chunk) => parser.write(chunk));
  gpsPort.on('close', () => {
    console.warn('[gps] port closed, retrying in 3s');
    setTimeout(openGps, 3000);
  });
  gpsPort.on('error', (err) => console.error('[gps] error:', err.message));

  parser.on('checksum-error', () => {
    // Occasional corrupt frames are normal on long/noisy UART runs; only
    // worry if this fires constantly.
  });

  parser.on('nav-pvt', handlePvt);
}

if (config.simulate) {
  // Resolve the course from Redis before starting: if another
  // simulator/base station already published marks, race that exact course
  // instead of computing a fresh one from local SIM_CENTER_LAT/LON, so a
  // whole fleet of simulators agrees on identical mark positions.
  (async () => {
    const { SimGpsSource } = require('./simGps');
    const { RedisStore } = require('./redisStore');
    const redisStore = new RedisStore({ url: config.redis.url, connection: config.redis.connection });
    let marks;
    try {
      marks = await redisStore.getOrCreateMarks(config.sim.centerLat, config.sim.centerLon);
    } catch (err) {
      console.error('[redis] failed to resolve course marks, falling back to local SIM_CENTER_LAT/LON:', err.message);
      marks = { leeward: { lat: config.sim.centerLat, lon: config.sim.centerLon } };
    }
    console.log(`[boatAgent] course marks (Redis): ${Object.keys(marks).join(', ')}`);

    // Start-line slot is by registration order, not the boat's own ID/sail
    // number (config.boatId could be anything, e.g. 51/52 - using it
    // directly would place a boat however far off the line that number
    // implies, which is exactly the bug this fixes).
    let startSlot;
    try {
      startSlot = await redisStore.getOrAssignStartSlot(config.boatId);
    } catch (err) {
      console.error('[redis] failed to assign a start slot, defaulting to slot 0:', err.message);
      startSlot = 0;
    }
    console.log(`[boatAgent] start slot (Redis): ${startSlot}`);

    // The leeward mark *is* the course's center/reference point by
    // construction (course.js), so it's exactly what SimGpsSource needs.
    const gps = new SimGpsSource({
      centerLat: marks.leeward.lat,
      centerLon: marks.leeward.lon,
      upwindSpeedKn: config.sim.upwindSpeedKn,
      downwindSpeedKn: config.sim.downwindSpeedKn,
      hz: config.sim.gpsHz,
      startSlot,
      lapCount: config.sim.lapCount,
    });
    gps.on('nav-pvt', handlePvt);
    gps.on('lap', ({ lap, inGate, eastM }) =>
      console.log(`[boatAgent] completed lap ${lap} ${inGate ? 'through the finish gate' : `OUTSIDE the finish gate (east=${eastM.toFixed(1)}m)`}`)
    );
    gps.on('finished', ({ laps }) => {
      console.log(`[boatAgent] finished simulated race after ${laps} lap(s)`);
      // Brief delay so the final fix's async SD-log write has a chance to
      // flush before the process actually exits.
      setTimeout(() => process.exit(0), 200);
    });
  })();
} else {
  openGps();
}

// Simple heartbeat so you can tell the process is alive even with no fix yet.
setInterval(() => {
  if (!lastPvt) console.log('[boatAgent] waiting for first GPS fix...');
}, 10000);

process.on('SIGINT', () => {
  console.log('\n[boatAgent] shutting down');
  process.exit(0);
});
