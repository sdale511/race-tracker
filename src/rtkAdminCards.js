// The base GPS / RTK-correction-quality admin cards, plus the client-side
// JS that drives their buttons - shared between adminServer.js's full base
// dashboard and rtkAdminServer.js's RTK-only dashboard (see README's
// "RTK-only mode" section) so the two never drift out of sync on what is,
// for both of them, the exact same underlying receiver and API surface
// (see baseGps.js). Pure rendering/markup - no serial/HTTP concerns here.

function fixQualityText(f) {
  if (f.carrSoln === 2) return 'RTK fixed';
  if (f.carrSoln === 1) return 'RTK float';
  if (f.gnssFixOk) return 'GPS';
  return 'No fix';
}

// A live connected/disconnected dot for the base GPS card - it otherwise
// just shows the last values received, which stay put (correctly - this is
// a live view, not something that should guess or clear stale data) even
// after the underlying connection actually drops, so there needs to be some
// separate signal that's actually live. `connected` is a tri-state:
// true/false is an actual live/dead reading, null means "not applicable"
// (no GPS configured at all).
function connectionDot(connected) {
  if (connected == null) return null;
  return `<span class="dot ${connected ? 'dot-green' : 'dot-red'}"></span>${connected ? 'Connected' : 'Disconnected'}`;
}

// Dilution of precision - how much the current satellite geometry is
// amplifying measurement error, independent of hAcc/vAcc. Standard rough
// bands (surveying/aviation guides agree on this shape, if not the exact
// cutoffs): under 2 is about as good as GPS geometry gets, 2-5 is normal
// good-sky conditions, 5-10 means a partially obstructed view, above 10
// means treat the fix with real suspicion.
function dopQualityText(dop) {
  if (dop < 2) return 'excellent';
  if (dop < 5) return 'good';
  if (dop < 10) return 'fair';
  return 'poor';
}

