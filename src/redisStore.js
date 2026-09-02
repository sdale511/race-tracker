const Redis = require('ioredis');
const { getMarks: computeMarks, METERS_PER_DEG_LAT, MARK_NAMES, PIN_BOUNDARY_MARK } = require('./course');

// Flat-earth approximation (same style as course.js's offsetToLatLon) - fine
// at the meter-scale distances this is used for (deciding whether a fix
// moved far enough to be worth recording), not meant for long distances.
function distanceMeters(lat1, lon1, lat2, lon2) {
  const dNorth = (lat2 - lat1) * METERS_PER_DEG_LAT;
  const dEast = (lon2 - lon1) * METERS_PER_DEG_LAT * Math.cos((lat1 * Math.PI) / 180);
  return Math.sqrt(dNorth * dNorth + dEast * dEast);
}

// Everything this app stores in Redis - course marks, the on-grid zone, the
// pin boundary flag, boat tracks, known boats, start slots - lives under
// `regattas:<regattaId>:...`, one complete, self-contained namespace per
// regatta. There is NO "which regatta is selected" key anywhere in Redis -
// that choice is entirely local to each base station process (see
// baseStation.js's own selectedRegatta variable and regattaIdFile.js's
// regatta-id.txt), and is simply assigned onto this class's own
// currentRegattaId via setCurrentRegatta below.
//
// This exists because a single Redis instance can genuinely be shared by
// multiple base stations/regattas happening at once - a Redis-stored
// selection would be one GLOBAL value every base sharing that Redis would
// fight over, exactly the collision this whole namespacing scheme exists to
// avoid for marks/tracks/boats; each base needs to be free to report for a
// completely different regatta than any other base sharing the same Redis,
// with nothing here to collide over. Selecting a regatta is effectively
// switching to a different, fully independent workspace: a regatta that's
// never been raced before starts with no marks, no known boats, nothing -
// getOrCreateMarks computes a fresh course for it exactly as if this were a
// brand new Redis, and an already-configured regatta picks up exactly where
// its own namespace left off.
//
// `none` is used as the regatta id whenever nothing is currently selected
// (see currentRegattaId below) - deliberately not blocking course
// creation/testing on having a real regatta chosen first, since SIMULATE=1
// testing without ever touching the regatta selector is a normal, common
// workflow this app needs to keep supporting.
//
// Records every decoded boat fix into Redis, indexed two ways so both
// query patterns the race committee needs are a single range read rather
// than a fan-out scan:
//
//   - `regattas:<id>:boat:<boatId>:track` - one sorted set per boat, for
//     "give me this boat's track" (optionally within a timeframe).
//   - `regattas:<id>:all:track` - one sorted set holding every boat's fixes
//     for that regatta, for "give me all boats' positions within this
//     timeframe" (e.g. replaying the whole fleet at a point in the race)
//     without knowing boat IDs up front.
//
// Both are scored by the fix's own GPS timestamp (ms since epoch) rather
// than when the base station happened to receive it, so a track reflects
// when the boat was actually there even if frames arrive slightly late or
// out of order over the radio.
//
// Stored members use short keys (see packFix/unpackFix) rather than the
// full field names - with a fleet reporting every couple seconds over a
// multi-hour race, the field names alone (`boatId`, `speedKnots`,
// `headingDeg`, `gnssFixOk`, `receivedAt`, ...) would otherwise account for
// close to half of every stored record. `timestamp` isn't stored at all -
// it's already the sorted-set score, so it's recovered via WITHSCORES on
// read instead of being duplicated in the payload. Callers still get back
// full, friendly field names from getBoatTrack/getAllTrack - the shortening
// is purely a storage-format detail.
const FIX_KEYS = { b: 'boatId', la: 'lat', lo: 'lon', s: 'speedKnots', h: 'headingDeg', f: 'gnssFixOk', c: 'carrSoln', n: 'numSV', r: 'receivedAt' };

function packFix(decoded, receivedAt) {
  return JSON.stringify({
    b: decoded.boatId,
    la: decoded.lat,
    lo: decoded.lon,
    s: decoded.speedKnots,
    h: decoded.headingDeg,
    f: decoded.gnssFixOk,
    c: decoded.carrSoln,
    n: decoded.numSV,
    r: receivedAt.getTime(),
  });
}

