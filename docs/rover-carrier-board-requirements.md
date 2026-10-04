# Rover carrier board - requirements for PCB design (Flux)

Purpose: design one custom carrier PCB that replaces the loose jumper wires, USB
adapter board and ad-hoc power wiring in a race-tracker rover. Quantity: 100 units.
This document is written to be pasted or attached to an AI PCB-design tool. Read the
"How to read this document" section first - it says which numbers are safe to rely on.

## How to read this document

Every technical statement carries one tag:

- **[V]** Verified against a manufacturer document (source listed at the end).
- **[R]** Taken from this project's own source code or README (the software the board must work with).
- **[D]** Derived by calculation from [V] or [R] numbers. The arithmetic is shown.
- **[A]** An assumption. It has NOT been confirmed. Do not finalize anything that depends
  on an [A] item until the owner answers the matching question in "Open items".

Do not invent pinouts, part numbers, voltages or currents that are not stated here.
If something needed is missing, list it as a question instead of guessing.

## 1. System context

A rover is a GPS tracker mounted on a vehicle (an ATV in the current tests). It has three
parts, all wired to one small Linux computer:

```
 [Vehicle 12V battery]  [A]
          |
          v
 +------------------ CARRIER BOARD (to be designed) ------------------+
 |  input protection -> 5V rail -> Pi Zero 2 W (via 40-pin header)      |
 |                    -> 3.3V rail (dedicated) -> XBee socket           |
 |                    -> 5V -> GPS connector                            |
 |  USB-serial bridge <-> XBee UART        GPS UART <-> Pi header UART  |
 +----------------------------------------------------------------------+
        |                        |                       |
  Pi Zero 2 W            XBee-PRO 900HP S3B       ArduSimple simpleRTK2B
  (host computer)        (telemetry radio,        (u-blox ZED-F9P GPS)
                          900 MHz, to the base)
```

The software on the Pi (`src/boatAgent.js`) reads GPS over one serial port, sends
position over the radio on a second serial port, and serves a small web dashboard over
the Pi's own WiFi.

Software constants the hardware must match [R] (`src/config.js`):

| Setting | Default | Meaning |
|---|---|---|
| `GPS_PORT` | `/dev/ttyAMA0` | GPS serial device = Pi header UART (GPIO14/15) |
| `GPS_BAUD` | 115200 | GPS baud (the receiver is configured to this) |
| `RADIO_PORT` | `/dev/ttyUSB0` | Radio serial device = a USB-serial device |
| `RADIO_BAUD` | 115200 | Radio baud. 8N1. The code sets no hardware flow control. |

The README documents that the Pi Zero 2 W has one USB data port and that the header UART
is used for GPS, leaving the single USB port for the radio [R]. Keep that arrangement.

## 2. Scope

In scope: schematic, PCB layout, BOM, and fabrication/assembly outputs for the carrier board.

Out of scope: changing the software, the radio protocol, the base station, or the antennas.
The radio's range problems seen in testing were caused by the rider and vehicle blocking the
antenna, not by wiring; a PCB does not fix that.

## 3. Components the board must interface with

### 3.1 Host: Raspberry Pi Zero 2 W

- Size 65 mm x 30 mm [V]. Mounting holes are 3.5 mm in from each edge (hole centers 58 mm x 23 mm apart) [V, D].
- 40-pin header is an **unpopulated footprint** [V]. A header must be soldered on the Pi.
- Input power: 5 V DC, 2.5 A [V]. It is normally powered through a micro-USB "PWR" socket [V].
- One USB 2.0 OTG data port (micro-USB) [V].
- Operating temperature -20 C to +70 C [V]. This is narrower than the other parts (see 3.3, 3.4).
- 2.4 GHz WiFi and Bluetooth 4.2 are on the board [V]. Bluetooth takes the Pi's main
  hardware UART unless disabled in software (`dtoverlay=disable-bt`) [R]. That is a software
  step; the carrier just wires to header pins 8 and 10.
- Standard Raspberry Pi 40-pin header functions used here:
  pins 2 and 4 = 5 V, pin 6 = GND, pin 8 = GPIO14 (TXD), pin 10 = GPIO15 (RXD). GPIO is 3.3 V
  logic [R, standard Pi header].

