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
    admin dashboard's own survey-in card has something to show.
  - rover: UBX-NAV-PVT on (or this app sees nothing from it at all), TMODE3
    disabled (a rover is not a stationary reference station), UBX-RXM-RTCM on
    (RTCM_LOG visibility into corrections actually arriving), and fix
    rate set to 10Hz (not the 20Hz spec ceiling - see CFG-RATE-MEAS's own
    comment on why 20Hz risks carrSoln instability under a real correction
    radio link, not just a bench test).
  Both roles also set UART2's baud (--uart2-baud, default 115200) - UART2 is
  the port the onboard correction radio is wired to, so it MUST equal that
  radio's own baud (the base's was 115200). The rover profile also makes sure
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
    "CFG-MSGOUT-UBX_RXM_RTCM_UART1": (0x20910269, "u1", "RXM-RTCM rate"),
    "CFG-RATE-MEAS": (0x30210001, "u2", "fix rate (ms)"),
    "CFG-UART2INPROT-RTCM3X": (0x10750004, "bool", "RTCM3 input UART2"),
    "CFG-UART2-BAUDRATE": (0x40530001, "u4", "UART2 baud"),
    "CFG-UART2OUTPROT-UBX": (0x10760001, "bool", "UBX output UART2"),
    "CFG-UART2OUTPROT-NMEA": (0x10760002, "bool", "NMEA output UART2"),
    "CFG-UART1INPROT-RTCM3X": (0x10730004, "bool", "RTCM3 input UART1"),
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


def build_base_settings(rtcm_ports, constellations, interval=1):
    """The base profile as an ordered {key name: target value}.

    On every port in `rtcm_ports`: 1005 on, the MSM4 observation message for
    each constellation in `constellations` on (and the others off), 1230 on
    only if GLONASS is among them (it pairs with 1084), every MSM7 message
    off, RTCM3 allowed as an output protocol. On every OTHER port: every RTCM
    message off, so nothing is sent where nothing reads it. NAV-SVIN stays on
    for the dashboard's survey-in card.

    `interval` is each enabled message's output rate in navigation epochs: 1 =
    every epoch, 2 = every second epoch, and so on (the receiver's measurement
    rate is left alone, so at its 1 Hz that is every `interval` seconds).
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
                want = interval
            else:  # MSM4 or 1230 - per-constellation
                want = interval if constellation in constellations else 0
            settings[f"CFG-MSGOUT-RTCM_3X_TYPE{t}_{name}"] = want
        if on:
            settings[f"CFG-{name}OUTPROT-RTCM3X"] = True
    settings["CFG-MSGOUT-UBX_NAV_SVIN_UART1"] = 1  # so the admin dashboard's survey-in card has something to show
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


def apply_setting(ser, name, target_value, dry_run):
    key_id, kind, label = KEY_INFO[name]
    current = poll_key(ser, key_id, kind)
    current_display = current if current is not None else "?"
    prefix = f"  {label:<{LABEL_WIDTH}}"
    if current == target_value:
        print(f"{prefix} = {target_value} (unchanged)")
        return True
    if dry_run:
        print(f"{prefix} {current_display} -> {target_value} [dry run]")
        return True
    if not set_key(ser, key_id, kind, target_value):
        print(f"{prefix} {current_display} -> {target_value} [FAILED]")
        return False
    # Read back to confirm it actually stuck, same reasoning as
    # xbee_configure_at.py's own set_and_verify - a write ACK alone doesn't
    # prove the receiver is now actually running the new value.
    verified = poll_key(ser, key_id, kind)
    if verified == target_value:
        print(f"{prefix} {current_display} -> {target_value} [OK]")
        return True
    print(f"{prefix} {current_display} -> {target_value} [wrote, read back {verified} - did not stick]")
    return False


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
        default=1,
        choices=range(1, 11),
        metavar="SECONDS",
        help="base role only: send the RTCM messages every N navigation epochs (default 1 = every second at the "
        "receiver's 1 Hz; 2 = every 2 s). Halves the correction airtime at 2, but a rover then works from "
        "corrections up to 2 s old (a lost message costs 2 s) - check that RTK still holds at speed. "
        "Applies to every enabled RTCM message; the receiver's own 1 Hz measurement rate is not changed",
    )
    ap.add_argument(
        "--uart2-baud",
        type=int,
        default=115200,
        help="both roles: baud for UART2, the port the onboard correction radio is wired to - must equal that radio's own baud "
        "(default 115200). Only UART2 is touched, never the port this script is connected through",
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
        settings = build_base_settings(rtcm_ports, constellations, args.rtcm_interval)
        print(f"[ubx_config_set] RTCM on: {', '.join(rtcm_ports)}; constellations: {', '.join(constellations)}; every {args.rtcm_interval} epoch(s)")
    else:
        settings = dict(ROVER_SETTINGS)
    settings["CFG-UART2-BAUDRATE"] = args.uart2_baud
    print(f"[ubx_config_set] UART2 baud {args.uart2_baud} - must equal the correction radio's own baud")

    print(f"[ubx_config_set] connecting to {args.port} @ {args.baud}, role={args.role}{' (dry run)' if args.dry_run else ''}")
    try:
        ser = serial.Serial(args.port, args.baud, timeout=0.1)
    except serial.SerialException as e:
        print(f"[ubx_config_set] failed to open {args.port}: {e}")
        sys.exit(1)

    ok = True
    try:
        for name, target_value in settings.items():
            if not apply_setting(ser, name, target_value, args.dry_run):
                ok = False
    finally:
        ser.close()

    if not args.dry_run:
        print(f"\n[ubx_config_set] {'all settings applied and verified' if ok else 'one or more settings FAILED - see above'}")
        print("[ubx_config_set] run ubx_config_report.py to see the full picture, including anything this profile doesn't touch")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