function unpackFix(member, timestamp) {
  const packed = JSON.parse(member);
  const fix = { timestamp };
  for (const [short, full] of Object.entries(FIX_KEYS)) fix[full] = packed[short];
  fix.receivedAt = new Date(fix.receivedAt).toISOString();
  return fix;
}

// ioredis's WITHSCORES reply is a flat [member, score, member, score, ...]
// array - pair them up and unpack each, recovering the timestamp from its
// score instead of a stored field (see module comment above).
function unpackWithScores(withScores) {
  const fixes = [];
  for (let i = 0; i < withScores.length; i += 2) {
    fixes.push(unpackFix(withScores[i], Number(withScores[i + 1])));
  }
  return fixes;
}

class RedisStore {
  // Accepts either a connection URL string (`url`) or an ioredis connection
  // options object (`connection`, e.g. {host, port, username, password,
  // tls}); `url` wins if both are given. See config.js for how these map to
  // REDIS_URL / REDIS_ENV. `minMovementM` (default 5) is the threshold
  // recordFix uses to skip writes from a boat that hasn't moved far enough
  // to be worth recording - see recordFix. `trackRetentionHours` (default
  // 48) is how long a track key lives before Redis expires it on its own -
  // see recordFix's own comment on why this is set once, not refreshed on
  // every write. `keepaliveIntervalMs` (default 60000) is how often an
  // idle-connection keepalive PING is sent - see its own comment below.
  constructor({ url, connection, minMovementM = 5, trackRetentionHours = 48, keepaliveIntervalMs = 60000 }) {
    // Fixed 3s retry backoff, matching the reconnect cadence used elsewhere
    // in this app (radioLink.js, boatAgent.js's GPS reopen) instead of
    // ioredis's default rapid-fire retry.
    const retryOpts = { lazyConnect: true, retryStrategy: () => 3000 };
    this.client = url ? new Redis(url, retryOpts) : new Redis({ ...connection, ...retryOpts });
    // Set by close() below - see the 'close' listener's own comment on why.
    this._closing = false;
    this.client.on('error', (err) => console.error('[redis] error:', err.message));
    // Brackets an outage with exactly one "lost"/"reconnected" pair, however
    // long it lasts or however many retries it takes - same rate-limited-
    // recovery idiom as _recordTrackWriteFailure/_recordTrackWriteSuccess
    // below, just for the TCP/auth connection itself rather than individual
    // writes. Without this, a transient error (e.g. the ETIMEDOUT this was
    // added for) is easy to mistake for a still-ongoing outage days later -
    // 'error' logs the failure, but ioredis's retryStrategy above quietly
    // reconnects on its own every 3s with nothing logging that it succeeded,
    // so there was no way to tell from the console alone whether (or when)
    // it actually came back. 'close' fires on every dropped connection,
    // including once per failed retry attempt during a prolonged outage -
    // connectionDownSince guards against re-logging "lost" on each of those.
    // Also fires on OUR OWN deliberate client.quit() (see close() below) -
    // this._closing skips logging that case, since nothing is actually
    // reconnecting and "lost - reconnecting" would be actively misleading
    // during a normal shutdown.
    let connectionDownSince = null;
    this.client.on('close', () => {
      if (this._closing) return;
      if (connectionDownSince == null) {
        connectionDownSince = Date.now();
        console.error('[redis] connection lost - reconnecting...');
      }
    });
    this.client.on('ready', () => {
      if (connectionDownSince != null) {
        const downSec = Math.round((Date.now() - connectionDownSince) / 1000);
        console.log(`[redis] reconnected after ${downSec}s`);
        connectionDownSince = null;
      }
    });
    this.ready = this.client.connect().catch((err) => {
      console.error('[redis] connect failed:', err.message);
    });
    // Idle-connection keepalive - without real traffic flowing, a managed
    // Redis instance (or whatever network sits between this base and it -
    // its own WiFi/cellular NAT included) silently drops the connection
    // after some idle period. Observed in production as a `read ETIMEDOUT`
    // roughly every 12-36 minutes, tracking how much real Redis traffic
    // happened to be flowing at the time - not a fixed clock, which is what
    // pointed at an idle-connection timeout somewhere in the path rather
    // than a periodic maintenance job on Redis's own side. ioredis's
    // retryStrategy above already recovers from this cleanly (~3s - see the
    // 'close'/'ready' logging above), so this doesn't fix a failure, it
    // avoids causing one: a lightweight PING often enough that neither end
    // (nor anything in between) ever sees the connection go idle long
    // enough to reap it. Errors are swallowed - a failed keepalive during a
    // real outage is already being handled by the 'error'/'close' listeners
    // above, this has nothing useful to add on top of that.
    this._keepaliveTimer = setInterval(() => {
      this.client.ping().catch(() => {});
    }, keepaliveIntervalMs);
    this.minMovementM = minMovementM;
    this.trackRetentionSeconds = Math.round(trackRetentionHours * 3600);
    // In-memory only (per boatId) - not persisted, so a restarted base
    // station just records the next fix from each boat unconditionally
    // (nothing to compare against yet), which is harmless.
    this.lastRecordedPosition = new Map();
    // Whichever regatta this base station process is currently reporting
    // for - this is what _prefix() below uses to build every key this class
    // touches, and recordFix reads it on every single fix (5-10Hz across a
    // fleet), so it can't afford any lookup per fix just to find out which
    // namespace to write into. There is deliberately no Redis-side "selected
    // regatta" key - Redis can be shared by multiple base stations at once,
    // and a single global selection key would have them fight over it, the
    // exact collision this whole namespacing scheme exists to avoid for
    // marks/tracks/boats. Set only via setCurrentRegatta() below, called by
    // baseStation.js from its own local selectedRegatta variable (itself
    // backed by regatta-id.txt - see regattaIdFile.js). null (mapped to the
    // 'none' namespace) until that has happened at least once, e.g. right
    // after a fresh process start with nothing selected yet.
    this.currentRegattaId = null;
    // Track-write health - separate from isConnected() below, which only
    // reflects the TCP/auth connection state and stays "connected" even
    // while Redis is up but refusing writes (e.g. out of memory under a
    // noeviction policy - see README's "If Redis runs out of space"). Without
    // this, a full Redis degrades completely silently: recordFix's own
    // writes fail, but nothing on the dashboard says so, since the
    // connection itself never drops. Exposed via getWriteHealth()/getStats()
    // for adminServer.js's own dashboard card.
    this.trackWriteHealthy = true;
    this.trackWriteFailureCount = 0;
    this.lastTrackWriteError = null;
    this.lastTrackWriteErrorAt = null;
    this.lastTrackWriteOkAt = null;
    // Rate-limits the "[redis] track write failed" console line - a full
    // Redis would otherwise log one of these per fix, per boat (5-10Hz
    // across a whole fleet), burying everything else in the console the
    // instant this starts happening. The first failure always logs
    // immediately (so it's not missed), then at most once per this interval
    // while it keeps failing, plus once more on recovery.
    this.WRITE_ERROR_LOG_INTERVAL_MS = 30000;
  }

