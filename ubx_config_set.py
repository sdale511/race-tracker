#!/usr/bin/env python3
"""
ubx_config_set.py

Applies the exact ArduSimpleRTK2B (ZED-F9P) settings this project's own base
and rover roles need - the same settings ubx_config_report.py/
gps_config_report.sh read, just written instead. Same "why not a library"
reasoning as xbee_configure_at.py: plain UBX binary protocol over pyserial,
no gpsd/ubxtool dependency.

Two profiles (--role base|rover), picked from what a live audit of this
fleet's own pair of boards actually found wrong:
  - base:  a clean MSM4 setup. The boards ship from ArduSimple with only
    RTCM3 TYPE1005 (station coordinates) plus a stock MSM4 set - which an
    earlier version of this script then topped up with MSM7, leaving a live
    board sending BOTH observation sets on UART2 every second (about 2.5x the
    bytes the rover needs, over a radio with a 100-byte packet limit - see the
    README's "RTK base GPS: enabling RTCM3 output"). This profile sends exactly
    one set: 1005 (station), MSM4 observations 1074/1084/1094/1124 (GPS/
    GLONASS/Galileo/BeiDou) and 1230 (GLONASS biases), with the MSM7 messages
    (1077/1087/1097/1127) explicitly switched OFF, on the ports chosen by
    --rtcm-ports (default UART2 = the onboard correction radio, plus USB = the
    host connection) and switched off on any other port. --constellations picks
    which constellations' observations are sent (default all four - this fleet
    operates in the US, where all four have real satellites in view and more
    satellites mean better RTK fix reliability under real-world sky
    obstruction; leave one out to save bytes). Also enables UBX-NAV-SVIN so the
    admin dashboard's own survey-in card has something to show. It also sets the
    measurement rate to 1 Hz: the RTCM interval is counted in measurement epochs, so a
    base left at the rover profile's 10 Hz would send bursts 10x too often. A receiver is only a
    base while TMODE3 is survey-in or a fixed position, so if TMODE3 is 0 (disabled -
    e.g. left that way by an earlier rover run on the same board) it is set to
    survey-in (--svin-min-dur seconds, --svin-acc-limit-m metres); a fixed position
    or a survey already running is left alone and shown. --survey-in forces survey-in
    even over a fixed position.
  - rover: UBX-NAV-PVT on (or this app sees nothing from it at all), TMODE3
    disabled (a rover is not a stationary reference station), UBX-RXM-RTCM on
    (RTCM_LOG visibility into corrections actually arriving), and fix
    rate set to 10Hz (not the 20Hz spec ceiling - see CFG-RATE-MEAS's own
    comment on why 20Hz risks carrSoln instability under a real correction
    radio link, not just a bench test).
  Both roles also set UART2's baud (--uart2-baud, default 115200) - UART2 is
  the port the onboard correction radio is wired to, so it MUST equal that
  radio's own baud (the base's was 115200). And both set UART1 - the port the
  Pi reads - to --uart1-baud (default 115200, the app's GPS_BAUD) with UBX
  output on. A receiver reset to factory settings is back at 38400 there, and
  the Pi then hears nothing it can decode; the boards come from ArduSimple at
  115200, which is why nothing set it before. UART1's baud is written last, and
  when this script is connected through UART1 itself it reconnects at the new
  baud to read it back. The rover profile also makes sure
  GPS/GLONASS/Galileo/BeiDou tracking is on and the differential mode is 3 (RTK
  fixed), so it can use everything the base sends.

Every key ID is the same cross-checked (SparkFun u-blox GNSS library +
pyubx2) set ubx_config_report.py already uses - see its own module comment.
Writes to RAM+BBR+Flash (layers 1+2+4=7), same ",7" convention as every
ubxtool command in the README - survives a power cycle, not just this
session.

Reads back and verifies every value actually stuck before reporting success,
same as xbee_configure_at.py's own set_and_verify - a write that silently
didn't take is worse than one that visibly failed.

USAGE
    pip install pyserial
    python3 ubx_config_set.py --port /dev/ttyAMA0 --baud 115200 --role base
    python3 ubx_config_set.py --port /dev/ttyAMA0 --baud 115200 --role rover
    python3 ubx_config_set.py --port /dev/ttyAMA0 --baud 115200 --role base --dry-run
    python3 ubx_config_set.py --port /dev/ttyAMA0 --baud 38400 --role rover      # a receiver reset to factory settings
    python3 ubx_config_set.py --port /dev/ttyACM0 --role base --rtcm-ports uart2,usb,uart1
    python3 ubx_config_set.py --port /dev/ttyACM0 --role base --constellations gps,galileo,beidou
    python3 ubx_config_set.py --port /dev/ttyACM0 --role base --rtcm-interval 2     # corrections every 2 s
"""

