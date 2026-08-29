const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// Persistent queue for foul webhook POSTs (see baseStation.js and
// foulWatcher.js) - same durability reasoning as lapWebhookQueue.js, see
// its module comment. Its own table AND its own file, same reasoning as
// onGridWebhookQueue.js's module comment: sql.js keeps the whole database
// in memory and overwrites its file wholesale on every save, so
// independent queue instances can't safely share one file.
class FoulWebhookQueue {
  static async create(dbPath) {
    const SQL = await initSqlJs();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const existing = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
    const db = existing ? new SQL.Database(existing) : new SQL.Database();
    const queue = new FoulWebhookQueue(db, dbPath);
    // boat_id is TEXT, not INTEGER - see lapWebhookQueue.js's own comment
    // on this exact column.
    queue.db.run(`
      CREATE TABLE IF NOT EXISTS pending_fouls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        boat_id TEXT NOT NULL,
        reason TEXT NOT NULL,
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

  // reason: which foul (e.g. 'downwind finish line'). Returns the new row's
  // id, for recordAttempt/remove to reference.
  enqueue({ boatId, reason, rtcTime, strength, receivedAt }) {
    this.db.run(
      `INSERT INTO pending_fouls (boat_id, reason, rtc_time, strength, received_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [boatId, reason, rtcTime, strength ?? null, receivedAt, Date.now()]
    );
    const [{ id }] = this._rows('SELECT last_insert_rowid() AS id');
    this._save();
    return id;
  }

  get(id) {
    const rows = this._rows('SELECT * FROM pending_fouls WHERE id = ?', [id]);
    return rows[0] || null;
  }

  // Call once RegattaUp has actually accepted the event.
  remove(id) {
    this.db.run('DELETE FROM pending_fouls WHERE id = ?', [id]);
    this._save();
  }

  // Call after every send attempt, success or failure, so dueForRetry's
  // backoff calculation has an accurate attempt count/timestamp.
  recordAttempt(id) {
    this.db.run('UPDATE pending_fouls SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ?', [Date.now(), id]);
    this._save();
  }

  // Rows whose next retry (capped exponential backoff from attempt count:
  // 2s, 4s, 8s, ... up to maxBackoffMs) is due now. A row with 0 attempts
  // is always due immediately - that only happens if the process crashed
  // between enqueue and the first send attempt.
  dueForRetry(maxBackoffMs) {
    const now = Date.now();
    return this._rows('SELECT * FROM pending_fouls').filter((row) => {
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

module.exports = { FoulWebhookQueue };