  // Builds the `regattas:<id>:` namespace prefix every key in this class is
  // built from - `regattaId`, when passed explicitly, overrides
  // this.currentRegattaId for one call (used by getBoatTrack/getAllTrack,
  // where asking for a DIFFERENT regatta's history than whatever's
  // currently selected is a normal, expected use). Everything else always
  // operates on the current regatta implicitly, same as recordFix already
  // did before this namespacing covered the whole class.
  _prefix(regattaId) {
    return `regattas:${regattaId || this.currentRegattaId || 'none'}:`;
  }

  // Skips the write (SD/console/UDP logging elsewhere are unaffected,
  // this only governs what lands in Redis) unless this is the first fix
  // seen for the boat, or it's moved at least minMovementM since the last
  // fix that WAS recorded - a stopped or barely-drifting boat reporting
  // every couple seconds would otherwise write a nearly-identical fix over
  // and over for no benefit.
  //
  // Never rejects - a Redis write failure (network blip, Redis full, ...)
  // is caught, tracked (see the constructor's own comment on
  // trackWriteHealthy), and logged (rate-limited), but never thrown back at
  // the caller - matching this app's "a storage/network hiccup shouldn't
  // affect any other output" philosophy elsewhere (console/CSV/UDP logging
  // in baseStation.js's radio.on('frame', ...) handler all keep working
  // regardless of what happens here).
  async recordFix(decoded, receivedAt) {
    await this.ready;
    const last = this.lastRecordedPosition.get(decoded.boatId);
    if (last && distanceMeters(last.lat, last.lon, decoded.lat, decoded.lon) < this.minMovementM) return;

    const member = packFix(decoded, receivedAt);
    const score = decoded.timestamp;
    const prefix = this._prefix();
    const boatTrackKey = `${prefix}boat:${decoded.boatId}:track`;
    const allTrackKey = `${prefix}all:track`;
    try {
      await Promise.all([
        this.client.zadd(boatTrackKey, score, member),
        this.client.zadd(allTrackKey, score, member),
        this.client.sadd(`${prefix}boats:known`, String(decoded.boatId)),
      ]);
    } catch (err) {
      this._recordTrackWriteFailure(err);
      return;
    }
    this.lastRecordedPosition.set(decoded.boatId, { lat: decoded.lat, lon: decoded.lon });
    this._recordTrackWriteSuccess();

    // Best-effort - EXPIRE NX only actually sets a TTL the first time a
    // given key is written on a given day (a no-op every write after that,
    // see the constructor's own comment), so a track key expires roughly
    // trackRetentionHours after its OWN first fix, not trackRetentionHours
    // after whatever the most RECENT fix was - a whole day's worth of races
    // all age out together instead of the window rolling forward every time
    // any boat reports in. Failure here isn't tracked as a write failure
    // above - the actual data already landed successfully; a missing TTL
    // just means this key won't self-expire until some later write
    // succeeds in setting it, not that anything was lost.
    this.client.expire(boatTrackKey, this.trackRetentionSeconds, 'NX').catch(() => {});
    this.client.expire(allTrackKey, this.trackRetentionSeconds, 'NX').catch(() => {});
  }

