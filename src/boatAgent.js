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
  const { SimGpsSource } = require('./simGps');
  const gps = new SimGpsSource({
    centerLat: config.sim.centerLat,
    centerLon: config.sim.centerLon,
    speedKn: config.sim.speedKn,
    hz: config.sim.gpsHz,
  });
  gps.on('nav-pvt', handlePvt);
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