import argparse
import struct
import sys
import time

import serial

UBX_SYNC1 = 0xB5
UBX_SYNC2 = 0x62
CLASS_CFG = 0x06
ID_VALGET = 0x8B
ID_VALSET = 0x8A
CLASS_ACK = 0x05
ID_ACK_ACK = 0x01
ID_ACK_NAK = 0x00

LAYER_RAM = 0  # for VALGET reads - what's actually running right now
LAYERS_RAM_BBR_FLASH = 0b111  # for VALSET writes - matches ubxtool's own ",7"

RESPONSE_TIMEOUT_S = 1.5

# name -> (key ID, decode kind, short label for the one-line log output) -
# decode kind needed both to build the right size value field for VALSET
# and to interpret the VALGET read-back. Key IDs cross-checked against
# u-blox's own interface description (and SparkFun's u-blox_config_keys.h /
# pyubx2's ubxtypes_configdb.py) - see ubx_config_report.py's own module
# comment (its own KEYS list has the full explanatory labels this one
# deliberately doesn't repeat - see the module docstring/README for what
# each of these actually does/why).
KEY_INFO = {
    "CFG-MSGOUT-UBX_NAV_SVIN_UART1": (0x20910089, "u1", "NAV-SVIN rate"),
    "CFG-MSGOUT-UBX_NAV_PVT_UART1": (0x20910007, "u1", "NAV-PVT rate"),
    "CFG-TMODE-MODE": (0x20030001, "tmode", "TMODE3 mode"),
    "CFG-TMODE-SVIN_MIN_DUR": (0x40030010, "u4", "survey-in min (s)"),  # seconds
    "CFG-TMODE-SVIN_ACC_LIMIT": (0x40030011, "u4", "survey-in acc 0.1mm"),  # 0.1 mm units
    "CFG-MSGOUT-UBX_RXM_RTCM_UART1": (0x20910269, "u1", "RXM-RTCM rate"),
    "CFG-RATE-MEAS": (0x30210001, "u2", "fix rate (ms)"),
    "CFG-UART2INPROT-RTCM3X": (0x10750004, "bool", "RTCM3 input UART2"),
    "CFG-UART2-BAUDRATE": (0x40530001, "u4", "UART2 baud"),
    "CFG-UART2OUTPROT-UBX": (0x10760001, "bool", "UBX output UART2"),
    "CFG-UART2OUTPROT-NMEA": (0x10760002, "bool", "NMEA output UART2"),
    "CFG-UART1INPROT-RTCM3X": (0x10730004, "bool", "RTCM3 input UART1"),
    "CFG-UART1-BAUDRATE": (0x40520001, "u4", "UART1 baud"),
    "CFG-UART1OUTPROT-UBX": (0x10740001, "bool", "UBX output UART1"),
    "CFG-USBINPROT-RTCM3X": (0x10770004, "bool", "RTCM3 input USB"),
    "CFG-NAVHPG-DGNSSMODE": (0x20140011, "u1", "DGNSS mode (3=fixed)"),
    "CFG-SIGNAL-GPS_ENA": (0x1031001F, "bool", "GPS tracking"),
    "CFG-SIGNAL-GLO_ENA": (0x10310025, "bool", "GLONASS tracking"),
    "CFG-SIGNAL-GAL_ENA": (0x10310021, "bool", "Galileo tracking"),
    "CFG-SIGNAL-BDS_ENA": (0x10310022, "bool", "BeiDou tracking"),
}

# The RTCM message types this profile cares about: type -> (what it is,
# which constellation it belongs to - None for messages that aren't
# per-constellation). MSM4 is what this profile sends; MSM7 carries the same
# observations at higher resolution and about 1.5x the bytes, and is switched
# OFF so a board never sends both sets (see the module docstring).
RTCM_MESSAGES = {
    "1005": ("station", None),
    "1074": ("GPS MSM4", "gps"),
    "1084": ("GLO MSM4", "glonass"),
    "1094": ("GAL MSM4", "galileo"),
    "1124": ("BDS MSM4", "beidou"),
    "1230": ("GLO bias", "glonass"),
    "1077": ("GPS MSM7", "gps"),
    "1087": ("GLO MSM7", "glonass"),
    "1097": ("GAL MSM7", "galileo"),
    "1127": ("BDS MSM7", "beidou"),
}
MSM4_TYPES = ("1074", "1084", "1094", "1124")
MSM7_TYPES = ("1077", "1087", "1097", "1127")