// The base's own ordinary GPS fix (NAV-PVT), shown mainly as a "is the base
// GPS module even alive and locked on" sanity view - the TMODE3/survey-in
// card below is what actually matters for RTK correction quality, but this
// one exists independent of TMODE3 mode/config, so it's useful even before
// survey-in has produced anything. Null both when no GPS is configured and
// when one is configured but no fix has arrived yet, since "no GPS hardware
// attached" is the overwhelmingly common case for a plain base station.
function renderBaseGpsCard(fix, gpsPort, connected) {
  const portLine = gpsPort ? `${gpsPort.port} @ ${gpsPort.baud}` : null;
  const statusHtml = connectionDot(connected);
  if (!fix) {
    return `<div class="card">
      <div class="label">Base GPS</div>
      <div class="value">—</div>
      <div class="sub">${statusHtml ? `${statusHtml} - ` : ''}${portLine ? `${portLine} - no fix yet` : 'no base GPS (GPS_PORT not set)'}</div>
    </div>`;
  }
  const rows = [];
  // Shown first, ahead of Position - the whole point is that it's visible
  // even at a glance, not buried under a screenful of otherwise-current-
  // looking (but possibly stale) numbers.
  if (statusHtml) rows.push({ label: 'Status', title: 'Whether the base GPS serial link is actively connected right now, independent of whether the fix data below is still fresh', value: statusHtml });
  rows.push({ label: 'Position', title: "Base antenna's own reported lat/lon - NOT the surveyed/fixed reference position broadcast to rovers, see the Base GPS survey-in card below for that", value: `${fix.lat.toFixed(7)}, ${fix.lon.toFixed(7)}` });
  if (fix.hMSLMm != null) {
    const ellipsoidM = fix.heightMm != null ? ` / ${(fix.heightMm / 1000).toFixed(2)}m ellipsoid` : '';
    rows.push({ label: 'Altitude', title: 'Height above mean sea level, and ellipsoid height if reported', value: `${(fix.hMSLMm / 1000).toFixed(2)}m MSL${ellipsoidM}` });
  }
  rows.push({ label: 'Satellites', title: 'Number of satellites used in this fix', value: `${fix.numSV}` });
  if (fix.hAccMm != null) {
    const vAccPart = fix.vAccMm != null ? ` / ±${(fix.vAccMm / 1000).toFixed(2)}m vert` : '';
    rows.push({ label: 'Accuracy', title: 'Estimated 1-sigma position error, as reported by the receiver itself', value: `±${(fix.hAccMm / 1000).toFixed(2)}m horiz${vAccPart}` });
  }
  if (fix.pDOP != null)
    rows.push({
      label: 'DOP',
      title: 'Dilution of precision - how much the current satellite geometry is amplifying measurement error, independent of the Accuracy figure above',
      value: `${fix.pDOP.toFixed(2)} (${dopQualityText(fix.pDOP)})`,
    });
  if (fix.gSpeedMmS != null) {
    const speedKn = (fix.gSpeedMmS / 1000 / 1852) * 3600;
    // A stationary base reading ~0.0kn is itself a useful sanity check
    // (confirms the antenna isn't drifting/slipping), so this is shown
    // even at zero rather than only when actually moving.
    rows.push({ label: 'Speed', title: 'Ground speed - should read ~0kn for a stationary base antenna, as a sanity check', value: `${speedKn.toFixed(1)}kn` });
  }
  if (fix.utcValid) {
    const p2 = (n) => String(n).padStart(2, '0');
    rows.push({
      label: 'GPS time (UTC)',
      title: "The GPS receiver's own clock, independent of this machine's system clock",
      value: `${fix.utcYear}-${p2(fix.utcMonth)}-${p2(fix.utcDay)} ${p2(fix.utcHour)}:${p2(fix.utcMin)}:${p2(fix.utcSec)}`,
    });
  }
  if (portLine) rows.push({ label: 'Port', title: 'Serial port and baud rate this GPS module is connected on', value: portLine });
  const rowsHtml = rows
    .map((r) => `<div class="stat-row"><span class="name" title="${r.title || ''}">${r.label}</span><span class="val">${r.value}</span></div>`)
    .join('');
  return `<div class="card">
      <div class="label" title="RTK fixed (cm-level) > RTK float (dm-level) > GPS (no RTK correction) > No fix">Base GPS</div>
      <div class="value">${fixQualityText(fix)}</div>
      <div class="stat-rows">${rowsHtml}</div>
    </div>`;
}

