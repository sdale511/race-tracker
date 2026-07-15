// Central configuration. Override any of these with environment variables,
// e.g. GPS_PORT=/dev/ttyAMA0 BOAT_ID=7 npm run boat

// SIMULATE=1 replaces the real GPS + radio hardware with a fake GPS track
// and a UDP-based stand-in for the radio link, so boatAgent/baseStation can
// be run and tested with no hardware attached (see simGps.js, simRadioLink.js).
const simulate = process.env.SIMULATE === '1' || process.env.SIMULATE === 'true';

module.exports = {
  simulate,

  // --- Simulation mode settings (only used when simulate=true) ---
  sim: {
    // boatAgent sends UDP frames to host:port; baseStation listens on port.
    host: process.env.SIM_HOST || '127.0.0.1',
    port: parseInt(process.env.SIM_PORT || '41234', 10),
    gpsHz: parseFloat(process.env.SIM_GPS_HZ || '2'),
    speedKn: parseFloat(process.env.SIM_SPEED_KN || '6'),
    // Default course center: Newport, RI.
    centerLat: parseFloat(process.env.SIM_CENTER_LAT || '41.4901'),
    centerLon: parseFloat(process.env.SIM_CENTER_LON || '-71.3128'),
    // % chance (0-100) each frame is dropped, to simulate radio range dropouts.
    packetLossPct: parseFloat(process.env.SIM_PACKET_LOSS || '0'),
  },

  // --- GPS (simpleRTK2B LR, ZED-F9P) ---
  // Wire this UART directly to the Pi. This link is Pi<->GPS only, so
  // baud/bandwidth here is NOT the constraint (the radio link is).
  gps: {
    port: process.env.GPS_PORT || '/dev/ttyAMA0',
    baud: parseInt(process.env.GPS_BAUD || '115200', 10),
  },

  // --- Telemetry radio (transparent-serial style, e.g. RFD900x/SiK) ---
  // Whatever bytes you write to this port are transmitted over the air and
  // appear byte-for-byte on the matching radio at the base station.
  radio: {
    port: process.env.RADIO_PORT || '/dev/ttyUSB0',
    baud: parseInt(process.env.RADIO_BAUD || '57600', 10),
  },

  // --- Identity & timing ---
  boatId: parseInt(process.env.BOAT_ID || '1', 10),
  // How often we actually transmit a position frame over the radio.
  // GPS fixes can arrive at 1-10Hz; we throttle radio TX independently
  // to conserve airtime/bandwidth over long range.
  txIntervalMs: parseInt(process.env.TX_INTERVAL_MS || '2000', 10),

  // --- Local logging (microSD) ---
  // Point this at a path that's actually on the SD card / a mounted volume.
  // In simulation mode, default to a local folder instead of the Pi's path.
  logDir: process.env.LOG_DIR || (simulate ? './race-logs' : '/home/pi/race-logs'),
};