# Which RTCM outputs this profile manages. UART2 is the onboard correction
# radio's port; USB is the host connection (the machine running the RTK
# dashboard, or a forwarder); UART1 is the Pi header UART - only needed if
# something reads the board there. Key IDs per port from u-blox's interface
# description (tables for CFG-MSGOUT-RTCM_3X_TYPE*_UART1/_UART2/_USB).
RTCM_PORTS = ("uart2", "usb", "uart1")
RTCM_KEY_IDS = {
    # type: (UART1, UART2, USB)
    "1005": (0x209102BE, 0x209102BF, 0x209102C0),
    "1074": (0x2091035F, 0x20910360, 0x20910361),
    "1084": (0x20910364, 0x20910365, 0x20910366),
    "1094": (0x20910369, 0x2091036A, 0x2091036B),
    "1124": (0x2091036E, 0x2091036F, 0x20910370),
    "1230": (0x20910304, 0x20910305, 0x20910306),
    "1077": (0x209102CD, 0x209102CE, 0x209102CF),
    "1087": (0x209102D2, 0x209102D3, 0x209102D4),
    "1097": (0x20910319, 0x2091031A, 0x2091031B),
    "1127": (0x209102D7, 0x209102D8, 0x209102D9),
}
# CFG-<port>OUTPROT-RTCM3X: whether RTCM3 may be sent on that port at all.
RTCM_OUTPROT_IDS = {"uart1": 0x10740004, "uart2": 0x10760004, "usb": 0x10780004}
PORT_INDEX = {"uart1": 0, "uart2": 1, "usb": 2}
PORT_NAME = {"uart1": "UART1", "uart2": "UART2", "usb": "USB"}

for _t, (_what, _c) in RTCM_MESSAGES.items():
    for _p in RTCM_PORTS:
        KEY_INFO[f"CFG-MSGOUT-RTCM_3X_TYPE{_t}_{PORT_NAME[_p]}"] = (
            RTCM_KEY_IDS[_t][PORT_INDEX[_p]],
            "u1",
            f"{_t} {_what} {PORT_NAME[_p]}",
        )
for _p in RTCM_PORTS:
    KEY_INFO[f"CFG-{PORT_NAME[_p]}OUTPROT-RTCM3X"] = (RTCM_OUTPROT_IDS[_p], "bool", f"RTCM3 output {PORT_NAME[_p]}")

ALL_CONSTELLATIONS = ("gps", "glonass", "galileo", "beidou")


def build_base_settings(rtcm_ports, constellations, interval=1, station_interval=10):
    """The base profile as an ordered {key name: target value}.

    On every port in `rtcm_ports`: 1005 on, the MSM4 observation message for
    each constellation in `constellations` on (and the others off), 1230 on
    only if GLONASS is among them (it pairs with 1084), every MSM7 message
    off, RTCM3 allowed as an output protocol. On every OTHER port: every RTCM
    message off, so nothing is sent where nothing reads it. NAV-SVIN stays on
    for the dashboard's survey-in card.

    `interval` is each enabled message's output rate in navigation epochs: 1 =
    every epoch, 2 = every second epoch, and so on. The measurement rate is set to
    1 Hz (CFG-RATE-MEAS 1000 ms) below, so that is every `interval` seconds.

    `station_interval` is the same for 1005 alone (the base's position - fixed, so a rover only needs to hear it now and
    then: every 10 s by default, though never more often than `interval`). Sent with every burst it was a 25-byte
    message arriving a second away from the observations at a 2 s interval, which the burst tracker had to learn to ignore.
    """
    settings = {}
    for port in RTCM_PORTS:
        name = PORT_NAME[port]
        on = port in rtcm_ports
        for t, (_what, constellation) in RTCM_MESSAGES.items():
            if not on:
                want = 0
            elif t in MSM7_TYPES:
                want = 0
            elif t == "1005":
                want = max(interval, station_interval)
            else:  # MSM4 or 1230 - per-constellation
                want = interval if constellation in constellations else 0
            settings[f"CFG-MSGOUT-RTCM_3X_TYPE{t}_{name}"] = want
        if on:
            settings[f"CFG-{name}OUTPROT-RTCM3X"] = True
    settings["CFG-MSGOUT-UBX_NAV_SVIN_UART1"] = 1  # so the admin dashboard's survey-in card has something to show
    # The RTCM interval above is counted in measurement epochs, so the epoch has to be a second: at the rover profile's 10 Hz
    # (100 ms) "every 2 epochs" is 0.2 s - five bursts a second, about 8x the intended airtime. Setting this here also puts
    # right a receiver that had the rover profile applied to it.
    settings["CFG-RATE-MEAS"] = 1000
    return settings


