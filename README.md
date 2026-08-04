# Race Tracker — Boat Agent + Base Station

Reports GPS position from a boat (Pi Zero 2 W + simpleRTK2B LR) to a shore/
committee base station over a long-range telemetry radio (>2 mi), with
full-rate logging to microSD as a durable backup.

## Architecture

```
[simpleRTK2B LR]--UART-->[Pi Zero 2 W]--UART-->[Telemetry radio]==RF==>[Telemetry radio]--UART-->[Base station]--> race software
                              |
                              v
                          microSD (CSV, every fix)
```

- **GPS**: ZED-F9P emits `UBX-NAV-PVT` binary messages (position, speed,
  heading, fix type, RTK carrier solution, satellite count) — parsed directly,
  no NMEA needed.
- **Radio**: assumed to be a transparent-serial telemetry radio (RFD900x,
  SiK, etc). Bytes written to the boat-side UART come out the base-side UART.
  A compact 23-byte binary frame (`src/protocol.js`) is used to minimize
  airtime.
- **SD log**: every GPS fix is logged to CSV regardless of radio status, so a
  dropped radio link never loses data — only live tracking is affected.

## Wiring notes

The simpleRTK2B LR has its own USB port, which is what the default config
assumes: GPS over the module's own USB (shows up as `/dev/ttyACM0`), radio
over a separate USB-to-serial adapter (`/dev/ttyUSB0`) - both off a hub,
since Pi Zero 2 W only has one USB/OTG port natively.

If you'd rather free up a USB port, GPS can instead go over the Pi's
dedicated hardware UART (`/dev/ttyAMA0`, GPIO 14/15 - avoid the mini-UART,
its clock is tied to the core clock and can glitch) with `GPS_PORT=/dev/ttyAMA0`,
leaving the radio as the only USB-to-serial adapter needed:

```
sudo raspi-config   # Interface Options -> Serial Port
                     # "login shell over serial" = No
                     # "serial port hardware enabled" = Yes
```
This frees `/dev/ttyAMA0` for the GPS instead of the console.

## GPS configuration (one-time, via u-center or ubxtool)

By default the ZED-F9P outputs a mix of NMEA sentences at 38400 baud, which
this app's `GPS_BAUD` default already matches - no baud reconfiguration
needed. For this app you just want `UBX-NAV-PVT` enabled and NMEA disabled
on the UART feeding the Pi:

```
ubxtool -P 27.11 -p CFG-VALSET -z CFG-MSGOUT-UBX_NAV_PVT_UART1,1
ubxtool -P 27.11 -p CFG-VALSET -z CFG-UART1OUTPROT-NMEA,0
ubxtool -P 27.11 -p CFG-VALSET -z CFG-RATE-MEAS,1000   # 1Hz; raise if you want faster fixes
```
Save the config to flash on the module (`-p CFG-VALSET ... ,,,, 7` or via
u-center's "Save Config") so it survives power cycles — otherwise it reverts
to NMEA-only output on the next power-up.

The simpleRTK2B LR's onboard LoRa radio is a **separate concern** — that's
normally used for RTCM3 correction data between your RTK base and this
rover, not for the position telemetry this app sends. Nothing here touches
that link.

## Radio configuration

Pair every radio (boat + base) on the same netid/frequency/baud, in
transparent-serial mode. `RADIO_BAUD` defaults to **115200**, not the
radio's factory default (9600 for XBee, 57600 for RFD900x/SiK) - at fleet
sizes beyond a couple boats, the serial link between the base station and
its own radio becomes the bottleneck (every boat's frames funnel through
that one port), well below the radio's actual RF capacity. Before running
with this default, reconfigure **every** radio's serial baud to 115200 via
XCTU (XBee) or RFD Modem Tools/Mission Planner (RFD900x) - a mismatch
between this setting and what the radio's actually set to just means the
port opens but nothing decodes. Also confirm all radios share the same
Network ID (XBee `ID`, via XCTU).

If you're running only 1-2 boats, the extra baud doesn't buy you much and
you can leave everything at factory defaults - just set `RADIO_BAUD` to
match (9600 for XBee, 57600 for RFD900x). Higher baud = faster frame
delivery but shorter range/reliability at a given power — this is a
real-world tuning step you'll need to do on the water. **Antenna height
matters a lot for going over water at >2mi; get both ends as high as
practical.**

### Bench-testing the radios

```
RADIO_TEST_MODE=send   RADIO_PORT=/dev/cu.usbserial-A npm run radio-test
RADIO_TEST_MODE=listen RADIO_PORT=/dev/cu.usbserial-B npm run radio-test
```

`src/radioTest.js` exercises the real radio link directly - no GPS, no
Redis, no simulated anything - using the exact same `RadioLink`/`protocol.js`
code `boatAgent.js`/`baseStation.js` use in production, so a clean result
here is a real signal about the actual RF link (framing, checksum
integrity, range), not just "can bytes get through at all." Run one
instance per radio: `ls /dev/cu.*` before/after plugging in each one to
find its device path (on macOS; use whatever your OS calls serial devices).
`RADIO_BAUD` must match what's actually configured on both radios (see
"Radio configuration" above) - and for XBee, confirm both share the same
Network ID (`ATID`) via XCTU first, or the listener will just see nothing.

