// Central configuration. Override any of these with environment variables,
// e.g. GPS_PORT=/dev/ttyAMA0 BOAT_ID=7 npm run boat

module.exports = {
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
  logDir: process.env.LOG_DIR || '/home/pi/race-logs',
};