ROVER_SETTINGS = {
    "CFG-MSGOUT-UBX_NAV_PVT_UART1": 1,  # must be on, or this app sees nothing from this rover at all
    "CFG-TMODE-MODE": 0,  # disabled - a rover is not a stationary reference station
    "CFG-MSGOUT-UBX_RXM_RTCM_UART1": 1,  # RTCM_LOG visibility into corrections actually arriving
    "CFG-UART2INPROT-RTCM3X": True,  # corrections must be accepted on the port the correction radio is wired to (already the default - set explicitly so a board that was changed is put right)
    # With one shared radio the Pi writes the RTCM it receives to the receiver's
    # UART1 (or USB when developing) - make sure it is accepted there too.
    # On a rover, UART2 is the radio's serial line and the receiver must NEVER
    # transmit on it: in a one-radio setup where the radio sits in the board's
    # socket, anything the receiver sent there would be broadcast as if it were
    # telemetry, and could collide with the Pi's own bytes on the radio's input.
    # (u-blox's defaults already have UBX and NMEA off here; RTCM output is on by
    # default but a rover has no RTCM messages enabled - set all three off so a
    # changed board is put right.)
    "CFG-UART2OUTPROT-UBX": False,
    "CFG-UART2OUTPROT-NMEA": False,
    "CFG-UART2OUTPROT-RTCM3X": False,
    "CFG-UART1INPROT-RTCM3X": True,
    "CFG-USBINPROT-RTCM3X": True,
    # RTK needs the rover to track every constellation the base sends observations
    # for (the base's default is all four) - a rover with one switched off just
    # ignores that constellation's corrections. All four are the receiver's own
    # default; set explicitly so a board that was changed is put right.
    "CFG-SIGNAL-GPS_ENA": True,
    "CFG-SIGNAL-GLO_ENA": True,
    "CFG-SIGNAL-GAL_ENA": True,
    "CFG-SIGNAL-BDS_ENA": True,
    # 3 = RTK fixed (the default) - 2 would stop at float and never reach cm-level.
    "CFG-NAVHPG-DGNSSMODE": 3,
    # 10Hz, not the 20Hz spec ceiling, to leave headroom. (An earlier version of this
    # comment cited u-blox's "link latency under nav-period minus 50ms" rule; the
    # integration manual gives that rule for MOVING-BASE RTK only, not for a
    # stationary base like this fleet's, so it is not a reason for 10Hz here. For a
    # stationary base the documented limit is that the rover stops using corrections
    # older than 60 s - CFG-NAVSPG-CONSTR_DGNSSTO.) Not the base's own concern - a
    # stationary reference station has no reason to move this off the base profile's
    # effective default (whatever this board already had).
    "CFG-RATE-MEAS": 100,
}


def checksum(data):
    ck_a = 0
    ck_b = 0
    for b in data:
        ck_a = (ck_a + b) & 0xFF
        ck_b = (ck_b + ck_a) & 0xFF
    return ck_a, ck_b


def build_frame(msg_class, msg_id, payload):
    body = bytes([msg_class, msg_id]) + struct.pack("<H", len(payload)) + payload
    ck_a, ck_b = checksum(body)
    return bytes([UBX_SYNC1, UBX_SYNC2]) + body + bytes([ck_a, ck_b])


def build_valget_request(key_id):
    payload = struct.pack("<BBHI", 0, LAYER_RAM, 0, key_id)
    return build_frame(CLASS_CFG, ID_VALGET, payload)


def build_valset_request(key_id, kind, value):
    value_bytes = encode_value(kind, value)
    # version(1)=0, layers(1)=RAM+BBR+Flash, transaction(2)=0, keyID(4), value(N)
    payload = struct.pack("<BBH", 0, LAYERS_RAM_BBR_FLASH, 0) + struct.pack("<I", key_id) + value_bytes
    return build_frame(CLASS_CFG, ID_VALSET, payload)


def build_valset_multi(items):
    """One VALSET carrying several keys, so the receiver applies them in the same navigation epoch."""
    payload = struct.pack("<BBH", 0, LAYERS_RAM_BBR_FLASH, 0)
    for key_id, kind, value in items:
        payload += struct.pack("<I", key_id) + encode_value(kind, value)
    return build_frame(CLASS_CFG, ID_VALSET, payload)