  _recordTrackWriteFailure(err) {
    const now = Date.now();
    const wasHealthy = this.trackWriteHealthy;
    this.trackWriteHealthy = false;
    this.trackWriteFailureCount++;
    this.lastTrackWriteError = err.message;
    this.lastTrackWriteErrorAt = now;
    // Log immediately on the very first failure (or the first one after a
    // recovery), then at most once per WRITE_ERROR_LOG_INTERVAL_MS while it
    // keeps failing - see the constructor's own comment on why this can't
    // just log every occurrence.
    const dueToLog = wasHealthy || now - (this._lastWriteErrorLoggedAt || 0) >= this.WRITE_ERROR_LOG_INTERVAL_MS;
    if (dueToLog) {
      this._lastWriteErrorLoggedAt = now;
      console.error(
        `[redis] track write failed (${this.trackWriteFailureCount} in a row): ${err.message}` +
          (wasHealthy ? '' : ' (repeating - see the admin dashboard for status)')
      );
    }
  }

  _recordTrackWriteSuccess() {
    if (!this.trackWriteHealthy) {
      console.log(`[redis] track writes recovered after ${this.trackWriteFailureCount} failure(s)`);
    }
    this.trackWriteHealthy = true;
    this.trackWriteFailureCount = 0;
    this.lastTrackWriteOkAt = Date.now();
  }

  // For the admin dashboard - see the constructor's own comment on why this
  // is tracked separately from isConnected().
  getWriteHealth() {
    return {
      healthy: this.trackWriteHealthy,
      failureCount: this.trackWriteFailureCount,
      lastError: this.lastTrackWriteError,
      lastErrorAt: this.lastTrackWriteErrorAt,
      lastOkAt: this.lastTrackWriteOkAt,
    };
  }

  // fromMs/toMs are inclusive; omit either for an open-ended range.
  // regattaId scopes this to one regatta's own namespace (see the module
  // comment above) - pass null/omit for whatever's currently selected, not
  // "every regatta this boat's ever raced."
  async getBoatTrack(boatId, fromMs, toMs, regattaId) {
    await this.ready;
    const withScores = await this.client.zrangebyscore(
      `${this._prefix(regattaId)}boat:${boatId}:track`,
      fromMs ?? '-inf',
      toMs ?? '+inf',
      'WITHSCORES'
    );
    return unpackWithScores(withScores);
  }