The sender transmits one frame every `RADIO_TEST_INTERVAL_MS` (default
500ms) with a sequence number piggybacked on the frame's timestamp field
(a test-only convention, not a real GPS time). The listener logs each
received frame and prints a running summary every 10s - received count,
estimated missed count, and loss %. Start with both radios close together
to confirm basic connectivity, then physically separate them to find where
the link actually starts to degrade - that's the number that matters for
real racing distance.

## Running

Boat (Pi Zero 2 W):
```
cd race-tracker
npm install
GPS_PORT=/dev/ttyACM0 RADIO_PORT=/dev/ttyUSB0 BOAT_ID=1 npm run boat
```

Base station (another Pi, or a laptop with a USB radio):
```
RADIO_PORT=/dev/ttyUSB0 npm run base
```

Auto-start on boat boot:
```
sudo cp systemd/boat-agent.service /etc/systemd/system/
sudo systemctl enable --now boat-agent
```

## Simulation mode (no hardware)

Set `SIMULATE=1` to run `boat` and `base` with no GPS or radio hardware
attached. In this mode:
- `src/simGps.js` generates fake GPS fixes for a landsailer racing a
  windward-leeward course around a configurable center point - beating
  upwind on alternating tacks, running downwind on alternating gybes, with
  randomized leg lengths so no two laps look the same - in place of the real
  UBX-NAV-PVT parser.
- `src/simRadioLink.js` replaces the serial radio link with a shared UDP
  broadcast socket carrying the exact same frames (`src/protocol.js`), so
  the real encode/decode/checksum path is still exercised end to end — just
  without serial ports. Every simulated boat and the base broadcast on and
  listen to the same port (`SIM_PORT`), mirroring how every radio shares
  one RF channel on real hardware — no per-boat address to configure, and
  it works the same way across a real LAN as it does on localhost.

Run both in separate terminals, on the same machine or over a LAN:
```
# terminal 1 - base station
SIMULATE=1 npm run base

# terminal 2 - boat agent
SIMULATE=1 BOAT_ID=1 npm run boat
```
For multiple simulated boats, run more `npm run boat` instances with
different `BOAT_ID` values pointed at the same base station.

### Simulated GPS with real radio hardware

`SIMULATE_GPS=1` fakes just the GPS track, while using the real radio on
both ends - useful for bench-testing actual radios (range, packet loss,
antenna placement) without needing a real GPS fix or being outdoors.
`SIMULATE=1` implies this too; use `SIMULATE_GPS=1` on its own when you
specifically want simulated positions over real hardware radios:

```
# terminal 1 - base station, real radio
RADIO_PORT=/dev/cu.usbserial-A npm run base

# terminal 2 - boat agent, fake GPS + real radio
SIMULATE_GPS=1 RADIO_PORT=/dev/cu.usbserial-B BOAT_ID=1 npm run boat
```