// TMODE3 governs how the base's own RTK receiver establishes ITS fixed
// reference position before it's trustworthy to broadcast RTCM corrections
// from. survey (see baseGps.js's getSurveyStatus) is null both when no base
// GPS is attached at all and when one is attached but hasn't answered a
// poll yet - this card just reads "unavailable" for either rather than
// needing a separate "not configured" signal plumbed through.
function renderBaseGpsSurveyCard(survey, fix) {
  // NAV-SVIN streams on its own once enabled, independent of the TMODE3
  // poll cycle (see baseGps.js's open) - a fresh connection can easily have
  // real survey-in progress before that poll's first response lands, so
  // mode alone being unknown doesn't mean there's nothing to show. Only the
  // true "nothing at all yet" case (neither mode nor any survey/fixed-
  // position data) falls through to the placeholder below.
  if (!survey || (survey.mode == null && !survey.survey && !survey.fixedPosition)) {
    return `<div class="card">
      <div class="label">Base GPS survey-in</div>
      <div class="value">—</div>
      <div class="sub">no base GPS, or not polled yet</div>
    </div>`;
  }
  const modeLabel = { disabled: 'Disabled', 'survey-in': 'Survey-in', fixed: 'Fixed' }[survey.modeText] || 'Unknown';
  // Built as {label, value} pairs and rendered one per row below, rather
  // than crammed onto one comma-separated line - status/time/accuracy are
  // different-shaped numbers (a clock, a distance, a count) that scan much
  // faster stacked than run together.
  const rows = [];
  if (survey.modeText === 'fixed' && survey.fixedPosition) {
    // The position TMODE3 is actually fixed to right now (see
    // ubxParser.js's _decodeTmode3 parsing the poll response's own position
    // fields) - shown instead of the survey-in rows below even if a
    // completed survey exists, since once mode has actually moved to
    // "fixed" that leftover NAV-SVIN result is stale (and stops updating -
    // the receiver only streams it in survey-in mode), while this reflects
    // whatever's live right now, however it got set.
    const fp = survey.fixedPosition;
    rows.push({ label: 'Status', value: 'Fixed position' });
    if (fp.fixedPosAccMm != null) rows.push({ label: 'Accuracy', value: `±${(fp.fixedPosAccMm / 1000).toFixed(2)}m` });
    rows.push({ label: 'Position', value: `${fp.lat.toFixed(7)}, ${fp.lon.toFixed(7)} (${fp.heightM.toFixed(2)}m)` });
  } else if (survey.survey) {
    const sv = survey.survey;
    const accM = (sv.meanAccMm / 1000).toFixed(2);
    // Survey-in finishes once BOTH conditions clear, whichever takes
    // longer - a duration well past the minimum with accuracy nowhere near
    // the limit (long-running but still wide) reads very differently from
    // the reverse (nearly there, just needs a few more seconds), so both
    // targets are shown alongside the live numbers rather than just "in
    // progress."
    const durTarget = survey.configuredMinDurS;
    const accTargetM = survey.configuredAccLimitMm != null ? (survey.configuredAccLimitMm / 1000).toFixed(2) : null;
    if (sv.valid) {
      rows.push({ label: 'Status', value: 'Done' });
      rows.push({ label: 'Time', value: `${sv.durationS}s` });
      rows.push({ label: 'Observations', value: `${sv.observations}` });
      rows.push({ label: 'Accuracy', value: `±${accM}m` });
      rows.push({ label: 'Position', value: `${sv.lat.toFixed(7)}, ${sv.lon.toFixed(7)} (${sv.heightM.toFixed(2)}m)` });
    } else if (sv.active) {
      rows.push({ label: 'Status', value: 'In progress' });
      rows.push({ label: 'Time', value: durTarget != null ? `${sv.durationS}s / ${durTarget}s` : `${sv.durationS}s` });
      rows.push({ label: 'Observations', value: `${sv.observations}` });
      rows.push({ label: 'Accuracy', value: accTargetM != null ? `±${accM}m / ${accTargetM}m` : `±${accM}m` });
      // Still converging, not the final answer - labeled so it doesn't read
      // like the confirmed position the "done" case above shows, just
      // something to sanity-check against ("is this even in the right
      // county") long before waiting out however many hours full
      // convergence takes.
      rows.push({ label: 'Current estimate', value: `${sv.lat.toFixed(7)}, ${sv.lon.toFixed(7)} (${sv.heightM.toFixed(2)}m)` });
    } else {
      rows.push({ label: 'Status', value: 'Not active' });
    }
  } else {
    rows.push({ label: 'Status', value: 'No survey-in status received yet' });
  }
  const rowsHtml = rows
    .map((r) => `<div class="stat-row"><span class="name">${r.label}</span><span class="val">${r.value}</span></div>`)
    .join('');
  return `<div class="card">
      <div class="label">Base GPS survey-in</div>
      <div class="value">${modeLabel}</div>
      <div class="stat-rows">${rowsHtml}</div>
      <div class="card-actions">
        <button type="button" class="card-btn" onclick="setTmode3Mode('survey-in', this)">Survey-in</button>
        <button type="button" class="card-btn" onclick="setTmode3Mode('fixed', this, true)">Set and save</button>
      </div>
    </div>`;
}

