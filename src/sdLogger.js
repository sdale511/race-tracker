const fs = require('fs');
const path = require('path');
const { pruneOldLogs } = require('./logRotation');

// Appends every GPS fix to a CSV on the microSD card, independent of what
// gets transmitted over radio. This is the durable record: if the radio
// link drops for a while, you still have the full track on the Pi.
class SdLogger {
  constructor({ logDir, boatId, retentionDays = 7 }) {
    this.logDir = logDir;
    fs.mkdirSync(logDir, { recursive: true });

    // Each session already gets its own file (sessionStamp below), so
    // pruning by age just deletes whole old-session files - no need to
    // touch the one currently being written.
    pruneOldLogs(logDir, /^boat\d+_.*\.csv$/, retentionDays);

    const sessionStamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.filePath = path.join(logDir, `boat${boatId}_${sessionStamp}.csv`);
    fs.writeFileSync(
      this.filePath,
      'timestamp_iso,lat,lon,height_m,speed_kn,heading_deg,fix_type,diff_soln,carr_soln,num_sv,h_acc_m\n'
    );
  }

  logPvt(pvt) {
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
    fs.appendFile(this.filePath, line + '\n', (err) => {
      if (err) console.error('[sdLogger] write failed:', err.message);
    });
  }
}

module.exports = { SdLogger };
