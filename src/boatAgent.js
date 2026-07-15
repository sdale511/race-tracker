const { SerialPort } = require('serialport');
const config = require('./config');
const { UbxParser } = require('./ubxParser');
const { RadioLink } = require('./radioLink');
const { SdLogger } = require('./sdLogger');
const protocol = require('./protocol');

console.log(`[boatAgent] starting, boatId=${config.boatId}`);
console.log(`[boatAgent] GPS  ${config.gps.port} @ ${config.gps.baud}`);
console.log(`[boatAgent] Radio ${config.radio.port} @ ${config.radio.baud}`);

const sdLogger = new SdLogger({ logDir: config.logDir, boatId: config.boatId });
const radio = new RadioLink({ port: config.radio.port, baud: config.radio.baud });
radio.on('error', (err) => console.error('[radio] error:', err.message));
radio.on('disconnected', () => console.warn('[radio] disconnected, retrying...'));

let lastTx = 0;
let lastPvt = null;

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

  parser.on('nav-pvt', (pvt) => {
    lastPvt = pvt;
    sdLogger.logPvt(pvt); // log every fix, full rate

    const now = Date.now();
    if (now - lastTx >= config.txIntervalMs) {
      lastTx = now;
      const frame = protocol.encode(config.boatId, pvt);
      const sent = radio.send(frame);
      if (!sent) console.warn('[radio] not connected, dropped a frame (still logged to SD)');
    }
  });
}

openGps();

// Simple heartbeat so you can tell the process is alive even with no fix yet.
setInterval(() => {
  if (!lastPvt) {
    console.log('[boatAgent] waiting for first GPS fix...');
  } else {
    console.log(
      `[boatAgent] last fix: ${lastPvt.lat.toFixed(6)},${lastPvt.lon.toFixed(6)} ` +
        `fixType=${lastPvt.fixType} carrSoln=${lastPvt.carrSoln} numSV=${lastPvt.numSV}`
    );
  }
}, 10000);

process.on('SIGINT', () => {
  console.log('\n[boatAgent] shutting down');
  process.exit(0);
});
