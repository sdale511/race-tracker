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
- Course marks from the base, kept in flash across a restart.
- Radio sleep mode (the XBee's SLEEP_RQ) with the GPS in software backup, woken by a base wake frame.
- RTCM from the radio: used for the burst timing, and optionally forwarded to the GPS (`rtcmForward`, off: the XBee's DOUT feeds the ZED's
  UART2 directly - see Wiring).

Not yet ported (the Node rover has them): start-grid parking (needs `onGridWatcher.js`), the event boost at start/finish/foul line crossings,
the finish-approach gate (off by default in Node too), mark mode / set-mark / mark-log, the power schedule (Witty Pi and the shutdown rule -
the ESP32 will do this with its own deep sleep and the accelerometer wake instead), the XBee node identifier, SD logging, log uploads, the
local UDP broadcast and the admin page. NAV-SIG (the dashboard's L1/L2 card) is parsed by nothing yet.

Not tested on hardware yet: everything here is checked by the host tests below and builds for the ESP32, but has not run on a Feather.

## Hardware

Adafruit ESP32-S3 Feather - `feather_s3_nopsram` (#5323, the default), `feather_s3` (#5477) or `feather_s3_reversetft` (#5691) in
`platformio.ini`.

| From | To | Notes |
|---|---|---|
| ZED-F9P TX1 | Feather `RX` | UBX at 115200 (`GPS_BAUD`) |
| ZED-F9P RX1 | Feather `TX` | polls, sleep and wake |
| XBee DOUT (pin 2) | GPIO 5 (`XBEE_RX_PIN`) | everything the base sends |
| XBee DOUT (pin 2) | the ArduSimple's empty XBee socket, pin 2 | the ZED's UART2 RX: RTCM straight to the GPS |
| XBee DIN (pin 3) | GPIO 6 (`XBEE_TX_PIN`) | telemetry out |
| XBee SLEEP_RQ (pin 9) | GPIO 9 (`RADIO_SLEEP_PIN`), 10 kohm to GND | high = asleep; the pull-down keeps it awake while the ESP32 boots |
| GND | GND | all grounds together |

Leave the ArduSimple socket's pin 3 (DIN) unconnected - the ZED drives it. Check the pin numbers against Adafruit's pinout for the exact
Feather before wiring, and change them with build flags (`-DXBEE_RX_PIN=...`) if needed. The XBee-PRO needs a few hundred mA when it
transmits: give it its own 3.3 V buck-boost regulator from the battery.

The boat id (5 letters, made up on first boot) and the last course marks are kept in NVS. Status goes to the USB serial console every 30 s.

## Building and testing

[PlatformIO](https://platformio.org) (`pipx install platformio`):

```
cd firmware/esp32-rover
pio run                      # build for the default Feather
pio run -t upload            # flash it
pio device monitor           # the console
pio test -e native           # the host tests (no hardware)
```

## Keeping it in sync with the Node rover

`lib/rover_core` is hardware-free C++ - one file per Node module it ports, with the same names, so a change to a Node module points at the
C++ file to change: `protocol.js` -> `protocol.cpp`, `radioLink.js`'s scanner -> `radio_scanner.cpp`, `ubxParser.js` -> `ubx.cpp`,
`burstTracker.js`, `txGate.js`, `txScheduler.js`, `slotTable.js`, `distanceGate.js`, `thinFixes.js`, `roverSleep.js`, `gpsSleep.js`,
`roverDiag.js`, and `boatAgent.js` -> `rover.cpp`. `src/main.cpp` is the only Arduino code.

`tools/gen_vectors.js` runs the Node modules on a fixed set of inputs - fixes, a sailed track, every frame type, a radio byte stream with
noise and corrupted frames, NAV-PVT frames, correction bursts, the diagnosis - and writes what they produce to `test/vectors/node_vectors.h`.
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
