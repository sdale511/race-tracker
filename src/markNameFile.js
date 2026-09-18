const fs = require('fs');
const path = require('path');

// Path this device's own assigned mark name is read from/written to -
// deliberately race-config/, not config.logDir (which can be redirected to
// an SD card mount via LOG_DIR - see config.js), same reasoning as
// boatIdFile.js/regattaIdFile.js's own path: this is an identity that
// should survive independently of wherever logs happen to be pointed this
// run. A rover physically attached to a course mark (see README's "Mark
// mode") remembers which mark it is across restarts the same way a boat
// remembers its own BOAT_ID.
const configDir = path.join(__dirname, '..', 'race-config');
fs.mkdirSync(configDir, { recursive: true });
const markNameFilePath = path.join(configDir, 'mark-name.txt');

// Whichever mark name was last persisted here, or null if this device has
// never had one assigned (a fresh checkout, plain base/markset never used
// for mark-tracking, or MARK_NAME has simply never been set) - never
// throws, same "missing means null, not an error" contract as
// getPersistedRegattaId. Not validated against MARK_NAMES here - course.js
// isn't a dependency of this module, and the caller (config.js) already
// validates against it, so an invalid leftover value fails loudly there
// with a clear error instead of this file silently reinterpreting it.
function getPersistedMarkName() {
  try {
    const raw = fs.readFileSync(markNameFilePath, 'utf8').trim();
    return raw || null;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[markNameFile] failed to read persisted mark name:', err.message);
    return null;
  }
}

// Called both from config.js (when MARK_NAME is set on the command line -
// see resolveMarkName) and from baseStation.js's setMarkAssignment
// (whenever an operator assigns/reassigns this device from the map's own
// dropdown) - either path updates the same file, so whichever one was used
// most recently is what the next restart defaults to. Not fatal on
// failure - this device just won't remember its assignment across a
// restart, same degraded-but-not-broken contract as boatIdFile.js/
// regattaIdFile.js's own persist steps.
function persistMarkName(name) {
  try {
    fs.writeFileSync(markNameFilePath, name);
  } catch (err) {
    console.error('[markNameFile] failed to persist mark name:', err.message);
  }
}

// Removes the persisted assignment entirely - called when an operator
// explicitly unassigns this device (back to "not representing any mark")
// from the map's dropdown, so a later restart doesn't silently re-apply an
// assignment that was deliberately cleared. Not fatal on failure, same as
// persistMarkName above.
function clearPersistedMarkName() {
  try {
    fs.unlinkSync(markNameFilePath);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[markNameFile] failed to clear persisted mark name:', err.message);
  }
}

module.exports = { getPersistedMarkName, persistMarkName, clearPersistedMarkName, markNameFilePath };