  // regattaId scopes this to one regatta's own namespace (see the module
  // comment above on why this can't be one shared key across every regatta
  // ever raced) - pass null/omit for whatever's currently selected, not
  // "every regatta at once."
  async getAllTrack(fromMs, toMs, regattaId) {
    await this.ready;
    const withScores = await this.client.zrangebyscore(`${this._prefix(regattaId)}all:track`, fromMs ?? '-inf', toMs ?? '+inf', 'WITHSCORES');
    return unpackWithScores(withScores);
  }

  async knownBoatIds() {
    await this.ready;
    return this.client.smembers(`${this._prefix()}boats:known`);
  }

  // Course marks: one entry per MARK_NAMES (`regattas:<id>:mark:windwardGreen`,
  // `regattas:<id>:mark:pin`, ...), each a Redis hash with lat/lon fields -
  // so boats can be checked against where the marks actually are (e.g.
  // confirming a rounding), and so anything else (a dashboard, race
  // software, another simulator) has one shared place to look up the
  // course for the currently-selected regatta.
  async setMark(name, { lat, lon }) {
    await this.ready;
    await this.client.hset(`${this._prefix()}mark:${name}`, { lat: String(lat), lon: String(lon) });
  }

  async getMark(name) {
    await this.ready;
    const h = await this.client.hgetall(`${this._prefix()}mark:${name}`);
    if (!h || h.lat === undefined) return null;
    return { lat: parseFloat(h.lat), lon: parseFloat(h.lon) };
  }

  // Removes a single mark:* hash - unlike clearCourseMarks (bulk, for a full
  // course reset), this exists specifically for the pin boundary gate's own
  // published mark:pinBoundary entry (see course.js's PIN_BOUNDARY_MARK):
  // that one gets deleted individually whenever the operator's checkbox
  // turns the gate off, without touching any other mark.
  async deleteMark(name) {
    await this.ready;
    await this.client.del(`${this._prefix()}mark:${name}`);
  }

  async getMarks() {
    const values = await Promise.all(MARK_NAMES.map((name) => this.getMark(name)));
    return Object.fromEntries(MARK_NAMES.map((name, i) => [name, values[i]]));
  }

  async setMarks(marks) {
    await Promise.all(Object.entries(marks).map(([name, pos]) => this.setMark(name, pos)));
  }

  // Reads the course marks from Redis if all of them are already set - so
  // multiple simulators (or a restarted base station) racing the same
  // course agree on identical mark positions instead of each computing its
  // own. Otherwise computes fresh defaults from the given center point (see
  // course.js) and publishes ONLY whichever marks are actually missing -
  // not the full computed set - so a course that already has real
  // positions (hand-surveyed, or edited through the admin UI) never gets
  // silently overwritten just because MARK_NAMES later grew a new mark
  // (e.g. the committeeStart/committeeFinish split): the marks that DO
  // exist are returned exactly as they are, and only the gap gets filled
  // in. Not atomic (a get-then-set race is possible if two processes start
  // at the exact same instant), which is an acceptable tradeoff for a
  // test/simulation tool. Operates on the currently-selected regatta's own
  // namespace - a regatta that's never been raced before starts with no
  // marks at all, so this computes and publishes a brand new course for it,
  // same as a fresh Redis would have before regatta namespacing existed.
  async getOrCreateMarks(centerLat, centerLon) {
    const existing = await this.getMarks();
    const missing = MARK_NAMES.filter((name) => !existing[name]);
    if (missing.length === 0) return existing;
    const computed = computeMarks(centerLat, centerLon);
    const fillIn = Object.fromEntries(missing.map((name) => [name, computed[name]]));
    await this.setMarks(fillIn);
    return { ...existing, ...fillIn };
  }

  // Deletes the current regatta's `mark:*` keys (plus the derived on-grid
  // zone and the pin boundary gate's own flag/published endpoint, so a
  // reader mid-transition sees "no zone"/"gate off" rather than something
  // computed from marks that no longer exist), so the next getOrCreateMarks
  // call recomputes and republishes the course from scratch instead of
  // reusing whatever's already there - needed any time the course geometry
  // itself changes (e.g. SIM_COURSE_LENGTH_NM), since getOrCreateMarks
  // otherwise has no way to tell "marks exist" from "marks exist but are
  // stale". Leaves boat tracks/start slots untouched (see clearBoatData for
  // those) and never touches any OTHER regatta's own namespace.
  async clearCourseMarks() {
    await this.ready;
    const prefix = this._prefix();
    const keys = [
      ...MARK_NAMES.map((name) => `${prefix}mark:${name}`),
      `${prefix}mark:${PIN_BOUNDARY_MARK}`,
      `${prefix}course:pin_boundary_enabled`,
      `${prefix}course:on_grid_zone`,
    ];
    const existingKeys = [];
    for (const key of keys) {
      if (await this.client.exists(key)) existingKeys.push(key);
    }
    if (existingKeys.length > 0) await this.client.del(...existingKeys);
    return existingKeys;
  }

