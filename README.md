# Race Tracker — Boat Agent + Base Station

Reports GPS position from a boat (Pi Zero 2 W + simpleRTK2B LR) to a shore/
committee base station over a long-range telemetry radio (>2 mi), with
logging to microSD as a durable backup.

## Architecture

```
[simpleRTK2B LR]--UART-->[Pi Zero 2 W]--UART-->[Telemetry radio]==RF==>[Telemetry radio]--UART-->[Base station]--> race software
                              |
                              v
                    microSD (CSV, same fixes sent over radio)
```

For the complete rover → base → RegattaUp data flow - wire formats, Redis
keys, webhook payloads, RegattaUp's own entity fields - see
[`docs/telemetry-pipeline.html`](docs/telemetry-pipeline.html) (open in a
browser).

| Component | Notes |
|---|---|
| GPS | ZED-F9P, `UBX-NAV-PVT` binary messages (position, speed, heading, fix type, RTK carrier solution, satellite count) - no NMEA needed |
| Radio | Transparent-serial telemetry radio (RFD900x, SiK, etc). A compact 26-byte binary frame (`src/protocol.js`) minimizes airtime - optionally batched, see `TX_BATCH_SIZE` below |
| SD log | Logged exactly when a fix clears the `TX_DISTANCE_M`/`TX_INTERVAL_S` gate - same gate as the radio send, so the SD record mirrors what actually transmitted rather than a separate full-rate trace |

## Wiring notes

Default config uses the Pi's own dedicated hardware UART (`/dev/ttyAMA0`,
GPIO 14/15 - avoid the mini-UART, its clock is tied to the core clock and
can glitch), leaving the one USB/OTG port free for the telemetry radio
alone.

```
sudo raspi-config   # Interface Options -> Serial Port
                     # "login shell over serial" = No
                     # "serial port hardware enabled" = Yes
```

- Prefer the simpleRTK2B's own USB port (`/dev/ttyACM0`) instead? Set
  `GPS_PORT=/dev/ttyACM0` (and matching `GPS_BAUD`) - simpler wiring, but
  needs a USB hub since the radio then needs its own USB-to-serial adapter.
- Any Pi with onboard Bluetooth (Zero 2 W, 3A+/3B+, 4, ...) puts GPIO14/15
  on the glitch-prone mini-UART (`ttyS0`) by default, since Bluetooth
  occupies the real UART. Fix:
  ```
  # /boot/firmware/config.txt (Bookworm+) or /boot/config.txt (older)
  dtoverlay=disable-bt
  ```
  then disable `hciuart`/`bluetooth` services and reboot.
- Which physical UART (UART1 vs UART2) your wiring reaches depends on the
  board - ArduSimple's simpleRTK2B routes UART2 to the XBee socket (used
  for RTCM correction radios, unrelated to this app), so a general
  breakout pin is more likely UART1 - verify, don't assume (see below).

## GPS configuration (one-time, via u-center or ubxtool)

Each UART is configured independently - a GPIO-wired UART may still be at
factory defaults (NMEA on, UBX off) even after USB's been configured.
Verify first:

```
stty -F /dev/ttyAMA0 <baud> raw -echo
cat /dev/ttyAMA0        # Ctrl-C to stop
```
Try common bauds (9600, 19200, 38400, 57600, 115200) until you see clean
`$GNGGA`/`$GNRMC`/... text.

```
sudo apt update
sudo apt install -y gpsd gpsd-clients python3-gps
sudo systemctl disable --now gpsd.socket gpsd   # stop it grabbing the port
```

At the confirmed baud, enable `UBX-NAV-PVT` and disable NMEA (try `UART1`
first, `UART2` if nothing changes):
```
ubxtool -f /dev/ttyAMA0 -s 115200 -P 27.11 -z CFG-MSGOUT-UBX_NAV_PVT_UART1,1,7
ubxtool -f /dev/ttyAMA0 -s 115200 -P 27.11 -z CFG-UART1OUTPROT-NMEA,0,7
ubxtool -f /dev/ttyAMA0 -s 115200 -P 27.11 -z CFG-RATE-MEAS,1000,7   # 1Hz
```
`,7` is a layer bitmask (`RAM=1, BBR=2, Flash=4`) - `7` writes to all
three, so the change is immediate and survives a power cycle. NMEA doesn't
need to be disabled - the app's UBX parser scans for UBX sync bytes and
skips interleaved NMEA text - disabling it just saves bandwidth.

### Verifying the connection

```
stty -F /dev/ttyAMA0 115200 raw -echo
cat /dev/ttyAMA0        # expect quiet gaps + a short binary burst ~1/sec
```
Then confirm this app itself decodes it (the check that actually matters):
```
GPS_PORT=/dev/ttyAMA0 GPS_BAUD=115200 npm run boat
```
Watch for `[gps]` lines with real `fixType`/`numSV` (see `GPS_LOG` in
"Tuning knobs"). Silence means `UBX-NAV-PVT` went to the wrong UART number
- undo (`CFG-MSGOUT-UBX_NAV_PVT_UARTx,0,7`) and try the other.

The simpleRTK2B LR's onboard radio (in the board's XBee socket) is a
**separate concern** - it carries RTCM3 correction data between RTK base
and this rover, not position telemetry. "LR" is ArduSimple's own kit name
("Long Range," ~10km), not a Digi product name - confirmed off the
module's label, the chip is a **Digi XBee SX** (Model XBSX, FCC ID
`MCQ-XBSX`); the step-up "XLR" kit uses a Digi XBee PRO SX for longer
range.

### RTK base GPS: enabling RTCM3 output (one-time)

