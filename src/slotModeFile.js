const fs = require('fs');
const path = require('path');

// The base's practice-mode switch (see slotTable.js's practice option and the dashboard's "Practice mode" button), remembered across
// restarts. Lives in race-config/ like the other things an operator sets on this machine (regatta-id.txt, slot_racing.json).
// Once the dashboard switch has been used, this file wins over the PRACTICE_MODE environment variable, which only supplies the first
// default; delete the file to go back to the variable.
const defaultPath = path.join(__dirname, '..', 'race-config', 'slot_mode.json');

// true / false as last saved, or null when it never has been (a missing or unreadable file is "never", not an error).
function getPersistedPractice(file = defaultPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed.practice === 'boolean' ? parsed.practice : null;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[slotModeFile] could not read the saved slot mode:', err.message);
    return null;
  }
}

// Not fatal on failure - the switch then simply is not remembered over a restart.
function persistPractice(practice, file = defaultPath) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ practice: !!practice }));
    return true;
  } catch (err) {
    console.error('[slotModeFile] could not save the slot mode:', err.message);
    return false;
  }
}

module.exports = { getPersistedPractice, persistPractice };