  // Whether the pin boundary gate (see course.js's own comment on
  // PIN_BOUNDARY_MARK/getPinBoundaryFarPoint) is currently on, for the
  // currently-selected regatta - the actual source of truth for the gate; a
  // plain on/off flag rather than a hash, since there's no position of its
  // own to store here (the gate's endpoint is always derived fresh from
  // pin/committeeStart, never independently edited - see baseStation.js's
  // setPinBoundaryEnabled).
  async setPinBoundaryEnabled(enabled) {
    await this.ready;
    const key = `${this._prefix()}course:pin_boundary_enabled`;
    if (enabled) await this.client.set(key, '1');
    else await this.client.del(key);
  }

  async getPinBoundaryEnabled() {
    await this.ready;
    return !!(await this.client.get(`${this._prefix()}course:pin_boundary_enabled`));
  }

  // The on-grid detection zone's own boundary, for the currently-selected
  // regatta - the exact quadrilateral OnGridWatcher.check tests against
  // (see onGridWatcher.js's zonePolygon), published so anything outside
  // this process (RegattaUp, another dashboard, a course-review tool) can
  // draw or reason about the same zone without re-deriving the geometry
  // itself and risking it drift out of sync with what actually gets
  // detected. A single JSON-array key, not a hash per point like mark:* -
  // this is one ordered polygon, not named fields.
  async setOnGridZone(polygon) {
    await this.ready;
    await this.client.set(`${this._prefix()}course:on_grid_zone`, JSON.stringify(polygon));
  }

  async getOnGridZone() {
    await this.ready;
    const raw = await this.client.get(`${this._prefix()}course:on_grid_zone`);
    return raw ? JSON.parse(raw) : null;
  }

  // Assigns each boat a 0-based start-line slot by registration order (the
  // first boat to ask gets slot 0, the next gets slot 1, etc.) - NOT derived
  // from the boat's own ID/sail number, which could be any value (51, 52,
  // ...) and isn't a small sequential count, so using it directly would
  // place boats however far off the line their ID happens to imply. The
  // mapping is persisted (a hash of boatId -> slot, scoped to the currently
  // selected regatta) so a boat that reconnects gets the same slot back
  // rather than a new one. The increment + HSETNX pair makes this safe if
  // two boats register at the same instant: whichever loses the HSETNX race
  // re-reads the slot the winner actually got, rather than both ending up
  // on the same slot.
  async getOrAssignStartSlot(boatId) {
    await this.ready;
    const prefix = this._prefix();
    const slotsKey = `${prefix}boats:start_slots`;
    const key = String(boatId);
    const existing = await this.client.hget(slotsKey, key);
    if (existing !== null) return parseInt(existing, 10);
    const slot = (await this.client.incr(`${prefix}boats:start_slot_counter`)) - 1;
    const added = await this.client.hsetnx(slotsKey, key, slot);
    if (added) return slot;
    const assigned = await this.client.hget(slotsKey, key);
    return parseInt(assigned, 10);
  }

  // Deletes every boat-related key for the CURRENTLY SELECTED regatta only
  // (tracks, the known-boats set, and start slot assignments) - deliberately
  // leaves the course marks untouched, so the same course can keep being
  // raced by a fresh fleet without recomputing/republishing marks, and
  // deliberately leaves every OTHER regatta's own namespace completely
  // alone. Returns the keys that were deleted, for whatever's calling this
  // to report back.
  async clearBoatData() {
    await this.ready;
    const prefix = this._prefix();
    const boatIds = await this.client.smembers(`${prefix}boats:known`);
    const keys = [
      ...boatIds.map((id) => `${prefix}boat:${id}:track`),
      `${prefix}all:track`,
      `${prefix}boats:known`,
      `${prefix}boats:start_slots`,
      `${prefix}boats:start_slot_counter`,
    ];
    const existingKeys = [];
    for (const key of keys) {
      if (await this.client.exists(key)) existingKeys.push(key);
    }
    if (existingKeys.length > 0) await this.client.del(...existingKeys);
    return existingKeys;
  }

