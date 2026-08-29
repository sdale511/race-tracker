const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// Persistent queue for lap-webhook POSTs (see baseStation.js), so a webhook
// failure (RegattaUp down, network blip, base station restart mid-retry)
// never silently loses a lap - every lap crossing is durably recorded here
// BEFORE the first send attempt, and only removed once RegattaUp actually
// accepts it. A background loop in baseStation.js keeps retrying whatever's
// left with capped exponential backoff, indefinitely - a missed lap matters
// more than a wasted retry.
//
// Backed by sql.js (a WASM build of SQLite) rather than a native module
// (better-sqlite3, node:sqlite) - this needs to build cleanly on a
// Raspberry Pi with whatever Node happens to be installed there, and WASM
// sidesteps both native-compile toolchain issues and any minimum-Node-
// version requirement a built-in module would impose.
//
// sql.js keeps the whole database in memory and has no concept of writing
// to disk itself - _save() below exports it and overwrites the file after
// every mutation. Fine at this app's write volume (one row per lap
// crossing, occasionally retried) - not meant for high-throughput use.
class LapWebhookQueue {
  static async create(dbPath) {
    const SQL = await initSqlJs();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const existing = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
    const db = existing ? new SQL.Database(existing) : new SQL.Database();
    const queue = new LapWebhookQueue(db, dbPath);
    // boat_id is TEXT, not INTEGER - BOAT_ID is a fixed-width alphanumeric
    // string (see boatIdFile.js), and SQLite's INTEGER type affinity
    // silently converts a numeric-looking value like "00001" to 1,
    // dropping the leading zeros - confirmed live, not theoretical.
    queue.db.run(`
      CREATE TABLE IF NOT EXISTS pending_laps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        boat_id TEXT NOT NULL,
        lap INTEGER NOT NULL,
        rtc_time INTEGER NOT NULL,
        strength INTEGER,
        received_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER,
        created_at INTEGER NOT NULL
      )
    `);
    queue._save();
    return queue;
  }

  constructor(db, dbPath) {
    this.db = db;
    this.dbPath = dbPath;
  }

  _save() {
    fs.writeFileSync(this.dbPath, Buffer.from(this.db.export()));
  }

  _rows(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  // Returns the new row's id, for recordAttempt/remove to reference.
  enqueue({ boatId, lap, rtcTime, strength, receivedAt }) {
    this.db.run(
      `INSERT INTO pending_laps (boat_id, lap, rtc_time, strength, received_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [boatId, lap, rtcTime, strength ?? null, receivedAt, Date.now()]
    );
    const [{ id }] = this._rows('SELECT last_insert_rowid() AS id');
    this._save();
    return id;
  }

  get(id) {
    const rows = this._rows('SELECT * FROM pending_laps WHERE id = ?', [id]);
    return rows[0] || null;
  }

  // Call once RegattaUp has actually accepted the lap.
  remove(id) {
    this.db.run('DELETE FROM pending_laps WHERE id = ?', [id]);
    this._save();
  }

  // Call after every send attempt, success or failure, so dueForRetry's
  // backoff calculation has an accurate attempt count/timestamp.
  recordAttempt(id) {
    this.db.run('UPDATE pending_laps SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ?', [Date.now(), id]);
    this._save();
  }

  // Rows whose next retry (capped exponential backoff from attempt count:
  // 2s, 4s, 8s, ... up to maxBackoffMs) is due now. A row with 0 attempts
  // is always due immediately - that only happens if the process crashed
  // between enqueue and the first send attempt.
  dueForRetry(maxBackoffMs) {
    const now = Date.now();
    return this._rows('SELECT * FROM pending_laps').filter((row) => {
      if (row.attempts === 0) return true;
      const backoff = Math.min(maxBackoffMs, 1000 * 2 ** row.attempts);
      return now - row.last_attempt_at >= backoff;
    });
  }

  close() {
    this._save();
    this.db.close();
  }
}

module.exports = { LapWebhookQueue };
