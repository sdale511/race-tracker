# ESP32-S3 rover

A C++ port of the rover (`src/boatAgent.js`'s racing path) for an Adafruit ESP32-S3 Feather, so a boat can run without a Pi: about half
the power, a one-second boot, and no Linux filesystem to corrupt. It talks the same radio protocol as the Node rover, so the base cannot
tell them apart and a fleet can mix both. The Node rover stays the reference and keeps being maintained; this one follows it.

## What it does (and doesn't yet)

Ported, behaving as the Node rover does:

- GPS: UBX NAV-PVT from the ZED-F9P's UART1, timestamps from the receiver's UTC, the "is the GPS link right" diagnosis.
- Sending: the distance gate (TX_DISTANCE_M, the 60 s heartbeat), batching (TX_BATCH_SIZE 8), delta frames.
- The shared radio: the correction-burst tracker, the burst gate, slot mode, the base's slot table, the shared join slots and their
  back-off, the slot's frame budget (TX_SLOT_MAX_HZ, the reserve, the full-rate zone around the marks and the finish line), thinning that
  keeps the turns, and the backfill after waiting for a slot.
- The status hello with the rover's diagnosis (the same flags; `power` is always 0 - there is no Pi power record), ping replies.
  With the MAX17048 answering it goes out as the battery hello (`0x9E`), with the charge and cell voltage, at least every 5 minutes -
  the base shows it in the fleet table's Battery column.
- Course marks from the base, kept in flash across a restart.
- Radio sleep mode (the XBee's SLEEP_RQ) with the GPS in software backup, woken by a base wake frame. With the XBee in the ArduSimple's
  socket SLEEP_RQ isn't wired: the boat stops sending and the GPS still backs up, but the XBee stays awake (so it hears the wake frame at
  once).
- RTCM from the radio: used for the burst timing, and forwarded to the GPS over UART1 (`RTCM_FORWARD`, on in the
  `feather_s3_reversetft_socket` build; off where the XBee's DOUT feeds the ZED's UART2 directly - see Hardware).
- Start-grid parking: inside the on-grid zone behind the start line the boat takes no slot and reports in the join slots every ~15 s.
- The event boost: the start, finish and foul detectors run on the boat's own fixes, so the pair of fixes straddling a crossing is always sent.
- The finish-approach gate (TX_FINISH_APPROACH_ZONE_M, off by default as in Node).
- The XBee node identifier set to the boat id at boot.
- The fleet power schedule from the base, as deep sleep - see "Power" below.
- The Reverse TFT Feather's screen: fix, corrections, slot, battery. The MAX17048 battery level is in the console status line on every Feather.

Left out on purpose: mark mode / set-mark / mark-log, the L1/L2 signal check, SD logging, log uploads, the local UDP broadcast and the admin
page.

On hardware so far (a Reverse TFT with the XBee in the ArduSimple's socket): the fix, the course marks and slot table from the base, and
frames the base hears. Not yet checked on hardware: an RTK fix from the forwarded corrections, deep sleep and the motion wake. Everything
is checked by the host tests below.

## Power

The base's power schedule (the Data page's Witty Pi and Boat shutdown cards) is applied with the ESP32's deep sleep instead of a Pi halting
and a Witty Pi switching it back on (`lib/rover_core/src/power_policy.cpp`):

- **The on window** (daily hours, or sunrise to sunset): outside it the boat sleeps, waking on a timer when the window next opens. With "wait
  until the boat has stopped" (the Witty Pi's halt-itself option) it is the shutdown rule, not the window's end, that puts it to sleep.
- **The shutdown rule**: past its time and stopped for its idle minutes (or at the time, without the idle gate) - the same gate as
  `powerSchedule.js`. Radio sleep mode doesn't count as stopped.
- **Motion**: the LIS3DH wakes the boat whenever it is moved. Woken outside its window, a boat stays up until it has been stopped for the
  shutdown rule's idle minutes (10 without one), so it is never put to sleep under its crew. If wind on a parked boat wakes it, raise
  `ACCEL_THRESHOLD_MG`.

Before it sleeps the GPS goes into software backup and the XBee's SLEEP_RQ is held high; with `GPS_POWER_PIN` / `RADIO_POWER_PIN` set (the
enable pins of their regulators) their supplies are cut too, which is what gets the sleep current down - without them the GPS board and the
XBee keep drawing through the night. With the XBee in the ArduSimple's socket, the S9V11F5's EN as `GPS_POWER_PIN` cuts both (the socket
runs off the ArduSimple's 3.3 V); left unconnected, an overnight sleep draws roughly 20-50 mA, mostly the XBee. The schedule's times are local: set `ROVER_TZ` (a POSIX TZ string, Pacific by default). The base's last
schedule is kept in NVS, and the GPS's time in the RTC, so a boat that wakes keeps to them before it hears the base or gets a fix.

## Hardware

Adafruit ESP32-S3 Feather - `feather_s3_nopsram` (#5323, the default), `feather_s3` (#5477), `feather_s3_reversetft` (#5691) or
`feather_s3_reversetft_socket` (the Reverse TFT with `RTCM_FORWARD=1`) in `platformio.ini`.

The boat's setup: a Reverse TFT, an ArduSimple simpleRTK2B Budget with the XBee in its own socket, a LIS3DH, a Pololu S9V11F5 5 V
regulator and a 1-cell LiPo. `docs/esp32-rover-wiring.pdf` has the diagrams and where each pin is on the boards.

| From | To | Notes |
|---|---|---|
| LiPo | the Feather's JST battery socket | check the polarity first |
| Feather `BAT` | S9V11F5 VIN | 3.0-4.2 V |
| S9V11F5 VOUT | ArduSimple `5V IN/OUT` | the ArduSimple's IOREF/5V switch **down** (IOREF=N/C, 5V=INPUT) |
| S9V11F5 EN | nothing, or `GPS_POWER_PIN` (optional) | its pull-up keeps it on; driven low in deep sleep it cuts the ArduSimple and the XBee |
| Feather `3V` | ArduSimple `IOREF` | the ZED's UART pins at 3.3 V; with the switch down nothing else feeds IOREF |
| ArduSimple `TX1` | Feather `RX` (GPIO 38) | UBX at 115200 (`GPS_BAUD`) |
| Feather `TX` (GPIO 39) | ArduSimple `RX1` | polls, sleep and wake, and the forwarded RTCM |
| ArduSimple `XBEE TX / GPS RX2` | GPIO 5 (`XBEE_RX_PIN`) | the XBee's DOUT: everything the base sends |
| GPIO 6 (`XBEE_TX_PIN`) | ArduSimple `XBEE RX / GPS TX2` | the XBee's DIN: telemetry out. Only with the ZED's UART2 off (below) |
| LIS3DH VIN, GND | Feather `3V`, GND | the main 3.3 V, not the STEMMA QT port: that supply is switched off in deep sleep |
| LIS3DH SDA, SCL | Feather `SDA`, `SCL` | address 0x18 (`ACCEL_ADDR`) |
| LIS3DH INT | GPIO 10 (`ACCEL_INT_PIN`) | the motion wake; must be an RTC GPIO (0-21) |
| GND | GND | the Feather, the ArduSimple (both power-header GNDs), the S9V11F5 and the LIS3DH |

Before the first boot, set the ZED up from a computer with `python3 ubx_config_set.py --port <its port> --role rover`: UBX on UART1 at
115200 and **UART2 off**, saved to flash. UART2's TX drives the XBee's DIN line; switched off it lets go, so the ESP32 can drive it
through Feather 6 - with UART2 on the two outputs fight. The corrections then reach the ZED only through the ESP32
(`feather_s3_reversetft_socket`, `RTCM_FORWARD=1`). The XBee: `BD` 115200 and `SM` 0 - the socket's SLEEP_RQ isn't wired, so leave
`RADIO_SLEEP_PIN` alone (GPIO 9 drives nothing).

**With the XBee on its own breakout instead** (a Pi-style rover profile): ZED `--role rover-pi` (UART2 on), the XBee's DOUT to GPIO 5
and also to the ArduSimple's `XBEE TX / GPS RX2` pin (RTCM straight into UART2, so `RTCM_FORWARD` can stay off), its DIN to GPIO 6,
SLEEP_RQ (pin 9) to GPIO 9 (`RADIO_SLEEP_PIN`) with 10 kohm to GND so it stays awake while the ESP32 boots, and `SM` 1. Leave
`XBEE RX / GPS TX2` unconnected there - the ZED drives it. Its 3.3 V can come from the ArduSimple's 3V3 pin, with 100 uF + 0.1 uF at
the XBee.

Check the pin numbers against Adafruit's pinout for the exact Feather before wiring, and change them with build flags
(`-DXBEE_RX_PIN=...`) if needed.

The boat id (5 letters, made up on first boot), the last course marks and the last power schedule are kept in NVS.

The USB serial console reads like the Node rover's: the same startup summary (`[boatAgent] boatId=..., race-tracker v0.1.N (hash, date)`,
then gps, radio and a `config:` line of the settings by their Node names), the same `[status]` line (at once when the fix, radio or
marks change, otherwise every minute), and the same wording for slots, parking, sleep, the RTCM watchdog and dropped frames. The
version comes from git at build time (`tools/version.py`, as `src/version.js` does it), and its commit count is the status hello's build
number. `-DGPS_LOG=1` logs every fix, like `GPS_LOG=1`. The battery is logged every minute.

### The screen (Reverse TFT)

The screen is lit for 30 s after boot and after a button press (a press while it is lit keeps it on for another 30 s); it shows the
full page after boot.

- **D1 - the full page**: eight lines - the boat id and READY / waiting / ASLEEP, the fix and satellites, corrections, the slot (or
  parked on the grid), the battery, frames sent, the last note (e.g. why it is about to sleep) and, while waiting, what it still needs
  from the base (`need marks rtcm slot`). The top line says READY once the boat has heard the course marks (this run - a stored copy
  doesn't count), the correction bursts and the slot table from the base; the console logs `[boatAgent] ready: ...` when that happens.
  The power schedule is not required: the base sends one only when it has one set.
- **D0 - the large page**, readable from across the boat: the boat id (coloured as the full page's top line: yellow waiting, green
  ready, white asleep), the battery % (red below 20 %), and one status word - the first of these that applies:

  | Condition | Shows | Colour |
  |---|---|---|
  | about to deep sleep | `ASLEEP` | white |
  | no GPS fix | `NO FIX` | red |
  | the course marks not heard from the base this run | `NO MARKS` | yellow |
  | marks heard, but no correction bursts | `NO RTCM` | yellow |
  | marks and corrections heard, but no slot table (never with `TX_SLOT` pinned) | `NO SLOT` | yellow |
  | not ready with nothing listed as missing (shouldn't happen) | `WAITING` | yellow |
  | ready, RTK fixed | `READY` | green |
  | ready, RTK float | `RTK FLT` | yellow |
  | ready, GPS only | `GPS ONLY` | yellow |

  `READY` here is stricter than on the full page: it also needs RTK fixed, so the one word says whether the boat can race. No fix
  hides what the base hasn't sent yet (the full page's bottom line lists it), and parking isn't shown - a parked boat that has
  everything reads `READY`.

## Settings

The rover settings are the Node rover's environment variables - `TX_DISTANCE_M`, `TX_BATCH_SIZE`, `TX_SLOT_MAX_HZ`, `TX_PARKED_REPORT_S`,
`RTCM_WATCHDOG`, `GPS_LOG` and the rest (`lib/rover_core/src/settings.cpp` lists them) - with the same defaults, and read exactly as
`src/config.js` reads them (the vectors check every one against `config.js`).

- **On the Mac**: set them in the environment, as for `npm run boat`: `TX_DISTANCE_M=2 .pio/build/mac/program ...`.
  `program --settings` lists them all with the values this environment gives.
- **On the ESP32**: type at the serial console (`pio device monitor`; it echoes what you type and takes Backspace, so no `--echo`
  needed). Tap RESET first if the boat is asleep - its USB port is gone in deep sleep. They are kept in flash, survive firmware updates, and take
  effect at the next boot:

  ```
  settings                  every setting, its value now, and what is saved for the next boot
  get TX_DISTANCE_M
  set TX_DISTANCE_M 2       (a number setting must be a number, a switch 1/0/true/false)
  unset TX_DISTANCE_M       back to the default
  boatid                    the boat id; "boatid QK3Q9" changes it (e.g. a replacement board taking over a boat)
  restart
  ```

A build can carry its own defaults, `-DROVER_SETTINGS="NAME=value NAME=value"`, used where nothing is set at the console (the boot
log says so; `settings` marks them `(this build)`). `feather_s3_reversetft_socket` is the Reverse TFT with `RTCM_FORWARD=1`, for an
XBee left in the ArduSimple's own socket: with the ZED's UART2 switched off (`ubx_config_set.py --role rover`, the ESP32
rover's profile; a Pi rover uses `--role rover-pi`, which keeps UART2 on) the ESP32 drives the XBee's DIN through the ArduSimple's
`XBEE RX / GPS TX2` pin (Feather 6) and hears its DOUT on `XBEE TX / GPS RX2` (Feather 5), and the corrections reach the ZED through
the ESP32 and UART1 - no XBee breakout. With UART2 on, the ZED drives that DIN line itself, so Feather 6 must not be wired to it.

The console is stricter than `config.js`, which reads `12x` as 12 and `abc` as its default: it refuses both. The pins, baud rates, time
zone and accelerometer threshold are build flags (top of `src/main.cpp`), not settings.

## Building and testing

[PlatformIO](https://platformio.org) (`pipx install platformio`):

```
cd firmware/esp32-rover
pio run                      # build for the default Feather
pio run -t upload            # flash it
pio device monitor           # the console
pio test -e native           # the host tests (no hardware)
```

## Running it on a Mac

`host/host_rover.cpp` runs the same `lib/rover_core` on the Mac, in place of `src/main.cpp`, so the C++ rover can sail against a base
before there is a Feather:

```
cd firmware/esp32-rover
pio run -e mac                        # builds .pio/build/mac/program
.pio/build/mac/program --help
```

**With the hardware on USB** - the ArduSimple's ZED-F9P on its GPS USB port, the XBee on the ArduSimple's XBee USB port or its own USB
adapter (`ls /dev/cu.*` to find them):

```
.pio/build/mac/program --radio /dev/cu.usbserial-XXXX --gps /dev/cu.usbmodemXXXX
```

- The ZED has to send NAV-PVT on its USB port too (`CFG-MSGOUT-UBX_NAV_PVT_USB`), not just UART1 as on the boat.
- An XBee on the ArduSimple feeds the ZED's UART2 with RTCM only if UART2 is on (`--role rover-pi`). With the ESP32 profile
  (`--role rover`, UART2 off), or an XBee on its own adapter, add `--rtcm-forward` so the rover writes the RTCM it hears to the GPS.
- `--set-ni` sets the XBee's node identifier as the firmware does at boot (it writes the XBee's config, so it's off by default).
- The GPS won't go into backup with its USB connected (`--gps-sleep-force-usb` forces it, which turns the ZED's USB off until a power
  cycle). There is no SLEEP_RQ pin, so radio sleep mode is off with a serial XBee.

**With no hardware** - against a `SIMULATE=1` base, over its UDP "radio", with `tools/sim_gps.js` sailing the simulated race (`simGps.js`)
as the GPS:

```
SIMULATE=1 npm run base                                                    # in the repo root
node tools/sim_gps.js | .pio/build/mac/program --radio udp --gps -        # SPACE starts the race
```

The `SIM_*` settings apply, as for `npm run boat`. Radio sleep mode works over UDP, as in the Node simulation.

It logs exactly what the ESP32 does (`--gps-log` for a line per fix), and serves a status page at http://localhost:8095 (`--ui-port`):
the same config and status values, refreshed every second, under a "Ready" or "Waiting for ... from the base" banner and a table of what
the base has sent: the course marks, the correction bursts, the slot table and the power schedule. Ctrl+C prints the `[txgate-stats]` line, as the Node rover does.

The boat id is the Node rover's - `BOAT_ID`, else `race-config/boat_id.txt` - so both rovers on the Mac are the same boat (`--boat-id` picks another). Marks and the power schedule are kept in `~/.esp32-rover-host`; `--state DIR` runs a second rover, which keeps its own boat id there.
Local time is the Mac's (`TZ=...` to run as a boat in another zone). Deep sleep is emulated: the rover ignores the radio and GPS until the
wake time, or until `kill -USR1 <pid>` (the accelerometer), then boots again. The accelerometer, battery chip and screen are not
emulated.

## Keeping it in sync with the Node rover

`lib/rover_core` is hardware-free C++ - one file per Node module it ports, with the same names, so a change to a Node module points at the
C++ file to change: `protocol.js` -> `protocol.cpp`, `radioLink.js`'s scanner -> `radio_scanner.cpp`, `ubxParser.js` -> `ubx.cpp`,
`burstTracker.js`, `txGate.js`, `txScheduler.js`, `slotTable.js`, `distanceGate.js`, `thinFixes.js`, `roverSleep.js`, `gpsSleep.js`,
`roverDiag.js`, `xbeeAt.js` -> `xbee_at.cpp`, `config.js`'s rover settings -> `settings.cpp`, `onGridWatcher.js` / `finishLineWatcher.js` / `foulWatcher.js` / `finishApproach.js` /
`eventBoost.js` -> `course_watchers.cpp`, `fleetShutdown.js` / `powerSchedule.js` / `sunSchedule.js` -> `power_policy.cpp`, and
`boatAgent.js` -> `rover.cpp`. `src/main.cpp` (and `src/display.cpp`) are the only Arduino code.

`tools/gen_vectors.js` runs the Node modules on a fixed set of inputs - fixes, a sailed track, every frame type, a radio byte stream with
noise and corrupted frames, NAV-PVT frames, correction bursts, a path crossing every line of the start/finish complex, the shutdown gate,
sunrise and sunset, the diagnosis - and writes what they produce to `test/vectors/node_vectors.h`.
The host tests require the C++ to produce exactly the same bytes and values.

After changing any Node module the script reads:

```
node firmware/esp32-rover/tools/gen_vectors.js    # regenerate the vectors
cd firmware/esp32-rover && pio test -e native     # does the C++ still match?
```

`npm test` includes `test/firmwareVectors.test.js`, which fails when the checked-in vectors no longer match the Node code - so a protocol
change can't land with the ESP32 rover silently left on the old format. A behaviour change in a module the vectors don't cover (the boat
agent's own logic, say) still needs the matching change in `rover.cpp` by hand; the end-to-end tests at the bottom of
`test/test_core/test_main.cpp` are the place to pin such behaviour down.
