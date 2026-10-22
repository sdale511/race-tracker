const http = require('http');
const { formatAgo, formatDuration, formatBytes, pct, renderDiskCard, SLOT_MAP_CSS, renderSlotMap, REFRESH_CONTROL_HTML, REFRESH_SCRIPT } = require('./dashboardFormat');
const { MARK_NAMES, MARK_COLORS, markStroke, distanceMeters, bearingDeg, compassDir, getPinBoundaryFarPoint } = require('./course');
const { renderConfigPage } = require('./configReport');
const { renderConsoleLogPage } = require('./consoleLogPage');
const { TABS_CSS, renderTabs, roverTabs } = require('./adminNav');
const { zonePolygon } = require('./onGridWatcher');
const config = require('./config');

function fixQualityText(f) {
  if (f.carrSoln === 2) return 'RTK fixed';
  if (f.carrSoln === 1) return 'RTK float';
  if (f.gnssFixOk) return 'GPS';
  return 'No fix';
}

// Dilution of precision - how much the current satellite geometry is
// amplifying measurement error, independent of hAcc/vAcc. Same rough bands
// as adminServer.js's own copy (duplicated rather than imported, same as
// buildCourseInfoHtml below): under 2 is about as good as GPS geometry
// gets, 2-5 is normal good-sky conditions, 5-10 a partially obstructed
// view, above 10 treat the fix with real suspicion.
function dopQualityText(dop) {
  if (dop < 2) return 'excellent';
  if (dop < 5) return 'good';
  if (dop < 10) return 'fair';
  return 'poor';
}

// `power` is whatever powerSchedule.js's getStatus() returned (see
// boatAgent.js's powerScheduler) - surfaces the scheduled-shutdown feature
// (config.js's "Scheduled shutdown" / powerSchedule.js) as a card with its
// own inline edit form, so an operator can arm/retune/disable it from the
// dashboard instead of hand-editing a .env and restarting the boat
// process. idleSince present means the gate is past shutdownAt AND
// currently reading idle - i.e. the countdown to an actual shutdown is
// running right now, which is worth calling out with its own color/copy
// rather than folding into the same "armed" state as "configured but nothing
// imminent."
// The Witty Pi 4 power schedule this boat got from the base admin (see wittySchedule.js) - read only here; the base sets it for
// the whole fleet. Says so when the board's software is not installed on this boat. A schedule that lets the boat halt itself
// needs the "Boat shutdown" card above to have a time, or the boat would stay on after the day ends.
const escapeWitty = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function renderWittyCard(witty, power) {
  if (!witty) return '';
  if (!witty.installed) {
    return `<div class="card power-card">
      <div class="label">Witty Pi schedule</div>
      <div class="value" style="font-size:16px;"><span class="dot dot-gray"></span>not installed</div>
      <div class="sub">expected install path: <code>${escapeWitty(witty.dir)}</code> (WITTYPI_DIR overrides); a schedule from the base is ignored on this boat</div>
    </div>`;
  }
  const a = witty.applied;
  const halts = a && a.ok && a.settings && a.settings.mode !== 'off' && a.settings.haltItself;
  const dot = !a ? 'dot-gray' : !a.ok ? 'dot-red' : halts && !power.shutdownAt ? 'dot-orange' : 'dot-green';
  const text = !a ? 'no schedule from the base yet' : !a.ok ? `not applied: ${escapeWitty(a.message)}` : escapeWitty(witty.description || a.message);
  return `<div class="card power-card">
      <div class="label">Witty Pi schedule</div>
      <div class="value" style="font-size:16px;"><span class="dot ${dot}"></span>${text}</div>
      <div class="sub">${a ? `applied ${formatDuration(Date.now() - a.appliedAt)} ago, ` : ''}Witty Pi software at <code>${escapeWitty(witty.dir)}</code>${halts && !power.shutdownAt ? '. <strong>This schedule leaves the shutdown to the boat, but the Boat shutdown card has no time, so the boat would stay on.</strong>' : ''}</div>
      ${witty.file ? `<details><summary class="sub">schedule file</summary><pre style="font-size:11px; overflow-x:auto; margin:6px 0 0;">${escapeWitty(witty.file)}</pre></details>` : ''}
    </div>`;
}

function renderPowerCard(power, fromBase) {
  const dotClass = power.triggered ? 'dot-red' : power.idleSince ? 'dot-orange' : power.armed ? 'dot-green' : 'dot-gray';
  const statusText = power.triggered
    ? 'shutting down now'
    : !power.capable
    ? 'unsupported on this platform'
    : power.shutdownAt && power.shutdownRequireIdle !== false
    ? power.idleSince
        ? `idle ${formatDuration(Date.now() - power.idleSince)} of ${power.shutdownIdleMinutes}m`
        : 'armed'
    : power.shutdownAt
    ? 'armed'
    : 'disabled';
  const subText = power.triggered
    ? 'device is powering off'
    : !power.capable
    ? `shutdown -h now only runs on Linux (platform=${process.platform}) - safe to leave configured for when this runs on the Pi`
    : power.shutdownAt && power.shutdownRequireIdle === false
    ? `at ${power.shutdownAt} local time, whatever the boat is doing`
    : power.shutdownAt
    ? `after ${power.shutdownAt} local time, once stationary &lt;${power.shutdownSpeedKn}kn (or no fresh fix) for ${power.shutdownIdleMinutes} continuous minutes`
    : 'no shutdown time set';
  // Read only: the base admin sets the shutdown for the whole fleet and sends it over the radio (fleetShutdown.js).
  const source = fromBase
    ? `from the base ${formatDuration(Date.now() - fromBase.appliedAt)} ago${fromBase.ok ? '' : ' (not applied: ' + escapeWitty(fromBase.message) + ')'}`
    : 'not set by a base';
  return `<div class="card power-card">
      <div class="label">Boat shutdown</div>
      <div class="value"><span class="dot ${dotClass}"></span>${statusText}</div>
      <div class="sub">${subText}</div>
      <div class="sub">${source}</div>
    </div>`;
}

// markMode's own assignment card (see config.js's markMode/boatAgent.js's
// setMarkName) - only ever rendered when s.markMode is true (npm run mark),
// so only a device explicitly launched for it has it. Lets an operator pick (or
// clear) which mark this device continuously represents without needing
// MARK_NAME set on the command line, and shows whether it's currently
// keeping up (a fresh auto-send is implied by currentMarkName being set -
// there's no separate "last auto-sent" timestamp surfaced here, since the
// Course marks card above already shows the mark's own last-known position
// the instant the base's re-broadcast confirms it landed).
function renderMarkCard(s) {
  const options = MARK_NAMES.map(
    (name) => `<option value="${name}" ${s.currentMarkName === name ? 'selected' : ''}>${name}</option>`
  ).join('');
  return `<div class="card">
      <div class="label">This device represents</div>
      <div class="value">${s.currentMarkName || 'unassigned'}</div>
      <div class="sub">auto-sends its own position as this mark whenever it drifts &ge;${config.markDistanceM}m</div>
      <div class="manual-fixed-field">
        <label for="markNameSelect">Mark</label>
        <select class="manual-input" id="markNameSelect">
          <option value="">unassigned</option>
          ${options}
        </select>
      </div>
      <div class="card-actions">
        <button type="button" class="card-btn" onclick="saveMarkName(this)">Assign</button>
      </div>
    </div>`;
}

