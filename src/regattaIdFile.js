const fs = require('fs');
const path = require('path');

// Path this base station's own default regatta id is read from/written to -
// deliberately the repo root, not config.logDir (which can be redirected to
// an SD card mount via LOG_DIR - see config.js), same reasoning as
// boatIdFile.js's own idFilePath: this is an identity/preference that
// should survive independently of wherever logs happen to be pointed this
// run.
const idFilePath = path.join(__dirname, '..', 'regatta-id.txt');

// Whatever regatta was last persisted here, as { id, name, defaultLat,
// defaultLon }, or null if this base has never had one set (a fresh
// checkout, or REGATTAUP_REGATTA_ID has simply never been used) - never
// throws, same "missing means null, not an error" contract as getMark/
// getDiskSpace elsewhere in this app. name/defaultLat/defaultLon are
// persisted alongside the id purely for display and as a course-creation
// fallback (a startup log line, an interactive prompt's "currently: X"
// hint, resolveCourseCenter's default map center - see course.js) -
// resolving/selecting a regatta always matches by id against RegattaUp's
// own live list, never by name.
function getPersistedRegattaId() {
  try {
    const raw = fs.readFileSync(idFilePath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.id
      ? { id: parsed.id, name: parsed.name || null, defaultLat: parsed.defaultLat ?? null, defaultLon: parsed.defaultLon ?? null }
      : null;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[regattaIdFile] failed to read persisted regatta id:', err.message);
    return null;
  }
}

// Called both from config.js (when REGATTAUP_REGATTA_ID is set on the
// command line - see resolveDefaultRegattaId) and from baseStation.js's
// selectRegatta (whenever an operator picks a different regatta, from the
// admin dashboard's own dropdown or the startup terminal prompt) - either
// path updates the same file, so whichever one was used most recently is
// what the next restart defaults to. Not fatal on failure - this base just
// won't remember its default regatta across a restart, same
// degraded-but-not-broken contract as boatIdFile.js's own persist step.
// defaultLat/defaultLon (RegattaUp's own venue coordinates for this regatta
// - see getActiveRegattas' default_lat/default_lon) are optional and only
// ever known when persisted from a live regatta object (selectRegatta,
// resetRegatta.js) - the REGATTAUP_REGATTA_ID env var path has no way to
// supply them, same reasoning as name being null in that case.
function persistRegattaId(id, name, defaultLat, defaultLon) {
  try {
    fs.writeFileSync(idFilePath, JSON.stringify({ id, name: name || null, defaultLat: defaultLat ?? null, defaultLon: defaultLon ?? null }));
  } catch (err) {
    console.error('[regattaIdFile] failed to persist regatta id:', err.message);
  }
}

// Removes the persisted default entirely - called when the selected regatta
// has passed its own end_date (see baseStation.js's refreshActiveRegattas),
// so a later restart doesn't immediately re-apply a regatta that's already
// over. Not fatal on failure, same as persistRegattaId above.
function clearPersistedRegattaId() {
  try {
    fs.unlinkSync(idFilePath);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[regattaIdFile] failed to clear persisted regatta id:', err.message);
  }
}

module.exports = { getPersistedRegattaId, persistRegattaId, clearPersistedRegattaId, idFilePath };
