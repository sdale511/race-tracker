const fs = require('fs');
const path = require('path');

// Path this boat's own scheduled-shutdown settings are read from/written to
// - race-config/, same reasoning as regattaIdFile.js/boatIdFile.js: an
// operator preference that should survive independently of wherever
// LOG_DIR happens to be pointed this run, and independently of whatever
// systemd unit/.env originally set ROVER_SHUTDOWN_AT (an operator using the
// rover dashboard's own power card to nudge a shutdown time shouldn't have
// to go hand-edit that instead).
const configDir = path.join(__dirname, '..', 'race-config');
fs.mkdirSync(configDir, { recursive: true });
const scheduleFilePath = path.join(configDir, 'power-schedule.txt');

// Whatever schedule was last persisted here, or null if this boat has never
// had one set (a fresh checkout, or ROVER_SHUTDOWN_AT/the dashboard have
// simply never been used) - never throws, same "missing means null, not an
// error" contract as regattaIdFile.js's getPersistedRegattaId.
function getPersistedPowerSchedule() {
  try {
    const raw = fs.readFileSync(scheduleFilePath, 'utf8').trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[powerScheduleFile] failed to read persisted power schedule:', err.message);
    return null;
  }
}

// Called both from config.js (resolveDefaultPowerSchedule, on every
// startup - see its own comment) and from powerSchedule.js's updateParams
// (whenever the rover dashboard's power card changes something live) -
// either path writes the same file, so whichever ran most recently is what
// the next restart defaults to. Not fatal on failure - this boat just won't
// remember its schedule across a restart, same degraded-but-not-broken
// contract as regattaIdFile.js's persistRegattaId.
function persistPowerSchedule(schedule) {
  try {
    fs.writeFileSync(scheduleFilePath, JSON.stringify(schedule));
  } catch (err) {
    console.error('[powerScheduleFile] failed to persist power schedule:', err.message);
  }
}

module.exports = { getPersistedPowerSchedule, persistPowerSchedule, scheduleFilePath };