# Same byte-stream scanner as ubx_config_report.py - see its own comment on
# why bytes must be allowed to accumulate ACROSS reads (a sync pair routinely
# arrives split across two separate reads on real hardware) rather than the
# buffer being cleared the moment a scan attempt doesn't find one yet.
def read_next_frame(ser, deadline):
    buf = bytearray()
    while time.time() < deadline:
        chunk = ser.read(max(1, ser.in_waiting or 1))
        if chunk:
            buf.extend(chunk)
        while True:
            sync_idx = buf.find(bytes([UBX_SYNC1, UBX_SYNC2]))
            if sync_idx == -1:
                if buf and buf[-1] == UBX_SYNC1:
                    del buf[:-1]
                else:
                    buf.clear()
                break
            if sync_idx > 0:
                del buf[:sync_idx]
            if len(buf) < 6:
                break
            msg_class, msg_id, length = buf[2], buf[3], struct.unpack("<H", buf[4:6])[0]
            total_len = 6 + length + 2
            if len(buf) < total_len:
                break
            frame = bytes(buf[:total_len])
            payload = frame[6 : 6 + length]
            ck_a, ck_b = checksum(frame[2 : 6 + length])
            if ck_a == frame[6 + length] and ck_b == frame[6 + length + 1]:
                del buf[:total_len]
                return msg_class, msg_id, payload
            del buf[:1]
    return None


def encode_value(kind, value):
    if kind in ("u1", "tmode"):
        return struct.pack("<B", value)
    if kind == "u2":
        return struct.pack("<H", value)
    if kind == "u4":
        return struct.pack("<I", value)
    if kind == "bool":
        return struct.pack("<B", 1 if value else 0)
    raise ValueError(f"unknown decode kind: {kind}")


def decode_value(kind, raw):
    if kind in ("u1",):
        return raw[0]
    if kind == "u2":
        return struct.unpack("<H", raw)[0]
    if kind == "u4":
        return struct.unpack("<I", raw)[0]
    if kind == "bool":
        return bool(raw[0])
    if kind == "tmode":
        return raw[0]
    raise ValueError(f"unknown decode kind: {kind}")


SIZE_BYTES = {"u1": 1, "u2": 2, "u4": 4, "bool": 1, "tmode": 1}


def poll_key(ser, key_id, kind):
    ser.reset_input_buffer()
    ser.write(build_valget_request(key_id))
    deadline = time.time() + RESPONSE_TIMEOUT_S
    while time.time() < deadline:
        frame = read_next_frame(ser, deadline)
        if frame is None:
            break
        msg_class, msg_id, payload = frame
        if msg_class == CLASS_ACK and msg_id == ID_ACK_NAK:
            return None
        if msg_class == CLASS_CFG and msg_id == ID_VALGET:
            if len(payload) < 8:
                continue
            got_key_id = struct.unpack("<I", payload[4:8])[0]
            if got_key_id != key_id:
                continue
            size = SIZE_BYTES[kind]
            value_bytes = payload[8 : 8 + size]
            if len(value_bytes) < size:
                continue
            return decode_value(kind, value_bytes)
    return None


def set_keys(ser, items):
    ser.reset_input_buffer()
    ser.write(build_valset_multi(items))
    deadline = time.time() + RESPONSE_TIMEOUT_S
    while time.time() < deadline:
        frame = read_next_frame(ser, deadline)
        if frame is None:
            break
        msg_class, msg_id, _payload = frame
        if msg_class == CLASS_ACK and msg_id == ID_ACK_ACK:
            return True
        if msg_class == CLASS_ACK and msg_id == ID_ACK_NAK:
            return False
    return False


def set_key(ser, key_id, kind, value):
    ser.reset_input_buffer()
    ser.write(build_valset_request(key_id, kind, value))
    deadline = time.time() + RESPONSE_TIMEOUT_S
    while time.time() < deadline:
        frame = read_next_frame(ser, deadline)
        if frame is None:
            break
        msg_class, msg_id, payload = frame
        if msg_class == CLASS_ACK and msg_id == ID_ACK_ACK:
            return True
        if msg_class == CLASS_ACK and msg_id == ID_ACK_NAK:
            return False
    return False


# Every line below fits in ~60 columns - one setting, one line, no wrap in
# a normal terminal. The full raw CFG- key name and why-it-matters
# explanation live in KEY_INFO's own comment/README/config.js, not repeated
# here on every run.
LABEL_WIDTH = 20  # longest label is 17 characters


def show(name, value):
    """How a value reads in the log. A CFG-MSGOUT-* value is a message's output rate
    in navigation epochs (0 = off, 1 = every epoch, 2 = every second epoch ...), so
    say so alongside the number - at the receiver's 1 Hz an epoch is a second."""
    if name.startswith("CFG-MSGOUT-") and isinstance(value, int) and not isinstance(value, bool):
        return f"{value} (off)" if value == 0 else (f"{value} (every epoch)" if value == 1 else f"{value} (every {value} epochs)")
    return value