// A separate, wider card (spans 2 grid columns, like a Course marks card)
// for typing in a known position - e.g. a club's own previously-surveyed
// benchmark for a permanent committee boat mooring, more trustworthy than
// anything survey-in or a live fix can produce itself. Split out from
// renderBaseGpsSurveyCard above (rather than folded into its card-actions
// row) so each input gets enough room to show a full 7-decimal lat/lon
// without truncating - three number inputs sharing a normal single-width
// card's row were too cramped for that.
function renderManualFixedPositionCard(survey, fix) {
  // Starting point - whatever position is already known, best first: the
  // currently-fixed position, then survey-in's own result - a converging
  // average, even mid-survey and not yet "valid", is still a better
  // estimate than a single instantaneous fix - and only then the base's own
  // live fix, if no survey-in data exists at all. So an operator entering a
  // known-good benchmark is editing a real nearby value rather than typing
  // coordinates from scratch, while still being free to overwrite it
  // entirely.
  const prefillPos =
    survey && survey.modeText === 'fixed' && survey.fixedPosition
      ? survey.fixedPosition
      : survey && survey.survey && (survey.survey.valid || survey.survey.active)
      ? survey.survey
      : fix
      ? { lat: fix.lat, lon: fix.lon, heightM: fix.heightMm != null ? fix.heightMm / 1000 : null }
      : null;
  const prefillLat = prefillPos ? prefillPos.lat.toFixed(7) : '';
  const prefillLon = prefillPos ? prefillPos.lon.toFixed(7) : '';
  const prefillHeight = prefillPos && prefillPos.heightM != null ? prefillPos.heightM.toFixed(2) : '';
  return `<div class="card manual-fixed-card">
      <div class="label">Set base GPS to a known position</div>
      <div class="sub">e.g. a surveyed benchmark for this club/mooring - overrides survey-in or a live fix</div>
      <div class="manual-fixed-field">
        <label for="manualLat">Lat</label>
        <input type="number" step="any" class="manual-input" id="manualLat" placeholder="Lat" value="${prefillLat}">
      </div>
      <div class="manual-fixed-field">
        <label for="manualLon">Lon</label>
        <input type="number" step="any" class="manual-input" id="manualLon" placeholder="Lon" value="${prefillLon}">
      </div>
      <div class="manual-fixed-field">
        <label for="manualHeight">Height (m)</label>
        <input type="number" step="any" class="manual-input" id="manualHeight" placeholder="Height (m)" value="${prefillHeight}">
      </div>
      <div class="card-actions">
        <button type="button" class="card-btn" onclick="setManualFixedPosition(this, false)">Set exact</button>
        <button type="button" class="card-btn" onclick="setManualFixedPosition(this, true)">Set and save</button>
      </div>
    </div>`;
}

