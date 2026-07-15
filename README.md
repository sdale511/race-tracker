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

By default the ZED-F9P outputs a mix of NMEA sentences. For this app you
want `UBX-NAV-PVT` enabled and NMEA disabled on the UART feeding the Pi:

```
ubxtool -P 27.11 -p CFG-VALSET -z CFG-MSGOUT-UBX_NAV_PVT_UART1,1
ubxtool -P 27.11 -p CFG-VALSET -z CFG-UART1OUTPROT-NMEA,0
ubxtool -P 27.11 -p CFG-VALSET -z CFG-RATE-MEAS,1000   # 1Hz; raise if you want faster fixes
```
Save the config to flash on the module (`-p CFG-VALSET ... ,,,, 7` or via
u-center's "Save Config") so it survives power cycles.

The simpleRTK2B LR's onboard LoRa radio is a **separate concern** — that's
normally used for RTCM3 correction data between your RTK base and this
rover, not for the position telemetry this app sends. Nothing here touches
that link.

## Radio configuration

Pair two radios (boat + base) on the same netid/frequency/baud, in
transparent-serial mode. Set `RADIO_BAUD` in the env/config to match
whatever baud you configure on the radios themselves. Higher baud = faster
frame delivery but shorter range/reliability at a given power — this is a
real-world tuning step you'll need to do on the water. **Antenna height
matters a lot for going over water at >2mi; get both ends as high as
practical.**

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

## Connecting to your race committee software

`src/baseStation.js` currently:
1. Logs every decoded fix to console + CSV
2. Broadcasts a synthesized `$GPGGA` NMEA sentence over UDP (port 10110,
   the conventional NMEA-over-UDP port) — some tracking tools can ingest
   this directly

Once you pick your race software (TracTrac, YB Tracking, RaceQs, Predict
Wind, or in-house), the `outputFrame()` function is the one place to change
— swap it for whatever that software actually expects (an HTTP POST to a
cloud ingestion API is common for the commercial platforms; check their
integration docs since most of them expect a per-boat auth token). Happy to
build that adapter once you know the target.

## Tuning knobs (env vars)

| Var | Default | Purpose |
|---|---|---|
| `GPS_PORT` / `GPS_BAUD` | `/dev/ttyAMA0` / 115200 | GPS UART |
| `RADIO_PORT` / `RADIO_BAUD` | `/dev/ttyUSB0` / 57600 | Telemetry radio UART |
| `BOAT_ID` | 1 | Numeric ID (0-255) distinguishing boats |
| `TX_INTERVAL_MS` | 2000 | How often a frame is sent over radio (SD log is always full-rate) |
| `LOG_DIR` | `/home/pi/race-logs` | Where CSV logs go (put this on the SD card) |

## What still needs real-hardware testing

- Actual achievable baud/range tradeoff for your specific radio model
- Whether `/dev/ttyAMA0` vs a USB-serial adapter is more reliable for your
  GPS wiring in practice
- UBX checksum/frame-sync robustness over a long noisy USB-serial run (the
  parser resyncs on bad frames, but hasn't been stress-tested on real RF
  noise)
- The actual ingestion format for whichever race software you land on
