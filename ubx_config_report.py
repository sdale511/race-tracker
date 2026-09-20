#!/usr/bin/env python3
"""
ubx_config_report.py

Reads the ArduSimpleRTK2B (ZED-F9P) settings this project's own GPS setup
depends on - fix rate, UART baud, message output, TMODE3 mode, RTCM3 output
- the same settings gps_config_report.sh reports, but talking the UBX binary
protocol directly over pyserial instead of shelling out to gpsd's ubxtool.
Same reasoning as xbee_configure_at.py's own "why not a library" comment -
this needs to work on a machine that won't/can't install gpsd-clients, the
same way that script avoids needing the digi-xbee library. Speaks plain UBX
frames, no other dependency.

Sends one UBX-CFG-VALGET (class 0x06, id 0x8B) request per key, RAM layer
(what's actually running right now, not just what's saved to survive a
reboot), and decodes the single-key response. Read-only - never sends
UBX-CFG-VALSET, never changes anything on the board.

Every key ID below is the ZED-F9P's own official 32-bit config key -
cross-checked against two independent open-source references (SparkFun's
u-blox GNSS library's u-blox_config_keys.h, and pyubx2's
ubxtypes_configdb.py) rather than typed from memory, since a wrong key ID
here would silently poll the wrong setting instead of failing obviously -
both agree on every value used here.

USAGE
    pip install pyserial
    python3 ubx_config_report.py --port /dev/ttyAMA0 --baud 115200
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
CLASS_ACK = 0x05
ID_ACK_ACK = 0x01
ID_ACK_NAK = 0x00

# 0=RAM (what's actually running right now), 1=BBR, 2=Flash, 7=Default -
# RAM is the one that matters here, same choice gps_config_report.sh makes
# with its own `-g KEY,0`.
LAYER_RAM = 0

# name, key ID, decode kind, human label - decode kind is one of:
#   u1/u2/u4 - plain unsigned int of that byte width
#   bool     - 1 byte, 0/1
#   tmode    - 1 byte enum, printed with its 0/1/2 meaning
# Cross-checked against SparkFun's u-blox_config_keys.h AND pyubx2's
# ubxtypes_configdb.py - both independently agree on every ID below.
KEYS = [
    ("CFG-RATE-MEAS", 0x30210001, "u2", "Measurement period, ms - 100 = 10Hz, 1000 = 1Hz"),
    ("CFG-RATE-NAV", 0x30210002, "u2", "Nav solutions per measurement - normally 1"),
    ("CFG-UART1-BAUDRATE", 0x40520001, "u4", "UART1 baud - must match this app's GPS_BAUD"),
    ("CFG-UART2-BAUDRATE", 0x40530001, "u4", "UART2 baud - the simpleRTK2B LR's correction-radio port"),
    ("CFG-MSGOUT-UBX_NAV_PVT_UART1", 0x20910007, "u1", "UBX-NAV-PVT rate on UART1 - must be on (1) or this app sees nothing"),
    ("CFG-UART1OUTPROT-NMEA", 0x10740002, "bool", "NMEA on UART1 - fine either way, disabling just saves bandwidth"),
    ("CFG-MSGOUT-UBX_NAV_SVIN_UART1", 0x20910089, "u1", "UBX-NAV-SVIN rate on UART1 - needed for the admin dashboard's survey-in card"),
    ("CFG-MSGOUT-UBX_RXM_RTCM_UART1", 0x20910269, "u1", "UBX-RXM-RTCM rate on UART1 - needed for GPS_LOG_RTCM visibility into corrections arriving"),
    ("CFG-TMODE-MODE", 0x20030001, "tmode", "TMODE3 mode - 0=disabled, 1=survey-in, 2=fixed"),
    ("CFG-MSGOUT-RTCM_3X_TYPE1005_UART2", 0x209102BF, "u1", "Station coordinates"),
    ("CFG-MSGOUT-RTCM_3X_TYPE1077_UART2", 0x209102CE, "u1", "GPS MSM7 observations"),
    ("CFG-MSGOUT-RTCM_3X_TYPE1087_UART2", 0x209102D3, "u1", "GLONASS MSM7 observations"),
    ("CFG-MSGOUT-RTCM_3X_TYPE1097_UART2", 0x2091031A, "u1", "Galileo MSM7 observations"),
    ("CFG-MSGOUT-RTCM_3X_TYPE1127_UART2", 0x209102D8, "u1", "BeiDou MSM7 observations"),
    ("CFG-MSGOUT-RTCM_3X_TYPE1230_UART2", 0x20910305, "u1", "GLONASS code-phase biases"),
]

DECODE_SIZE = {"u1": 1, "u2": 2, "u4": 4, "bool": 1, "tmode": 1}

RESPONSE_TIMEOUT_S = 1.5


def checksum(data):
    # Standard UBX 8-bit Fletcher checksum over class+id+length+payload.
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
    # version(1)=0, layer(1)=RAM, position(2)=0, then this one keyID(4).
    payload = struct.pack("<BBHI", 0, LAYER_RAM, 0, key_id)
    return build_frame(CLASS_CFG, ID_VALGET, payload)


# Scans an arbitrary, possibly-interleaved UBX byte stream (a rover already
# streaming UBX-NAV-PVT at its configured rate looks exactly like this -
# our own VALGET response is just one frame among many) for the next
# complete, checksum-valid frame - same "find sync, read length, verify,
# else drop a byte and resync" approach as this project's own
# radioLink.js._onData, just for UBX framing instead of protocol.js's.
def read_next_frame(ser, deadline):
    buf = bytearray()
    while time.time() < deadline:
        chunk = ser.read(max(1, ser.in_waiting or 1))
        if chunk:
            buf.extend(chunk)
        while True:
            sync_idx = buf.find(bytes([UBX_SYNC1, UBX_SYNC2]))
            if sync_idx == -1:
                # No sync found in what's accumulated so far - do NOT just
                # wipe the buffer (a real sync pair routinely arrives split
                # across two separate reads, e.g. one byte at a time when
                # in_waiting is 0 between polls - clearing here would throw
                # the first sync byte away before its partner ever showed up,
                # so a real frame could NEVER be detected except by dumb
                # luck landing in a single read() call). Keep a trailing lone
                # 0xB5 (a possible partial sync) so the next chunk can still
                # complete it; discard everything else so the buffer doesn't
                # grow unbounded while genuinely sync-less noise streams by.
                if buf and buf[-1] == UBX_SYNC1:
                    del buf[:-1]
                else:
                    buf.clear()
                break
            if sync_idx > 0:
                del buf[:sync_idx]
            if len(buf) < 6:
                break  # need class+id+length at least
            msg_class, msg_id, length = buf[2], buf[3], struct.unpack("<H", buf[4:6])[0]
            total_len = 6 + length + 2
            if len(buf) < total_len:
                break  # wait for the rest of this frame
            frame = bytes(buf[:total_len])
            payload = frame[6 : 6 + length]
            ck_a, ck_b = checksum(frame[2 : 6 + length])
            if ck_a == frame[6 + length] and ck_b == frame[6 + length + 1]:
                del buf[:total_len]
                return msg_class, msg_id, payload
            # bad checksum / false sync match - drop one byte and resync
            del buf[:1]
    return None


def decode_value(kind, raw):
    if kind == "u1":
        return raw[0]
    if kind == "u2":
        return struct.unpack("<H", raw)[0]
    if kind == "u4":
        return struct.unpack("<I", raw)[0]
    if kind == "bool":
        return bool(raw[0])
    if kind == "tmode":
        return {0: "0 (disabled)", 1: "1 (survey-in)", 2: "2 (fixed)"}.get(raw[0], f"{raw[0]} (unknown)")
    raise ValueError(f"unknown decode kind: {kind}")


def poll_key(ser, name, key_id, kind, label):
    print(f"\n--- {label} ({name}) ---")
    ser.reset_input_buffer()
    ser.write(build_valget_request(key_id))
    deadline = time.time() + RESPONSE_TIMEOUT_S
    while time.time() < deadline:
        frame = read_next_frame(ser, deadline)
        if frame is None:
            break
        msg_class, msg_id, payload = frame
        if msg_class == CLASS_ACK and msg_id == ID_ACK_NAK:
            print("  (NAK - key not recognized on this firmware, or wrong layer)")
            return
        if msg_class == CLASS_CFG and msg_id == ID_VALGET:
            # version(1), layer(1), position(2), then keyID(4)+value(N) - one
            # entry, since we only ever ask for one key at a time.
            if len(payload) < 8:
                continue
            got_key_id = struct.unpack("<I", payload[4:8])[0]
            if got_key_id != key_id:
                continue  # some other in-flight response/leftover - keep waiting
            size = DECODE_SIZE[kind]
            value_bytes = payload[8 : 8 + size]
            if len(value_bytes) < size:
                continue
            print(f"  {decode_value(kind, value_bytes)}")
            return
        # anything else (a NAV-PVT the rover is already streaming, etc.) -
        # not what we asked for, keep scanning until the deadline.
    print("  (no response - not supported on this firmware, or wrong port/baud)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", required=True, help="Serial port, e.g. /dev/ttyAMA0 or COM5")
    ap.add_argument("--baud", type=int, default=115200, help="Baud to connect at (default 115200, matches GPS_BAUD)")
    args = ap.parse_args()

    print(f"[ubx_config_report] connecting to {args.port} @ {args.baud}")
    try:
        ser = serial.Serial(args.port, args.baud, timeout=0.1)
    except serial.SerialException as e:
        print(f"[ubx_config_report] failed to open {args.port}: {e}")
        sys.exit(1)

    try:
        for name, key_id, kind, label in KEYS:
            poll_key(ser, name, key_id, kind, label)
    finally:
        ser.close()

    print(
        "\n[ubx_config_report] done - a board acting as a rover should show the "
        "RTK-base rows (TMODE3, RTCM3 output) at 0/off; a board acting as the "
        "RTK base should show its own rows enabled and CFG-TMODE-MODE non-zero."
    )


if __name__ == "__main__":
    main()
