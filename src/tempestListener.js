const dgram = require('dgram');
const { EventEmitter } = require('events');

// Listens for a Tempest (WeatherFlow) weather station's local UDP broadcasts and turns them into wind samples for the
// selected regatta's Redis wind series (regattas:<id>:wind - see redisStore.js's recordWind), the same series RegattaUp's
// recordRaceWind fills from the Tempest cloud. The local broadcast needs no internet, so wind is still recorded at a
// venue with no connection, as long as the Tempest hub is on the base's network.
//
// The hub broadcasts JSON datagrams to UDP port 50222 (WeatherFlow's "UDP API"):
//   - obs_st, once a minute: obs[0] = [epoch s, wind lull, wind avg, wind gust, wind direction, wind sample interval s,
//     pressure, temperature, humidity, ...], wind speeds in m/s, direction in degrees.
//   - rapid_wind, every 3 s: ob = [epoch s, wind speed m/s, wind direction].
// Each obs_st becomes one sample (one a minute, like RegattaUp's); rapid_wind only feeds the dashboard card, so Redis
// holds one sample a minute rather than twenty. Everything else (hub_status, device_status, evt_*) is ignored.
//
// Samples are stored the way RegattaUp's map reads them: speeds in mph (it understands mph and kph only), the time the
// base received the observation as `t` (the hub's own clock comes from the internet and may be wrong without it).

const MS_TO_MPH = 2.2369362920544;

const round1 = (v) => Math.round(v * 10) / 10;
const speedMph = (ms) => (Number.isFinite(ms) && ms >= 0 ? round1(ms * MS_TO_MPH) : null);
const direction = (deg) => (Number.isFinite(deg) && deg >= 0 && deg <= 360 ? Math.round(deg) % 360 : null);

// Parses one datagram. Returns { type: 'obs', serial, dir, avg, gust, lull, stationTime } for an obs_st,
// { type: 'rapid', serial, dir, speed, stationTime } for a rapid_wind (speeds in mph, null when the station reported
// none), or null for anything else or anything malformed.
function parseTempestMessage(buf) {
  let msg;
  try {
    msg = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const serial = typeof msg.serial_number === 'string' ? msg.serial_number : null;
  if (msg.type === 'obs_st' && Array.isArray(msg.obs) && Array.isArray(msg.obs[0])) {
    const ob = msg.obs[0];
    return {
      type: 'obs',
      serial,
      stationTime: Number.isFinite(ob[0]) ? ob[0] * 1000 : null,
      lull: speedMph(ob[1]),
      avg: speedMph(ob[2]),
      gust: speedMph(ob[3]),
      dir: direction(ob[4]),
    };
  }
  if (msg.type === 'rapid_wind' && Array.isArray(msg.ob)) {
    const ob = msg.ob;
    return { type: 'rapid', serial, stationTime: Number.isFinite(ob[0]) ? ob[0] * 1000 : null, speed: speedMph(ob[1]), dir: direction(ob[2]) };
  }
  return null;
}

// The wind sample for an obs_st, in RegattaUp's shape, or null when it has no direction or average (a sensor fault):
// the map skips samples without a direction anyway.
function windSampleFromObs(obs, t, station) {
  if (!obs || obs.dir == null || obs.avg == null) return null;
  return { t, dir: obs.dir, avg: obs.avg, gust: obs.gust, lull: obs.lull, station, units: 'mph' };
}

// Emits 'sample' with each wind sample (see windSampleFromObs). serial, when set, keeps only that station's messages (for a
// network with more than one Tempest); stationName names the station in the samples, defaulting to its serial number.
class TempestListener extends EventEmitter {
  constructor({ port = 50222, serial = null, stationName = null, now = Date.now } = {}) {
    super();
    this.port = port;
    this.serial = serial;
    this.stationName = stationName;
    this.now = now;
    this.socket = null;
    this.error = null;
    this.packets = 0;
    this.ignored = 0; // from a different station than TEMPEST_SERIAL
    this.samples = 0;
    this.stationsHeard = new Set();
    this.lastObs = null; // { ...parsed, at }
    this.lastRapid = null; // { ...parsed, at }
  }

  start() {
    // reuseAddr: the WeatherFlow app (or a second listener) on the same machine can bind the port too.
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('message', (buf) => this.handleMessage(buf));
    this.socket.on('error', (err) => {
      this.error = err.message;
      console.error(`[tempest] UDP ${this.port}:`, err.message);
    });
    this.socket.bind(this.port);
    return this;
  }

  handleMessage(buf) {
    const msg = parseTempestMessage(buf);
    if (!msg) return;
    this.packets++;
    if (msg.serial) this.stationsHeard.add(msg.serial);
    if (this.serial && msg.serial !== this.serial) {
      this.ignored++;
      return;
    }
    const at = this.now();
    if (msg.type === 'rapid') {
      this.lastRapid = { ...msg, at };
      return;
    }
    this.lastObs = { ...msg, at };
    const sample = windSampleFromObs(msg, at, this.stationName || msg.serial || 'Tempest');
    if (sample) {
      this.samples++;
      this.emit('sample', sample);
    }
  }

  status() {
    return {
      port: this.port,
      serial: this.serial,
      error: this.error,
      packets: this.packets,
      ignored: this.ignored,
      samples: this.samples,
      stationsHeard: [...this.stationsHeard],
      lastObs: this.lastObs,
      lastRapid: this.lastRapid,
    };
  }

  close() {
    if (this.socket) this.socket.close();
    this.socket = null;
  }
}

module.exports = { TempestListener, parseTempestMessage, windSampleFromObs, MS_TO_MPH };