// Client-side JS driving the three cards' buttons above - identical for
// both dashboards that embed these cards (see the module comment), so it's
// a single template string interpolated into each page's own <script>
// block rather than a second hand-kept copy. Talks to the same
// /api/gps/survey/mode and /api/gps/save-config routes on whichever server
// hosts it (adminServer.js's full route table, or rtkAdminServer.js's much
// smaller one - see baseGps.js for what actually backs both).
const RTK_CLIENT_JS = `
    // Shared by setTmode3Mode/setManualFixedPosition below - POSTs the
    // save-config request right after a successful set, so "Set and save"
    // is one click instead of two. Throws (rather than alerting itself) so
    // the caller's own catch block reports it consistently with the set
    // step's own errors - "set succeeded but save failed" is a meaningfully
    // different problem from "set failed" and worth saying so explicitly,
    // not just repeating a generic "request failed".
    async function saveGpsConfigOrThrow() {
      const res = await fetch('/api/gps/save-config', { method: 'POST' });
      const result = await res.json();
      if (!result.ok) throw new Error('set succeeded but save failed: ' + (result.error || 'request failed'));
    }

    // No optimistic UI update: the page's own 5s meta-refresh picks up the
    // new mode on its own once the receiver's actually responded to the
    // poll the server sends right after the SET - reloading immediately
    // here would still show the OLD mode, since that poll response hasn't
    // arrived yet.
    async function setTmode3Mode(mode, btn, andSave) {
      const label = mode === 'fixed' ? 'lock the base GPS to a fixed position' : 'start (or restart) survey-in on the base GPS';
      const saveNote = andSave ? ' and save it so it survives a reboot' : '';
      if (!confirm('Are you sure you want to ' + label + saveNote + '? This affects RTK corrections for every boat.')) return;
      btn.disabled = true;
      try {
        const res = await fetch('/api/gps/survey/mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
        });
        const result = await res.json();
        if (!result.ok) throw new Error(result.error || 'request failed');
        if (andSave) await saveGpsConfigOrThrow();
        setTimeout(() => location.reload(), 800);
      } catch (err) {
        alert('Failed: ' + err.message);
        btn.disabled = false;
      }
    }

    // Manual-entry counterpart to setTmode3Mode('fixed', ...) above - an
    // operator-typed position (e.g. a club's own previously-surveyed
    // benchmark) instead of whatever survey-in/live-fix would otherwise
    // supply. Validated here (range checks) AND again server-side (see
    // baseGps.js's setFixed) - this is just for a fast, clear error before
    // ever sending a request; the server-side check is the one that
    // actually matters. The confirm() spells out the exact numbers about to
    // be sent, not just "are you sure", so a typo (wrong sign, transposed
    // digits) is visible one last time before it reconfigures RTK
    // corrections for every boat. andSave mirrors setTmode3Mode's own flag.
    async function setManualFixedPosition(btn, andSave) {
      const lat = parseFloat(document.getElementById('manualLat').value);
      const lon = parseFloat(document.getElementById('manualLon').value);
      const heightM = parseFloat(document.getElementById('manualHeight').value);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) return alert('Lat must be a number between -90 and 90.');
      if (!Number.isFinite(lon) || lon < -180 || lon > 180) return alert('Lon must be a number between -180 and 180.');
      if (!Number.isFinite(heightM)) return alert('Height must be a number (meters).');
      const saveNote = andSave ? ' and save it so it survives a reboot' : '';
      const confirmMsg =
        'Set the base GPS fixed position to exactly ' + lat.toFixed(7) + ', ' + lon.toFixed(7) + ' (' + heightM.toFixed(2) + 'm)' + saveNote + '?\\n\\n' +
        'This affects RTK corrections for every boat - double-check these numbers against your known position before continuing.';
      if (!confirm(confirmMsg)) return;
      btn.disabled = true;
      try {
        const res = await fetch('/api/gps/survey/mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'fixed', lat, lon, heightM }),
        });
        const result = await res.json();
        if (!result.ok) throw new Error(result.error || 'request failed');
        if (andSave) await saveGpsConfigOrThrow();
        setTimeout(() => location.reload(), 800);
      } catch (err) {
        alert('Failed: ' + err.message);
        btn.disabled = false;
      }
    }`;

// Minimal CSS these three cards (plus the page shell around them) need -
// shared so rtkAdminServer.js's much smaller page still looks/behaves
// identically to the same cards on adminServer.js's full dashboard.
// Deliberately just the classes these cards and their container actually
// use, not adminServer.js's entire stylesheet (fleet table, map, marks
// cards, ...), which the RTK-only dashboard has no elements for.
const RTK_CARD_CSS = `
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
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; flex-shrink: 0; }
  .dot-green { background: #3fb950; box-shadow: 0 0 6px #3fb95080; }
  .dot-red { background: #f85149; box-shadow: 0 0 6px #f8514980; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .card-actions { display: flex; gap: 6px; margin-top: 10px; }
  .card-btn {
    flex: 1; padding: 6px 8px; border-radius: 6px; border: 1px solid #262c36;
    background: #1c222b; color: #e6e9ef; font-size: 11px; cursor: pointer;
  }
  .card-btn:hover { background: #262c36; }
  .card-btn:disabled { opacity: 0.5; cursor: default; }
  .manual-fixed-card { grid-column: span 2; }
  .manual-fixed-field { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
  .manual-fixed-field label { flex-shrink: 0; width: 70px; font-size: 11px; color: #8b94a3; }
  .manual-input {
    flex: 1; min-width: 0; padding: 7px 10px; border-radius: 6px; border: 1px solid #262c36;
    background: #0f1216; color: #e6e9ef; font-size: 13px; font-variant-numeric: tabular-nums;
  }`;

module.exports = {
  fixQualityText,
  dopQualityText,
  connectionDot,
  renderBaseGpsCard,
  renderBaseGpsSurveyCard,
  renderManualFixedPositionCard,
  RTK_CLIENT_JS,
  RTK_CARD_CSS,
};