// Shown on EVERY rover mode (plain boat, mark) - unlike renderMarkCard
// above, marking the base's own log with a note is just as relevant to an
// ordinary boat as to a mark device, so this isn't gated on s.markMode the
// way that card is. No GPS fix
// needed (see boatAgent.js's sendMarkLog) and nothing on THIS dashboard
// changes as a result - the whole point lands on the base's own log, not
// here - so the button's own JS (see the <script> below) shows a brief
// inline confirmation instead of the usual location.reload() other cards
// use, and clears the field so it's obviously ready for the next note.
function renderMarkLogCard() {
  return `<div class="card">
      <div class="label">Mark base log</div>
      <div class="sub">Sends a short note to the base's own log/rate-stats right now - e.g. right after walking to a new distance, or any other physical change worth timestamping.</div>
      <div class="manual-fixed-field">
        <label for="markLogInput">Note</label>
        <input type="text" class="manual-input" id="markLogInput" placeholder="e.g. 1000m from base" maxlength="20">
      </div>
      <div class="card-actions">
        <button type="button" class="card-btn" onclick="sendMarkLog(this)">Mark</button>
      </div>
      <div class="sub" id="markLogStatus" style="margin-top:6px;"></div>
    </div>`;
}

// Renders the boat's own dashboard server-side from one stats snapshot (see
// boatAgent.js's getRoverStats) - the boat-side counterpart to
// adminServer.js's renderDashboard, but there's only ever one boat here, so
// this is a single detail view rather than a fleet table.
// The numbers of the shared "join" slots, e.g. "39, 40" (slots are numbered from 0)
function joinSlotNumbers(txSlot) {
  if (txSlot.joinFirst == null || !txSlot.joinSlots) return '?';
  return Array.from({ length: txSlot.joinSlots }, (_, i) => txSlot.joinFirst + i).join(', ');
}

// The slot table this boat is following: what the base broadcast, as a slot map with this boat's own slot highlighted and
// the list behind it. Shown only once the boat has heard a table (a pinned boat never follows one).
function renderSlotTableCard(s) {
  const t = s.txSlot && s.txSlot.table;
  if (!s.txSlot || !s.txSlot.enabled) return '';
  if (!t) {
    return `<div class="card slot-table-card">
      <div class="label" title="The table of transmit slots the base broadcasts, listing which boat holds which slot">Slot table</div>
      <div class="value">not heard yet</div>
      <div class="sub">The base sends its slot table every few seconds; this boat has not heard one.</div>
    </div>`;
  }
  const assignable = t.slotCount - t.joinSlots;
  const bySlot = new Map(t.entries.map((e) => [e.slot, e.boatId]));
  const mine = t.entries.find((e) => e.boatId === s.boatId);
  const ago = Math.max(0, Math.round((Date.now() - t.heardAt) / 1000));
  const rows = [...t.entries]
    .sort((a, b) => a.slot - b.slot)
    .map((e) => `<tr class="${e.boatId === s.boatId ? 'mine' : ''}"><td>slot ${e.slot}</td><td>boat ${e.boatId}${e.boatId === s.boatId ? ' (this boat)' : ''}</td></tr>`)
    .join('');
  return `<div class="card slot-table-card">
      <div class="label" title="The table of transmit slots the base broadcasts, listing which boat holds which slot">Slot table</div>
      <div class="value">${t.entries.length} of ${assignable}</div>
      <div class="sub">${t.practice ? 'Practice mode' : 'Race mode'} &middot; table v${t.version}, heard ${ago} s ago &middot; ${
        mine ? `this boat holds slot ${mine.slot}` : 'this boat is not listed (it shares the join slots)'
      }</div>
      ${renderSlotMap({ slotCount: t.slotCount, joinSlots: t.joinSlots, bySlot, mineId: s.boatId })}
      <details class="slot-list"><summary>List the ${t.entries.length} boats</summary><table>${rows || '<tr><td>nobody holds a slot</td></tr>'}</table></details>
    </div>`;
}

