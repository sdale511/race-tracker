const fs = require('fs');
const path = require('path');
const { pruneOldLogs } = require('./logRotation');

// Appends every GPS fix to an hourly CSV on the microSD card, independent
// of what gets transmitted over radio - this is the durable record: if the
// radio link drops for a while, you still have the full track on the Pi.
//
// One file per boat per hour (boat<id>_<YYYY-MM-DDTHH>.csv), grouped by
// each fix's own GPS timestamp, not wall-clock write time - a fix taken a
// moment before an hour boundary still lands in that earlier hour's file
// even if it's logged a moment after. A restarted process resumes
// appending to the current hour's file instead of starting a new one,
// since the file is keyed by hour, not by session.
class SdLogger {
  constructor({ logDir, boatId, retentionDays = 7 }) {
    this.logDir = logDir;
    this.boatId = boatId;
    this.currentHour = null;
    this.filePath = null;
    fs.mkdirSync(logDir, { recursive: true });
    pruneOldLogs(logDir, /^boat\d+_.*\.csv$/, retentionDays);
  }

  // Only touches the filesystem (existsSync/writeFileSync) when the hour
  // bucket actually changes, not on every fix - GPS fixes can arrive at up
  // to 10Hz, and re-stat-ing the same file on every single one would be
  // wasteful SD card I/O for no benefit.
  _fileFor(timestamp) {
    const hour = new Date(timestamp).toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
    if (hour === this.currentHour) return this.filePath;

    this.currentHour = hour;
    this.filePath = path.join(this.logDir, `boat${this.boatId}_${hour}.csv`);
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(
        this.filePath,
        'timestamp_iso,lat,lon,height_m,speed_kn,heading_deg,fix_type,diff_soln,carr_soln,num_sv,h_acc_m\n'
      );
    }
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

module.exports = { SdLogger };
