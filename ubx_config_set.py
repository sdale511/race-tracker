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
  - base:  the boards shipped by ArduSimple with only RTCM3 TYPE1005 (station
    coordinates) enabled and no satellite observation message - exactly the
    failure mode the README's own "RTK base GPS: enabling RTCM3 output"
    section warns about (looks "locked and working" while a rover receives
    nothing usable). Enables all four constellations (GPS/GLONASS/Galileo/
    BeiDou) by default, not gated behind opt-in flags - this fleet operates
    in the US, where all four have real satellites in view, and more
    satellites means better RTK fix reliability under real-world sky
    obstruction. Also enables UBX-NAV-SVIN so the admin dashboard's own
    survey-in card has something to show.
  - rover: UBX-NAV-PVT on (or this app sees nothing from it at all), TMODE3
    disabled (a rover is not a stationary reference station), UBX-RXM-RTCM on
    (GPS_LOG_RTCM visibility into corrections actually arriving), and fix
    rate set to 10Hz (not the 20Hz spec ceiling - see CFG-RATE-MEAS's own
    comment on why 20Hz risks carrSoln instability under a real correction
    radio link, not just a bench test).

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
# SparkFun's u-blox_config_keys.h AND pyubx2's ubxtypes_configdb.py - see
# ubx_config_report.py's own module comment (its own KEYS list has the full
# explanatory labels this one deliberately doesn't repeat - see the
# module docstring/README for what each of these actually does/why).
KEY_INFO = {
    "CFG-MSGOUT-RTCM_3X_TYPE1077_UART2": (0x209102CE, "u1", "RTCM 1077 (GPS)"),
    "CFG-MSGOUT-RTCM_3X_TYPE1087_UART2": (0x209102D3, "u1", "RTCM 1087 (GLONASS)"),
    "CFG-MSGOUT-RTCM_3X_TYPE1097_UART2": (0x2091031A, "u1", "RTCM 1097 (Galileo)"),
    "CFG-MSGOUT-RTCM_3X_TYPE1127_UART2": (0x209102D8, "u1", "RTCM 1127 (BeiDou)"),
    "CFG-MSGOUT-UBX_NAV_SVIN_UART1": (0x20910089, "u1", "NAV-SVIN rate"),
    "CFG-MSGOUT-UBX_NAV_PVT_UART1": (0x20910007, "u1", "NAV-PVT rate"),
    "CFG-TMODE-MODE": (0x20030001, "tmode", "TMODE3 mode"),
    "CFG-MSGOUT-UBX_RXM_RTCM_UART1": (0x20910269, "u1", "RXM-RTCM rate"),
    "CFG-RATE-MEAS": (0x30210001, "u2", "fix rate (ms)"),
}

# All four constellations on by default, not gated behind opt-in flags -
# this fleet operates in the US, where GPS/GLONASS/Galileo/BeiDou (BeiDou-3,
# not the old Asia-Pacific-only BeiDou-2) all have real satellites in view;
# more satellites means better RTK fix reliability/convergence under any
# real-world sky obstruction. GLONASS observations (1087) in particular pair
# with CFG-MSGOUT-RTCM_3X_TYPE1230_UART2 (GLONASS code-phase biases), which
# this fleet's base already had ON with no 1087 to pair it with before this
# script existed - a half-configured combination fixed by enabling 1087.
BASE_SETTINGS = {
    "CFG-MSGOUT-RTCM_3X_TYPE1077_UART2": 1,  # GPS observations - the missing piece a base needs to actually correct anything
    "CFG-MSGOUT-RTCM_3X_TYPE1087_UART2": 1,  # GLONASS observations - pairs with TYPE1230, already on
    "CFG-MSGOUT-RTCM_3X_TYPE1097_UART2": 1,  # Galileo observations
    "CFG-MSGOUT-RTCM_3X_TYPE1127_UART2": 1,  # BeiDou observations
    "CFG-MSGOUT-UBX_NAV_SVIN_UART1": 1,  # so the admin dashboard's survey-in card has something to show
}

ROVER_SETTINGS = {
    "CFG-MSGOUT-UBX_NAV_PVT_UART1": 1,  # must be on, or this app sees nothing from this rover at all
    "CFG-TMODE-MODE": 0,  # disabled - a rover is not a stationary reference station
    "CFG-MSGOUT-UBX_RXM_RTCM_UART1": 1,  # GPS_LOG_RTCM visibility into corrections actually arriving
    # 10Hz, not the 20Hz spec ceiling - u-blox's own correction-link-latency
    # guidance (< nav period - 50ms) leaves ~0ms margin at 20Hz, meaning a
    # real correction-radio link (not a bench test) risks carrSoln
    # flickering fixed->float right at the moment precision matters most.
    # 10Hz keeps a comfortable 50ms margin instead. Not the base's own
    # concern - a stationary reference station has no reason to move this
    # off BASE_SETTINGS' effective default (whatever this board already had).
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
LABEL_WIDTH = 20


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
    args = ap.parse_args()

    settings = BASE_SETTINGS if args.role == "base" else ROVER_SETTINGS

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
