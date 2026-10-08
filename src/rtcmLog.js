// Console logging for RTCM correction messages (RTCM_LOG - see config.js).
//
// Level 1 (RTCM_LOG=1): ONE tight line per second per source, e.g.
//   [rtcm-radio] 449B 6msg MSM4 1005:stn 1074:GPS8 1084:GLO7 1094:GAL3 1124:BDS7 1230:bias
//   [rtcm] 6/6 used: 1005 1074 1084 1094 1124 1230
// Level 2 (RTCM_LOG=2): one line per message, with the decoded header:
//   [rtcm-radio] 1074 GPS 8sv 12c 129B
//   [rtcm] 1074 used
//
// A "burst" is the run of messages the base sends once a second; messages are
// grouped into one by a short idle gap (idleMs), then the line is printed.
// `sv` = satellites in the message, `c` = signal cells (satellite x signal
// pairs). The set of messages is compared with the previous burst's, and a
// change is flagged - a message that suddenly stops appearing is the thing worth
// seeing at a glance.

const protocol = require('./protocol');

function createRtcmLogger({ level = 1, log = console.log, warn = console.warn, idleMs = 250 } = {}) {
  let radioBurst = [];
  let radioTimer = null;
  let prevSet = null;
  let forwardedAny = false;
  let rxBurst = [];
  let rxTimer = null;

  // "1074:GPS8" = message number, constellation, satellites in it
  function token(d) {
    if (d.name === 'stn') return `${d.type}:${d.station ? `stn#${d.station}` : 'stn'}`;
    if (d.sats !== undefined) return `${d.type}:${d.name}${d.sats}`;
    return `${d.type}:${d.name}`;
  }

  function flushRadio() {
    radioTimer = null;
    if (!radioBurst.length) return;
    const described = radioBurst.map((f) => ({ d: protocol.describeRtcm(f), size: f.length }));
    const bytes = described.reduce((n, x) => n + x.size, 0);
    const levels = [...new Set(described.map((x) => x.d.msm).filter(Boolean))];
    const set = described.map((x) => x.d.type).join(',');
    let line = `[rtcm-radio] ${bytes}B ${described.length}msg`;
    if (levels.length === 1) line += ` MSM${levels[0]}`;
    else if (levels.length > 1) line += ` MSM${levels.join('+')}`;
    line += ' ' + described.map((x) => token(x.d)).join(' ');
    if (forwardedAny) line += ' ->GPS';
    if (prevSet !== null && set !== prevSet) line += `  !set changed (${set})`;
    prevSet = set;
    radioBurst = [];
    forwardedAny = false;
    log(line);
  }

  function flushReceiver() {
    rxTimer = null;
    if (!rxBurst.length) return;
    const used = rxBurst.filter((m) => m.msgUsed === 2).length;
    const unused = rxBurst.filter((m) => m.msgUsed !== 2 && !m.crcFailed).map((m) => m.msgType);
    const failed = rxBurst.filter((m) => m.crcFailed).map((m) => m.msgType);
    let line = `[rtcm] ${used}/${rxBurst.length} used: ${rxBurst.map((m) => m.msgType).join(' ')}`;
    if (unused.length) line += `, not used ${unused.join(',')}`;
    if (failed.length) line += `, CRC-FAIL ${failed.join(',')}`;
    rxBurst = [];
    (failed.length ? warn : log)(line);
  }

  return {
    // An RTCM frame that arrived over the telemetry radio; `forwarded` = it was
    // also written to the GPS.
    radio(frame, forwarded = false) {
      if (level >= 2) {
        const d = protocol.describeRtcm(frame);
        let line = `[rtcm-radio] ${d.type}`;
        if (d.name && d.name !== String(d.type)) line += ` ${d.name}`;
        if (d.sats !== undefined) line += ` ${d.sats}sv`;
        if (d.cells !== undefined) line += ` ${d.cells}c`;
        line += ` ${frame.length}B${forwarded ? ' ->GPS' : ''}`;
        log(line);
        return;
      }
      radioBurst.push(frame);
      if (forwarded) forwardedAny = true;
      if (radioTimer) clearTimeout(radioTimer);
      radioTimer = setTimeout(flushRadio, idleMs);
      radioTimer.unref();
    },
    // A UBX-RXM-RTCM report from the GPS receiver ({ msgType, msgUsed, crcFailed }).
    receiver(msg) {
      if (level >= 2) {
        const state = msg.crcFailed ? 'CRC-FAILED' : msg.msgUsed === 2 ? 'used' : 'not used';
        (msg.crcFailed ? warn : log)(`[rtcm] ${msg.msgType} ${state}`);
        return;
      }
      rxBurst.push(msg);
      if (rxTimer) clearTimeout(rxTimer);
      rxTimer = setTimeout(flushReceiver, idleMs);
      rxTimer.unref();
    },
  };
}

module.exports = { createRtcmLogger };
