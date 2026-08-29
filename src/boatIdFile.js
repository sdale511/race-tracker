const fs = require('fs');
const path = require('path');
const { customAlphabet } = require('nanoid');
const { BOAT_ID_LEN } = require('./protocol');

// Uppercase letters and digits, no lowercase/symbols - the wire protocol's
// boatId field (protocol.js's BOAT_ID_LEN, imported above as the single
// source of truth for the length so the two files can't quietly drift
// apart) is a fixed-width slot of raw ASCII bytes, so any generated id has
// to be exactly that many characters, always drawn from this alphabet, or
// it won't fit the frame encode() expects.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ID_LENGTH = BOAT_ID_LEN;
const generate = customAlphabet(ALPHABET, ID_LENGTH);

// Length chosen for "as short as possible while still statistically
// unique," not "guaranteed unique" - there's no coordination between
// independently-booting devices to check against (see this file's own
// getOrCreatePersistentBoatId). 36^5 = ~60.5M possible ids; at a fleet of
// 100 devices the birthday-paradox collision odds are ~0.00008% - which
// is what actually matters for something that silently misidentifies a
// boat's reported position, not just a cosmetic annoyance. Explicit
// BOAT_ID (config.js, or fleetSim.js for every boat it spawns) always
// overrides this anyway, so this fallback's odds only matter for
// independently-run, entirely unconfigured devices.
function generateBoatId() {
  return generate();
}

// Fixed-width, zero-padded decimal text (1 -> "00001", 2 -> "00002", ...) -
// a purely sequential alternative to the random generateBoatId above, for
// fleetSim.js specifically: it assigns every id in a single fleet itself,
// so it can just count instead of drawing randomly, and a plain number is
// far easier to tell apart at a glance in a console full of interleaved
// per-boat log lines than random letters would be. Not used for
// getOrCreatePersistentBoatId above - independently-booting standalone
// devices have no shared counter to coordinate through, which is exactly
// why that one has to draw randomly instead (see its own comment). The
// wire protocol's boatId field (see protocol.js) is just a fixed-width
// text slot - nothing about it actually requires letters, that's only
// this file's own ALPHABET choice for the random case.
function sequentialBoatId(n) {
  return String(n).padStart(ID_LENGTH, '0');
}

// Path this device's own generated id is read from/written to - deliberately
// the repo root, not config.logDir (which can be redirected to an SD card
// mount via LOG_DIR - see config.js), since this identity should survive
// independently of wherever logs happen to be pointed this run.
const idFilePath = path.join(__dirname, '..', 'boat_id.txt');

// Generates (once) and thereafter reuses a persistent BOAT_ID for this
// physical device - see config.js's own boatId resolution. Only consulted
// when BOAT_ID isn't set at all in the environment - an explicit BOAT_ID
// (set by hand, or by fleetSim.js for every boat it spawns) always wins
// outright over this, never merged with it. Exists so a standalone
// `npm run boat` with no BOAT_ID set doesn't default to the same hardcoded
// value on every device - today's behavior before this existed (every
// unconfigured boat defaulting to the same id) guaranteed a collision the
// moment a second one showed up. Each physical unit instead claims its own
// random id the first time it ever runs unconfigured, persists it to disk,
// and keeps using that exact same id on every later run.
function getOrCreatePersistentBoatId() {
  try {
    const existing = fs.readFileSync(idFilePath, 'utf8').trim();
    if (new RegExp(`^[${ALPHABET}]{${ID_LENGTH}}$`).test(existing)) return existing;
    console.error(`[boatIdFile] ${idFilePath} contains an invalid boat id - generating a fresh one`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[boatIdFile] failed to read persisted boat id:', err.message);
  }

  const generated = generateBoatId();
  try {
    fs.writeFileSync(idFilePath, generated);
  } catch (err) {
    // Not fatal - this device just won't remember its id across a restart,
    // same as if the file had never been written at all (a fresh id gets
    // generated again next run). Worth surfacing since it usually means a
    // permissions/disk problem worth knowing about anyway.
    console.error('[boatIdFile] failed to persist generated boat id:', err.message);
  }
  return generated;
}

module.exports = { getOrCreatePersistentBoatId, generateBoatId, sequentialBoatId, ALPHABET, ID_LENGTH };
