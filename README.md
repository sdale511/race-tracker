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
  A compact 21-byte binary frame (`src/protocol.js`) is used to minimize
  airtime.
- **SD log**: every GPS fix is logged to CSV regardless of radio status, so a
  dropped radio link never loses data — only live tracking is affected.

## Wiring notes

**Pi Zero 2 W only has one dedicated hardware UART** (the mini-UART is
generally best avoided since its clock is tied to the core clock and can
glitch). You have two serial devices to connect (GPS + radio). Realistic
options:

1. Hardware UART (`/dev/ttyAMA0`, GPIO 14/15) → GPS. Radio → USB-to-serial
   adapter (shows up as `/dev/ttyUSB0`). **This is what the default config
   assumes.**
2. Both via USB-to-serial adapters (uses two USB ports off a hub, since Pi
   Zero 2 W only has one USB/OTG port natively).

Either way:
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

Pair two radios (boat + base) on the same netid/frequency/baud, in
transparent-serial mode. `RADIO_BAUD` defaults to 9600 to match the Digi
XBee SX's factory default, so two out-of-box XBee SX modules need no
baud reconfiguration - just confirm both share the same Network ID
(`ATID`, via XCTU), which fresh-from-factory modules already do. If you
raise the radio's baud for faster frame delivery, or use a different radio
(e.g. RFD900x/SiK, whose factory default is typically 57600), override
`RADIO_BAUD` to match whatever you configure on the radios themselves.
Higher baud = faster frame delivery but shorter range/reliability at a
given power — this is a real-world tuning step you'll need to do on the
water. **Antenna height matters a lot for going over water at >2mi; get
both ends as high as practical.**

## Running

Boat (Pi Zero 2 W):
```
cd race-tracker
npm install
GPS_PORT=/dev/ttyAMA0 RADIO_PORT=/dev/ttyUSB0 BOAT_ID=1 npm run boat
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
- `src/simRadioLink.js` replaces the serial radio link with a UDP socket
  carrying the exact same 21-byte frames (`src/protocol.js`), so the real
  encode/decode/checksum path is still exercised end to end — just without
  serial ports.

Run both in separate terminals, on the same machine or over a LAN:
```
# terminal 1 - base station
SIMULATE=1 npm run base

# terminal 2 - boat agent
SIMULATE=1 BOAT_ID=1 npm run boat
```
For multiple simulated boats, run more `npm run boat` instances with
different `BOAT_ID` values pointed at the same base station.

CSV logs land in `./race-logs` (relative to the package, regardless of mode)
unless you override `LOG_DIR`, and the base station's console/CSV/UDP GGA
output all work exactly as they would with real hardware.

| Var | Default | Purpose |
|---|---|---|
| `SIM_HOST` / `SIM_PORT` | `127.0.0.1` / `41234` | Where boatAgent sends sim radio frames; baseStation listens here |
| `SIM_GPS_HZ` | 2 | Fake GPS fix rate |
| `SIM_UPWIND_SPEED_KN` / `SIM_DOWNWIND_SPEED_KN` | 30 / 55 | Simulated landsailer speed beating vs. running - much faster downwind than up, unlike a water boat, since low rolling resistance lets apparent wind build well past true wind speed on a reach/run |
| `SIM_CENTER_LAT` / `SIM_CENTER_LON` | `40.8744` / `-119.2024` | Center point of the simulated racecourse |
| `SIM_PACKET_LOSS` | 0 | % chance (0-100) each radio frame is dropped, to simulate range dropouts |

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
way `boat`/`base` do, so point it at whichever Redis you actually want
cleared.

## Tuning knobs (env vars)

| Var | Default | Purpose |
|---|---|---|
| `GPS_PORT` / `GPS_BAUD` | `/dev/ttyAMA0` / 38400 | GPS UART |
| `RADIO_PORT` / `RADIO_BAUD` | `/dev/ttyUSB0` / 9600 | Telemetry radio UART |
| `NO_RADIO` | unset | Set to `1` to skip opening the radio port entirely, on either `npm run boat` (fixes still log to SD) or `npm run base` (other outputs — console/CSV/Redis — still testable, just with no incoming frames) |
| `BOAT_ID` | 1 | Numeric ID (0-255) distinguishing boats |
| `TX_INTERVAL_MS` | 2000 | How often a frame is sent over radio (SD log is always full-rate). Actual TX timing is jittered +/-20% (and randomized on startup) so a fleet transmitting on a shared channel doesn't cluster/collide |
| `LOG_DIR` | `./race-logs` (next to the package) | Where CSV logs go — override to put this on the SD card, e.g. `/home/pi/race-logs` |
| `REDIS_ENV` | `local` | Base station only — selects a Redis connection preset (`local` or `production`), see "Redis track storage" above |
| `REDIS_USERNAME` / `REDIS_PASSWORD` / `REDIS_TLS` | `default` / unset / unset | Credentials for the `production` Redis preset — never hardcode these, set via environment |
| `REDIS_URL` | unset | Base station only — overrides `REDIS_ENV` entirely with a full connection string, for ad-hoc targets |

## What still needs real-hardware testing

- Actual achievable baud/range tradeoff for your specific radio model
- Whether `/dev/ttyAMA0` vs a USB-serial adapter is more reliable for your
  GPS wiring in practice
- UBX checksum/frame-sync robustness over a long noisy USB-serial run (the
  parser resyncs on bad frames, but hasn't been stress-tested on real RF
  noise)
- The actual ingestion format for whichever race software you land on
