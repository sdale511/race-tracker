# ESP32 rover carrier (rev B): optional connections

> **OPTIONAL. Not used by the current firmware.** The rover works the same with or without them.

These connections are wired on the board but do nothing until the firmware uses them. The exception is the GPS power cut,
which needs one wire and a build flag. None of them change the connections the rover uses today: each one is its own
trace between two otherwise-unused pins. The firmware never drives GPIO 14–18, and none of these are ESP32-S3 boot
(strapping) pins.

## Summary

| Connection | Pins | What it gives | Firmware needed | Value |
|---|---|---|---|---|
| [GPS power cut](#1-gps-power-cut-gps_en) | Feather A0 (GPIO 18) → pad TP2 → wire to the S9V11F5 EN hole | Overnight standby goes from days to weeks | No: build flag `-DGPS_POWER_PIN=18` | High |
| [TIMEPULSE](#2-zed-timepulse-gps_pps) | ArduSimple D13 (TPS) → Feather A1 (GPIO 17) | Sub-millisecond timing of line crossings and gun time | Yes | Medium–high if timing matters |
| [EXTINT](#3-zed-extint-gps_extint) | Feather A2 (GPIO 16) → ArduSimple D12 (EXTINT) | GPS-timed event marks; a hardware GPS wake | Yes | Low–medium |
| [Charger enable](#4-charger-enable-chg_dis) | Feather A3 (GPIO 15) → bq24074 ~CE | Charging rules for cold weather and storage | Yes, small | Low–medium |
| [LIS3DH INT2](#5-lis3dh-int2-acc_int2) | LIS3DH INT2 → Feather A4 (GPIO 14) | Tap, capsize or crash detection | Yes | Low |
| [Feather EN](#6-feather-en-header-feather_en) | Feather EN → J12 (EN, GND) | Feather-only off or reset | No | Low |

Start with the GPS power cut. TIMEPULSE matters if accurate start and finish timing comes back.

Not wired: the ZED's I2C, and a VBUS sense (the charger's ~PGOOD on D12 already says when USB power is present).
Feather D9, D13, A5, SCK, MOSI and MISO are still free.

## 1. GPS power cut (GPS_EN)

**What it does.** In deep sleep, the Feather switches off the whole ArduSimple and the XBee, instead of only telling them
to sleep.

**Why it matters.** An overnight sleep draws roughly 20–50 mA today, mostly the XBee. With the cut, the draw falls close
to the Feather and LIS3DH alone. On a 2,000 mAh battery, that's roughly 2–4 days of standby before, against weeks after.

**Cost.**
- The GPS loses its satellite data while it's off, so the first fix after waking takes about 30 s or more instead of a
  few seconds. Keeping the GPS's backup supply (V_BCKP) powered would avoid this.
- The boat can't hear the base while it's asleep, which is already true today.

**To use it.**
1. Solder a short insulated wire from pad TP2 to the S9V11F5's EN hole. EN is a through-hole on the module, not a
   header pin.
2. Build with `-DGPS_POWER_PIN=18`. The firmware already drives this pin high when awake and low in deep sleep.

**Cautions.**
- Fit the wire only together with that build. Without the flag, the pin floats and only the regulator's own pull-up
  keeps the GPS on.
- With the GPS off, the Feather's 3V still feeds IOREF and its TX line still idles high, so a powered-down ZED can be
  partly powered through those pins. Measure the sleep current before relying on the saving.

## 2. ZED TIMEPULSE (GPS_PPS)

**What it does.** The ZED sends a pulse exactly on each GPS second, accurate to tens of nanoseconds.

**Why it matters.** The firmware takes the time from position messages, which arrive over the UART a variable tens of
milliseconds late. With the pulse, the Feather knows exactly when each second started and can time-stamp events against
GPS time to well under a millisecond.

**Useful for:**
- Start, finish and mark-crossing times.
- The deferred gun-time and over-early (OCS) work.
- Keeping each boat's clock in step with the base without the radio's delay.

**Firmware needed.** An interrupt on GPIO 17 that latches the local clock at each pulse. The ZED's default 1 Hz time
pulse is enough.

**Idle behaviour.** The ZED pulses into an input nothing reads. Harmless.

## 3. ZED EXTINT (GPS_EXTINT)

**What it does.** It can do two separate jobs:
- **Hardware wake:** the Feather can wake the ZED from its low-power mode with a pin, instead of sending bytes over the
  UART. This is slightly more reliable, but the UART wake already works.
- **Time mark:** a pulse on EXTINT makes the ZED report the exact GPS time of that pulse (UBX-TIM-TM2). That allows a
  "mark this moment" feature with GPS-grade timing, for example a crew button pressed at the gun.

**Firmware needed.** ZED configuration (its power-management or time-mark settings), plus code to send the pulse and
read the report.

**Idle behaviour.** The ZED ignores EXTINT unless it's configured to use it. Neither `ubx_config_set.py` nor the firmware
does that. The ArduSimple pin also had nothing connected in rev A.

## 4. Charger enable (CHG_DIS)

**What it does.** The Feather can stop the battery charging: driving the pin high stops it.

**Useful for:**
- **Not charging in the cold.** LiPos must not be charged below 0 °C, and the bq24074's temperature input isn't wired.
- **Storage:** stopping at about 80 % extends battery life.
- **Radio noise:** pausing charging while the radio transmits, if supply noise turns out to be a problem.

With ~CHG (D11) and ~PGOOD (D12) already wired, the firmware could also show charge state on the screen and report it to
the base.

**Firmware needed.** A few lines, plus a rule for when to stop.

**Idle behaviour.** The bq24074's own 10 kΩ pull-down holds ~CE low, so it keeps charging. Without a charger fitted, the
trace goes to an empty socket.

## 5. LIS3DH INT2 (ACC_INT2)

**What it does.** INT1 already gives the motion wake. INT2 can carry a different event at the same time, without
reconfiguring INT1. For example:
- **Tap or double-tap:** a "wake up now" or "show the status screen" gesture with no button.
- **Free-fall or impact:** flags a capsized or crashed yacht.
- **Tilt or orientation:** for example, the boat upside down or on its side.

GPIO 14 is an RTC GPIO, so INT2 can also wake the board from deep sleep.

**Firmware needed.** Configure the event on the LIS3DH (CTRL_REG6 routes it to INT2) and handle the interrupt.

**Idle behaviour.** INT2 sits low because the firmware never sets it up. Harmless.

## 6. Feather EN header (FEATHER_EN)

**What it does.** Shorting J12 (EN to GND) turns off the Feather's 3.3 V supply.

**Limits.**
- It does not turn off the GPS or the radio, which stay on the battery. It's mainly useful as a reset, or to force the
  Feather off while you work on it.
- With the Feather off, the ArduSimple keeps sending signals into an unpowered ESP32. A brief state like this is
  harmless, but don't leave a boat like that for days.

**For a real off switch:** without the charger, put a switch on JP1 instead of the shunt. That cuts everything.

**Idle behaviour.** Nothing happens unless J12 is shorted.