(See "Bench-testing the radios" above for a more focused radio-only test
that doesn't involve GPS, Redis, or course logic at all.)

The boat has no Redis access at all (see "Broadcasting marks to the
rovers" above) - its simulated GPS won't start until the base actually
broadcasts marks to it, which means the base needs marks to broadcast in
the first place. With real radio hardware and no `SIMULATE=1` on the base,
that means Redis needs marks already published (by a real race operator,
or an earlier `SIMULATE=1` session) before this will do anything; the base
station's own real-hardware path only reads marks, it won't invent a
course (see "Connecting to your race committee software" below).

CSV logs land in `./race-logs` (relative to the package, regardless of mode)
unless you override `LOG_DIR`, and the base station's console/CSV/UDP GGA
output all work exactly as they would with real hardware.

| Var | Default | Purpose |
|---|---|---|
| `SIM_PORT` | `41234` | Shared port every simulated boat and the base broadcast on and listen to - see "Broadcasting marks to the rovers" above |
| `SIM_GPS_HZ` | 2 | Fake GPS fix rate |
| `SIM_UPWIND_SPEED_KN` / `SIM_DOWNWIND_SPEED_KN` | 30 / 55 | Simulated landsailer speed beating vs. running - much faster downwind than up, unlike a water boat, since low rolling resistance lets apparent wind build well past true wind speed on a reach/run |
| `SIM_CENTER_LAT` / `SIM_CENTER_LON` | `40.8744` / `-119.2024` | Center point of the simulated racecourse |
| `SIM_PACKET_LOSS` | 0 | % chance (0-100) each radio frame is dropped, to simulate range dropouts |
| `SIM_COURSE_LENGTH_NM` | 1 | Leeward-to-windward distance in nautical miles - shorten this (e.g. `0.05`) to quickly test laps without waiting through a full-length beat/run each time. Setting it clears any already-published course marks on startup so the new length actually takes effect (see "Changing the course" below) |
| `SIM_LAP_COUNT` | 2 | How many laps a simulated boat sails before it stops |

## Connecting to your race committee software

`src/baseStation.js` currently:
1. Logs every decoded fix to console + CSV
2. Records every decoded fix to Redis (see below) for querying tracks later
3. Broadcasts a synthesized `$GPGGA` NMEA sentence over UDP (port 10110,
   the conventional NMEA-over-UDP port) — some tracking tools can ingest
   this directly

Once you pick your race software (TracTrac, YB Tracking, RaceQs, Predict
Wind, or in-house), the `outputFrame()` function is the one place to change
— swap it for whatever that software actually expects (an HTTP POST to a
cloud ingestion API is common for the commercial platforms; check their
integration docs since most of them expect a per-boat auth token). Happy to
build that adapter once you know the target.

## Lap events -> RegattaUp

Lap detection lives entirely on the base station, not the boat: a real
rover has no Redis access to resolve course marks itself, so it only ever
sends its raw position (the regular 23-byte position frame, unchanged) -
`src/finishLineWatcher.js`, running inside `baseStation.js`, watches every
incoming fix - real hardware or simulated, it makes no difference - against
the committee/finish marks published in Redis, and detects a lap the same
way a real race committee would: the boat's path actually crossing the
committee<->finish segment (not just anywhere on the line) while heading
upwind (committee to port, finish to starboard - see the module for the
geometry). One `FinishLineWatcher` is kept per boat ID, since each needs its
own independent crossing-state and lap counter. This works "as long as the
finish line is set" - if the base station can't find committee/finish marks
in Redis at startup, lap detection is just unavailable for that run, logged
once, not retried.

Whenever a crossing is detected, the base station queues it (see below) and
POSTs to RegattaUp's lap webhook so the crossing counts as a lap there:

```json
{
  "decoded": {
    "tranCode": "51",
    "rtcTime": 1785337740000000,
    "strength": 2
  },
  "receivedAt": "2026-07-29T15:09:00.604Z"
}
```

- `tranCode` — the boat's ID (as a string), matched against that boat's
  transponder code configured in RegattaUp
- `rtcTime` — the lap's own timestamp, converted from milliseconds to
  microseconds (the unit RegattaUp's webhook expects)
- `strength` — the fix's `carrSoln` (RTK solution quality) at the moment of
  crossing, standing in for signal strength
- `receivedAt` — the base station's wall-clock time, sent as the fallback
  timestamp

### Durable retry queue

A failed webhook POST doesn't just get logged and dropped - `src/lapWebhookQueue.js`
durably records every lap (in a small sqlite file, via `sql.js` - a WASM
build, so it needs no native compilation on whatever machine or Raspberry Pi
this runs on) *before* the first send attempt, and only removes it once
RegattaUp actually accepts it. A background loop retries whatever's still
queued with capped exponential backoff (2s, 4s, 8s, ... up to
`REGATTAUP_MAX_BACKOFF_MS`), indefinitely - this also means a lap survives a
base station restart mid-retry, since the queue is a file on disk, not just
in-memory state.

| Var | Default | Purpose |
|---|---|---|
| `REGATTAUP_WEBHOOK_URL` | `https://regattaup.com/api/functions/mylapsWebhook` | Override to point at a mock endpoint for testing |
| `REGATTAUP_WEBHOOK_DISABLED` | unset | Set to `1` to skip sending entirely (crossings are still detected and logged) |
| `REGATTAUP_QUEUE_DB` | `<LOG_DIR>/lap_webhook_queue.sqlite` | Where the retry queue's sqlite file lives |
| `REGATTAUP_RETRY_INTERVAL_MS` | 15000 | How often the retry loop checks for due-for-retry laps |
| `REGATTAUP_MAX_BACKOFF_MS` | 300000 (5 min) | Cap on the exponential backoff between retries for a single lap |

### Testing the lap -> webhook path

```
TEST_LAP=1 npm run base
```

Sends one synthetic lap straight into the webhook queue and exits - no
radio, no GPS, no finish-line detection involved, just checking the queue ->
RegattaUp path in isolation. `TEST_LAP_BOAT_ID`/`TEST_LAP_NUMBER` (default 1
and 1) pick which boat/lap number it's sent as.

## Redis track storage

Every fix the base station decodes is recorded into Redis by `src/redisStore.js`
(`REDIS_URL`, default `redis://127.0.0.1:6379`), indexed two ways so both
common queries are a single range read:

- `boat:<id>:track` — one sorted set per boat, scored by the fix's own GPS
  timestamp (ms since epoch). Use `getBoatTrack(boatId, fromMs, toMs)` (either
  bound optional) to get that boat's track, optionally within a timeframe.
- `all:track` — one sorted set holding every boat's fixes together, same
  scoring. Use `getAllTrack(fromMs, toMs)` to get all boats' positions within
  a timeframe without knowing boat IDs up front.
- `boats:known` — a set of every boat ID that's ever reported in
  (`knownBoatIds()`), for discovering which boats exist without scanning keys.

Each stored entry is the decoded frame (`boatId, timestamp, lat, lon,
speedKnots, headingDeg, gnssFixOk, carrSoln, numSV`) plus `receivedAt` (the
base's own wall-clock time, useful for spotting radio-link latency/drops).
If Redis is unreachable, `baseStation.js` logs the error and keeps running —
console/CSV/UDP output are unaffected, matching this app's "SD/console never
blocks on the network" philosophy elsewhere.

### Switching between Redis servers

`REDIS_ENV` picks a connection preset in `config.js` (default `local`,
`127.0.0.1:6379`). `production` points at the Redis Cloud instance; its
host/port are fine to keep in source, but credentials never are — set these
in your environment (or a git-ignored `.env`), not in the repo:

```
REDIS_ENV=production REDIS_PASSWORD=<password> npm run base
```

- `REDIS_USERNAME` — defaults to `default` (Redis Cloud's default ACL user)
- `REDIS_PASSWORD` — required for `production`, no default
- `REDIS_TLS` — set to `1` if your database requires TLS (this one currently doesn't)

For anything outside the two presets, `REDIS_URL` still works and overrides
both `REDIS_ENV` presets entirely, e.g. `REDIS_URL=redis://host:port npm run base`.

### Clearing boat data

```
npm run clear-boats
```

Deletes every boat-related key (`boat:<id>:track`, `all:track`,
`boats:known`, and start-slot assignments) so a fresh fleet can race the
same course without stale boats/tracks left over from earlier runs. The
course marks are left untouched. Respects `REDIS_ENV`/`REDIS_URL` the same
way `base` does (`boat` doesn't touch Redis at all - see "Broadcasting
marks to the rovers" above), so point it at whichever Redis you actually
want cleared.

### Changing the course

```
npm run clear-course
```

Deletes the five `mark:*` keys so the next `boat`/`base` run recomputes and
republishes the course from scratch (e.g. after changing
`SIM_COURSE_LENGTH_NM` or `SIM_CENTER_LAT`/`SIM_CENTER_LON`) instead of
reusing whatever's already there. Boat tracks are left untouched — pair with
`npm run clear-boats` if you want those cleared too. You normally don't need
to run this yourself for `SIM_COURSE_LENGTH_NM` specifically: setting that
env var makes `boat`/`base` clear the old marks automatically on startup, so
the course actually changes length instead of silently reusing whatever
course was already published.

### Broadcasting marks to the rovers

A real rover has no Redis access of its own (see `finishLineWatcher.js`'s
module comment), so the base station periodically radios the current course
marks out to every boat, using a second frame type alongside the regular
position frame (`protocol.js`'s `encodeMarks`/`decodeMarks`, its own sync
byte since it isn't the same length). Every boat's `radioLink.js` byte
stream already recognizes both frame types, so nothing else needs wiring up.

Each boat keeps the latest marks in memory and also writes them to
`<LOG_DIR>/course_marks.json`, so a reboot or restart has a last-known
course immediately on the next boot, without waiting for the next
broadcast. This is best-effort, not a guaranteed sync - if a boat misses one
broadcast (radio dropout, powered on late), it just gets the next one; no
ack/retry, since marks essentially never change mid-race and the persisted
copy already covers the "just missed it" case.

The base doesn't wait for a fixed interval to send the *first* one: it
broadcasts the moment marks actually resolve (real hardware polls Redis
every 5s until an operator publishes them, rather than giving up after one
look - an operator setting up the course after the base is already running
is a normal sequence, not an error), and again immediately whenever a
previously-unseen boatId is heard from, so a boat joining after the base
already knows the course doesn't have to wait either.
`MARKS_BROADCAST_INTERVAL_MS` (default 60000) governs the ongoing
heartbeat re-send after that, purely as a safety net for a boat that missed
both of the above - see "Tuning knobs" below.

This also works in `SIMULATE=1` mode, no real radios needed to test it, and
mirrors the real radio model exactly rather than approximating it:
`simRadioLink.js` has every simulated boat and the base bind the *same*
shared UDP port (`SIM_PORT`) and broadcast to it, the same way every real
radio shares one RF channel - there's no per-boat host/address tracking at
this layer at all, on either side, the same as real hardware (a boat's
`boatId` lives in the frame payload, not the radio addressing - see
`protocol.js`). That also means this works unchanged across a real LAN,
not just localhost: put the boat on a different machine on the same
subnet and it just works, no host/IP to configure - broadcast reaches it
either way. You shouldn't need to wait on `MARKS_BROADCAST_INTERVAL_MS` at
all to see a simulated boat get the course (the immediate-broadcast paths
above cover it) - if you do, something's stuck (see the base's console log
for what it's currently waiting on).

### Log rotation

CSV logs (the boat's SD card log, and the base station's received-fix log)
are pruned automatically: anything in `LOG_DIR` older than
`LOG_RETENTION_DAYS` (default 7) gets deleted, checked at startup and, for
the base station, again on every write (so a laptop left running for a
multi-day regatta still rotates at midnight instead of growing one file
forever). See `src/logRotation.js`.

The boat's log is segmented per boat *and* per hour
(`boat<id>_<YYYY-MM-DDTHH>.csv`, see `src/sdLogger.js`) - every fix is
appended to whichever hour's file its own GPS timestamp falls into, not
wall-clock write time, and a restarted process resumes appending to the
current hour's file rather than starting a new one (the file is keyed by
hour, not by session). The base station's file is named per day
(`base_station_received_<date>.csv`) for the same by-age pruning to apply
to it too, instead of one file growing without bound across an entire
season. Neither ever prunes rows *within* a file that's still being
actively written, only whole files once they age out.

The lap webhook retry queue (`lapWebhookQueue.js`'s sqlite file) isn't
touched by this - it already self-cleans on successful delivery, and isn't
a rotating log in the same sense.

## Tuning knobs (env vars)

With this many knobs, `npm run print-config` prints the fully-resolved
config - every default plus whatever you've actually overridden via
environment variables or `.env` - so there's one place to check what a
given `boat`/`base` run will actually use, instead of reading through
`config.js`'s fallbacks by hand. The Redis password is redacted even here.

| Var | Default | Purpose |
|---|---|---|
| `GPS_PORT` / `GPS_BAUD` | `/dev/ttyACM0` / 38400 | GPS UART (simpleRTK2B LR's own USB port by default — override to `/dev/ttyAMA0` if wired to the Pi's hardware UART instead, see "Wiring notes" above) |
| `RADIO_PORT` / `RADIO_BAUD` | `/dev/ttyUSB0` / 115200 | Telemetry radio UART - 115200 is NOT the radio's factory default, every radio must be reconfigured to match (see "Radio configuration" above) |
| `RADIO_TEST_MODE` / `RADIO_TEST_INTERVAL_MS` | unset / 500 | `npm run radio-test` only — `send` or `listen`, and how often the sender transmits, see "Bench-testing the radios" above |
| `NO_RADIO` | unset | Set to `1` to skip opening the radio port entirely, on either `npm run boat` (fixes still log to SD) or `npm run base` (other outputs — console/CSV/Redis — still testable, just with no incoming frames) |
| `BOAT_ID` | 1 | Numeric ID (0-255) distinguishing boats |
| `TX_DISTANCE_M` | 1 | How far the boat has to move before a new frame is sent over radio (SD log is always full-rate) — distance-based, not time-based, so a stopped boat doesn't keep re-sending the same fix. Keep this smaller than the finish gate/start-finish strip width (see course.js) — the base station's lap detection only sees transmitted positions, so a gap much wider than the gate risks jumping over it entirely without a lap being detected |
| `MARKS_BROADCAST_INTERVAL_MS` | 60000 | Base station only — how often the current course marks are re-broadcast to every boat, see "Broadcasting marks to the rovers" above |
| `LOG_DIR` | `./race-logs` (next to the package) | Where CSV logs go — override to put this on the SD card, e.g. `/home/pi/race-logs` |
| `LOG_RETENTION_DAYS` | 7 | CSV files in `LOG_DIR` older than this are deleted automatically (see "Log rotation" below) — keeps a boat's microSD card or an always-running base station laptop from filling up over a season |
| `REDIS_ENV` | `local` | Base station only — selects a Redis connection preset (`local` or `production`), see "Redis track storage" above |
| `REDIS_USERNAME` / `REDIS_PASSWORD` / `REDIS_TLS` | `default` / unset / unset | Credentials for the `production` Redis preset — never hardcode these, set via environment |
| `REDIS_URL` | unset | Base station only — overrides `REDIS_ENV` entirely with a full connection string, for ad-hoc targets |
| `REDIS_MIN_MOVEMENT_M` | 5 | Base station only — skip a Redis write (SD/console/UDP output unaffected) unless a boat has moved at least this many meters since its last recorded fix, so a stopped or barely-drifting boat doesn't fill Redis with near-duplicate fixes |
| `REGATTAUP_WEBHOOK_URL` | RegattaUp's lap webhook | Base station only — see "Lap events -> RegattaUp" above |
| `REGATTAUP_WEBHOOK_DISABLED` | unset | Base station only — set to `1` to skip posting lap crossings to RegattaUp entirely |
| `REGATTAUP_QUEUE_DB` / `REGATTAUP_RETRY_INTERVAL_MS` / `REGATTAUP_MAX_BACKOFF_MS` | see "Durable retry queue" above | Base station only — tune the lap webhook's local retry queue |
| `TEST_LAP` / `TEST_LAP_BOAT_ID` / `TEST_LAP_NUMBER` | unset / 1 / 1 | `npm run base` only — send a single test lap straight into the webhook queue and exit, see "Testing the lap -> webhook path" above |

## What still needs real-hardware testing

- Actual achievable baud/range tradeoff for your specific radio model
- Whether the Pi's hardware UART (`/dev/ttyAMA0`) is more reliable than the
  simpleRTK2B LR's own USB port (`/dev/ttyACM0`, the default) for your GPS
  wiring in practice
- UBX checksum/frame-sync robustness over a long noisy USB-serial run (the
  parser resyncs on bad frames, but hasn't been stress-tested on real RF
  noise)
- The actual ingestion format for whichever race software you land on
