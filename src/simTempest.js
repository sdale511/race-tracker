const dgram = require('dgram');
const { MS_TO_MPH } = require('./tempestListener');

// A pretend Tempest weather station for a SIMULATE=1 base: sends the same UDP messages a real Tempest hub broadcasts
// (see tempestListener.js) to the base's own Tempest port, so the listener, the Redis wind series and the dashboard card
// all run exactly as they would with real hardware.
//
// The wind blows down the course: from the windward end, along the leeward black -> windward black axis (getAxisDeg,
// the bearing the wind comes from). Every changeS seconds it picks a new wind - a speed between minMph and maxMph and a
// direction within dirSwingDeg either side of the axis - and holds it, with a little gust-like wobble on each 3-second
// reading. Like a real hub it sends a rapid_wind every 3 s and an obs_st every minute, whose lull/avg/gust are the
// lowest/mean/highest of that minute's 3-second speeds and whose direction is their mean.

const RAPID_EVERY_MS = 3000;
const OBS_EVERY_MS = 60000;

const wrap360 = (deg) => ((deg % 360) + 360) % 360;

// A new wind around the course axis: { dir, mph }.
function pickWind(axisDeg, { minMph, maxMph, dirSwingDeg }, rng = Math.random) {
  return {
    dir: wrap360(axisDeg + (rng() * 2 - 1) * dirSwingDeg),
    mph: minMph + rng() * (maxMph - minMph),
  };
}

// One 3-second reading near the current wind: speed within ±0.5 mph (never below 0), direction within ±3°.
function wobble(wind, rng = Math.random) {
  return { dir: wrap360(wind.dir + (rng() * 2 - 1) * 3), mph: Math.max(0, wind.mph + (rng() * 2 - 1) * 0.5) };
}

// Mean of compass directions (so 350° and 10° average to 0°, not 180°).
function meanDirection(dirs) {
  let x = 0;
  let y = 0;
  for (const d of dirs) {
    x += Math.cos((d * Math.PI) / 180);
    y += Math.sin((d * Math.PI) / 180);
  }
  return wrap360((Math.atan2(y, x) * 180) / Math.PI);
}

const round2 = (v) => Math.round(v * 100) / 100;
const toMs = (mph) => round2(mph / MS_TO_MPH);

function rapidWindMessage(serial, epochS, reading) {
  return { serial_number: serial, type: 'rapid_wind', hub_sn: 'HB-SIM00001', ob: [epochS, toMs(reading.mph), Math.round(reading.dir)] };
}

// The minute's obs_st from its 3-second readings (at least one). Only the wind fields are meaningful; the rest are
// plausible fixed values in the positions a real station sends them.
function obsStMessage(serial, epochS, readings) {
  const speeds = readings.map((r) => r.mph);
  const avg = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  const ob = [epochS, toMs(Math.min(...speeds)), toMs(avg), toMs(Math.max(...speeds)), Math.round(meanDirection(readings.map((r) => r.dir))), 3, 1012.0, 20.0, 40, 50000, 5, 400, 0, 0, 0, 0, 2.6, 1];
  return { serial_number: serial, type: 'obs_st', hub_sn: 'HB-SIM00001', obs: [ob], firmware_revision: 0 };
}

class SimTempest {
  constructor({ port, address = '127.0.0.1', serial = 'ST-SIM00001', getAxisDeg, changeS = 30, minMph = 5, maxMph = 8, dirSwingDeg = 10, rng = Math.random, now = Date.now }) {
    this.port = port;
    this.address = address;
    this.serial = serial;
    this.getAxisDeg = getAxisDeg;
    this.range = { minMph, maxMph, dirSwingDeg };
    this.changeMs = changeS * 1000;
    this.rng = rng;
    this.now = now;
    this.wind = null;
    this.windSetAt = 0;
    this.minute = []; // this minute's 3-second readings, for the next obs_st
    this.timers = [];
    this.socket = null;
  }

  start() {
    this.socket = dgram.createSocket('udp4');
    // Started on timers, never synchronously: the axis comes from the base's course, which resolves after startup.
    this.timers.push(setInterval(() => this.sendRapid(), RAPID_EVERY_MS));
    this.timers.push(setInterval(() => this.sendObs(), OBS_EVERY_MS));
    return this;
  }

  // The current wind, re-picked every changeMs.
  currentWind() {
    const t = this.now();
    if (!this.wind || t - this.windSetAt >= this.changeMs) {
      this.wind = pickWind(this.getAxisDeg(), this.range, this.rng);
      this.windSetAt = t;
    }
    return this.wind;
  }

  sendRapid() {
    const reading = wobble(this.currentWind(), this.rng);
    this.minute.push(reading);
    this.send(rapidWindMessage(this.serial, Math.floor(this.now() / 1000), reading));
  }

  sendObs() {
    if (this.minute.length === 0) return;
    const readings = this.minute;
    this.minute = [];
    this.send(obsStMessage(this.serial, Math.floor(this.now() / 1000), readings));
  }

  send(message) {
    if (!this.socket) return;
    this.socket.send(Buffer.from(JSON.stringify(message)), this.port, this.address, (err) => {
      if (err) console.error('[simTempest] send failed:', err.message);
    });
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.socket) this.socket.close();
    this.socket = null;
  }
}

module.exports = { SimTempest, pickWind, wobble, meanDirection, rapidWindMessage, obsStMessage };