function renderDashboard(s, power, witty, shutdownFromBase) {
  const fix = s.lastFix;
  // receivedAt (this Pi's own local-clock receipt time), not timestamp
  // (the fix's own GPS-derived time, which can legitimately diverge from
  // this Pi's clock - see ubxParser.js) - staleness is a question about
  // locally-measured elapsed time, not the fix's absolute clock.
  const fixAgeMs = fix ? Date.now() - fix.receivedAt : null;
  // Stale if the boat hasn't produced a new fix in a while - catches a GPS
  // that's stopped responding even though the process itself is still up.
  const fixStale = fixAgeMs == null || fixAgeMs > 10000;

  const baseReachable = s.upload.lastHealthCheckOkAt && Date.now() - s.upload.lastHealthCheckOkAt < 60000;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>boat ${s.boatId} - rover admin</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    background: #0f1216;
    color: #e6e9ef;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .subtitle { color: #8b94a3; font-size: 13px; margin-bottom: 24px; }
  .refresh-control { cursor: pointer; user-select: none; color: #c3cad5; }
  .refresh-control input { vertical-align: middle; accent-color: #f2b84b; cursor: pointer; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-bottom: 24px; }
  .card {
    background: #161b22;
    border: 1px solid #262c36;
    border-radius: 10px;
    padding: 16px 18px;
  }
  .card .label { color: #8b94a3; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
  .card .value { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .card .sub { color: #8b94a3; font-size: 12px; margin-top: 4px; }
  .stat-rows { display: flex; flex-direction: column; gap: 5px; margin-top: 6px; }
  .stat-row { display: flex; align-items: baseline; gap: 10px; font-size: 12px; }
  .stat-row .name { flex-shrink: 0; color: #8b94a3; }
  .stat-row .val { color: #e6e9ef; font-variant-numeric: tabular-nums; margin-left: auto; text-align: right; }
  .marks-card { grid-column: span 2; }
  .marks-mini { display: flex; flex-direction: column; gap: 5px; margin-top: 2px; }
  .marks-mini .mark-row { display: flex; align-items: baseline; gap: 6px; font-size: 12px; }
  .marks-mini .mark-row .name { flex-shrink: 0; }
  .marks-mini .mark-row .coords { color: #8b94a3; font-variant-numeric: tabular-nums; margin-left: auto; white-space: nowrap; }
  section { margin-bottom: 28px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.04em; color: #8b94a3; margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #262c36; border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 14px; font-size: 13px; font-variant-numeric: tabular-nums; }
  th { color: #8b94a3; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid #262c36; }
  tr:not(:last-child) td { border-bottom: 1px solid #1c222b; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; flex-shrink: 0; }
  .dot-green { background: #3fb950; box-shadow: 0 0 6px #3fb95080; }
  .dot-gray { background: #4b535e; }
  .dot-red { background: #f85149; box-shadow: 0 0 6px #f8514980; }
  .dot-orange { background: #f2b84b; box-shadow: 0 0 6px #f2b84b80; }
  .muted { color: #8b94a3; }
  .empty { color: #8b94a3; padding: 20px; text-align: center; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .card-actions { display: flex; gap: 6px; margin-top: 10px; }
  .card-btn {
    flex: 1; padding: 6px 8px; border-radius: 6px; border: 1px solid #262c36;
    background: #1c222b; color: #e6e9ef; font-size: 11px; cursor: pointer;
  }
  .card-btn:hover { background: #262c36; }
  .card-btn:disabled { opacity: 0.5; cursor: default; }
  .power-card { grid-column: span 2; }
  .manual-fixed-field { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
  .manual-fixed-field label { flex-shrink: 0; width: 70px; font-size: 11px; color: #8b94a3; }
  .manual-input {
    flex: 1; min-width: 0; padding: 7px 10px; border-radius: 6px; border: 1px solid #262c36;
    background: #0f1216; color: #e6e9ef; font-size: 13px; font-variant-numeric: tabular-nums;
  }
  .manual-input::placeholder { color: #5a6270; }
  ${TABS_CSS}
  ${SLOT_MAP_CSS}
  .slot-table-card { grid-column: span 2; }
  .slot-list { margin-top: 8px; font-size: 12px; color: #8b94a3; }
  .slot-list summary { cursor: pointer; }
  .slot-list table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  .slot-list td { padding: 2px 8px 2px 0; font-variant-numeric: tabular-nums; }
  .slot-list tr.mine td { color: #56d364; font-weight: 600; }
</style>
</head>
<body>
  <h1>boat ${s.boatId} - rover admin${s.markMode ? ' &middot; <span style="color:#e3b341;">MARK MODE</span>' : ''}${s.sleep && s.sleep.state !== 'awake' ? ` &middot; <span style="color:#58a6ff;">${s.sleep.gps && s.sleep.gps.asleep ? 'RADIO + GPS ASLEEP' : 'RADIO ASLEEP'}</span>` : ''}</h1>
  ${renderTabs(roverTabs(!!(s.currentMarks || fix)), 'home')}
  <div class="subtitle">
    <strong style="color:#e6e9ef;">Boat ID ${s.boatId}</strong>
    &nbsp;·&nbsp; Regatta: ${s.currentRegattaName || 'not set'}
    &nbsp;·&nbsp; <span class="dot ${fixStale ? 'dot-red' : 'dot-green'}"></span>GPS ${s.gpsMode}
    &nbsp;·&nbsp; radio ${s.radioMode}
    &nbsp;·&nbsp; uptime ${formatDuration(s.uptimeMs)}
    &nbsp;·&nbsp; reloads every 5s &nbsp;${REFRESH_CONTROL_HTML}
    ${s.baseIp ? `&nbsp;·&nbsp; <a href="http://${s.baseIp}:${s.adminPort}/" target="_blank" rel="noopener">base dashboard ↗</a>` : ''}
  </div>

  <div class="grid">
    <div class="card">
      <div class="label">Last fix</div>
      <div class="value">${formatAgo(fix ? fix.timestamp : null)}</div>
      <div class="stat-rows">${
        fix
          ? [
              { label: 'Position', value: `${fix.lat.toFixed(6)}, ${fix.lon.toFixed(6)}` },
              fix.hMSLMm != null
                ? {
                    label: 'Altitude',
                    value: `${(fix.hMSLMm / 1000).toFixed(2)}m MSL${fix.heightMm != null ? ` / ${(fix.heightMm / 1000).toFixed(2)}m ellipsoid` : ''}`,
                  }
                : null,
              fix.gSpeedMmS != null ? { label: 'Speed', value: `${((fix.gSpeedMmS / 1000 / 1852) * 3600).toFixed(1)}kn` } : null,
              fix.headMotDeg != null && fix.gSpeedMmS > 0 ? { label: 'Heading', value: `${fix.headMotDeg.toFixed(0)}&deg;` } : null,
            ]
              .filter(Boolean)
              .map((r) => `<div class="stat-row"><span class="name">${r.label}</span><span class="val">${r.value}</span></div>`)
              .join('')
          : '<div class="stat-row"><span class="name">no fix yet</span></div>'
      }</div>
    </div>
    <div class="card">
      <div class="label" title="RTK fixed (cm-level) > RTK float (dm-level) > GPS (no RTK correction) > No fix">Fix quality</div>
      <div class="value">${fix ? fixQualityText(fix) : '—'}</div>
      <div class="stat-rows">${
        fix
          ? [
              {
                label: 'diffSoln',
                title: 'Whether this fix uses any differential correction data at all - goes true as soon as RTCM corrections from the base start being applied, even before carrSoln below reaches float/fixed',
                value: `${fix.diffSoln}`,
              },
              {
                label: 'carrSoln',
                title: '0 = no RTK carrier-phase solution, 1 = RTK float (decimeter-level, still resolving), 2 = RTK fixed (centimeter-level)',
                value: `${fix.carrSoln}`,
              },
              {
                label: 'Fix rate',
                title: "This boat's own raw GPS output rate (CFG-RATE-MEAS), measured from actual fix-receipt gaps over the last 10s - not the radio transmit rate, which is throttled separately by TX_DISTANCE_M",
                value: s.fixHz != null ? `${s.fixHz.toFixed(1)} Hz` : '—',
              },
              { label: 'Satellites', title: 'Number of satellites used in this fix', value: `${fix.numSV}` },
              {
                label: 'Accuracy',
                title: "Estimated 1-sigma position error, as reported by the receiver itself",
                value: `&plusmn;${(fix.hAccMm / 1000).toFixed(2)}m horiz${fix.vAccMm != null ? ` / &plusmn;${(fix.vAccMm / 1000).toFixed(2)}m vert` : ''}`,
              },
              fix.pDOP != null
                ? {
                    label: 'DOP',
                    title: 'Dilution of precision - how much the current satellite geometry is amplifying measurement error, independent of the Accuracy figure above',
                    value: `${fix.pDOP.toFixed(2)} (${dopQualityText(fix.pDOP)})`,
                  }
                : null,
            ]
              .filter(Boolean)
              .map(
                (r) =>
                  `<div class="stat-row"><span class="name" title="${r.title || ''}">${r.label}</span><span class="val">${r.value}</span></div>`
              )
              .join('')
          : ''
      }</div>
    </div>
    ${
      s.currentMarks
        ? `<div class="card marks-card">
      <div class="label">Course marks</div>
      <div class="sub">last update ${
        s.lastMarksReceivedAt == null ? 'unknown' : `${Math.floor((Date.now() - s.lastMarksReceivedAt) / 1000)}s ago`
      }</div>
      <div class="marks-mini">
        ${MARK_NAMES.map((name) => {
          const m = s.currentMarks[name];
          return `<div class="mark-row"><span class="dot" style="background:${MARK_COLORS[name]}; box-shadow: inset 0 0 0 1.5px ${markStroke(name)}"></span><span class="name">${name}</span><span class="coords">${m.lat.toFixed(4)}, ${m.lon.toFixed(4)}</span></div>`;
        }).join('')}
        <div class="mark-row"><span class="dot" style="background:${MARK_COLORS.pinBoundary}"></span><span class="name">pin boundary gate</span><span class="coords">${s.currentMarks.pinBoundaryEnabled ? 'ON' : 'off'}</span></div>
      </div>
    </div>`
        : `<div class="card">
      <div class="label">Course marks</div>
      <div class="value">waiting</div>
      <div class="sub">no course broadcast received yet</div>
    </div>`
    }
    <div class="card">
      <div class="label" title="RTCM3 correction messages from the base - what the RTK fix depends on">RTK corrections</div>
      <div class="value">${
        s.rtcm.lastReceivedAt == null
          ? s.radioRtcm.lastReceivedAt == null
            ? 'none yet'
            : 'not applied'
          : Date.now() - s.rtcm.lastReceivedAt < 10000
          ? 'receiving'
          : 'stalled'
      }</div>
      <div class="stat-rows">${[
        {
          label: 'GPS applied',
          title: 'Correction messages the GPS receiver itself reports receiving (UBX-RXM-RTCM) - the count that matters for RTK',
          value: s.rtcm.count.toLocaleString(),
        },
        {
          label: 'GPS last',
          title: 'How long ago the GPS receiver last reported a correction message, and its RTCM message type (1005 = base position, 1074/1084/1094/1124 = observations, 1230 = GLONASS biases)',
          value: `${formatAgo(s.rtcm.lastReceivedAt)}${s.rtcm.lastMsgType != null ? ` (type ${s.rtcm.lastMsgType})` : ''}`,
        },
        {
          label: 'CRC failures',
          title: 'Correction messages the GPS rejected as corrupted',
          value: s.rtcm.crcFailures.toLocaleString(),
        },
        {
          label: 'Radio received',
          title: 'Correction messages that arrived over this boat\'s telemetry radio (shared-radio setup only - 0 if corrections come in on a separate radio straight into the GPS)',
          value: `${s.radioRtcm.frames.toLocaleString()} (${formatAgo(s.radioRtcm.lastReceivedAt)})`,
        },
        {
          label: 'Sent to GPS',
          title: 'Of those, how many this boat wrote to its GPS receiver. 0 while corrections arrive means forwarding is off - set RTCM_FORWARD=1 (shared radio on the Pi, with the Pi TX line wired to the receiver RX)',
          value: s.radioRtcm.forwarded.toLocaleString(),
        },
      ]
        .map((r) => `<div class="stat-row"><span class="name" title="${r.title}">${r.label}</span><span class="val">${r.value}</span></div>`)
        .join('')}</div>
    </div>
    ${
      s.txGate
        ? `<div class="card">
      <div class="label" title="Where this boat sends its position in the shared-radio schedule, and whether frames are keeping to it">Transmit slot</div>
      <div class="value">${
        !s.txGate.tracker.active
          ? 'no bursts heard'
          : s.txSlot && s.txSlot.enabled && !s.txSlot.sharing && s.txSlot.index != null
          ? `slot ${s.txSlot.index}`
          : s.txSlot && s.txSlot.joinFirst != null
          ? `shared ${joinSlotNumbers(s.txSlot)}`
          : 'shared'
      }</div>
      <div class="stat-rows">${[
        {
          label: 'Corrections',
          title: 'How often the correction bursts this radio hears arrive - the transmit slots are timed from them',
          value: s.txGate.tracker.active && s.txGate.tracker.periodMs ? `every ${Math.round(s.txGate.tracker.periodMs)} ms` : 'not heard',
        },
        s.txSlot && s.txSlot.enabled
          ? {
              label: 'Slots',
              title: 'How many slots there are in one correction cycle (including the shared join slots) and how wide each is. Until this boat has heard the base\'s table the count is what it works out from RTCM_INTERVAL_S and TX_SLOT_MS.',
              value: `${s.txSlot.count} x ${s.txSlot.widthMs} ms`,
            }
          : null,
        s.txSlot && s.txSlot.practice
          ? { label: 'Mode', title: 'The base is in practice mode: any moving boat gets a slot, and this boat does not park itself in the start zone', value: 'practice' }
          : null,
        s.txSlot && s.txSlot.enabled
          ? {
              label: 'Table',
              title: 'Whether this boat has heard the base\'s slot table. "Shared" slots (the headline) belong to nobody: a boat with no slot of its own yet sends there.',
              value: s.txSlot.tableHeard ? 'from the base' : 'not heard yet',
            }
          : null,
        { label: 'Sent in slot', title: 'Frames released in this boat\'s own slot', value: s.txGate.slotted.toLocaleString() },
        {
          label: 'Spilled',
          title: 'Frames that did not fit the slot and went out a cycle later - nothing is lost. A few near marks is normal; one every cycle means the slot is too small (raise TX_SLOT_MS or lower TX_SLOT_MAX_HZ)',
          value: s.txGate.spilled.toLocaleString(),
        },
        {
          label: 'Expired / dropped',
          title: 'Frames discarded because they waited too long or the queue was full - these positions never went out (they are still on the SD card)',
          value: `${s.txGate.expired.toLocaleString()} / ${s.txGate.dropped.toLocaleString()}${s.txGate.expired + s.txGate.dropped > 0 ? ' &#9888;' : ''}`,
        },
        { label: 'Waiting now', title: 'Frames queued for the next slot', value: s.txGate.queued },
      ]
        .filter(Boolean)
        .map((r) => `<div class="stat-row"><span class="name" title="${r.title}">${r.label}</span><span class="val">${r.value}</span></div>`)
        .join('')}</div>
    </div>`
        : ''
    }
    ${renderSlotTableCard(s)}
    <div class="card">
      <div class="label">Frames sent</div>
      <div class="value">${s.radio.framesSent.toLocaleString()}</div>
      <div class="sub">${s.radio.syncErrors} sync errors received</div>
    </div>
    <div class="card">
      <div class="label">Base station</div>
      <div class="value">${s.baseIp ? (baseReachable ? 'reachable' : 'unreachable') : 'not discovered'}</div>
      <div class="stat-rows">${
        s.baseIp
          ? [
              { label: 'Address', value: s.baseIp },
              s.adminPort
                ? {
                    label: 'Dashboard',
                    value: `<a href="http://${s.baseIp}:${s.adminPort}/" target="_blank" rel="noopener">${s.baseIp}:${s.adminPort} &#8599;</a>`,
                  }
                : null,
              s.baseUploadPort ? { label: 'Upload port', value: s.baseUploadPort } : null,
              { label: 'Last check ok', value: formatAgo(s.upload.lastHealthCheckOkAt) },
            ]
              .filter(Boolean)
              .map((r) => `<div class="stat-row"><span class="name">${r.label}</span><span class="val">${r.value}</span></div>`)
              .join('')
          : '<div class="stat-row"><span class="name">learned from the course marks broadcast - waiting to hear one</span></div>'
      }</div>
    </div>
    <div class="card">
      <div class="label">Pending uploads</div>
      <div class="value">${s.pendingCount}</div>
      <div class="sub">not yet sent to base</div>
    </div>
    <div class="card">
      <div class="label">Uploaded files</div>
      <div class="value">${s.upload.successes.toLocaleString()}</div>
      <div class="sub">${formatBytes(s.upload.bytesTotal)} total, last ${formatAgo(s.upload.lastUploadAt)}</div>
    </div>
    <div class="card">
      <div class="label">Upload attempts</div>
      <div class="value">${s.upload.attempts.toLocaleString()}</div>
      <div class="sub">${pct(s.upload.successes, s.upload.attempts)} success rate, ${s.upload.failures} failures</div>
    </div>
    ${renderDiskCard(s.disk, `Logs chunked every ${config.logChunkMinutes}min, kept ${config.logRetentionDays} days`)}
    ${s.markMode ? renderMarkCard(s) : ''}
    ${renderMarkLogCard()}
    ${renderPowerCard(power, shutdownFromBase)}
    ${renderWittyCard(witty, power)}
  </div>

  <script>
    // markMode's own card (see renderMarkCard) - assigns/clears which mark
    // this device continuously represents (see boatAgent.js's
    // setMarkName). Reloads on success, same reasoning as
    // postPowerSchedule above - the card's own "This device represents"
    // value should reflect the change immediately, not wait on the next
    // 5s meta-refresh.
    async function saveMarkName(btn) {
      btn.disabled = true;
      try {
        const markName = document.getElementById('markNameSelect').value || null;
        const res = await fetch('/api/mark-name', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ markName }),
        });
        const result = await res.json();
        if (!result.ok) throw new Error(result.error || 'request failed');
        location.reload();
      } catch (err) {
        alert('Failed: ' + err.message);
        btn.disabled = false;
      }
    }

    // Mark base log card (see renderMarkLogCard) - unlike every other
    // card's own button here, nothing on THIS page changes as a result (the
    // whole point lands on the base's own log), so this shows a brief
    // inline confirmation instead of location.reload(), and clears the
    // field so it's obviously ready for the next note.
    async function sendMarkLog(btn) {
      btn.disabled = true;
      const status = document.getElementById('markLogStatus');
      const input = document.getElementById('markLogInput');
      status.textContent = 'Sending…';
      try {
        const res = await fetch('/api/mark-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: input.value }),
        });
        const result = await res.json();
        if (!result.ok) throw new Error(result.error || 'request failed');
        status.textContent = 'Sent - ' + new Date().toLocaleTimeString();
        input.value = '';
      } catch (err) {
        status.textContent = 'Failed: ' + err.message;
      } finally {
        btn.disabled = false;
      }
    }
  </script>
  <script>${REFRESH_SCRIPT}</script>
</body>
</html>`;
}

// A full-page map view (see adminServer.js's renderMap - same Esri World
// Imagery CDN tiles, same reasoning: these courses are raced on open
// playa, not somewhere a street basemap has anything useful to draw, so
// the viewing browser needs internet access). Unlike the base's version,
// this one is scoped to a single boat, so it also plots this boat's own
// last known fix - a live breadcrumb, not just the static course - since
// that's the one thing the base's fleet-wide map doesn't have room to
// show per-boat.
// Floating card in the map page's top-left corner, showing the start/finish
// lines' own lengths and bearings plus a compass heading from committeeStart
// to each windward/leeward mark - the numbers a race committee actually
// calls out on the water, not just raw mark coordinates. Windward/leeward
// bearings are measured FROM committeeStart specifically (the usual
// start-line committee boat), matching how an operator standing there would
// actually read them - not from this boat's own live position, which would
// make every reading shift as the boat moves. Same as adminServer.js's own
// copy - see its comment for why this file doesn't import that one instead.
// Each row carries a data-marks attribute (one mark name, or two comma-
// separated) so the map page's own script can zoom to it on click - one
// name zooms straight to that mark, two fits both into view (a line, not a
// single point). Same as adminServer.js's own copy.
function buildCourseInfoHtml(marks) {
  const startLineM = distanceMeters(marks.pin, marks.committeeStart);
  const startLineBearing = bearingDeg(marks.committeeStart, marks.pin);
  const finishLineM = distanceMeters(marks.committeeFinish, marks.finish);
  const finishLineBearing = bearingDeg(marks.committeeFinish, marks.finish);
  const headingRows = ['windwardBlack', 'windwardGreen', 'leewardGreen', 'leewardBlack']
    .map((name) => {
      const label = name[0].toUpperCase() + name.slice(1);
      const bearing = bearingDeg(marks.committeeStart, marks[name]);
      return `<div class="course-info-row zoomable" data-marks="${name}"><span class="label">Hdg &rarr; ${label}</span><span class="value">${Math.round(bearing)}&deg; ${compassDir(bearing)}</span></div>`;
    })
    .join('');
  // Only shown when the pin boundary gate is actually on - read-only here
  // (this checkbox only lives on the base's own admin map), same shape as
  // adminServer.js's own copy.
  const pinBoundaryRow = marks.pinBoundaryEnabled
    ? '<div class="course-info-row zoomable" data-marks="pin"><span class="label">Pin boundary gate</span><span class="value">ON &middot; extends past pin</span></div>'
    : '';
  return `<div class="course-info-card">
    <div class="course-info-title">Course</div>
    <div class="course-info-row zoomable" data-marks="pin,committeeStart"><span class="label">Start line</span><span class="value">${Math.round(startLineM)} m &middot; ${Math.round(startLineBearing)}&deg; ${compassDir(startLineBearing)}</span></div>
    <div class="course-info-row zoomable" data-marks="committeeFinish,finish"><span class="label">Finish line</span><span class="value">${Math.round(finishLineM)} m &middot; ${Math.round(finishLineBearing)}&deg; ${compassDir(finishLineBearing)}</span></div>
    ${pinBoundaryRow}
    ${headingRows}
  </div>`;
}

function renderMap(s) {
  const fix = s.lastFix;
  // receivedAt, not timestamp - see renderDashboard's own comment above.
  const fixAgeMs = fix ? Date.now() - fix.receivedAt : null;
  const fixStale = fixAgeMs == null || fixAgeMs > 10000;

  // Skipped entirely in mark mode, even with neither marks nor a fix yet -
  // that device's whole point is its own right-hand column (see
  // showMarkModeInfo below), which needs to render its own "auto-sends once
  // assigned" explanation rather than this generic placeholder swallowing
  // the page before it ever gets there.
  if (!s.currentMarks && !fix && !s.markMode) {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>boat ${s.boatId} map</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; height: 100vh; display: flex; flex-direction: column; gap: 14px; align-items: center; justify-content: center;
    background: #0f1216; color: #8b94a3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  a { color: #58a6ff; text-decoration: none; margin-left: 8px; }
  a:hover { text-decoration: underline; }
  .tabs a { margin-left: 0; }
  ${TABS_CSS}
</style>
</head>
<body><div>No course marks or GPS fix yet.</div>${renderTabs(roverTabs(false), 'map')}</body>
</html>`;
  }

  const marks = s.currentMarks;
  const markersJs = marks
    ? MARK_NAMES.map(
        (name) =>
          `L.circleMarker([${marks[name].lat}, ${marks[name].lon}], { radius: 8, color: '${markStroke(name)}', weight: 2, fillColor: '${MARK_COLORS[name]}', fillOpacity: 0.85 })
        .addTo(map)
        .bindTooltip('${name}', { permanent: true, direction: 'top', offset: [0, -8], className: 'mark-label' });`
      ).join('\n    ')
    : '';
  const linesJs = marks
    ? `
    L.polyline([[${marks.pin.lat}, ${marks.pin.lon}], [${marks.committeeStart.lat}, ${marks.committeeStart.lon}]], { color: '${MARK_COLORS.pin}', weight: 2, dashArray: '6 6' }).addTo(map);
    L.polyline([[${marks.committeeFinish.lat}, ${marks.committeeFinish.lon}], [${marks.finish.lat}, ${marks.finish.lon}]], { color: '${MARK_COLORS.finish}', weight: 2, dashArray: '6 6' }).addTo(map);
    L.polyline([[${marks.leewardBlack.lat}, ${marks.leewardBlack.lon}], [${marks.windwardBlack.lat}, ${marks.windwardBlack.lon}]], { color: '#e6e9ef', weight: 1, dashArray: '2 8' }).addTo(map);
    // On-grid detection zone - the exact quadrilateral OnGridWatcher.check
    // itself tests against (see onGridWatcher.js's zonePolygon), not a
    // separately-eyeballed approximation, so this can never show a
    // different zone than what actually gets detected as on-grid.
    L.polygon(${JSON.stringify(zonePolygon(marks, config.regattaup.onGridZoneM).map((p) => [p.lat, p.lon]))}, { color: '${MARK_COLORS.pin}', weight: 2, dashArray: '4 6', fillColor: '${MARK_COLORS.pin}', fillOpacity: 0.08 }).addTo(map);
    // Pin boundary gate - read-only here, same as adminServer.js's own copy
    // (see its comment on why this is never included in a fitBounds call).
    ${
      marks.pinBoundaryEnabled
        ? (() => {
            const far = getPinBoundaryFarPoint(marks.pin, marks.committeeStart);
            return `L.polyline([[${marks.pin.lat}, ${marks.pin.lon}], [${far.lat}, ${far.lon}]], { color: '${MARK_COLORS.pinBoundary}', weight: 2, dashArray: '6 6' }).addTo(map);`;
          })()
        : ''
    }`
    : '';
  const boatMarkerJs = fix
    ? `boatMarker = L.circleMarker([${fix.lat}, ${fix.lon}], { radius: 7, color: '#ffffff', weight: 2, fillColor: '${fixStale ? '#8b94a3' : '#3fb950'}', fillOpacity: 0.9 })
      .addTo(map)
      .bindTooltip('boat ${s.boatId}', { permanent: true, direction: 'bottom', offset: [0, 8], className: 'mark-label' });`
    : '';

  // Fallback for the initial view (see initialViewJs below) when this boat
  // has no fix of its own yet but has already received a course - marks
  // only, not combined with the boat's own position the way this used to
  // work, since a fix (when there is one) should always win on its own -
  // see initialViewJs's own comment.
  const markPoints = marks ? MARK_NAMES.map((name) => `[${marks[name].lat}, ${marks[name].lon}]`) : [];
  // The map should always come up centered on wherever THIS device
  // actually is, not a bounds-fit that also drags in every course mark,
  // which could zoom out a long way to show both. Falls back to fitting the known marks when there's no fix yet
  // (nothing of this boat's own to center on), or does nothing at all if
  // there's neither - left for refreshBoat's own first-fix centering
  // (below) to take over the moment a position actually arrives.
  const initialViewJs = fix
    ? `map.setView([${fix.lat}, ${fix.lon}], 18);`
    : markPoints.length
    ? `map.fitBounds([${markPoints.join(', ')}], { padding: [60, 60], maxZoom: 18 });`
    : '';

  // Mark mode's own right-hand column - never has Set buttons at all (see
  // markStation.js's own comment: it auto-sends, there's nothing to tap),
  // but still shows SOMETHING there rather than leaving the column just
  // absent. Always rendered .visible.
  const showMarkModeInfo = !!s.markMode;
  const markModeInfoHtml = showMarkModeInfo
    ? `<div class="edit-column visible" id="markModeColumn">
      <div class="edit-column-inner">
        <h2>Mark mode</h2>
        <div class="muted" style="font-size:12px;">No manual "Set" buttons here - this device automatically sends its own GPS position as <strong style="color:#e6e9ef;">${
          s.currentMarkName || 'its assigned mark, once one is picked'
        }</strong> whenever it drifts &ge;${config.markDistanceM}m.</div>
        ${
          fix
            ? ''
            : '<div class="muted" style="font-size:12px;margin-top:8px;">Also waiting for a GPS fix - nothing to send until this device has a position.</div>'
        }

        <div class="gps-readout"><span>Represents</span></div>
        <select class="recenter-btn" id="markModeNameSelect" style="cursor:pointer;">
          <option value="">unassigned</option>
          ${MARK_NAMES.map((name) => `<option value="${name}" ${s.currentMarkName === name ? 'selected' : ''}>${name}</option>`).join('')}
        </select>
        <button type="button" class="recenter-btn" id="markModeAssignBtn">Assign</button>
      </div>
    </div>`
    : '';
  const courseInfoHtml = marks ? buildCourseInfoHtml(marks) : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>boat ${s.boatId} map</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">
<style>
  html, body { height: 100%; margin: 0; background: #0f1216; }
  .topbar {
    position: absolute; top: 0; left: 0; right: 0; z-index: 1000;
    display: flex; align-items: center; gap: 14px;
    padding: 10px 16px;
    background: #161b22ee;
    border-bottom: 1px solid #262c36;
    color: #e6e9ef;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 13px;
  }
  .topbar h1 { font-size: 15px; margin: 0; font-weight: 600; }
  .topbar .muted { color: #8b94a3; }
  .topbar a { color: #58a6ff; text-decoration: none; }
  .topbar a:hover { text-decoration: underline; }
  .topbar .spacer { flex: 1; }
  ${TABS_CSS}
  .topbar .tabs { margin: 0; flex-wrap: nowrap; }
  .topbar .tabs a { padding: 4px 12px; font-size: 12px; white-space: nowrap; }
  .topbar h1 { white-space: nowrap; }
  .refresh-toggle { display: flex; align-items: center; gap: 6px; color: #8b94a3; cursor: pointer; user-select: none; }
  .refresh-toggle input { accent-color: #3fb950; cursor: pointer; }
  .mark-label {
    background: #161b22; border: 1px solid #262c36; color: #e6e9ef;
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;
    padding: 2px 6px; border-radius: 4px;
  }
  .leaflet-tooltip.mark-label::before { display: none; }

  /* Zoom control moved to the top-right (Leaflet's own default is
     top-left, set via zoomControl:false + a manual L.control.zoom below)
     - offset down past the topbar the same way .edit-column-inner already
     does (56px), so it doesn't sit underneath/behind it. */
  .leaflet-top.leaflet-right { top: 56px; }

  /* Course-info card, top-left, offset past the topbar the same way -
     deliberately a light card (not this page's usual dark chrome) so it
     reads clearly over satellite imagery of any brightness, the same
     reasoning real paper course cards on a committee boat use a plain
     white background regardless of the water/sky behind them. */
  .course-info-card {
    position: absolute; top: 66px; left: 16px; z-index: 800;
    background: #ffffff; color: #1b2430;
    border-radius: 14px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
    padding: 14px 18px; min-width: 230px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  .course-info-title { font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 8px; }
  .course-info-row { display: flex; justify-content: space-between; align-items: baseline; gap: 18px; padding: 4px 0; font-size: 13px; }
  .course-info-row .label { color: #8a94a3; }
  .course-info-row .value { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  /* Rows with a data-marks attribute (see buildCourseInfoHtml) zoom the map
     to that mark/line on click - same as adminServer.js's own copy. */
  .course-info-row.zoomable { cursor: pointer; border-radius: 6px; margin: 0 -6px; padding: 4px 6px; }
  .course-info-row.zoomable:hover { background: #f1f3f6; }

  /* A map area that shrinks for mark mode's right-hand column. */
  .main { position: absolute; inset: 0; display: flex; }
  .map-wrap { position: relative; flex: 1; min-width: 0; }
  #map { position: absolute; inset: 0; }
  .edit-column {
    width: 0; flex-shrink: 0; overflow: hidden;
    background: #161b22; border-left: 1px solid #262c36;
    transition: width 0.15s ease;
  }
  .edit-column.visible { width: 240px; }
  .edit-column-inner {
    width: 240px; box-sizing: border-box; height: 100%; overflow-y: auto;
    padding: 56px 14px 14px;
    color: #e6e9ef;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  .edit-column h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #8b94a3; margin: 0 0 10px; }
  .recenter-btn {
    display: block; width: 100%; margin-bottom: 14px;
    padding: 8px 10px; border-radius: 6px; border: 1px solid #262c36;
    background: #1c222b; color: #e6e9ef; font-size: 12px; cursor: pointer;
  }
  .recenter-btn:hover { background: #262c36; }
  .gps-readout { display: flex; justify-content: space-between; align-items: baseline; font-size: 11px; color: #8b94a3; margin: 2px 0 6px; gap: 6px; }
  .gps-readout .value { color: #e6e9ef; font-variant-numeric: tabular-nums; text-align: right; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
</style>
</head>
<body>
  <div class="topbar">
    <h1>Boat ${s.boatId} map${s.markMode ? ` &middot; <span style="color:#e3b341;">MARK MODE${s.currentMarkName ? ' (' + s.currentMarkName + ')' : ''}</span>` : ''}</h1>
    <span class="muted">Regatta: ${s.currentRegattaName || 'not set'}</span>
    <span class="muted" id="fixStatus">${fix ? `last fix ${fixStale ? 'stale, ' : ''}${formatAgo(fix.timestamp)}` : 'no GPS fix yet'}</span>
    ${renderTabs(roverTabs(true), 'map')}
    <div class="spacer"></div>
    <label class="refresh-toggle">
      <input type="checkbox" id="autoRefresh">
      auto-refresh (5s)
    </label>
  </div>
  <div class="main">
    <div class="map-wrap">
      <div id="map"></div>
      ${courseInfoHtml}
    </div>
    ${markModeInfoHtml}
  </div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
  <script>
    // zoomControl:false + a manual L.control.zoom below (positioned
    // top-right, see .leaflet-top.leaflet-right above) instead of Leaflet's
    // own default top-left control, which sits under the topbar/course-info
    // card. maxZoom:22 matches RegattaUp's own map, well past the imagery's
    // own native resolution (maxNativeZoom below) - Leaflet upscales the
    // last real tile level for anything past that rather than showing
    // nothing, so zooming that far in still shows *something*, just soft,
    // instead of hitting a hard ceiling.
    const map = L.map('map', { zoomControl: false, maxZoom: 22 });
    L.control.zoom({ position: 'topright' }).addTo(map);
    let boatMarker = null;

    // Course-info card rows (see buildCourseInfoHtml's own comment on
    // data-marks) zoom the map to the mark(s) they're describing on click -
    // same as adminServer.js's own copy. courseMarks is null when no course
    // is published yet, in which case there are no .zoomable rows to wire up.
    const courseMarks = ${marks ? JSON.stringify(marks) : 'null'};
    const COURSE_INFO_ZOOM = 19;
    document.querySelectorAll('.course-info-row.zoomable').forEach((row) => {
      const names = row.dataset.marks.split(',');
      row.addEventListener('click', () => {
        if (names.length === 1) {
          const m = courseMarks[names[0]];
          map.setView([m.lat, m.lon], Math.max(map.getZoom(), COURSE_INFO_ZOOM));
        } else {
          const points = names.map((name) => [courseMarks[name].lat, courseMarks[name].lon]);
          map.fitBounds(points, { padding: [80, 80], maxZoom: COURSE_INFO_ZOOM });
        }
      });
    });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 22,
      maxNativeZoom: 19,
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
    }).addTo(map);

    ${markersJs}
    ${linesJs}
    ${boatMarkerJs}

    ${initialViewJs}

    // Moves the boat's own marker (and creates it, if this page loaded
    // before the first fix came in) rather than reloading the page, so
    // pan/zoom isn't thrown away every few seconds. Course marks aren't
    // re-fetched here since they don't move mid-race. Hits /api/position,
    // NOT /api/stats - the latter also calls countPending's
    // fs.readdirSync over the log directory, which this loop has no use
    // for (see boatAgent.js's getPosition).
    async function refreshBoat() {
      let pos;
      try {
        pos = await (await fetch('/api/position')).json();
      } catch (err) {
        return; // boat unreachable for a moment - just try again next tick
      }
      const fixStatusEl = document.getElementById('fixStatus');
      if (!pos) {
        fixStatusEl.textContent = 'no GPS fix yet';
        return;
      }
      const ageMs = Date.now() - pos.receivedAt;
      const stale = ageMs > 10000;
      const ageS = Math.floor(ageMs / 1000);
      const ageText = ageS < 5 ? 'just now' : ageS + 's ago';
      fixStatusEl.textContent = 'last fix ' + (stale ? 'stale, ' : '') + ageText;
      const fillColor = stale ? '#8b94a3' : '#3fb950';
      if (boatMarker) {
        boatMarker.setLatLng([pos.lat, pos.lon]);
        boatMarker.setStyle({ fillColor });
      } else {
        boatMarker = L.circleMarker([pos.lat, pos.lon], { radius: 7, color: '#ffffff', weight: 2, fillColor, fillOpacity: 0.9 })
          .addTo(map)
          .bindTooltip('boat ${s.boatId}', { permanent: true, direction: 'bottom', offset: [0, 8], className: 'mark-label' });
        // This is the FIRST fix this page has ever seen (server-rendered
        // load had none - see initialViewJs's own comment on why it
        // couldn't center on one yet) - center on it now, once. Every
        // later update above only moves the existing marker, never the
        // view, so pan/zoom the operator's already done isn't thrown away.
        map.setView([pos.lat, pos.lon], 18);
      }
    }

    (function () {
      const KEY = 'raceTrackerMapAutoRefresh';
      const checkbox = document.getElementById('autoRefresh');
      checkbox.checked = localStorage.getItem(KEY) !== '0'; // on by default
      let timer = null;
      function reschedule() {
        if (timer) clearInterval(timer);
        timer = checkbox.checked ? setInterval(refreshBoat, 5000) : null;
      }
      checkbox.addEventListener('change', () => {
        localStorage.setItem(KEY, checkbox.checked ? '1' : '0');
        reschedule();
      });
      reschedule();
    })();

    // Mark mode's own assign control (see renderMap's markModeInfoHtml) -
    // markModeAssignBtn only exists when showMarkModeInfo rendered it, so
    // this script works unmodified on every other page variant too.
    const markModeAssignBtn = document.getElementById('markModeAssignBtn');
    if (markModeAssignBtn) {
      markModeAssignBtn.addEventListener('click', async () => {
        markModeAssignBtn.disabled = true;
        try {
          const markName = document.getElementById('markModeNameSelect').value || null;
          const res = await fetch('/api/mark-name', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ markName }),
          });
          const body = await res.json();
          if (!res.ok || !body.ok) throw new Error(body.error || ('HTTP ' + res.status));
          location.reload();
        } catch (err) {
          alert('Failed to assign: ' + err.message);
          markModeAssignBtn.disabled = false;
        }
      });
    }

  </script>
</body>
</html>`;
}

// Parses a POST body as JSON - duplicated from adminServer.js's own
// readJsonBody rather than imported, same "small enough to just duplicate"
// reasoning as this file's other standalone helpers.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10000) req.destroy(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Serves the boat's own admin dashboard - same idea as adminServer.js on
// the base, but scoped to this one boat's own state (GPS, radio, course,
// upload activity) rather than a whole fleet. Runs on the same ADMIN_PORT
// by default so the base's dashboard can link to it (see
// stats.recordBoatIp / adminServer.js's statsLink). getPosition is a
// separate, lean callback (see boatAgent.js) - the map page's own
// live-refresh loop (renderMap above) polls GET /api/position instead of
// /api/stats specifically so watching the map doesn't cost a
// fs.readdirSync of the log directory (via countPending) every 5s for
// data it doesn't use.
function startRoverAdminServer({ port, getStats, getPosition, getPowerStatus, getWittyStatus, getShutdownFromBase, setMarkName, sendMarkLog }) {
  const server = http.createServer(async (req, res) => {
    // Dashboard's "Mark log" card (see renderDashboard) - sends a short
    // free-text note to the base over the radio (see boatAgent.js's
    // sendMarkLog/protocol.js's encodeMarkLog), no GPS fix or WiFi needed
    // at all. Available on every rover mode (plain boat, mark), not just
    // mark mode - field testing (walking to a
    // new distance, checking an antenna) is just as relevant to an
    // ordinary boat as to either of those.
    if (req.url === '/api/mark-log' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        sendMarkLog(body.label || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // markMode's own dashboard control (see renderDashboard's mark-name
    // select) - assigns (or clears, markName: null) which mark this device
    // continuously represents (see boatAgent.js's setMarkName/handlePvt's
    // own markMode block). This doesn't touch
    // the radio at all - it just changes what the NEXT auto-send, if any,
    // will use.
    if (req.url === '/api/mark-name' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const result = setMarkName(body.markName || null);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, markName: result }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(404);
      res.end();
      return;
    }

    if (req.url === '/api/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getStats()));
      return;
    }

    if (req.url === '/api/position') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getPosition()));
      return;
    }

    if (req.url === '/' || req.url === '') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderDashboard(getStats(), getPowerStatus(), getWittyStatus ? getWittyStatus() : null, getShutdownFromBase ? getShutdownFromBase() : null));
      return;
    }

    if (req.url === '/map') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderMap(getStats()));
      return;
    }

    if (req.url === '/config') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      const st = getStats();
      res.end(renderConfigPage({ role: 'boat', navHtml: renderTabs(roverTabs(!!(st.currentMarks || st.lastFix)), 'config'), navCss: TABS_CSS }));
      return;
    }

    // Last logBuffer.MAX_LINES (100) lines of this boat's own console
    // output - works the same whether this is an interactive `npm run
    // boat` session or a systemd service (where stdout goes straight to
    // the journal, not something this app could otherwise re-read itself -
    // see logBuffer's own comment).
    if (req.url === '/console') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      const st = getStats();
      res.end(renderConsoleLogPage(`boat ${st.boatId} console`, { navHtml: renderTabs(roverTabs(!!(st.currentMarks || st.lastFix)), 'console'), navCss: TABS_CSS }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.on('error', (err) => console.error('[roverAdminServer] error:', err.message));
  // The "dashboard at http://..." announcement itself is logged by
  // boatAgent.js, as early as possible in its own startup - well before
  // this function even runs - so an operator sees it before everything
  // else this process logs during GPS/radio/upload setup, not after.
  server.listen(port);

  return server;
}

module.exports = { startRoverAdminServer, renderDashboard, renderMap };
