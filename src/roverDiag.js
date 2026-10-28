// The rover's own diagnosis, sent to the base in the status hello (protocol.js's encodeStatusHello) so the base log and the
// fleet table can say WHY a rover is quiet or degraded, not just that it is. Everything here is something the rover can see
// and the base can't: what is (or isn't) coming in on the GPS serial port, whether its radio hears the base, whether the
// receiver reports corrections arriving, and the Pi's own power record.
//
// The GPS checks follow the data down the line and report only the first stage that fails - a closed port also means no
// bytes, no UBX and no NAV-PVT, and saying all four would hide which one to fix.

const fs = require('fs');
const { execFileSync } = require('child_process');

const FLAGS = {
  GPS_PORT_CLOSED: 0x01, // the Pi could not open GPS_PORT
  GPS_NO_DATA: 0x02, // port open, not a byte from the receiver
  GPS_NO_UBX: 0x04, // bytes, but no valid UBX frame - a baud mismatch (a reset receiver is at 38400)
  GPS_NO_PVT: 0x08, // UBX frames, but no NAV-PVT - the receiver's position output is off
  NO_BURSTS: 0x10, // the rover's radio hears no RTCM correction bursts
  RTCM_NOT_REACHING_GPS: 0x20, // bursts heard, but the receiver reports no RTCM arriving (UBX-RXM-RTCM)
  NO_BASE_RX: 0x40, // nothing from the base (marks, slot table, ping, power) - the radio works one way only
};

// From the Pi firmware's get_throttled value: bit 0 under-voltage now, 2 throttled now, 16/18 the same since boot.
const POWER = {
  UNDERVOLT_NOW: 0x01,
  UNDERVOLT_SINCE_BOOT: 0x02,
  THROTTLED_NOW: 0x04,
  THROTTLED_SINCE_BOOT: 0x08,
};

const GPS_STALE_MS = 5000; // the receiver sends several frames a second; this long with nothing is a real gap
const RXM_RTCM_STALE_MS = 15000; // corrections come every 2-4 s; a few bursts with no RXM-RTCM back
const BURST_GRACE_MS = 20000; // same grace as rtcmWatchdog.js's default before "no bursts" counts
const BASE_RX_STALE_MS = 150 * 1000; // the slot table comes every 10 s and the marks every minute

// s: what boatAgent.js tracks - every time a ms timestamp or null:
//   since              process start, or the last wake: nothing counts as missing until it has had time to arrive
//   gpsReal            false for a simulated GPS or none (no port to check)
//   gpsAsleep          the receiver is in backup on purpose
//   gpsPortOpen, lastGpsBytesAt, lastUbxAt, lastPvtAt, lastRxmRtcmAt
//   watchBursts        whether this rover expects to hear bursts on its own radio (rtcmWatch enabled)
//   burstsHeard        burstTracker.isActive()
//   lastBaseRxAt
function computeFlags(s, now = Date.now()) {
  const stale = (t, ms) => now - (t != null ? t : s.since) > ms;
  let flags = 0;
  if (s.gpsReal && !s.gpsAsleep) {
    if (!s.gpsPortOpen) flags |= FLAGS.GPS_PORT_CLOSED;
    else if (stale(s.lastGpsBytesAt, GPS_STALE_MS)) flags |= FLAGS.GPS_NO_DATA;
    else if (stale(s.lastUbxAt, GPS_STALE_MS)) flags |= FLAGS.GPS_NO_UBX;
    else if (stale(s.lastPvtAt, GPS_STALE_MS)) flags |= FLAGS.GPS_NO_PVT;
  }
  const pastGrace = now - s.since > BURST_GRACE_MS;
  if (s.watchBursts && pastGrace && !s.burstsHeard) flags |= FLAGS.NO_BURSTS;
  // Only with the GPS link itself working - otherwise there is no RXM-RTCM to miss, and the GPS flag already says why
  if (s.gpsReal && !s.gpsAsleep && s.burstsHeard && !(flags & 0x0f) && stale(s.lastRxmRtcmAt, RXM_RTCM_STALE_MS)) {
    flags |= FLAGS.RTCM_NOT_REACHING_GPS;
  }
  if (stale(s.lastBaseRxAt, BASE_RX_STALE_MS)) flags |= FLAGS.NO_BASE_RX;
  return flags;
}

function powerFromThrottled(value) {
  let p = 0;
  if (value & 0x1) p |= POWER.UNDERVOLT_NOW;
  if (value & 0x10000) p |= POWER.UNDERVOLT_SINCE_BOOT;
  if (value & 0x4) p |= POWER.THROTTLED_NOW;
  if (value & 0x40000) p |= POWER.THROTTLED_SINCE_BOOT;
  return p;
}

