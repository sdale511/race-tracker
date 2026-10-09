// A synthetic RTK base for SIMULATE=1 (SIM_RTCM_INTERVAL_S=N on the simulated base): broadcasts a
// burst of RTCM3 messages the size of a real epoch every N seconds, spaced a few ms apart like the
// receiver's serial output, so the shared-radio gate and slots (txScheduler.js) can be exercised
// with no hardware. The messages are valid RTCM3 frames (correct CRC) with filler payloads.

const protocol = require('./protocol');

// message number -> total frame size, from a real epoch (see docs/rtk-base-rtcm-capture-2026-10-07.pdf)
const EPOCH = [
  [1005, 25],
  [1074, 126],
  [1084, 120],
  [1094, 120],
  [1124, 95],
  [1230, 10],
];

function makeRtcmFrame(type, totalBytes) {
  const len = totalBytes - 6;
  const payload = Buffer.alloc(len, 0x55);
  payload[0] = (type >> 4) & 0xff;
  payload[1] = ((type & 0x0f) << 4) | (payload[1] & 0x0f);
  const body = Buffer.concat([Buffer.from([0xd3, (len >> 8) & 3, len & 255]), payload]);
  const crc = protocol.crc24q(body, body.length);
  return Buffer.concat([body, Buffer.from([crc >> 16, (crc >> 8) & 255, crc & 255])]);
}

// send(buf) writes straight to the radio (not through the telemetry gate - this stands in for the
// RTK base's own radio). Returns a stop() function.
function startSimRtcm(send, intervalS, { messageSpacingMs = 6 } = {}) {
  const frames = EPOCH.map(([t, n]) => makeRtcmFrame(t, n));
  const fire = () => frames.forEach((f, i) => setTimeout(() => send(f), i * messageSpacingMs));
  const timer = setInterval(fire, intervalS * 1000);
  fire();
  return () => clearInterval(timer);
}

module.exports = { startSimRtcm, makeRtcmFrame, EPOCH };