`TMODE3` (fixed/survey-in position, set from this app's `npm run
rtk`/`basertk` dashboard) and RTCM3 *output* are separate config groups -
setting a fixed position doesn't turn sending RTCM on. Some kits ship with
only `1005` enabled and no observation messages, which looks like "locked
and working" on the dashboard while the rover receives nothing usable.

Check/enable on the base's correction-radio UART (`UART2` on the
simpleRTK2B LR - its onboard XBee SX is wired internally to UART2, not
something you'd jumper yourself):

| Message | Content |
|---|---|
| `1005` | Station coordinates (depends on the fixed position) |
| `1077`/`1087`/`1097`/`1127` | MSM7 observations: GPS/GLONASS/Galileo/BeiDou |
| `1230` | GLONASS code-phase biases (needed alongside `1087`) |

```
ubxtool -f <base GPS port> -s <baud> -P 27.11 -z CFG-MSGOUT-RTCM_3X_TYPE1005_UART2,1,7
ubxtool -f <base GPS port> -s <baud> -P 27.11 -z CFG-MSGOUT-RTCM_3X_TYPE1077_UART2,1,7
ubxtool -f <base GPS port> -s <baud> -P 27.11 -z CFG-MSGOUT-RTCM_3X_TYPE1087_UART2,1,7
ubxtool -f <base GPS port> -s <baud> -P 27.11 -z CFG-MSGOUT-RTCM_3X_TYPE1097_UART2,1,7
ubxtool -f <base GPS port> -s <baud> -P 27.11 -z CFG-MSGOUT-RTCM_3X_TYPE1127_UART2,1,7
ubxtool -f <base GPS port> -s <baud> -P 27.11 -z CFG-MSGOUT-RTCM_3X_TYPE1230_UART2,1,7
```
Only enable constellations you're actually tracking. `,7` saves to flash
immediately (bare `,1` is RAM-only, for testing before committing).

For visibility into corrections arriving rover-side, enable `UBX-RXM-RTCM`
on the rover's own GPS UART and set `GPS_LOG_RTCM=1` (off by default):
```
ubxtool -f /dev/ttyAMA0 -s <baud> -P 27.11 -z CFG-MSGOUT-UBX_RXM_RTCM_UART1,1,7
```
Watch `[rtcm]` lines (`type=1077 station=0 used=used`) - `used=not used` on
its own is normal (unused constellations), `CRC-FAILED` means a correction
arrived corrupted. Message counts/CRC failures are always tracked
internally (`GET /api/stats`) regardless of this flag.

### RTK base GPS: enabling the survey-in status card (optional)

If the "Base GPS survey-in" card shows "no base GPS, or not polled yet"
even with `GPS_PORT` set and TMODE3 configured for survey-in,
`UBX-NAV-SVIN` likely isn't enabled as an output:
```
ubxtool -f /dev/ttyAMA0 -s 115200 -P 27.11 -z CFG-MSGOUT-UBX_NAV_SVIN_UART1,1,7
```
Configuring TMODE3 itself for survey-in (vs. just reading it) is a
separate one-time step, typically done via u-center at setup - see
u-blox's ZED-F9P integration manual for survey-in parameters.

### Checking everything at once (gps_config_report.sh)

`gps_config_report.sh` (repo root) polls every setting the sections above
depend on - fix rate, UART baud, `UBX-NAV-PVT`/NMEA/`UBX-NAV-SVIN`/
`UBX-RXM-RTCM` output, TMODE3 mode, RTCM3 output types - in one pass,
instead of re-typing each `ubxtool -g` poll by hand or assuming a board's
still configured the way it was last time. Read-only (`-g`/poll only,
never `-z`/set):
```
./gps_config_report.sh -f /dev/ttyAMA0 -s 115200
```
A board acting as a rover should show the RTK-base rows (TMODE3, RTCM3
output) at 0/off; a board acting as the RTK base should show its own rows
enabled and `CFG-TMODE-MODE` non-zero.

No `gpsd`/`ubxtool` available (or can't install it)? `ubx_config_report.py`
reports the exact same settings, talking the UBX binary protocol directly
over `pyserial` instead - same reasoning as `xbee_configure_at.py`'s own
"why not a library" comment, no external CLI tool needed:
```
pip install pyserial
python3 ubx_config_report.py --port /dev/ttyAMA0 --baud 115200
```
Every key ID it polls is cross-checked against two independent open-source
references (SparkFun's u-blox GNSS library and pyubx2), not typed from
memory - see its own module comment.

`ubx_config_set.py` applies the fix, same no-`ubxtool`-needed approach:
```
python3 ubx_config_set.py --port /dev/ttyAMA0 --baud 115200 --role base
python3 ubx_config_set.py --port /dev/ttyAMA0 --baud 115200 --role rover
```
`--role base` enables RTCM3 observations for all four constellations
(`1077`/`1087`/`1097`/`1127` - GPS/GLONASS/Galileo/BeiDou) and `UBX-NAV-SVIN`
- the exact gap a live audit of this fleet's own base unit found (`1005`
station coordinates on, no observation message at all, so a rover would
never get a usable correction from it - see "RTK base GPS: enabling RTCM3
output" above). All four on by default, not gated behind opt-in flags -
this fleet operates in the US, where all four have real satellites in view
(including BeiDou-3's global coverage, not just the old Asia-Pacific-only
BeiDou-2), and more satellites means better RTK fix reliability under
real-world sky obstruction; edit `BASE_SETTINGS` directly if you want fewer.
`--role rover` enables `UBX-NAV-PVT`
(required, or this app sees nothing from it), disables TMODE3 (a rover
isn't a stationary reference station), enables `UBX-RXM-RTCM` (for
`GPS_LOG_RTCM` visibility), and sets the fix rate to 10Hz (`CFG-RATE-MEAS`)
- not the ZED-F9P's 20Hz spec ceiling, since u-blox's own correction-link-
latency guidance (link latency should stay under nav-period minus 50ms)
leaves ~0ms margin at 20Hz - a real correction-radio link (not a bench
test) risks `carrSoln` flickering fixed→float right at the moment
precision matters most. 10Hz keeps a comfortable 50ms margin instead.
Every write goes to
RAM+BBR+Flash (survives a power cycle) and is read back afterward to
confirm it actually stuck - a silently-failed write is worse than a loud
one. `--dry-run` shows what would change without writing anything.

## Radio configuration

Pair every radio (boat + base) on the same netid/frequency/baud, in
transparent-serial mode.

| | Factory default | This app's default |
|---|---|---|
| XBee baud | 9600 | **115200** |
| RFD900x/SiK baud | 57600 | **115200** |

At fleet sizes beyond a couple boats, the base↔radio serial link (every
boat's frames funnel through one port) becomes the bottleneck well below
the radio's actual RF capacity - hence 115200. Reconfigure **every**
radio's serial baud via XCTU (XBee) or RFD Modem Tools/Mission Planner
(RFD900x) before running with this default; a mismatch just means the
port opens but nothing decodes. Also confirm all radios share the same
Network ID (XBee `ID`).

**Don't raise this past 115200 without re-testing.** It's tempting to - a
100-boat `radio-congestion` run at 115200 measured the SERIAL link
saturating at ~11.2 KB/s, almost exactly 115200's own 8N1 ceiling (115200 ÷
10 bits/byte = 11,520 B/s), apparently well under an XBee-PRO 900HP 200K's
nominal RF capacity. Bumping to 230400 does relieve that serial ceiling
(the same test then pushed 15.4 KB/s, using only ~67% of 230400's own
~23 KB/s ceiling) but sync errors jumped from 0.2% to 10.4% - real
RF-level bit corruption (see `radioLink.js`'s own `sync-error` event), not
local serial buffering, since bandwidth used stayed well under the new
ceiling. This fleet's actual radios' real sustainable RF throughput tops
out around ~11-12 KB/s regardless of serial baud - 115200 was accidentally
already throttling right at that ceiling, not artificially limiting it. If
you need more real fix throughput, use `TX_BATCH_SIZE` instead (reduces
actual RF bytes-per-fix, not just how fast the serial link can be fed) -
see "Batching multiple fixes per send" below - and re-run the same
`radio-congestion` test checking sync-error rate, not just bandwidth
headroom, before trusting any higher baud.

Running only 1-2 boats? Leave everything at factory defaults and set
`RADIO_BAUD` to match. Higher baud = faster delivery but shorter
range/reliability at a given power - tune on the water. **Antenna height
matters a lot for going over water at >2mi.**

### Configuring XBee radios (xbee_configure_at.py)

For XBee-PRO S3B (900HP/XSC) radios, `xbee_configure_at.py` (repo root)
automates the above instead of using XCTU by hand: DigiMesh delivery mode,
routing/relaying disabled on every node (single-hop fleet only), matching
Network ID/DH-DL/HP/MT/BD. Every command/value comes from Digi's XBee-PRO
900HP/XSC S3/S3B User Guide - not `MM`/`CH`/`CD`, which don't exist on
this module (confirmed live: both `ERROR`). No base-vs-rover split - every
radio gets identical config. Speaks plain AT Command Mode over `pyserial`
("+++", "ATxx<value>", "ATWR") - never leaves transparent mode.

```
pip install pyserial

python3 xbee_configure_at.py --port /dev/ttyUSB0             # every radio
python3 xbee_configure_at.py --port /dev/ttyUSB0 --dry-run    # read only
```

| Flag | Default | Notes |
|---|---|---|
| `--connect-baud` | 115200 | The radio's CURRENT speed - pass its actual current baud if already reconfigured, or `9600` for a genuinely factory-fresh radio |
| `--target-baud` | 115200 | Applied last (changes how the script itself talks to the radio), matches `RADIO_BAUD` |
| `--mode` | `p2mp` | `p2mp` / `digimesh` / `digimesh-routing` |

Config values (network ID, DH/DL, etc.) live in the `CONFIG` dict at the
top of the script, not as flags. Channel selection (`CM`) isn't touched at
all - set by hand first if avoiding specific frequencies. Only one process
can hold a serial port - stop any running `npm run base`/`boat`/`radio-test`
or XCTU on that port first.

**Mode history**: DigiMesh (`TO=0xC0`) is confirmed-working and was the
long-time default. Point-to-Multipoint (`TO=0x40`, lower overhead, no
network header) failed traffic between two persistently-verified P2MP
radios on this hardware - a real incompatibility, not config/persistence.
As of this pass **P2MP is the new default** based on further review (one
open lead: DigiMesh's own broadcasts already reuse Directed-Broadcast wire
framing, not unique DigiMesh framing, since this app's traffic is 100%
broadcast - so the earlier "working" DigiMesh test never actually
exercised mesh-routing behavior). Fall back with `--mode digimesh` if P2MP
doesn't work on your hardware. A real (non-dry-run) run soft-resets (`FR`)
and reconnects to re-verify every parameter survives a reboot, not just
reads back correctly mid-session.

### Bench-testing the radios

```
RADIO_TEST_MODE=send   RADIO_PORT=/dev/cu.usbserial-A npm run radio-test
RADIO_TEST_MODE=listen RADIO_PORT=/dev/cu.usbserial-B npm run radio-test
```

`src/radioTest.js` exercises the real radio link directly (no GPS, Redis,
or simulation) using the exact same `RadioLink`/`protocol.js` code
production uses. One instance per radio (`ls /dev/cu.*` before/after
plugging in to find device paths on macOS). `RADIO_BAUD` and Network ID
(`ATID`) must match on both.

Sender transmits one frame every `RADIO_TEST_INTERVAL_MS` (default 500ms)
with a sequence number in the timestamp field. Listener logs received
frames and prints a running summary every 10s (received count, estimated
missed, loss %). Start close together to confirm connectivity, then
separate to find where the link degrades.

### Congestion-testing the radio

`npm run fleet`'s `SIMULATE=1` link is UDP with no airtime limit, so it
can't show real congestion; running real `FLEET_SIZE` boats needs one real
radio *per boat*. `src/radioCongestionTest.js` instead runs one process,
one real radio, transmitting the *combined* frame traffic a whole
simulated fleet at speed would put on the air - same
`protocol.js`/`RadioLink` frames, same per-boat `TX_DISTANCE_M` cadence,
computed directly rather than from a live GPS track.

```
npm run base                                                   # real base, real radio - NOT SIMULATE=1
BOAT_COUNT=30 RADIO_PORT=/dev/cu.usbserial-A npm run radio-congestion
```

Watch the base's fleet dashboard (last-seen/frame counts) and its
`[radio] link quality` log line (sync errors) as `BOAT_COUNT` climbs.
`CONGESTION_SPEED_KN` (default 26.1, ≈ 30mph - this fleet's own reference
planning speed, land yachts rather than displacement sailboats; still in
knots like every other speed value in this app, so a bare `30` here means
30 *knots* instead) sets the assumed speed driving send rate. This tests
airtime/throughput load on the base's real receive
pipeline - it is **not** a test of real multi-transmitter RF collisions
(every frame still leaves one real antenna); that needs one real radio per
virtual boat.

**For real collisions**, run several of these at once, each on its own
physical radio, `BOAT_ID_OFFSET`-staggered so their boat ids don't overlap
(purely cosmetic for telling frames apart on the dashboard - the actual RF
collision behavior only depends on the radios being physically separate
transmitters, not on the ids). Split a target fleet size across them to
get realistic aggregate load *and* genuine multi-transmitter contention at
once, rather than choosing between the two:

```
BOAT_COUNT=7 BOAT_ID_OFFSET=0  RADIO_PORT=<radio1> npm run radio-congestion
BOAT_COUNT=7 BOAT_ID_OFFSET=7  RADIO_PORT=<radio2> npm run radio-congestion
BOAT_COUNT=7 BOAT_ID_OFFSET=14 RADIO_PORT=<radio3> npm run radio-congestion
BOAT_COUNT=7 BOAT_ID_OFFSET=21 RADIO_PORT=<radio4> npm run radio-congestion
```

Physically separate the transmitting radios rather than clustering them -
radios that can all hear each other collide differently (often more
politely) than ones spread across a real course, where some pairs are
hidden nodes to each other but both still reach the base. That hidden-node
case is usually where the ugliest real collision behavior actually shows
up, and clustering hides it entirely.

### Batching multiple fixes per send (TX_BATCH_SIZE)

`TX_BATCH_SIZE` (default 1 - one frame per fix, this app's original
behavior, byte-for-byte unchanged) packs that many consecutive fixes from
one boat into a single radio transmission instead of sending each on its
own - fewer, larger over-the-air transmissions instead of many small ones.
Whether that's actually worth the added latency (fixes wait to fill a
batch, though never longer than `TX_INTERVAL_S` - see below) depends on
whether your bottleneck is per-transmission overhead or per-byte airtime;
see the XBee-PRO 900HP/XSC S3B's own `NP` command (max RF payload - 256
bytes on the standard 900HP, but read-only and check it yourself: the
"900HP 200K" variant's higher RF data rate caps it much lower, 100 bytes on
this fleet's actual radios) for the ceiling a batch frame stays comfortably
under - `MAX_BATCH_COUNT` (protocol.js) is capped at 4 fixes (84 bytes) to
fit that, not the standard 900HP's larger default.

Test it with the same tool "Congestion-testing the radio" above uses -
`radio-congestion` respects `TX_BATCH_SIZE` too, so you can compare real
transmission rates with and without batching at your actual fleet size
before ever touching a real boat:

```
BOAT_COUNT=30 TX_BATCH_SIZE=4 RADIO_PORT=/dev/cu.usbserial-A npm run radio-congestion
```

The console's own "X frames sent, Y tx/s actual average" line (and the
base's `[radio] link quality` log) reflect actual transmissions, not
fixes - with batching on, that number should drop roughly in proportion to
`TX_BATCH_SIZE` for the same fix rate. Once you're happy with a value,
set it the same way on real boats:

```
TX_BATCH_SIZE=4 npm run boat
```

### What happens when a send fails (and why it never retries stale data)

A boat never queues-and-retries a fix that fails to go out - it's always
"try again with whatever's current on the next real GPS fix," never "hold
onto this one and resend it later." `lastTxPosition`/`lastTxTime` only
advance once `radio.send()` actually reports success (or there's
deliberately no radio at all, `RADIO_ENABLED=0`) - on failure they stay
put, so the movement/interval gate re-clears on the very next fix and
tries again with a position that's actually still true. The frame that
didn't go out isn't lost either way - it's already on the SD card by the
time `radio.send()` is even called.

`send()` reports failure for two different reasons, and only one of them
used to be detected:

- **The serial port isn't open** - disconnected, or hasn't finished
  connecting yet. Always handled this way.
- **The port IS open, but its local write buffer is still full** - real RF
  congestion (a saturated shared channel, collisions with other boats'
  transmissions) doesn't close the port, the radio just can't drain what
  it's handed as fast as it's handed it. `RadioLink` is a standard Node
  `Writable` stream underneath, so this is the same backpressure signal any
  Node stream gives (`write()` returning `false`, a later `'drain'` event
  once there's room) - `send()` now checks it *before* writing, not just
  after, so a fix never gets queued on top of an already-backed-up buffer.
  Without this, congestion would otherwise make things worse, not better:
  stale bytes already queued get transmitted first (FIFO), pushing fresher
  positions further behind them, right when a congested link most needs to
  be carrying current data, not old data it's already too late for.

Both cases now log the same way - `[radio] not connected, dropped a frame
(still logged to SD)` for a closed port vs. `[radio] backed up (congested
link?), dropped a frame (still logged to SD)` for the backpressure case -
so an operator watching the console can actually tell a cable/connection
problem apart from a genuinely saturated radio link, instead of both
looking identical.

## Running

Six modes, each its own `npm run` script:

| Mode | Command | Runs on | What it does |
|---|---|---|---|
| Boat | `npm run boat` | Each boat's Pi | Reads GPS, transmits over radio, logs to SD, serves rover dashboard |
| Base | `npm run base` | Shore/committee machine | Receives telemetry, tracks course/fleet/laps, reports to RegattaUp, serves fleet dashboard. Optional own GPS for planting course marks at a surveyed position - not RTK control |
| RTK-only | `npm run rtk` | Machine with just the RTK correction-source GPS | Monitors/configures TMODE3/survey-in, small dedicated dashboard - no telemetry, course, fleet, or RegattaUp |
| Base + RTK combined | `npm run basertk` | One machine, both roles | Everything `base` does + RTK-only's TMODE3/survey-in controls, one process/dashboard |
| Mark-set | `npm run markset` | Handheld/backpack RTK unit | Regatta/course/Redis, always-on GPS, dashboard opens to course map for manually setting mark positions - no radio/fleet/uploads/webhooks |
| Mark | `npm run mark` | Rover attached to one mark | Identical to Mark-set, plus a mark **assignment** (`MARK_NAME` or set from the map) that auto-posts this device's GPS as that mark moves |

Run `base` + `rtk` together on one machine (`basertk`) when simplest, or
split them (plain `base` + separate `rtk`) when the telemetry base and
correction GPS aren't the same box - see the mode sections below.

Boat (Pi Zero 2 W):
```
cd race-tracker
npm install
RADIO_PORT=/dev/ttyUSB0 npm run boat
```
(GPS defaults to `/dev/ttyAMA0`; add `GPS_PORT=/dev/ttyACM0` for the
simpleRTK2B's own USB port instead.)

`BOAT_ID` doesn't need to be set by hand: with none in the environment,
the app generates a random 5-character id, writes it to
`race-config/boat_id.txt`, and reuses it on every later run from that
device. An explicit `BOAT_ID` (exactly 5 characters - fixed-width wire
protocol field) always overrides this and never touches the file - useful
for a fleet that would otherwise need ids flashed by hand.

Base station (another Pi, or a laptop with a USB radio):
```
RADIO_PORT=/dev/ttyUSB0 npm run base
```
On macOS: a USB-to-serial radio adapter shows up as
`/dev/cu.usbserial-XXXX`, a GPS module's native USB as
`/dev/cu.usbmodemXXXX`:
```
RADIO_PORT=/dev/cu.usbserial-0001 GPS_PORT=/dev/cu.usbmodem1101 npm run base
```
Run `ls /dev/cu.*` before/after plugging in each device to find its path.

### Auto-start on boot (systemd)

```
sudo ./install-service.sh MODE [EXTRA_ARG]
```
`MODE` is one of `boat base rtk basertk markset mark` (Linux only). Named
units: `boat-agent`/`base-station` for those two,
`rtk-station`/`basertk-station`/`markset-station`/`mark-station` for the
rest.

| Mode | `EXTRA_ARG` |
|---|---|
| `boat` | `BOAT_ID` - omit to auto-generate/persist; a plain number (`7`) zero-pads to `00007` |
| `base`, `basertk` | `REGATTAUP_REGATTA_ID` - omit to use `regatta-id.txt` or auto-pick the nearest active/future regatta |
| `mark` | `MARK_NAME` - omit to start unassigned |
| `rtk`, `markset` | none |

Also forces `GPS_LOG=0` for every mode (stdout isn't a TTY under systemd,
so in-place overwrite doesn't apply and every fix would become a permanent
journal entry). Nothing else is overridden - edit the generated unit
directly for other per-machine overrides. Safe to re-run any time
`EXTRA_ARG` changes.

| Script | Does |
|---|---|
| `./service-logs.sh MODE` | Follows logs (`journalctl -u <unit> -f`) |
| `sudo ./service-restart.sh MODE` | Restarts, prints status |
| `sudo ./service-stop.sh MODE` / `service-start.sh MODE` | Stop/start without touching autostart |
| `sudo ./service-autostart.sh MODE [on\|off]` | Controls autostart-on-boot separately; no arg shows status |

### RTK-only mode

```
GPS_PORT=/dev/ttyACM0 npm run rtk
```
`src/rtkStation.js` - a small entry point that only opens the base GPS and
serves Base GPS / Base GPS survey-in / manual-fixed-position cards (same
underlying code `basertk` uses, not a second copy - see
`src/baseGps.js`/`src/rtkAdminCards.js`). No radio, course, fleet, Redis,
or RegattaUp. Unlike plain `base` (GPS only opens if `GPS_PORT` is
explicit), this mode always opens one, falling back to the boat GPS
defaults. Same `ADMIN_PORT` (8092) as other dashboards - run one mode per
machine unless overridden. Has its own filtered `GET /config`.

### Base + RTK combined

```
RADIO_PORT=/dev/ttyUSB0 GPS_PORT=/dev/ttyACM0 npm run basertk
```
`src/baseRtkStation.js` - a thin wrapper (not a second `baseStation.js`)
that sets `RTK_CONTROLS_ENABLED=1` before requiring it: `base`'s full
dashboard plus RTK-only's TMODE3/survey-in cards and
`/api/gps/survey/...` routes. `GET /config` shows the union of both.

Plain `base` still opens `GPS_PORT` when set, but only for the ordinary
"Base GPS" fix card (map's "plant a mark at my position" feature) - no
TMODE3/survey-in cards, and `/api/gps/survey/mode`/`/api/gps/save-config`
404. Use `basertk` when this machine's GPS should actually control RTCM
broadcast to the fleet, not just supply a one-off reading.

### Mark-set mode

```
GPS_PORT=/dev/ttyACM0 npm run markset
```
`src/markSetStation.js` - same thin-wrapper pattern (`MARKSET_MODE=1`).
Changes from plain `base`:

| Change | Detail |
|---|---|
| GPS always on | Not gated on `GPS_PORT` being explicit - falls back to boat GPS defaults |
| Dashboard opens to course map | `GET /` renders `GET /map`; also shows Redis indicator + regatta selector in the topbar |
| Radio disabled outright | Regardless of `RADIO_ENABLED`/`SIMULATE` - a mark edited here still persists to Redis, picked up on base/basertk's next regatta-select or restart |
| Upload server, CSV/Redis fix recording, UDP broadcast, all 4 webhook queues | Skipped entirely, not just hidden |

### Mark mode

```
MARK_NAME=windwardBlack npm run mark
```
`src/markStation.js` - identical to `markset` plus `MARK_MODE=1`, which
prompts on the terminal for a mark assignment if unassigned once startup
settles (same shape as the regatta prompt). That prompt (and `MARK_NAME`,
which skips it) are the only things distinguishing "mark mode" from
"markset mode" - the current **assignment** is runtime state either way,
so a `markset` instance can also be assigned a mark from its own map.

`MARK_NAME` is optional - omit to be prompted (TTY) or start unassigned
(no TTY, e.g. systemd). However set - env var, prompt, or the map's
dropdown - it persists to `race-config/mark-name.txt` (same pattern as
`boat_id.txt`/`regatta-id.txt`).

Once assigned, on the map:
- The assigned mark's row swaps its "Set" button for a "This rover" badge
  - manually setting a mark this device already auto-posts would just
    fight its own next fix. Every other row keeps its normal button.
- Every GPS fix is checked against the last posted position; once moved
  `MARK_DISTANCE_M` (default 1m), it calls the same `setMarkLocation` the
  "Set" button uses - same Redis write, in-memory update, pin-boundary
  republish, broadcast. Only advances "last posted" on success, so a
  transient failure keeps retrying.

Reassigning (or unassigning) is a live change from the dropdown - each
reset posts a first position immediately rather than waiting out a stale
threshold.

**Known limitation:** posting-side only - a *separate*, already-running
`base`/`basertk` process has no way to notice a Redis-side mark change
made by another process while racing (its in-memory course only refreshes
on regatta-select/restart, or its own admin-API edit). Reliable for course
setup and between-race corrections; not yet wired up as a live,
race-time-moving mark an active base re-broadcasts immediately.

**Seeing which rover represents a mark**, from the base's own dashboard
(no need to find the rover's own map page): every mark carries
`assignedBoatId`/`assignedAt` in Redis while a rover's mark mode is
actively posting it, refreshed on every position write and on its own 20s
heartbeat (`MARK_ASSIGNMENT_HEARTBEAT_MS`) - independent of
`MARK_DISTANCE_M`'s movement gate, so a stationary anchored mark still
reads live.

| Where | Shows |
|---|---|
| Course marks card | Badge per mark: green ● + boat id (heartbeat within 60s, `MARK_ASSIGNMENT_STALE_MS`) or amber ○ once stale. Hover for last-update time |
| Fleet table | Inverse lookup: `acting as windwardBlack` badge on the rover's own row, including rovers with no other radio/WiFi presence (mark mode disables both) |

A manual "Set" always clears a mark's attribution, but doesn't stop a
still-live rover's next heartbeat/movement from silently reasserting it -
the badge is how you notice a manual edit didn't stick; reassign/unassign
that rover first.

### Scheduled shutdown (boat, battery-saving)

Set from the rover dashboard's "Scheduled shutdown" card (time, idle
threshold, speed threshold - no restart needed), or pre-configure via
`ROVER_SHUTDOWN_AT` (e.g. `21:00`) before the process starts. Shuts the Pi
down once BOTH the clock has passed that time AND the boat has been idle
(stationary or no fresh fix) for `ROVER_SHUTDOWN_IDLE_MIN` continuous
minutes (default 10) - the idle gate stops a race running late from being
killed mid-track. Disabled by default. Settings persist to
`race-config/power-schedule.txt`. **Linux-only** - refuses to arm on
macOS, so a leftover schedule never shuts down a dev machine.

**Only handles powering DOWN, never back up** - a Pi has no built-in way
to power itself back on; that needs a physical re-power or dedicated wake
hardware this repo doesn't drive.

Requires passwordless `shutdown` for the service's user:
```
echo "jycadmin ALL=(ALL) NOPASSWD: /sbin/shutdown, /usr/sbin/shutdown" | sudo tee /etc/sudoers.d/boat-shutdown
sudo chmod 440 /etc/sudoers.d/boat-shutdown
```
(swap `jycadmin` for the actual service user). Without this, the attempt
fails loudly in the journal and the Pi stays on.

WiFi setup, no desktop needed:
```
sudo ./set-wifi.sh "<SSID>" "<PASSWORD>"
sudo ./set-wifi.sh                     # saves every default network (JYC RC, Rustybit, Bondi-Van, JYC Outer)
./set-wifi.sh -list                    # lists saved networks (no sudo needed)
```
Prefers `nmcli` to *save* credentials as a connection profile - the
network doesn't need to be in range, NetworkManager auto-joins once it is,
so a no-arg run saves every default network in one pass. Falls back to
`raspi-config`'s helper (older Pi OS) if `nmcli` isn't installed - also
range-independent. Blank password = open network. Only adds/updates given
networks, existing ones untouched. If nothing associates, set a WiFi
country code: `sudo raspi-config nonint do_wifi_country <CC>` (one-time).

## Simulation mode (no hardware)

`SIMULATE=1` runs `boat`/`base` with no GPS or radio hardware:
- `src/simGps.js` fakes a landsailer racing a windward-leeward course
  (beating upwind on alternating tacks, running downwind on alternating
  gybes, randomized leg lengths) in place of the real UBX-NAV-PVT parser.
  Races whichever mark pair `SIM_COURSE_MARKS` picks (default `BB`).
- `src/simRadioLink.js` replaces the serial link with a shared UDP
  broadcast carrying the same frames (`protocol.js`) - real
  encode/decode/checksum path exercised end to end, works the same over a
  real LAN as localhost.

```
# terminal 1 - base station
SIMULATE=1 npm run base

# terminal 2 - boat agent
SIMULATE=1 npm run boat
```
For multiple boats, run more instances with different `BOAT_ID`s, or:
```
FLEET_SIZE=5 npm run fleet
```
Spawns `FLEET_SIZE` (default 3) boats as one command, each with a unique
auto-generated `BOAT_ID` and its own dashboard port, output prefixed per
boat. Each exits on its own once it finishes laps
(`SIM_EXIT_ON_FINISH=1`, auto-set); `fleetSim` reports done once the last
one exits. `SIMULATE=1` is assumed; any other `SIM_*` var passes through
to every boat.

Ctrl+C always stops every boat cleanly. Killing by PID also works, but
only the real `fleetSim` `node` process - `npm run fleet`'s outer `npm`
wrapper does not reliably forward the signal. Use `pkill -f
'src/fleetSim.js'` or Ctrl+C.

By default (`SIM_HOLD_FOR_START=1`) the whole fleet gets on the grid and
holds - press SPACE in the fleet's terminal to release everyone at once
(same for a standalone boat, its own terminal). Set
`SIM_HOLD_FOR_START=0` to auto-depart after `SIM_PRESTART_DWELL_S`
seconds instead.

### Simulated GPS with real radio hardware

`SIMULATE_GPS=1` fakes just the GPS track, using real radios on both ends
- for bench-testing range/loss/antenna placement without a GPS fix or
being outdoors. `SIMULATE=1` implies this.

```
# terminal 1 - base station, real radio
RADIO_PORT=/dev/cu.usbserial-A npm run base

# terminal 2 - boat agent, fake GPS + real radio
SIMULATE_GPS=1 RADIO_PORT=/dev/cu.usbserial-B npm run boat
```
A boat has no Redis access, so its simulated GPS won't start until the
base broadcasts marks - with real radio hardware and no `SIMULATE=1` on
the base, Redis needs marks already published first.

CSV logs land in the usual places (`base-logs`/`boat-logs`) regardless of
mode.

| Var | Default | Purpose |
|---|---|---|
| `SIM_PORT` | 41234 | Shared UDP port every simulated boat/base uses |
| `SIM_GPS_HZ` | 2 | Fake GPS fix rate |
| `SIM_UPWIND_SPEED_KN` / `SIM_DOWNWIND_SPEED_KN` | 30 / 55 | Landsailer speed beating vs. running |
| `SIM_CENTER_LAT` / `SIM_CENTER_LON` | 40.8970 / -118.3821 | Course center - only takes effect on a fresh course (nothing published in Redis) |
| `SIM_PACKET_LOSS` | 0 | % chance (0-100) each frame is dropped |
| `SIM_COURSE_LENGTH_NM` | 1 | leewardBlack↔windwardBlack distance (nm). Green marks always sit halfway to center, so short course = half this. Fresh-course-only, like `SIM_CENTER_*` |
| `SIM_START_LINE_POSITION` | 50 | Where start/finish sits along the beat, 0-100% (0=leewardBlack, 100=windwardBlack). Fresh-course-only |
| `SIM_COMMITTEE_GAP_M` | 6 | Gap between `committeeStart`/`committeeFinish` (two independent committee boats). `0` = single shared mark, disables the committee-gap foul. Fresh-course-only |
| `SIM_COURSE_MARKS` | `BB` | Which mark pair to race - 2 letters, windward first, `G`/`B` each |
| `SIM_LAP_COUNT` | 2 | Laps before stopping |
| `SIM_START_ONLY` | unset | `1` = sit forever at start position, emitting a stationary fix stream, instead of racing |
| `SIM_PRESTART_DWELL_S` | 15 | Seconds sitting at start before departing (non-hold mode). `0` = depart immediately |
| `SIM_HOLD_FOR_START` | 1 (on) | Holds fleet at start indefinitely until SPACE is pressed; overrides the dwell timer. `0` = old auto-depart behavior |
| `SIM_FOUL` | unset | `1` = this boat sails upwind then loops back through start/finish/committee-gap the wrong way, for testing `foulWatcher.js`. One boat at a time |
| `SIM_FOUL_WINDWARD_M` | 150 | Distance upwind before the `SIM_FOUL` boat turns back |

Once `SIM_LAP_COUNT` laps complete, simulated GPS stops but the process
keeps running so its upload client can flush any pending log chunk.
Ctrl+C to stop.

## Connecting to your race committee software

`src/baseStation.js` currently:
1. Logs every decoded fix to console + CSV
2. Records every fix to Redis (see below)
3. Re-broadcasts locally over UDP (port 10110, NMEA-over-UDP convention) -
   synthetic `UBX-NAV-PVT` by default (`GPS_OUTPUT_FORMAT=nmea` for
   `$GPGGA` instead). `boatAgent.js` does the same independently, on the
   same port, unthrottled, for onboard instruments.

Once you pick your race software (TracTrac, YB Tracking, RaceQs, Predict
Wind, in-house), `outputFrame()` is the one place to change - swap it for
whatever that software expects (usually an HTTP POST with a per-boat auth
token).

## Lap events -> RegattaUp

Lap detection lives on the base station, not the boat - a rover has no
Redis access, so it only sends raw position. `src/finishLineWatcher.js`
(one instance per boat) watches every fix against the committee/finish
marks and detects a lap the way a real committee would: crossing the
committee↔finish segment while heading upwind (committee to port, finish
to starboard). Unavailable (logged once, not retried) if committee/finish
marks aren't in Redis at startup.

```json
{
  "mode": "lap",
  "regatta_id": "6a44a2531e401d60c28afcd8",
  "decoded": { "tranCode": "51", "rtcTime": 1785337740000000, "strength": 2 },
  "receivedAt": "2026-07-29T15:09:00.604Z"
}
```

| Field | Meaning |
|---|---|
| `mode` | Always explicit `"lap"` - real MyLaps hardware never sends this field |
| `regatta_id` | Current regatta id, omitted if none selected |
| `tranCode` | Boat's ID (string), matched to its RegattaUp transponder code |
| `rtcTime` | Lap timestamp, ms → µs |
| `strength` | Fix's `carrSoln` at crossing, standing in for signal strength |
| `receivedAt` | Base's wall-clock time, fallback timestamp |

### Durable retry queue

A failed webhook POST isn't dropped - `src/lapWebhookQueue.js` durably
records every lap (sqlite via `sql.js`, WASM, no native build) *before*
the first send attempt, removed only once RegattaUp accepts it - survives
a base restart mid-retry. Every lap/on-grid/mark-rounding/foul event is
always queued first; one shared loop drains at most one POST per
`REGATTAUP_POST_INTERVAL_MS` tick across all queues, round-robin, so a
burst (a whole fleet going on-grid at once) doesn't fire concurrent
requests. Failed sends retry with capped exponential backoff (2s, 4s, 8s,
... up to `REGATTAUP_MAX_BACKOFF_MS`), indefinitely.

| Var | Default | Purpose |
|---|---|---|
| `REGATTAUP_WEBHOOK_URL` | `https://regattaup.com/api/functions/mylapsWebhook` | Override for a mock endpoint |
| `REGATTAUP_WEBHOOK_ENABLED` | unset (on) | `0` = skip sending, still detected/logged |
| `REGATTAUP_QUEUE_DB` | `race-config/lap_webhook_queue.sqlite` | Retry queue file |
| `REGATTAUP_POST_INTERVAL_MS` | 500 | Drain-loop interval, all queues combined |
| `REGATTAUP_MAX_BACKOFF_MS` | 300000 (5 min) | Backoff cap per event |

### Testing the lap -> webhook path

```
TEST_LAP_NUMBER=3 npm run base
```
`0` (default) = off. Any positive value sends one synthetic lap straight
into the queue (reported as that lap number) and exits - no radio/GPS/
finish-line detection involved, just the queue → RegattaUp path. Always
exactly one lap, regardless of the number. `TEST_LAP_BOAT_ID` (default 1)
is the attributed boat.

## On-grid detection -> RegattaUp

Separate from laps: `src/onGridWatcher.js` (one per boat) watches every
fix against the **start** side - the pin↔committee segment.

![The on-grid zone: a box along the leeward side of the pin-to-committee line, with a right triangle cut from EACH end - one hypotenuse starting at committee, the other at pin, each running 55° down from the start line to the far edge of the zone, cutting off both bottom corners of the box.](docs/on-grid-zone.svg)

On-grid requires all of:
- Between pin and committee (1m slack at either end for float/projection noise)
- Within `REGATTAUP_ONGRID_ZONE_M` (default 10m) of the line
- Leeward side only (derived from the windwardGreen↔leewardGreen bearing - the only wind direction this app knows)
- Not inside either corner's exclusion triangle (below)

**Corner triangles**: both ends of the box are angled off, not just
committee's. A boat finishing upwind on starboard tack near committee
briefly reads as "on-grid" by the checks above; a boat rounding leeward
mark close past pin can do the same on that side. Each excluded triangle's
hypotenuse starts at that corner's mark and runs `HYPOTENUSE_ANGLE_DEG`
(55°) down into the zone to its leeward edge. The committee-side cut only
applies when `committeeFinish` is within `SAFE_FINISH_SEPARATION_MULTIPLE`
(2 zone-widths) of `committeeStart`; the pin-side cut is always on. Both
are capped at `COMMITTEE_TRIANGLE_MAX_FRACTION` (50%) of the actual
pin↔committee distance, so an aggressively short test course never lets
the two cuts overlap past the line's midpoint.

```json
{ "mode": "ongrid", "regatta_id": "6a44a2531e401d60c28afcd8", "decoded": { "tranCode": "51", "rtcTime": 1785337740000000 } }
{ "mode": "offgrid", "regatta_id": "6a44a2531e401d60c28afcd8", "decoded": { "tranCode": "51", "rtcTime": 1785337745000000 } }
```

`onGridWatcher.check()` re-fires `'ongrid'` on every fix while a boat
stays in the zone, following `TX_DISTANCE_M`'s transmit cadence.
`baseStation.js` throttles what's actually **sent**: only the genuine
zone-entry transition sends by default, but a boat sitting on-grid
continuously for `ONGRID_RESEND_INTERVAL_MS` (30s, not yet its own env
var) gets a fresh send anyway, so a long dwell still reads as "alive."
`offgrid` only sends once, on exit. The same reconnect detection that
triggers a marks re-broadcast (`BOAT_RECONNECT_GAP_MS`, 10s gap) also
clears this latch, so a restarted boat/fleet with a reused `BOAT_ID`
doesn't inherit stale state; "Ping fleet" clears it too.

Same durable-queue mechanics as laps - `src/onGridWebhookQueue.js`, own
sqlite file (`REGATTAUP_ONGRID_QUEUE_DB`), same
`REGATTAUP_POST_INTERVAL_MS`/`REGATTAUP_MAX_BACKOFF_MS`.
`REGATTAUP_WEBHOOK_ENABLED=0` disables lap and on-grid together (no
separate switch). Editing pin/committee from the map clears every boat's
watcher.

Test without a boat sailing off the line:
```
SIM_START_ONLY=1 SIMULATE=1 npm run boat
```

## Mark-rounding detection -> RegattaUp

On by default; `REGATTAUP_MARK_ROUNDING_ENABLED=0` to disable
independently (`REGATTAUP_WEBHOOK_ENABLED=0` still gates everything).

![A boat's track loops through a radius around windwardGreen, sweeping through a wide turning angle before exiting - a genuine rounding. A boat transiting past the same mark on a straight tack barely turns at all while inside the same radius.](docs/mark-rounding.svg)

`src/markRoundingWatcher.js` (one per boat per mark - windward/leeward
have no second mark to form a gate). Detects a rounding by cumulative
turning angle (sign-agnostic) while within
`REGATTAUP_MARK_ROUNDING_EXTENSION_M` (default 50m) of the mark, not by a
synthesized crossing line - a real rounding sweeps ~125° almost entirely
on one side of the course axis (which side depends on approach tack), so
no fixed line catches both directions. A boat merely transiting past
turns at most ~80° (one ordinary tack); `ROUNDING_MIN_SWEEP_DEG` (100)
sits between the two with margin. Watched at all four
windward/leeward marks regardless of which course is sailed.

The green (inner) marks' rounding radius is capped to half the actual
green↔black distance (`OUTER_MARK_SAFETY_FRACTION`), measured fresh each
time a watcher is built, so a black-mark rounding stays clear of the green
radius. Only applies to green marks - black marks are outermost.

```json
{ "mode": "mark", "mark": "windwardGreen", "regatta_id": "6a44a2531e401d60c28afcd8", "decoded": { "tranCode": "51", "rtcTime": 1785337740000000 } }
```
`mark` is which mark was rounded; other fields match laps/on-grid.
`rtcTime` is the interpolated crossing instant, same upsampling as
finish-line laps.

Same durable-queue mechanics - `src/markRoundingWebhookQueue.js`, own
sqlite file (`REGATTAUP_MARK_ROUNDING_QUEUE_DB`). Editing any mark clears
every boat's mark-rounding watchers.

## Foul detection -> RegattaUp

On by default; `REGATTAUP_FOUL_ENABLED=0` to disable independently
(`REGATTAUP_WEBHOOK_ENABLED` still gates it).

`src/foulWatcher.js` (one per boat) watches the three start/finish
segments: `pin↔committeeStart` (start line), `committeeStart↔committeeFinish`
(gap between committee boats), `committeeFinish↔finish` (finish line).
Start/finish each have one legal (upwind) crossing direction; the middle
segment has none - any crossing there is a foul.

```json
{ "mode": "foul", "reason": "downwind finish line", "regatta_id": "6a44a2531e401d60c28afcd8", "decoded": { "tranCode": "51", "rtcTime": 1785337740000000 } }
```

| `reason` |
|---|
| `downwind start line` |
| `downwind finish line` |
| `through committee gap` |
| `downwind pin boundary` (only while the pin boundary gate, below, is on) |

Same durable-queue mechanics - `src/foulWebhookQueue.js`, own sqlite file
(`REGATTAUP_FOUL_QUEUE_DB`).

**Not yet handled on RegattaUp's side** - `mylapsWebhook` doesn't branch
on `mode: "foul"` yet; falls into the "unknown mode" catch-all
(`skip_reason: "unknown mode: foul"`, safe no-op). A `Foul` entity and
matching webhook branch are being built separately on the RegattaUp
platform.

### Testing with SIM_FOUL

```
# terminal 1 - base station
SIMULATE=1 npm run base

# terminal 2 - the boat, in foul-test mode
SIMULATE=1 SIM_FOUL=1 npm run boat
```
Holds on the grid (press SPACE to release), sails `SIM_FOUL_WINDWARD_M`
upwind, loops back through start line, finish line, committee gap (if a
real gap exists), and the pin boundary (if the gate was on when the boat
started) - each the wrong way. Watch terminal 1 for orange
`[baseStation] boat=... foul - ...` lines, followed by
`[regattaup] foul webhook sent...`. Add `REGATTAUP_WEBHOOK_ENABLED=0` to
see detection without posting.

To include the pin-boundary line, turn the gate on (checkbox on `/map`,
or `curl -X POST http://localhost:8092/api/pin-boundary -H 'Content-Type:
application/json' -d '{"enabled": true}'`) *before* starting the boat -
the simulator reads the flag once at startup.

Missing crossings? Confirm both processes started fresh against the
course you expect - `SIM_COMMITTEE_GAP_M=0` means no committee-gap
crossing (nothing to cross), and the pin-boundary crossing only appears
if the gate was already on when the boat started.

### Pin boundary gate

Optional, off by default: a checkbox on the base admin map that makes the
entire pin side of the course illegal to sail through downwind,
indefinitely - without it, a boat can legally escape past the pin end of
the line. On: the whole port side stops being an option downwind; a boat
must come back through the finish gate.

No position to set, just on/off. Toggling persists to Redis immediately,
re-broadcasts, and draws a dashed red line continuing the
committeeStart→pin bearing far past pin (`getPinBoundaryFarPoint` - 50x
the start line's length, floored at 500m). The line is a visual
convenience only - the actual rule has no far edge; a boat can only clear
it by turning back through the finish gate. `simGps.js` treats this as a
hard constraint once on (tack selection, line-clearing, and the
finished-boat parking route all account for it, parking east of finish
regardless of the gate).

`npm run reset-course` always turns this back off, same as every other
mark. Synced to RegattaUp with no backend changes: on, `baseStation.js`
publishes a computed `mark:pinBoundary` entry that RegattaUp's generic
`mark:*` scan picks up automatically; off, the key is simply absent.

## File layout

Everything lands in one of four git-ignored directories, all relative to
the repo root by default. **A boat and a base never share a directory**,
even on the same machine:

```
race-config/                                 - small per-device identity/state (fixed location, not redirectable)
  boat_id.txt                                  this device's own persistent BOAT_ID, auto-generated if unset
  mark-name.txt                                this device's mark assignment, if any
  regatta-id.txt                               this base's default regatta selection
  power-schedule.txt                           this boat's scheduled-shutdown settings
  course_marks.json                            a boat's local cache of the last-broadcast course
  lap_webhook_queue.sqlite                      RegattaUp webhook retry queues
  ongrid_webhook_queue.sqlite
  mark_rounding_webhook_queue.sqlite
  foul_webhook_queue.sqlite

boat-logs/                                   - BOAT ONLY: this boat's own chunked SD-card log (BOAT_LOG_DIR to redirect, e.g. an SD card mount)
  boat<boatId>_<chunk>.csv

base-logs/<regattaId>/                       - BASE ONLY: base's own received-fix CSV log, nested per regatta (BASE_LOG_DIR to redirect)
  base_station_received_<date>.csv

base-uploads/<regattaId>/<boatId>/           - BASE ONLY: each boat's uploaded SD-card logs, nested per regatta then per boat (BASE_UPLOAD_DIR to redirect)
  boat<boatId>_<chunk>.csv
```

| Dir | Redirectable | Regatta-nested | Notes |
|---|---|---|---|
| `race-config/` | No (fixed) | No | Small, low-write identity/state; survives independent of wherever raw log data is pointed (e.g. a swapped SD card) |
| `boat-logs/` | `BOAT_LOG_DIR` | No | A boat can't reliably know a regatta boundary - it only sees fixes and broadcasts |
| `base-logs/` | `BASE_LOG_DIR` | Yes (`none` if unselected) | Switching regattas starts fresh local history |
| `base-uploads/` | `BASE_UPLOAD_DIR` | Yes | Base-only even though uploaded *from* boats |

`npm run clear-base-logs` clears the active regatta's `base-logs/` +
`base-uploads/` only, never `boat-logs/`. `npm run clear-boat-logs` clears
`boat-logs/` only. `npm run boat` never writes `base-logs/` or
`base-uploads/`.

## Redis track storage

Every fix the base decodes is recorded via `src/redisStore.js`
(`REDIS_URL`, default `redis://127.0.0.1:6379`). **Everything lives under
`regattas:<regattaId>:...`** - one self-contained namespace per regatta,
no exceptions, so multiple regattas (or base stations) can share one
Redis instance without collisions. Which regatta is selected is never
itself stored in Redis (see "Selecting a regatta at startup"). `<regattaId>`
is `none` for anything recorded with no regatta selected.

| Key | Contents |
|---|---|
| `regattas:<id>:mark:<name>` | Hash: `lat`/`lon`, plus `assignedBoatId`/`assignedAt` while a mark-mode rover actively posts it |
| `regattas:<id>:course:pin_boundary_enabled` | On/off flag; when on, also publishes `mark:pinBoundary` (computed) for RegattaUp's generic scan |
| `regattas:<id>:course:on_grid_zone` | JSON array of `{lat, lon}` - the exact polygon `OnGridWatcher` tests against, republished on every marks broadcast |
| `regattas:<id>:boat:<boatId>:track` | Sorted set per boat, scored by fix timestamp. `getBoatTrack(boatId, fromMs, toMs, regattaId)` |
| `regattas:<id>:all:track` | Sorted set, every boat's fixes for the regatta. `getAllTrack(fromMs, toMs, regattaId)` |
| `regattas:<id>:boats:known` | Set of boat IDs that reported in. `knownBoatIds()` |
| `regattas:<id>:boats:start_slots` / `:start_slot_counter` | Assigned start-line slots. `getOrAssignStartSlot` |

Each stored fix: decoded frame (`boatId, timestamp, lat, lon, speedKnots,
headingDeg, gnssFixOk, carrSoln, numSV`) + `receivedAt`. If Redis is
unreachable, `baseStation.js` logs and keeps running - console/CSV/UDP
unaffected.

### If Redis runs out of space

- **Auto-expiry**: track keys get a TTL (`REDIS_TRACK_RETENTION_HOURS`,
  default 48h) set once, on the first write of each day - not refreshed
  per-write, so a day's races age out together ~2 days after that day's
  *first* fix. Marks/regatta selection/on-grid zone/pin boundary never
  expire.
- **Graceful degradation**: a failed track write is caught in
  `redisStore.js`, never thrown - console/CSV/UDP and lap/on-grid/
  mark-rounding/foul detection (in-memory watchers + sqlite queues, not
  live Redis reads) are unaffected. Only new track history stops
  accumulating. Rate-limited console warnings (once, then ≤1/30s) and an
  amber Redis-status dot on the dashboard.

The "Redis memory" card shows usage against `REDIS_MEMORY_LIMIT_MB`
(default 250) - set to your actual plan size; a managed instance typically
won't report its own limit via `CONFIG GET`.

**Eviction policy**: for proactive eviction before writes fail, set
`volatile-ttl` on the instance (via the provider's console, not this app)
- only evicts keys with a TTL (i.e. only track history, oldest day first).
Avoid `allkeys-lru`/`allkeys-random` - those can evict an in-progress
race's own track key.

### Switching between Redis servers

`REDIS_URL`, if set, wins outright over `REDIS_ENV` (not merged).
`REDIS_ENV` picks a preset in `config.js` (default `local`,
`127.0.0.1:6379`; `production` points at Redis Cloud - credentials go in
environment/`.env`, never source):

```
REDIS_ENV=production REDIS_PASSWORD=<password> npm run base
```

| Var | Default | Notes |
|---|---|---|
| `REDIS_USERNAME` | `default` | Redis Cloud's default ACL user |
| `REDIS_PASSWORD` | none | Required for `production` |
| `REDIS_TLS` | unset | `1` if the database requires TLS |

`REDIS_URL` works for anything outside the two presets - a full connection
string, overriding `REDIS_ENV` and making the three vars above irrelevant.
Every Redis-talking process (`base`, `reset-course`, `clear-base-logs`)
resolves identically via `config.redis`.

### Clearing boat data (`clear-base-logs` / `clear-boat-logs`)

```
npm run clear-base-logs
```
Deletes every boat-related Redis key (tracks, `all:track`, `boats:known`,
start-slot assignments) for the **currently selected regatta only** -
course marks untouched, other regattas untouched. Also clears this base's
own local files for that regatta
(`BASE_LOG_DIR/<regattaId>/base_station_received_*.csv`,
`BASE_UPLOAD_DIR/<regattaId>/`) plus anything left in the old
pre-regatta-nesting flat layout. Never touches `BOAT_LOG_DIR`. Respects
`REDIS_ENV`/`REDIS_URL`.

```
npm run clear-boat-logs
```
Run on the boat: deletes every chunked CSV (and `.uploaded` marker) under
`BOAT_LOG_DIR` - full local history reset. Doesn't touch `boat_id.txt` (no
new `BOAT_ID`) or `BASE_LOG_DIR`. No regatta scoping - a boat has no
regatta concept.

### Changing the course

Eight marks (`src/course.js`'s `MARK_NAMES`): `pin`, `committeeStart`,
`committeeFinish`, `finish` (start/finish complex, two independent
committee boats), plus green (short course) and black (long course)
windward/leeward pairs on the same axis. `SIM_COURSE_LENGTH_NM` sets the
black-pair length; green always sits halfway to center. `SIM_COURSE_MARKS`
picks which pair the simulator actually races.

```
npm run reset-course
```
Deletes all eight `mark:*` keys plus the on-grid zone and pin-boundary
flag for the currently-resolved regatta, then immediately republishes a
fresh course from current `SIM_*` defaults - one atomic command, never a
gap where marks are just gone. Prints every geometry parameter before
publishing. Never touches other regattas or boat tracks (pair with
`clear-base-logs` for that).

**This is the only thing that resets published marks.** Changing
`SIM_COURSE_LENGTH_NM`/`SIM_CENTER_LAT`/`SIM_CENTER_LON`/
`SIM_START_LINE_POSITION`/`SIM_COMMITTEE_GAP_M` does nothing to an
already-published course - `base` checks the actual published course
against requested values on startup and warns loudly rather than changing
anything, since this Redis can be the same one a real committee's course
is published on. Run `reset-course` first, then restart. (An older
single-mark/single-committee `course_marks.json` cache on a boat is
detected and ignored automatically, no crash.)

### Broadcasting marks to the rovers

A rover has no Redis access, so the base periodically radios the current
marks out using a second frame type (`protocol.js`'s
`encodeMarks`/`decodeMarks`, own sync byte). Each boat keeps marks in
memory and writes them to `race-config/course_marks.json`, so a
reboot/restart has a last-known course immediately. Best-effort, not
guaranteed sync - a missed broadcast just waits for the next one.

The base broadcasts the moment marks resolve (polls Redis every 5s until
published, not a one-shot check) and again immediately whenever a
previously-unseen `boatId` is heard from. `MARKS_BROADCAST_INTERVAL_MS`
(default 60000) governs the ongoing heartbeat re-send as a safety net.

Works the same in `SIMULATE=1` - `simRadioLink.js` has every simulated
boat and the base bind the same shared UDP port (`SIM_PORT`), mirroring
real RF sharing (no per-boat host tracking), and works unchanged over a
real LAN, not just localhost.

A boat's very first start with `SIMULATE_GPS`/no real GPS closes a
chicken-and-egg gap itself: `boatAgent.js` sends one throwaway frame at
startup (before real marks exist) so the base hears the `boatId` and
broadcasts right away, using a best-guess position (last-known marks from
disk, or `SIM_CENTER_LAT`/`SIM_CENTER_LON`) rather than `(0,0)`, avoiding
a spurious crossing on the first real fix.

### Log rotation

CSV logs (boat SD log, base received-fix log) are pruned automatically:
anything older than `LOG_RETENTION_DAYS` (default 7) is deleted, checked
at startup and on every write. See `src/logRotation.js`.

| | Location | Segmented by |
|---|---|---|
| Boat log | `BOAT_LOG_DIR` (default `boat-logs/`) | Per boat + time chunk (`boat<id>_<YYYY-MM-DDTHH-MM>.csv`, `LOG_CHUNK_MINUTES` wide, default 10min). Keyed by the fix's own GPS timestamp, not wall-clock write time - a restart resumes the current chunk |
| Base log | `BASE_LOG_DIR` (default `base-logs/`) | Per day, nested per regatta (`none` if unselected) - switching regattas starts a fresh file even same-day |

Neither prunes rows within a file still being written, only whole aged-out
files. The webhook retry queues aren't touched here - they self-clean on
delivery.

### Disk space

Both dashboards show a "Disk space" card (free/total, green **OK**/red
**ALERT** below 10% free) for the filesystem holding that side's log
directory. See `src/diskSpace.js`.

If free space drops to **5%** despite age-based pruning, both sides run an
independent check every 60s (`pruneForDiskSpace`) that starts **deleting
the oldest CSV log files** (one at a time, re-checking after each) until
back above 5% or nothing's left. Last-resort safety valve, logged loudly
each time. Never touches `base-uploads`, webhook queues, or the other side
of the radio link.

### Uploading boat logs to the base over WiFi

A boat's SD card log is the durable backup if the radio drops - if the
boat's WiFi reaches the base (dockside, at the trailer), it also pushes
completed chunk files there as an off-boat copy
(`src/uploadServer.js`/`src/uploadClient.js`).

**Discovery**: the base doesn't need to be configured into the boat - it
publishes its own LAN IP and upload port alongside the marks broadcast
(auto-detected, override with `BASE_IP` if wrong interface picked). A boat
that's never received a broadcast (or got `0.0.0.0`) just doesn't attempt
uploads yet.

`UPLOAD_ENABLED` (default on) only gates the file transfer - the periodic
health-check ping (also how the base learns a boat's IP/admin port) always
runs.

**Fault tolerance**:
- Boat polls (`UPLOAD_CHECK_INTERVAL_MS`, 15s) rather than holding a connection
- Each attempt times out (`UPLOAD_TIMEOUT_MS`, 5s)
- Base writes to `.part` and only renames on full arrival - a dropped connection never leaves a truncated real file
- Boat only marks a file uploaded (`<file>.csv.uploaded` marker) after a 200 - a lost ack just means a harmless re-upload
- The chunk currently being written is never a candidate
- One file at a time, oldest first

Lands in `BASE_UPLOAD_DIR` (default `base-uploads`, separate from
`base-logs`), nested `<regattaId>/<boatId>/`. **Not** pruned by
`LOG_RETENTION_DAYS` or emergency low-disk cleanup - meant to be the
durable centrally-collected copy. `UPLOAD_ENABLED=0` skips uploads only
(health-check ping still runs).

The boat gzips each file before sending (small files, but a better chance
of finishing inside a marginal WiFi window); the base decompresses on
arrival, so `base-uploads` holds plain readable `.csv` files.

### Admin dashboard

Live-stats page on the base station (`src/adminServer.js`, default port
8092, `http://<base-ip>:8092`): boats seen, tracks recorded, tracks/laps
per boat, radio link quality, upload activity. Reloads every 5s; `GET
/api/stats` for the same data as JSON. Applies to both `npm run base` and
`npm run basertk` (`rtk`'s own smaller dashboard is separate, see
"RTK-only mode").

In-memory only (`src/stats.js`) - resets on restart. Durable records are
Redis (tracks) and `base-uploads` (files); the dashboard reflects both
plus things Redis doesn't track (link quality, upload counts).

**Radio frames card**'s "Frames/sec" row is the same live, rolling-1s-window
rate the bandwidth card below uses (last *completed* second, not a
lifetime average) - the card's own big number is still the all-time
cumulative count.

**Radio bandwidth card**: live bytes/sec in each direction (↓ in, ↑ out),
plus a small scrolling sparkline of the last 60 seconds. Both
`RadioLink`/`SimRadioLink` emit a `bytes` event on every real read/write -
counting every byte that actually crossed the link (corrupted/resynced
ones included, on the real-radio side - not just successfully-decoded
frames), never bytes that were only *attempted* (a send skipped due to
backpressure, or `SIM_PACKET_LOSS`, doesn't count - see "What happens when
a send fails" above). Sampled into 1-second buckets independently of the
page's own 5s reload, so the window a page load embeds is always a true
continuous 60s history, not one resampled to match reload timing. Under
`SIMULATE=1` this reflects real UDP traffic with no real airtime ceiling
to compare against (same caveat as `radio-congestion`'s own docs); under
`RADIO_ENABLED=0` the card just shows "no radio."

**Regatta card**: picks which RegattaUp regatta this base reports for
(`POST /api/functions/getActiveRegattas`, refreshed every
`REGATTAUP_REGATTAS_REFRESH_INTERVAL_MS`), persisted to `regatta-id.txt`.
Shows a warning if nothing's selected. The whole regatta object is stored,
so a regatta that later drops off RegattaUp's "active" list still gets
reported for until its own `end_date` passes, then auto-clears with a
console warning.

### Selecting a regatta at startup

Resolved before touching the course at all, logged as
`[baseStation] regatta: ...`. Never stored in Redis - a shared Redis
instance would otherwise have every base fighting over one global value;
selection is entirely local to this process/machine.

| Order | Source | Notes |
|---|---|---|
| 1 | `REGATTAUP_REGATTA_ID` env var | Persisted to `regatta-id.txt` immediately, must match an active/future regatta |
| 2 | `regatta-id.txt` | Whatever was last used (env var or a pick) |
| 3 | Interactive terminal prompt | Only with a real TTY attached; lists active/future regattas, re-prompts on invalid input |
| 4 | Auto-pick nearest active/future regatta | Only with no TTY (systemd/piped) - 0 distance if currently running, else distance to nearer boundary |

If nothing resolves (no TTY and an empty active/future list), the base
starts with no regatta selected - pick one from the dashboard. Whichever
gets selected, by any path, persists to `regatta-id.txt` on this machine
only; a different base keeps its own independent selection.

**Ping fleet** button: broadcasts a request for every boat to report its
position now (`POST /api/ping-fleet`, `protocol.js`'s `encodePing`) -
useful for a boat stationary since before the dashboard came up (past its
one-time `TX_DISTANCE_M` clear, waiting on the 60s `TX_INTERVAL_S`
heartbeat). Each boat replies after a random `PING_RESPONSE_JITTER_MS`
delay (default 3000) so a full fleet doesn't key up at once. Also clears
every boat's on-grid dedup latch, so the reply's on-grid status is
actually sent to RegattaUp.

### Boat startup announcement ("hello")

Opposite direction from Ping fleet: a boat announces itself the moment its
radio connects (`protocol.js`'s `encodeHello`/`decodeHello`,
`boatAgent.js`'s `startHelloAnnounce`) - a cold GPS start can take
minutes, and without this the base had no way to know a boat's radio was
alive until its first real fix. Carries just the boat's id, sent after a
random `HELLO_STARTUP_JITTER_MS` delay (default up to 3s - same reasoning
as Ping fleet's own jitter above: a whole fleet's radios connecting
together, e.g. everyone powering on right before a start, would otherwise
announce in lockstep and keep colliding on every retry), then retried
every 5s (`HELLO_RETRY_MS`, inheriting that same random offset) until the
first real fix transmits. Base-side, only updates the Fleet table's "last
seen" - never written to CSV/Redis/RegattaUp. Not gated on a regatta being
selected.

**Base GPS card** (when `GPS_PORT` is set): the receiver's ordinary
NAV-PVT fix - fix quality, position, altitude (both MSL and WGS84
ellipsoid), satellite count, h/v accuracy, DOP (labeled
excellent/good/fair/poor), ground speed, satellite-derived UTC clock.

**Base GPS survey-in card** (`rtk`/`basertk` only): current TMODE3 mode
(disabled/survey-in/fixed), and while surveying, progress against both
completion conditions - elapsed vs. `GPS_SVIN_MIN_DUR_S`, accuracy vs.
`GPS_SVIN_ACC_LIMIT_MM` (e.g. `27835s / 60s, ±19.83m / 2.00m`). Once
`fixed`, shows the position TMODE3 is actually fixed to (read back from
the poll, reflecting reality regardless of what configured it). Polled
once on connect and every 15s (`UBX-CFG-TMODE3`); NAV-SVIN streams on its
own once enabled.

| Button | Does |
|---|---|
| Survey-in | (Re)starts survey-in with `GPS_SVIN_MIN_DUR_S`/`GPS_SVIN_ACC_LIMIT_MM`, RAM only |
| Survey-in & save | Same, persisted immediately - fixes a receiver that reboots back into a bad `Fixed` position |

Manual-position form: no separate "lock to my current fix" button - the
three fields prefill from whatever's known (fixed position → completed
survey → live fix), so "click Set and save" with the prefill *is* that.
Validated client-side (fast) and server-side in `setBaseGpsFixed` (lat
±90°, lon ±180°, height -500-9000m). Confirm dialog spells out the exact
numbers being sent.

Every button POSTs `/api/gps/survey/mode` (only registered under
`rtk`/`basertk`) with `{"mode": "survey-in"}` or `{"mode": "fixed", lat,
lon, heightM}`.

**No standalone "save" button** - saving is always a modifier on the
action ("& save" variants), since raw `UBX-CFG-TMODE3` only changes live
RAM config; without saving, TMODE3 silently reverts on restart (the exact
mechanism behind a receiver stuck rebooting into a stale `Fixed`
position). Any "& save" sends a follow-up `UBX-CFG-CFG`, persisting to
both BBR and flash - ArduSimple boards typically rely on BBR (supercap or
coin cell backed), targeting flash too is harmless when absent. BBR
persistence only lasts as long as its backup power does.

A boat's "pending uploads" figure rides on the same health-check ping used
for reachability - the base has no other way to see what's unsent on an
SD card.

**Map** (`GET /map`, linked as "map ↗" once marks are known): all seven
marks over Esri World Imagery satellite tiles (no street basemap - these
courses are dry lake beds), black marks outlined for contrast, start/finish
lines drawn in, auto-fit to the course. Needs internet access in the
viewing browser (not the base's own connectivity). Any boat heard this
session gets a dot (green within the last minute, gray otherwise) - sourced
only from in-memory `stats.js`, never `base-uploads` history.

"Auto-refresh boats (5s)" checkbox (on by default, `localStorage`) polls
`GET /api/positions` (leaner than `/api/stats`, no Redis track-count
query) without reloading the page, so panning/zooming isn't undone. A
boat's own `GET /map` has the same toggle, polling `GET /api/position`
for just its own marker.

#### Editing mark positions from the map

"Edit marks" checkbox reveals a column of all seven marks with "Set"
buttons, plus a fixed crosshair at map center. Workflow: walk/sail to the
mark, snap the map to your position, fine-tune by panning (crosshair
always shows `map.getCenter()`), tap "Set" - confirms first, since it
immediately updates the live course and re-broadcasts. Checkbox state
persists across reloads; the confirm step is what guards against
accidental edits.

The base's edit column has one more control at the bottom (not on a
boat's map): the pin boundary gate checkbox (see above) - plain on/off,
its own confirm, no crosshair.

Each GPS-recenter button has a live coordinate readout above it, updated
continuously while edit mode is on (`watchPosition()`,
`enableHighAccuracy: true`) rather than a blind one-shot lookup - the
readout doubles as proof it's working. RTK-based readouts (base/boat GPS)
also show fix quality and `hAcc`.

| Recenter button | Source |
|---|---|
| Recenter on my GPS | Viewing device's location (browser Geolocation API) - needs a secure context (HTTPS/localhost), may be blocked over plain HTTP on a LAN |
| Recenter on marks | Snaps back to fit the whole course |
| Recenter on base GPS (base map only) | GPS wired to the base machine (`GPS_PORT`/`GPS_BAUD`) - for planting a mark with RTK precision, not tracking the base |
| Recenter on boat GPS (boat map only) | That boat's own already-flowing fix |

Setting a mark persists to Redis, clears cached finish-line watchers (so
lap detection picks up a corrected committee/finish position), and
re-broadcasts (`POST /api/marks/:name`). A boat's own "Set" has no local
Redis access, so it POSTs cross-origin to the base's `/api/marks/:name`
(CORS-enabled) - only works while the boat has WiFi to the base. A
successful edit doesn't repaint the boat's own marker immediately (marks
don't live-poll) - reload after the next broadcast.

Fleet table sorts most-recently-seen first; boats never heard from this
session sink to the bottom, ordered by ID.

Both dashboards also have:
- **config** (`GET /config`) - fully-resolved config, same data as `npm
  run print-config`, overridden rows called out (`src/configReport.js`)
- **console** (`GET /console`) - last 100 log lines, refreshes every 5s,
  works the same under systemd (`src/logBuffer.js` ring buffer, fed from
  the shared `console.log`/`warn`/`error` wrapper)

Each boat runs its own matching dashboard (`src/roverAdminServer.js`,
also port 8092, `8093` under `SIMULATE=1` to coexist with a local base):
"Last fix" and "Fix quality" cards (same row-per-field format as the
base's "Base GPS" card), course-received status, frames sent, "Base
station" card (address, dashboard link, upload port, last health check),
upload history, and its own `GET /map` (plots that boat's own position
too). The dashboards link to each other automatically - each learns the
other's IP/port at runtime (boat reports its own on the health-check
ping; base reports its own on the marks broadcast) - a link only appears
once that information has arrived.

## Tuning knobs (env vars)

`npm run print-config` prints the fully-resolved config - every default
plus overrides via environment/`.env` - one place to check what a run will
actually use. Redis password is redacted.

| Var | Default | Purpose |
|---|---|---|
| `SIMULATE` | unset | `1` = no GPS/radio hardware - fake GPS + UDP radio stand-in |
| `SIMULATE_GPS` | unset | Fake GPS only, real radio on both ends. Implied by `SIMULATE=1` |
| `GPS_OUTPUT_FORMAT` | `ubx` | Local UDP broadcast format: `ubx` (synthetic NAV-PVT) or `nmea` (`$GPGGA`) |
| `UDP_PORT` / `UDP_BROADCAST_ADDR` | 10110 / `255.255.255.255` | Local UDP broadcast target, both roles |
| `GPS_PORT` / `GPS_BAUD` | `/dev/ttyAMA0` / 115200 | GPS UART. Boat always opens it unless `SIMULATE`/`NO_GPS`. `rtk`/`basertk` always try it. Plain `base` only if explicitly set and not `SIMULATE=1` |
| `GPS_LOG` | unset (on) | `0` = silence the per-fix `[gps]`/`[baseGps]` console line |
| `GPS_LOG_REPLACE` | unset (on) | In-place overwrite of the console line on a real TTY (a real radio-send commit still scrolls). `0` = always scroll |
| `GPS_LOG_RTCM` | unset (off) | Boat only - `1` logs `[rtcm]` per `UBX-RXM-RTCM` message; also needs that message enabled on the receiver |
| `GPS_SVIN_MIN_DUR_S` | 60 | `rtk`/`basertk` only - minimum survey-in duration (s) |
| `GPS_SVIN_ACC_LIMIT_MM` | 2000 | `rtk`/`basertk` only - required survey-in accuracy (mm) |
| `RADIO_PORT` / `RADIO_BAUD` | `/dev/ttyUSB0` / 115200 | Telemetry radio UART - 115200 is NOT the factory default, every radio must be reconfigured |
| `RADIO_TEST_MODE` / `RADIO_TEST_INTERVAL_MS` | unset / 500 | `radio-test` only - `send`/`listen`, send interval |
| `BOAT_COUNT` / `CONGESTION_SPEED_KN` | 30 / 26.1 | `radio-congestion` only - simulated boat count, assumed speed (knots; 26.1 ≈ 30mph) |
| `BOAT_ID_OFFSET` | 0 | `radio-congestion` only - shifts this instance's boat ids up by this many, so several instances on separate real radios can run at once with disjoint ranges - see "Congestion-testing the radio" above |
| `RADIO_ENABLED` | unset (on) | `0` = skip opening the radio port entirely |
| `NO_GPS` | unset | Boat only - `1` skips any GPS source, real or simulated |
| `BOAT_ID` | auto-persisted | Exactly 5 chars, overrides this device's persisted id |
| `MARK_NAME` | unset | `mark`/`markset` - which mark this device auto-posts, persisted to `mark-name.txt` |
| `MARK_DISTANCE_M` | 1 | `mark`/`markset` - movement gate before posting a mark update |
| `TX_DISTANCE_M` | 1 | Movement gate for radio send + SD log. Keep smaller than the finish-gate width - lap detection only sees transmitted positions |
| `TX_FINISH_APPROACH_ZONE_M` | 0 (off) | Boat only - within this many meters of the finish line, closing on it while sailing upwind, `TX_DISTANCE_M` is replaced by `TX_FINISH_DISTANCE_M` below for much more frequent reporting right at a close finish. `0` disables this entirely (`TX_DISTANCE_M` applies everywhere) - off by default until the rover's actual achievable fix spacing at real finish speeds is validated in the field |
| `TX_FINISH_DISTANCE_M` | 0.3 | Boat only - the tightened movement gate itself, only in effect inside `TX_FINISH_APPROACH_ZONE_M` |
| `TX_INTERVAL_S` | 60 | Heartbeat alongside `TX_DISTANCE_M` - always sends at least this often. `0` disables (distance gate only) |
| `TX_BATCH_SIZE` | 1 | How many consecutive fixes to pack into one radio transmission - `1` (default) sends one frame per fix, unchanged from before this existed. Clamped to `MAX_BATCH_COUNT` (4 - this fleet's actual radio hardware's own payload limit, see "Batching multiple fixes per send" above), not the wire format's own theoretical cap |
| `ROVER_SHUTDOWN_AT` | unset (off) | Boat only - 24h local time (`"HH:MM"`) after which shutdown can trigger |
| `ROVER_SHUTDOWN_IDLE_MIN` | 10 | Boat only - continuous idle minutes required after `ROVER_SHUTDOWN_AT` |
| `ROVER_SHUTDOWN_SPEED_KN` | 0.5 | Boat only - speed below which a fix counts as stationary |
| `ROVER_SHUTDOWN_CHECK_INTERVAL_MS` | 30000 | Boat only - shutdown gate re-check interval |
| `PING_RESPONSE_JITTER_MS` | 3000 | Boat only - max random delay replying to "Ping fleet" |
| `HELLO_STARTUP_JITTER_MS` | 3000 | Boat only - max random delay before the first hello announcement (and, since the retry interval inherits it, every retry after) - see "Boat startup announcement" above |
| `MARKS_BROADCAST_INTERVAL_MS` | 60000 | Base only - course re-broadcast heartbeat |
| `LOG_RECEIVED_FIXES` | unset (off) | Base only - `1` = console-echo every received frame. CSV/Redis/detection always run regardless |
| `BASE_LOG_DIR` | `./base-logs` | Base only - received-fix CSV location |
| `BOAT_LOG_DIR` | `./boat-logs` | Boat only - SD-card CSV location |
| `LOG_RETENTION_DAYS` | 7 | CSV files older than this are auto-deleted |
| `LOG_CHUNK_MINUTES` | 10 | Boat only - CSV chunk width |
| `UPLOAD_ENABLED` | unset (on) | Boat only - `0` skips log uploads (health-check ping still runs) |
| `UPLOAD_LOG` | unset (off) | Both roles - `1` logs each successful upload |
| `UPLOAD_PORT` | 8090 | Base only - log-upload HTTP server port |
| `BASE_UPLOAD_DIR` | `base-uploads` | Base only - uploaded boat logs location |
| `BASE_IP` | unset (auto) | Base only - override auto-detected LAN IP |
| `UPLOAD_CHECK_INTERVAL_MS` / `UPLOAD_TIMEOUT_MS` | 15000 / 5000 | Boat only - base-reachability poll interval/timeout |
| `ADMIN_PORT` | 8092 (boat: 8093 under `SIMULATE=1`) | Every mode - dashboard port |
| `REDIS_ENV` | `local` | Base only - `local`/`production` preset. Ignored if `REDIS_URL` set |
| `REDIS_USERNAME` / `REDIS_PASSWORD` / `REDIS_TLS` | `default` / unset / unset | `production` preset credentials - never hardcode |
| `REDIS_URL` | unset | Base only - full connection string, wins over `REDIS_ENV` and the credential vars |
| `REDIS_MIN_MOVEMENT_M` | 1 | Base only - skip a Redis track write below this movement |
| `REDIS_TRACK_RETENTION_HOURS` | 48 | Base only - track key TTL |
| `REDIS_MEMORY_LIMIT_MB` | 250 | Base only - "Redis memory" card's usage denominator |
| `REGATTAUP_WEBHOOK_URL` | RegattaUp's lap webhook | Base only - independent of `REGATTAUP_ACTIVE_REGATTAS_URL` |
| `REGATTAUP_WEBHOOK_ENABLED` | unset (on) | Base only - `0` disables all four webhook types |
| `REGATTAUP_ACTIVE_REGATTAS_URL` | `.../getActiveRegattas` | Base only - regatta-selector fetch source |
| `REGATTAUP_REGATTA_ID` | unset | Base only - selects at startup, persists to `regatta-id.txt` |
| `REGATTAUP_REGATTAS_REFRESH_INTERVAL_MS` | 300000 (5 min) | Base only - active-regattas background refresh |
| `REGATTAUP_LOG_ACTIVE_REGATTAS` | unset (off) | Base only - `1` logs each successful background refresh |
| `REGATTAUP_QUEUE_DB` / `POST_INTERVAL_MS` / `MAX_BACKOFF_MS` | see "Durable retry queue" | Lap webhook queue tuning; interval/backoff shared with on-grid and mark-rounding |
| `REGATTAUP_ONGRID_ZONE_M` | 10 | Base only - on-grid zone width (m) |
| `REGATTAUP_ONGRID_QUEUE_DB` | `race-config/ongrid_webhook_queue.sqlite` | On-grid retry queue file |
| `REGATTAUP_MARK_ROUNDING_ENABLED` | unset (on) | Base only - `0` disables independently |
| `REGATTAUP_MARK_ROUNDING_EXTENSION_M` | 50 | Base only - rounding-gate radius (m), capped to half the green↔black distance |
| `REGATTAUP_MARK_ROUNDING_QUEUE_DB` | `race-config/mark_rounding_webhook_queue.sqlite` | Mark-rounding retry queue file |
| `REGATTAUP_FOUL_ENABLED` | unset (on) | Base only - `0` disables independently |
| `REGATTAUP_FOUL_QUEUE_DB` | `race-config/foul_webhook_queue.sqlite` | Foul retry queue file |
| `TEST_LAP_NUMBER` | 0 | `base` only - positive value sends one synthetic lap and exits |
| `TEST_LAP_BOAT_ID` | 1 | `base` only - attributed boat for the synthetic lap |

## What still needs real-hardware testing

- Actual achievable baud/range tradeoff for your specific radio model
- Whether the Pi's hardware UART (`/dev/ttyAMA0`) holds up as reliably over
  a full race day as the simpleRTK2B LR's own USB port did before this
  wiring change
- UBX checksum/frame-sync robustness over a long noisy USB-serial run (the
  parser resyncs on bad frames, but untested against real RF noise)
- The actual ingestion format for whichever race software you land on
- The "Base GPS survey-in" dashboard card (`UBX-NAV-SVIN`/`UBX-CFG-TMODE3`
  parsing, ECEF-to-lat/lon conversion, TMODE3 poll) - verified against
  synthetic UBX frames only, never a real ZED-F9P running survey-in