def apply_setting(ser, name, target_value, dry_run):
    key_id, kind, label = KEY_INFO[name]
    current = poll_key(ser, key_id, kind)
    current_display = show(name, current) if current is not None else "?"
    prefix = f"  {label:<{LABEL_WIDTH}}"
    if current == target_value:
        print(f"{prefix} = {show(name, target_value)} (unchanged)")
        return True
    if dry_run:
        print(f"{prefix} {current_display} -> {show(name, target_value)} [dry run]")
        return True
    if not set_key(ser, key_id, kind, target_value):
        print(f"{prefix} {current_display} -> {show(name, target_value)} [FAILED]")
        return False
    # Read back to confirm it actually stuck, same reasoning as
    # xbee_configure_at.py's own set_and_verify - a write ACK alone doesn't
    # prove the receiver is now actually running the new value.
    verified = poll_key(ser, key_id, kind)
    if verified == target_value:
        print(f"{prefix} {current_display} -> {show(name, target_value)} [OK]")
        return True
    print(f"{prefix} {current_display} -> {target_value} [wrote, read back {show(name, verified)} - did not stick]")
    return False


def apply_rtcm_rates(ser, rates, dry_run, force):
    """The base's RTCM message rates, written TOGETHER. Each message's output counter starts when its rate is set, so keys
    written one after another can land in different navigation epochs: with "every 2 epochs" some message types then go out
    on even seconds and the rest on odd ones, and the receivers (and the transmit scheduler, which looks for one burst per
    interval) see a burst every second instead of every 2 s. So when any rate needs changing, or force (--realign-rtcm)
    is given, every rate is first switched off in one VALSET and then set in one VALSET - all counters start together."""
    current = {}
    for name in rates:
        key_id, kind, _label = KEY_INFO[name]
        current[name] = poll_key(ser, key_id, kind)
    differs = [n for n in rates if current[n] != rates[n]]
    ok = True
    for name, target in rates.items():
        _key_id, _kind, label = KEY_INFO[name]
        prefix = f"  {label:<{LABEL_WIDTH}}"
        cur_display = show(name, current[name]) if current[name] is not None else "?"
        if current[name] == target:
            print(f"{prefix} = {show(name, target)} (unchanged)" + (" [re-applied together]" if force and not dry_run else ""))
        else:
            print(f"{prefix} {cur_display} -> {show(name, target)}" + (" [dry run]" if dry_run else ""))
    if dry_run:
        if force:
            print("  (--realign-rtcm: all RTCM rates would be switched off, then set again together)")
        return True
    if not differs and not force:
        return True
    items = [(KEY_INFO[n][0], KEY_INFO[n][1]) for n in rates]
    if not set_keys(ser, [(k, kind, 0) for k, kind in items]) or not set_keys(ser, [(k, kind, rates[n]) for (k, kind), n in zip(items, rates)]):
        print("  RTCM rates [FAILED to write]")
        return False
    for name, target in rates.items():
        key_id, kind, label = KEY_INFO[name]
        got = poll_key(ser, key_id, kind)
        if got != target:
            print(f"  {label:<{LABEL_WIDTH}} wrote {show(name, target)}, read back {show(name, got)} - did not stick")
            ok = False
    print(f"  RTCM rates written together{' and verified' if ok else ' - see above'}")
    return ok


TMODE_NAMES = {0: "disabled", 1: "survey-in", 2: "fixed position"}


def read_tmode(ser):
    key_id, kind, _label = KEY_INFO["CFG-TMODE-MODE"]
    return poll_key(ser, key_id, kind)


def survey_in_settings(min_dur_s, acc_limit_m):
    """TMODE3 survey-in: the receiver averages its own position for at least min_dur_s seconds, until it is within
    acc_limit_m metres, then becomes a base and sends corrections."""
    return {
        "CFG-TMODE-MODE": 1,
        "CFG-TMODE-SVIN_MIN_DUR": min_dur_s,
        "CFG-TMODE-SVIN_ACC_LIMIT": int(round(acc_limit_m * 10000)),  # metres -> 0.1 mm
    }


def report_tmode(mode):
    """Base role: show a TMODE3 mode that is being left alone (survey-in or a fixed position). Shown in a dry run too."""
    key_id, kind, label = KEY_INFO["CFG-TMODE-MODE"]
    prefix = f"  {label:<{LABEL_WIDTH}}"
    if mode is None:
        print(f"{prefix} ? (could not read) [left alone]")
        print(f"  {'':<{LABEL_WIDTH}}   WARNING: could not read TMODE3 - if it is 0 (disabled) this receiver is not a base; check with ubx_config_report.py")
        return
    print(f"{prefix} = {mode} ({TMODE_NAMES.get(mode, 'unknown')}) [left alone]")