  // Which regatta this base station is currently reporting for - and whose
  // `regattas:<id>:...` namespace every other method above reads/writes -
  // is deliberately NOT stored in Redis at all. Redis can be shared by
  // multiple base stations at once (see the module comment above); a Redis
  // key for "the selected regatta" would be a single GLOBAL value every
  // base sharing that Redis would fight over, exactly the same collision
  // this whole namespacing scheme exists to avoid for marks/tracks/boats.
  // Each base's own selection is instead entirely local to that process -
  // see baseStation.js's own selectedRegatta variable and regattaIdFile.js's
  // regatta-id.txt - and simply assigned here directly.
  setCurrentRegatta(regattaId) {
    this.currentRegattaId = regattaId;
  }

  // For the admin dashboard's connection indicator - ioredis's own
  // connection state machine, exposed here rather than reaching into
  // .client directly from outside this class.
  isConnected() {
    return this.client.status === 'ready';
  }

  // Current Redis memory usage, for the admin dashboard's "Redis memory"
  // card - so an operator can actually see room running out (see this
  // app's own recordFix, which records position fixes continuously
  // whenever a boat is transmitting, not just during a race - a fleet
  // roaming around all day between races can accumulate real volume even
  // on days with fewer actual races) rather than only finding out once
  // writes start failing. Instance-wide, not scoped to any one regatta's
  // namespace - Redis's own memory usage is a whole-database concern
  // regardless of how many regattas' worth of data live inside it.
  //
  // maxmemoryBytes is best-effort: a managed instance (Redis Cloud and
  // similar) commonly restricts CONFIG GET for this - it's enforced by the
  // platform's own plan size, not a runtime-adjustable Redis setting - in
  // which case this comes back null (unknown), not 0. Callers should fall
  // back to an operator-configured limit (see config.js's
  // REDIS_MEMORY_LIMIT_MB) rather than assume "no limit at all" just
  // because Redis itself won't say.
  async getMemoryInfo() {
    await this.ready;
    const info = await this.client.info('memory');
    const usedBytes = parseInt(info.match(/used_memory:(\d+)/)?.[1] || '0', 10);
    let maxmemoryBytes = null;
    try {
      const result = await this.client.config('GET', 'maxmemory');
      // A 0 here is Redis's own "no limit configured" - genuinely different
      // from CONFIG GET being blocked entirely (empty/missing result),
      // which means "unknown," not "unlimited."
      if (result && result.length >= 2) maxmemoryBytes = parseInt(result[1], 10) || 0;
    } catch (err) {
      // CONFIG GET itself restricted (common on managed instances) -
      // maxmemoryBytes stays null, meaning "unknown."
    }
    return { usedBytes, maxmemoryBytes };
  }

  // Cheap counts for the admin dashboard (adminServer.js) - ZCARD instead
  // of fetching full tracks (getBoatTrack/getAllTrack), so this stays fast
  // regardless of how much data has accumulated over a race day. Scoped to
  // the CURRENTLY SELECTED regatta's own namespace - the admin dashboard's
  // "Total tracks" card is meant to answer "what's happening right now,"
  // and a cross-regatta total wouldn't mean much there anyway.
  async getStats() {
    await this.ready;
    const prefix = this._prefix();
    const boatIds = await this.client.smembers(`${prefix}boats:known`);
    const [totalTracks, perBoatCounts] = await Promise.all([
      this.client.zcard(`${prefix}all:track`),
      Promise.all(boatIds.map((id) => this.client.zcard(`${prefix}boat:${id}:track`))),
    ]);
    const tracksByBoat = Object.fromEntries(boatIds.map((id, i) => [id, perBoatCounts[i]]));
    return { totalTracks, boatsKnown: boatIds.length, tracksByBoat, writeHealth: this.getWriteHealth() };
  }

  async close() {
    this._closing = true;
    clearInterval(this._keepaliveTimer);
    await this.client.quit();
  }
}

module.exports = { RedisStore };