Powering the Pi through the 5 V header pins bypasses the Pi's micro-USB input protection
[A: stated from general Raspberry Pi guidance, confirm against the Pi Zero 2 W schematic], so
the carrier must supply its own fuse, reverse-polarity and transient protection. Never power the
Pi from both the carrier and a micro-USB cable at once.

### 3.2 GPS: ArduSimple simpleRTK2B (u-blox ZED-F9P)

The project README calls the board "simpleRTK2B LR". ArduSimple's "LR" kit is a simpleRTK2B
Budget board plus a separate long-range radio module [V]. **The exact SKU in use is unconfirmed
(Open item 1).** Facts below are for the simpleRTK2B Budget board [V]:

- 6-pin Pixhawk-style JST connector (UART1): pin 1 = 5V_IN, pin 2 = UART1 RX (3.3 V level),
  pin 3 = UART1 TX (3.3 V level), pins 4 and 5 not connected, pin 6 = GND.
  The connector family is described as JST-GH [A: confirm on the physical board].
- UART1 is the port this project uses [R: the README configures NAV-PVT on UART1].
- Board also has two micro-USB ports (one with native ZED-F9P USB, one for the XBee socket's FTDI)
  and an on-board XBee socket wired to UART2 [V]. **That on-board socket is NOT the telemetry
  radio and is not used by this project.** It is for RTCM correction radios.
- Antenna connector is SMA, supports an active antenna up to 75 mA at 3.3 V [V].
- Operating temperature -40 C to +85 C [V].
- Supply current and allowed supply range: **not confirmed from the sources reviewed.**
  One search result stated "3-5 V supply" but could not be tied to this board. See Open item 3.

Crossover rule [D from the pin table above]: Pi TXD (header pin 8) must go to the GPS board's
UART1 RX (JST pin 2). Pi RXD (header pin 10) must go to the GPS board's UART1 TX (JST pin 3).
Do the crossover on the carrier. Label the carrier's GPS connector from the GPS board's point
of view so a normal straight 1:1 JST cable works: carrier pin 1 = 5 V, pin 2 = Pi TXD, pin 3 = Pi RXD, pin 6 = GND.

### 3.3 Telemetry radio: Digi XBee-PRO 900HP (S3B)

The project uses the 200 kbps variant, which has a 100-byte maximum RF payload [R]. Exact part
number and antenna connector are unconfirmed (Open item 2). The datasheet lists U.FL
(`XBP9B-DMUT-002`) and RP-SMA (`XBP9B-DMST-002`) variants of the 200 kbps DigiMesh part [V].

Electrical [V]:
- Supply voltage 2.1 to 3.6 V. Below 3.0 V output power and receiver sensitivity may degrade.
- Transmit current at full power (PL=4): 215 mA typical, **290 mA maximum**.
  Lower power levels: PL=3 160 mA, PL=2 120 mA, PL=1 95 mA, PL=0 60 mA (typical).
- Receive/idle current 29 mA typical at 3.3 V (35 mA max). Sleep 2.5 uA typical.
- Data interface is UART at 3 V logic [V].
- Operating temperature -40 C to +85 C [V].
- Receiver sensitivity -101 dBm at 200 kbps [V]. This is why supply noise matters (see R-PWR-6).

Mechanical [V] (through-hole module):
- Body 24.38 mm x 32.94 mm (0.960 in x 1.297 in), height 5.46 mm without connector/antenna.
- Pin pitch 2.00 mm (0.079 in), two rows of 10 pins, rows 22.00 mm apart (0.866 in).
- Pin numbering per Digi's top view: pins 1-10 run down one row and pins 11-20 run back up the other
  row, so pin 1 and pin 20 sit at the same end of the module, and pin 10 and pin 11 sit at the other end.

Pin assignments [V] (Digi user guide, "Pin signals"):

| Pin | Name | Direction | Use on this board |
|---|---|---|---|
| 1 | VCC | power | 3.3 V rail |
| 2 | DOUT | out | to USB-serial bridge RX |
| 3 | DIN | in | from USB-serial bridge TX |
| 4 | DIO12 / SPI_MISO | both | leave unconnected |
| 5 | RESET | in (open-drain out) | to bridge or a test point/button; drive low to reset; never drive high |
| 6 | DIO10 / PWM0 / RSSI | both | optional RSSI LED; else unconnected |
| 7 | DIO11 / PWM1 | both | unconnected |
| 8 | Reserved | - | **do not connect** |
| 9 | DTR / SLEEP_RQ / DIO8 | in | to bridge DTR (needed for serial firmware update) |
| 10 | GND | - | ground |
| 11 | DIO4 / SPI_MOSI | both | unconnected |
| 12 | CTS / DIO7 | out | to bridge flow control, or test point |
| 13 | ON_SLEEP / DIO9 | out | optional status LED |
| 14 | VREF | in | connect to GND (not a programmable module) |
| 15 | Associate / DIO5 | both | optional associate LED |
| 16 | RTS / DIO6 | in | to bridge flow control (needed for serial firmware update) |
| 17-19 | DIO3, DIO2, DIO1 | both | unconnected |
| 20 | DIO0 / commissioning | both | optional pushbutton or test point |

Digi's guidance [V]: the only required connections for two-way communication are VCC, GND,
DOUT and DIN. Serial firmware updates additionally need RTS and DTR. Do not connect unused pins.

### 3.4 Other facts

- XBee modules carry FCC modular approval (FCC ID MCQ-XB900HP) [V]. The carrier must not change
  the module's antenna or RF path.
- Digi advises pointing the antenna vertically, keeping it away from metal, and using an
  external antenna when the module is inside a metal enclosure or vehicle [V].

## 4. Requirements

IDs are stable so the tool can reference them. MUST = required, SHOULD = strongly preferred.

### 4.1 Mechanical

- **R-MECH-1 (MUST)** Mate to the Pi Zero 2 W through the 40-pin header. Use a female header on the carrier.
- **R-MECH-2 (MUST)** Mounting holes aligned to the Pi's pattern: holes 3.5 mm from the edges, 58 mm x 23 mm
  apart. Hole diameter to be taken from the official Raspberry Pi mechanical drawing [A].
- **R-MECH-3 (SHOULD)** Target outline no larger than 65 mm x 56 mm (HAT-sized) [A: size goal, confirm]. The XBee
  alone is 24.38 mm x 32.94 mm, so the carrier will be larger than the Pi's 65 mm x 30 mm.
- **R-MECH-4 (MUST)** XBee footprint: two 1x10 sockets, 2.00 mm pitch, rows 22.00 mm apart, matching section 3.3.
- **R-MECH-5 (MUST)** Keep the XBee antenna end at a board edge. No copper, components or tall parts
  under or above the antenna area, per Digi's layout guidance [V].
- **R-MECH-6 (SHOULD)** Provide strain relief or retention for the GPS cable and USB link (vibration, see 4.6).

### 4.2 Power

- **R-PWR-1 (MUST)** Input protection: reverse-polarity protection, a fuse or resettable fuse, and
  a transient suppressor sized for a vehicle electrical system. Input range and polarity are
  unconfirmed [A]. Until confirmed, design for 9-16 V continuous and survive 40 V transients.
- **R-PWR-2 (MUST)** 5 V rail for the Pi and the GPS board, rated at least 3.5 A continuous
  [D: 2.5 A Pi supply rating [V] + about 1 A allowance for the GPS board, USB-serial bridge, LEDs and
  margin; the GPS current is unconfirmed, so this allowance is a placeholder].
- **R-PWR-3 (MUST)** Feed the Pi through header pins 2 and 4 (5 V) and pin 6 plus other GND pins. Provide
  no path that back-feeds 5 V into the Pi's micro-USB.
- **R-PWR-4 (MUST)** Dedicated 3.3 V rail for the XBee, not taken from the Pi's 3.3 V pin. It must
  deliver the XBee's 290 mA maximum transmit current with headroom; regulator rated at least 500 mA
  [D: 290 mA max [V] plus margin].
- **R-PWR-5 (MUST)** Keep the XBee supply at or above 3.0 V at all times, including during a transmit burst [V].
- **R-PWR-6 (MUST)** XBee supply ripple no more than 50 mV peak-to-peak. If a switching regulator is
  used for this rail, switch above 500 kHz. Place a 1.0 uF and a 47 pF capacitor as close as possible to
  XBee pin 1, with the 47 pF closest [V].
- **R-PWR-7 (SHOULD)** Power-good or simple status LED on the 5 V and 3.3 V rails.
- **R-PWR-8 (SHOULD)** Keep the 5 V switching regulator and its inductor away from the XBee antenna
  and RF end. The receiver sensitivity is -101 dBm [V], so switching noise is a real risk.

### 4.3 Radio link (XBee <-> Pi)

- **R-RAD-1 (MUST)** A USB-to-UART bridge IC on the carrier connects the XBee UART to the Pi's USB data port,
  replacing the separate USB adapter board used today. It must appear on the Pi as `/dev/ttyUSB0`
  [R: `RADIO_PORT` default]. Use a bridge with a mainline Linux driver (e.g. CP210x or FTDI family) that is in
  stock in quantity [A: part choice open, see Open item 8].
- **R-RAD-2 (MUST)** UART at 3.3 V, 115200 baud, 8N1 [R]. Bridge TX to XBee DIN (pin 3), bridge RX from
  XBee DOUT (pin 2).
- **R-RAD-3 (MUST)** Also connect XBee DTR (pin 9), RTS (pin 16), CTS (pin 12) and RESET (pin 5) to the bridge or to
  test points, so Digi's serial firmware update and XCTU configuration work through the carrier [V].
  Verify the RTS/CTS crossover against the chosen bridge datasheet; do not assume it.
- **R-RAD-4 (MUST)** The bridge is a USB device and the Pi is the host. Connect only data lines and ground
  between them. The bridge takes its power from the carrier's 5 V rail, not from the Pi's USB port.
  Whether the Pi Zero 2 W's data port supplies 5 V to the cable must be checked on the Pi schematic [A]; if it does,
  isolate it so the two 5 V sources never connect.
- **R-RAD-5 (MUST)** Provide the Pi-side USB connection as a connector on the carrier that a short commercial
  micro-USB OTG cable mates with, or a board-to-board pogo/solder option. Choose whichever survives vibration
  and note the choice.
- **R-RAD-6 (MUST)** Antenna connector: match the module variant (U.FL with a pigtail to a panel-mount
  connector, or RP-SMA on the module). The module's own RF path is untouched (section 3.4).
- **R-RAD-7 (SHOULD)** RSSI and associate LEDs on the XBee's optional pins, for field diagnosis.

### 4.4 GPS link (Pi <-> ArduSimple)

- **R-GPS-1 (MUST)** One 6-pin connector for the GPS board, pinout per section 3.2: pin 1 = 5 V, pin 2 = Pi TXD (header 8),
  pin 3 = Pi RXD (header 10), pins 4 and 5 not connected, pin 6 = GND. Keyed so it cannot be inserted backwards.
- **R-GPS-2 (MUST)** All GPS UART signals 3.3 V, direct connection, no level shifter. The Pi header is 3.3 V
  and the GPS board's UART1 is 3.3 V [V, R].
- **R-GPS-3 (SHOULD)** Series resistors (about 100 ohm) on the two UART lines and ESD protection at the connector
  [A: good-practice suggestion, not from a datasheet].
- **R-GPS-4 (MUST NOT)** Do not connect to the GPS board's USB ports or its on-board XBee socket.

### 4.5 Test and debug

- **R-TST-1 (MUST)** Test points for 12 V input, 5 V, 3.3 V, GND, GPS TX, GPS RX, XBee DIN, XBee DOUT, XBee RESET.
- **R-TST-2 (SHOULD)** A pad or header to read the XBee UART directly if the bridge is bypassed.

### 4.6 Environment

- **R-ENV-1 (MUST)** Survive vehicle vibration: no unsupported tall parts, secured connectors, solid mounting.
- **R-ENV-2 (SHOULD)** Allow conformal coating (dust, moisture). Keep coating off the connectors and the antenna area.
- **R-ENV-3 (MUST)** Choose components rated for at least -20 C to +70 C. The Pi Zero 2 W is rated -20 C to +70 C [V],
  the narrowest of the three main parts. A closed box in desert sun can exceed 70 C; this is an Open item.

### 4.7 Manufacturing (100 units)

- **R-MFG-1 (MUST)** Every part must be in stock at the volume of 100 boards (plus spares), from a distributor you can
  name, and not marked end-of-life. The Raspberry Pi Zero 2 W itself is currently scarce, so do not design in any
  other single-source part that is also scarce.
- **R-MFG-2 (MUST)** Output: schematic, BOM with manufacturer part numbers and distributor stock/price at 100, PCB layout,
  Gerbers, drill file, pick-and-place file, assembly drawing.
- **R-MFG-3 (SHOULD)** SMD parts on one side so the board can be assembled by a standard assembly house. Through-hole
  parts only where unavoidable (XBee sockets, Pi header).
- **R-MFG-4 (SHOULD)** Two-layer board with a solid ground pour is acceptable; use four layers only if the power or
  noise analysis requires it, and say why.
- **R-MFG-5 (MUST)** Run design-rule checks and electrical-rule checks and report any waived warnings.

## 5. Acceptance tests (run on the first 3-5 boards)

1. Power: measure ripple on the XBee VCC with the radio transmitting at full power. Pass: 50 mV peak-to-peak or less (R-PWR-6).
2. Power: measure XBee VCC during a transmit burst. Pass: never below 3.0 V (R-PWR-5).
3. GPS: `GPS_PORT=/dev/ttyAMA0 GPS_BAUD=115200 npm run boat` prints `[gps]` lines with real `fixType` and `numSV` [R].
4. Radio device: the XBee appears as `/dev/ttyUSB0` and `python3 xbee_configure_at.py --port /dev/ttyUSB0 --dry-run`
   reads its settings [R].
5. Link: run the radio against a second radio at a known distance and compare error rate to a hand-wired reference rover.
   Pass: no worse than the reference.
6. Firmware update: an XBee firmware update completes through the carrier using XCTU (confirms RTS/DTR wiring, R-RAD-3).
7. Thermal and vibration smoke test appropriate to the open environment answers.

## 6. Open items - the owner must answer these before layout

1. Exact ArduSimple SKU in the rovers. Is it a simpleRTK2B Budget? Is the 6-pin JST connector the one to use, or Arduino headers?
2. Exact XBee part number, and its antenna connector (U.FL, RP-SMA or wire).
3. GPS board supply: allowed input range and measured current draw at 5 V. The 5 V rail sizing (R-PWR-2) uses a placeholder.
4. Vehicle electrical system: nominal and worst-case voltage, polarity, and expected transients (R-PWR-1 assumes 9-16 V).
5. Enclosure and environment: maximum temperature, dust/water exposure, vibration level.
6. Pi Zero 2 W only, or also the Orange Pi Zero 2W? The Orange Pi Zero 2W is the same 65 mm x 30 mm, and its wiki puts UART0
   TX/RX on header pins 8 and 10 like the Pi. The positions of its 5 V and GND header pins, its USB-C connectors, and its
   Bluetooth/UART behavior are NOT verified. Treat it as out of scope unless confirmed.
7. Does the Pi Zero 2 W's micro-USB data port supply 5 V when a device is attached? Check the Pi Zero 2 W reduced schematic (R-RAD-4).
8. USB-serial bridge IC choice, by stock and price at 100 units.
9. Target board outline limit (R-MECH-3).

## 7. Known errors in earlier project material - do not use

- `docs/rover_wiring.pdf` states the XBee can draw "close to 1A on transmit." That is wrong. The correct figures are 215 mA
  typical and 290 mA maximum (section 3.3). The older document also describes wiring to a Pi 3B+ with a separate USB adapter
  board; this carrier replaces that arrangement.
- `docs/telemetry-pipeline.html` describes the radio protocol, not the hardware, and is not an input to this design.

## 8. Sources

- Digi XBee-PRO 900HP datasheet: https://hub.digi.com/dp/path=/marketing/asset/ds_xbeepro900hp
- Digi XBee-PRO 900HP/XSC S3 and S3B User Guide (pin table, power supply design, layout guidance): https://docs.digi.com/resources/documentation/digidocs/pdfs/90002173.pdf
- Raspberry Pi Zero 2 W product brief (size, input power, temperature, mounting dimensions): https://datasheets.raspberrypi.com/rpizero2/raspberry-pi-zero-2-w-product-brief.pdf
- ArduSimple simpleRTK2B Budget datasheet: https://www.ardusimple.com/wp-admin/admin-post.php?action=generate_product_pdf&product_id=556
- ArduSimple simpleRTK2B Budget user guide (connector pinout): https://www.ardusimple.com/user-guide-simplertk2b-budget/
- Orange Pi Zero 2W wiki (header and UART0 pins): http://www.orangepi.org/orangepiwiki/index.php/Orange_Pi_Zero_2W
- This repository: `src/config.js` (port and baud defaults), `README.md` ("Wiring notes", "GPS configuration"), `src/boatAgent.js`.