// The Pi's get_throttled value as POWER bits; 0 off a Pi (a Mac running SIMULATE) or when it can't be read. The sysfs file
// needs nothing installed; vcgencmd is the fallback on kernels without it.
const THROTTLED_FILE = '/sys/devices/platform/soc/soc:firmware/get_throttled';
function readPower({ readFile = (f) => fs.readFileSync(f, 'utf8'), run = execFileSync } = {}) {
  try {
    return powerFromThrottled(parseInt(readFile(THROTTLED_FILE).trim(), 16) || 0);
  } catch {}
  try {
    const out = run('vcgencmd', ['get_throttled'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /throttled=(0x[0-9a-f]+)/i.exec(out);
    return m ? powerFromThrottled(parseInt(m[1], 16)) : 0;
  } catch {
    return 0;
  }
}

// What changes the base should hear about at once, not just on the next periodic resend: the flags, power now, and whether
// the receiver sees any satellites. Not the satellite count itself, which moves all the time.
function problemKey(d) {
  return `${d.flags}/${d.power & (POWER.UNDERVOLT_NOW | POWER.THROTTLED_NOW)}/${d.fixType != null && d.numSV === 0 ? 'nosv' : ''}`;
}

function hasProblem(d) {
  return d.flags !== 0 || d.power !== 0 || (d.fixType != null && d.numSV === 0);
}

const FLAG_TEXT = [
  [FLAGS.GPS_PORT_CLOSED, 'bad', 'GPS port not open', 'The Pi could not open GPS_PORT - check the port name, and that nothing else (gpsd) holds it'],
  [FLAGS.GPS_NO_DATA, 'bad', 'GPS silent', 'Not a byte from the GPS serial port - check the wiring and board power, and that the receiver is not left asleep'],
  [FLAGS.GPS_NO_UBX, 'bad', 'GPS wrong baud?', "Bytes arrive from the GPS but none are UBX frames - almost always UART1 at a different baud from GPS_BAUD (a reset receiver is at 38400). Re-run ubx_config_set.py --role rover"],
  [FLAGS.GPS_NO_PVT, 'bad', 'GPS: no NAV-PVT', 'The receiver sends UBX but no NAV-PVT, so there are no positions - re-run ubx_config_set.py --role rover'],
  [FLAGS.NO_BURSTS, 'warn', 'no corrections heard', "This rover's radio hears no RTCM correction bursts - the base's correction radio is off or out of range, or this XBee's settings differ from the base's. No RTK, and no transmit slot timing"],
  [FLAGS.RTCM_NOT_REACHING_GPS, 'warn', 'corrections not reaching GPS', "The rover hears correction bursts but the receiver reports none arriving (UBX-RXM-RTCM) - UART2's baud must match the XBee's (115200). Re-run ubx_config_set.py --role rover"],
  [FLAGS.NO_BASE_RX, 'warn', 'hears nothing from base', 'No marks, slot table or ping from the base for 2.5 minutes, though the base hears this rover - the radio works one way only'],
];

// The rover's report as short labelled items for the base log and the fleet table, worst first.
// diag: decodeStatusHello's diag. opts.baseBuild: this base's own commit count, to point out a rover on other code.
// opts.hasPosition: the base already has positions from this rover, so "no fix yet" says nothing new.
// Returns [{ level: 'bad' | 'warn' | 'info', text, title }].
function describe(diag, { baseBuild = null, hasPosition = false } = {}) {
  const items = [];
  for (const [bit, level, text, title] of FLAG_TEXT) {
    if (diag.flags & bit) items.push({ level, text, title });
  }
  if (diag.fixType != null && diag.numSV === 0) {
    items.push({ level: 'bad', text: 'no satellites', title: 'The receiver tracks no satellites at all - the GPS antenna, its cable or coupler, or no view of the sky' });
  } else if (!hasPosition && diag.fixType != null && diag.fixType < 2) {
    items.push({ level: 'info', text: `no fix yet, ${diag.numSV} sv`, title: 'Satellites tracked, still working out a position' });
  }
  if (diag.power & POWER.UNDERVOLT_NOW) {
    items.push({ level: 'bad', text: 'under-voltage', title: "The Pi's supply is below 4.63 V right now - the power supply, cable or a connector" });
  } else if (diag.power & POWER.UNDERVOLT_SINCE_BOOT) {
    items.push({ level: 'warn', text: 'under-voltage since boot', title: "The Pi's supply dropped below 4.63 V at some point since it booted - the power supply, cable or a connector" });
  } else if (diag.power & (POWER.THROTTLED_NOW | POWER.THROTTLED_SINCE_BOOT)) {
    items.push({ level: 'warn', text: 'CPU throttled', title: 'The Pi slowed its CPU down (heat or power)' + (diag.power & POWER.THROTTLED_NOW ? ' - now' : ' - at some point since boot') });
  }
  if (diag.build != null && baseBuild != null && diag.build !== baseBuild) {
    items.push({
      level: 'warn',
      text: `build ${diag.build}${diag.build < baseBuild ? ' (behind)' : ''}`,
      title: `This rover runs build ${diag.build}, the base ${baseBuild} - ${diag.build < baseBuild ? 'it missed an update (it pulls at boot)' : 'the base is behind it'}`,
    });
  }
  if (diag.dirty) items.push({ level: 'info', text: 'local changes', title: 'The code on this rover has uncommitted changes' });
  const rank = { bad: 0, warn: 1, info: 2 };
  return items.sort((a, b) => rank[a.level] - rank[b.level]);
}

// "v0.1.290" -> 290; null without a commit count (no git)
function buildNumber(version) {
  if (!version || !version.commit) return null;
  const n = parseInt(String(version.version).split('.').pop(), 10);
  return Number.isFinite(n) ? n : null;
}

module.exports = { FLAGS, POWER, computeFlags, powerFromThrottled, readPower, problemKey, hasProblem, describe, buildNumber };