def apply_uart1_baud(ser, port, target, dry_run):
    """UART1 is the port the Pi reads, so its baud must equal the app's GPS_BAUD. Written after everything else: when this
    script is connected through UART1 itself, the receiver switches as soon as it takes the write, so the ACK can be lost
    and nothing answers at the old baud - then it reconnects at the new one to read the value back. Over USB the
    connection doesn't depend on UART1's baud and the read-back just works. Returns (ok, the serial port now in use)."""
    key_id, kind, label = KEY_INFO["CFG-UART1-BAUDRATE"]
    prefix = f"  {label:<{LABEL_WIDTH}}"
    current = poll_key(ser, key_id, kind)
    current_display = current if current is not None else "?"
    if current == target:
        print(f"{prefix} = {target} (unchanged)")
        return True, ser
    if dry_run:
        print(f"{prefix} {current_display} -> {target} [dry run]")
        return True, ser
    set_key(ser, key_id, kind, target)  # the ACK may already come at the new baud - the read-back decides
    verified = poll_key(ser, key_id, kind)
    via = ""
    if verified is None and ser.baudrate != target:
        ser.close()
        ser = serial.Serial(port, target, timeout=0.1)
        verified = poll_key(ser, key_id, kind)
        via = f" (reconnected at {target})"
    if verified == target:
        print(f"{prefix} {current_display} -> {target} [OK]{via}")
        return True, ser
    print(f"{prefix} {current_display} -> {target} [FAILED - read back {verified if verified is not None else 'nothing'}]")
    return False, ser


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", required=True, help="Serial port, e.g. /dev/ttyAMA0 or COM5")
    ap.add_argument("--baud", type=int, default=115200, help="Baud to connect at (default 115200, matches GPS_BAUD)")
    ap.add_argument("--role", required=True, choices=["base", "rover"], help="Which settings profile to apply")
    ap.add_argument("--dry-run", action="store_true", help="Read current values and show what would change - write nothing")
    ap.add_argument(
        "--rtcm-ports",
        default="uart2,usb",
        help="base role only: comma-separated ports that carry RTCM (uart1, uart2, usb); every other port has its RTCM messages "
        "switched off. Default uart2,usb - UART2 is the onboard correction radio, USB the host connection",
    )
    ap.add_argument(
        "--constellations",
        default=",".join(ALL_CONSTELLATIONS),
        help="base role only: comma-separated constellations whose observations are sent (gps, glonass, galileo, beidou). "
        "Default all four; a constellation left out has its MSM4 message switched off, and 1230 goes with GLONASS",
    )
    ap.add_argument(
        "--rtcm-interval",
        type=int,
        default=2,
        choices=range(1, 11),
        metavar="SECONDS",
        help="base role only: send the RTCM messages every N navigation epochs (default 2 = every 2 s; 1 = every second at the "
        "receiver's 1 Hz). Halves the correction airtime at 2, but a rover then works from "
        "corrections up to 2 s old (a lost message costs 2 s) - check that RTK still holds at speed. "
        "Applies to every enabled RTCM message; the base profile also sets the receiver's measurement rate to 1 Hz so an epoch is a second",
    )
    ap.add_argument(
        "--survey-in",
        action="store_true",
        help="base role only: set TMODE3 to survey-in even if it already holds a fixed position, replacing it (the receiver averages "
        "its own position, then becomes a base). Without this the base role sets survey-in only when TMODE3 is 0/disabled, and "
        "leaves a fixed position or a running survey alone",
    )
    ap.add_argument(
        "--station-interval",
        type=int,
        default=10,
        choices=range(1, 61),
        metavar="SECONDS",
        help="base role only: send the 1005 station-position message every N seconds (default 10; never more often than "
        "--rtcm-interval). The base position is fixed, so a rover only needs it now and then - it is what a rover needs to start "
        "an RTK fix, so a boat that powers up waits up to this long for its first one",
    )
    ap.add_argument(
        "--realign-rtcm",
        action="store_true",
        help="base role only: switch every RTCM message rate off and set them all again in one command, even if they already read "
        "correctly - fixes corrections arriving in two groups a second apart (see rtcm_listen.py) at a 2 s interval, which "
        "happens when the rates were written one by one across a navigation epoch",
    )
    ap.add_argument("--svin-min-dur", type=int, default=300, help="with --survey-in: minimum survey time in seconds (default 300)")
    ap.add_argument("--svin-acc-limit-m", type=float, default=2.0, help="with --survey-in: position accuracy to reach, metres (default 2.0)")
    ap.add_argument(
        "--uart2-baud",
        type=int,
        default=115200,
        help="both roles: baud for UART2, the port the onboard correction radio is wired to - must equal that radio's own baud "
        "(default 115200)",
    )
    ap.add_argument(
        "--uart1-baud",
        type=int,
        default=115200,
        help="both roles: baud for UART1, the port the Pi reads - must equal the app's GPS_BAUD (default 115200). A receiver "
        "reset to factory settings is at 38400 here: connect with --baud 38400 through UART1, or over USB, which works at any baud",
    )
    args = ap.parse_args()

    if args.role == "base":
        rtcm_ports = [p.strip().lower() for p in args.rtcm_ports.split(",") if p.strip()]
        constellations = [c.strip().lower() for c in args.constellations.split(",") if c.strip()]
        for p in rtcm_ports:
            if p not in RTCM_PORTS:
                ap.error(f"--rtcm-ports: unknown port {p!r} (choose from {', '.join(RTCM_PORTS)})")
        for c in constellations:
            if c not in ALL_CONSTELLATIONS:
                ap.error(f"--constellations: unknown constellation {c!r} (choose from {', '.join(ALL_CONSTELLATIONS)})")
        if not rtcm_ports or not constellations:
            ap.error("--rtcm-ports and --constellations must each name at least one")
        if "uart2" not in rtcm_ports:
            print("[ubx_config_set] note: uart2 is not selected - the onboard correction radio will receive no RTCM")
        settings = {}
        if args.survey_in:
            settings.update(survey_in_settings(args.svin_min_dur, args.svin_acc_limit_m))
        settings.update(build_base_settings(rtcm_ports, constellations, args.rtcm_interval, args.station_interval))
        print(f"[ubx_config_set] RTCM on: {', '.join(rtcm_ports)}; constellations: {', '.join(constellations)}; every {args.rtcm_interval} epoch(s); station 1005 every {max(args.rtcm_interval, args.station_interval)} epoch(s)")
    else:
        if args.survey_in:
            ap.error("--survey-in is for the base role only (a rover's TMODE3 is switched off)")
        settings = dict(ROVER_SETTINGS)
    settings["CFG-UART2-BAUDRATE"] = args.uart2_baud
    settings["CFG-UART1OUTPROT-UBX"] = True  # NAV-PVT/NAV-SVIN go out on UART1 - UBX must be allowed there
    print(f"[ubx_config_set] UART2 baud {args.uart2_baud} - must equal the correction radio's own baud")
    print(f"[ubx_config_set] UART1 baud {args.uart1_baud} - must equal the app's GPS_BAUD")

    print(f"[ubx_config_set] connecting to {args.port} @ {args.baud}, role={args.role}{' (dry run)' if args.dry_run else ''}")
    try:
        ser = serial.Serial(args.port, args.baud, timeout=0.1)
    except serial.SerialException as e:
        print(f"[ubx_config_set] failed to open {args.port}: {e}")
        sys.exit(1)

    ok = True
    try:
        # Nothing answering at all is almost always the wrong --baud - say so once rather than print "?" for every setting.
        if poll_key(ser, *KEY_INFO["CFG-UART1-BAUDRATE"][:2]) is None:
            print(f"[ubx_config_set] no UBX reply on {args.port} @ {args.baud} - wrong --baud? A receiver reset to factory "
                  "settings talks at 38400 on UART1 (try --baud 38400); over USB any baud works")
            sys.exit(1)
        if args.role == "base" and not args.survey_in:
            # A receiver is only a base while TMODE3 is survey-in or fixed. 0 (disabled) - e.g. after the rover profile,
            # which sets it to 0, was applied to this receiver - means it sends no usable corrections, so the base profile
            # puts it into survey-in. Survey-in or a fixed position already set up is left alone (--survey-in forces it).
            mode = read_tmode(ser)
            if mode == 0:
                print("  TMODE3 mode          = 0 (disabled): a base needs survey-in or a fixed position - setting survey-in (a fixed position or running survey is never replaced without --survey-in)")
                settings = {**survey_in_settings(args.svin_min_dur, args.svin_acc_limit_m), **settings}
            else:
                report_tmode(mode)
        rtcm_rates = {n: v for n, v in settings.items() if n.startswith("CFG-MSGOUT-RTCM_3X_TYPE")} if args.role == "base" else {}
        for name, target_value in settings.items():
            if name in rtcm_rates:
                continue
            if not apply_setting(ser, name, target_value, args.dry_run):
                ok = False
        if rtcm_rates and not apply_rtcm_rates(ser, rtcm_rates, args.dry_run, args.realign_rtcm):
            ok = False
        uart1_ok, ser = apply_uart1_baud(ser, args.port, args.uart1_baud, args.dry_run)
        ok = ok and uart1_ok
    finally:
        ser.close()

    if not args.dry_run:
        print(f"\n[ubx_config_set] {'all settings applied and verified' if ok else 'one or more settings FAILED - see above'}")
        print("[ubx_config_set] run ubx_config_report.py to see the full picture, including anything this profile doesn't touch")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
