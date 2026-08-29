const fs = require('fs');
const path = require('path');
const { pruneOldLogs } = require('./logRotation');

// Rounds `timestamp` down to the start of its chunkMinutes-wide bucket and
// formats that as a filename-safe string ("YYYY-MM-DDTHH-MM") - shared with
// uploadClient.js so both always agree on exactly where a chunk boundary
// falls.
//
// Anchored to the top of each hour (:00, not epoch), so chunk boundaries
// land on the expected round numbers (10 -> :00/:10/:20.../:50) rather than
// wherever a chunk happens to fall relative to 1970. For a chunk size that
// doesn't evenly divide 60 (e.g. 7), this deliberately makes the last chunk
// of each hour shorter than the rest rather than letting a chunk span
// across the hour boundary - every hour restarts the count at :00.
function chunkBucket(timestamp, chunkMinutes) {
  const date = new Date(timestamp);
  const bucketMinute = Math.floor(date.getUTCMinutes() / chunkMinutes) * chunkMinutes;
  const bucketStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), bucketMinute);
  return new Date(bucketStart).toISOString().slice(0, 16).replace(':', '-');
}

function chunkFilename(boatId, timestamp, chunkMinutes) {
  return `boat${boatId}_${chunkBucket(timestamp, chunkMinutes)}.csv`;
}

// Appends every GPS fix to a chunked CSV on the microSD card, independent
// of what gets transmitted over radio - this is the durable record: if the
// radio link drops for a while, you still have the full track on the Pi.
// Chunked (not one huge session file) specifically so uploadClient.js can
// push complete, upload-sized pieces to the base over WiFi as they finish,
// rather than one large file that's only ever "done" when the boat is.
//
// One file per boat per chunk (boat<id>_<YYYY-MM-DDTHH-MM>.csv, chunk
// boundary set by LOG_CHUNK_MINUTES), grouped by each fix's own GPS
// timestamp, not wall-clock write time - a fix taken a moment before a
// chunk boundary still lands in that earlier chunk's file even if it's
// logged a moment after. A restarted process resumes appending to the
// current chunk's file instead of starting a new one, since the file is
// keyed by chunk, not by session.
class SdLogger {
  constructor({ logDir, boatId, retentionDays = 7, chunkMinutes = 60 }) {
    this.logDir = logDir;
    this.boatId = boatId;
    this.chunkMinutes = chunkMinutes;
    this.retentionDays = retentionDays;
    this.currentChunk = null;
    this.filePath = null;
    fs.mkdirSync(logDir, { recursive: true });
    // Alphanumeric, not \d+ - BOAT_ID is a fixed-width alphanumeric string
    // now (see boatIdFile.js), not guaranteed numeric.
    pruneOldLogs(logDir, /^boat[A-Za-z0-9]+_.*\.csv$/, retentionDays);
  }

  // Only touches the filesystem (existsSync/writeFileSync/pruneOldLogs)
  // when the chunk bucket actually changes, not on every fix - GPS fixes
  // can arrive at up to 10Hz, and re-stat-ing the same file on every single
  // one would be wasteful SD card I/O for no benefit. Pruning here (not
  // just once in the constructor above) matters for how this actually
  // runs in production: under systemd's Restart=always (see
  // install-boat-service.sh), this process is meant to stay up for a whole
  // season, not just one run - without a prune on every chunk rollover,
  // old CSVs past retentionDays would only ever get cleaned up on a crash/
  // restart, silently defeating LOG_RETENTION_DAYS for as long as the
  // service keeps running cleanly.
  _fileFor(timestamp) {
    const chunk = chunkBucket(timestamp, this.chunkMinutes);
    if (chunk === this.currentChunk) return this.filePath;

    this.currentChunk = chunk;
    this.filePath = path.join(this.logDir, chunkFilename(this.boatId, timestamp, this.chunkMinutes));
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(
        this.filePath,
        'timestamp_iso,lat,lon,height_m,speed_kn,heading_deg,fix_type,diff_soln,carr_soln,num_sv,h_acc_m\n'
      );
    }
    // Every chunk rollover, not just when this particular chunk's file
    // happens to be new - a resumed-after-restart process re-entering an
    // already-existing chunk should still get the periodic prune below.
    // Alphanumeric, not \d+ - see the constructor's own comment on this
    // exact pattern.
    pruneOldLogs(this.logDir, /^boat[A-Za-z0-9]+_.*\.csv$/, this.retentionDays);
    return this.filePath;
  }

  logPvt(pvt) {
    const filePath = this._fileFor(pvt.timestamp);
    const speedKn = (pvt.gSpeedMmS / 1000) * 1.94384;
    const line = [
      new Date(pvt.timestamp).toISOString(),
      pvt.lat.toFixed(7),
      pvt.lon.toFixed(7),
      (pvt.heightMm / 1000).toFixed(2),
      speedKn.toFixed(2),
      pvt.headMotDeg.toFixed(1),
      pvt.fixType,
      pvt.diffSoln,
      pvt.carrSoln,
      pvt.numSV,
      (pvt.hAccMm / 1000).toFixed(2),
    ].join(',');
    fs.appendFile(filePath, line + '\n', (err) => {
      if (err) console.error('[sdLogger] write failed:', err.message);
    });
  }
}

module.exports = { SdLogger, chunkBucket, chunkFilename };
