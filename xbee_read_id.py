#!/usr/bin/env python3
"""
xbee_read_id.py

Connects to a Digi XBee radio over AT Command Mode and prints its Network
ID (ATID) plus a few other identifying parameters, in two groups. The first
group is deliberately generic - parameters present on essentially every
Digi XBee model (ID, BD, NI, SH/SL) - safe to point at any XBee, including
a different module family (e.g. the XBee SX-based correction radio
ArduSimple's LR kits use), without assuming anything about its specific
command set. The second group reads exactly the parameters
xbee_configure_at.py's own CONFIG dict sets on the telemetry radios
specifically (TO/DH/DL/HP/MT/CE), printed alongside each one's expected
value, so a radio's actual live config can be checked against CONFIG at a
glance instead of re-running xbee_configure_at.py's own --dry-run just to
look. Only meaningful on a radio xbee_configure_at.py has actually been run
against - pointed at a different module family (the SX correction radio),
these params may not exist at all, or exist with an entirely different
meaning, so treat that second group as informational-only off telemetry
radios.

Read-only in AT/transparent mode. The one exception: if --detect-baud finds
nothing in AT mode and falls back to checking API mode (see try_api_mode's
own comment - a module already in API mode never answers +++ at any baud,
which looks identical to a wrong baud guess), and that succeeds, it sets AP
back to 0 (transparent) before exiting - same reasoning as
xbee_configure_at.py's own FINAL_AP_MODE: this repo's tooling and the
radios' actual job both expect AT/transparent mode, so a module found
sitting in API mode is left the way everything else here needs it, not in
whatever mode it happened to be in when this script found it.

USAGE
    python3 xbee_read_id.py --port /dev/cu.usbserial-0001
    python3 xbee_read_id.py --port /dev/cu.usbserial-0001 --connect-baud 115200
"""

import argparse
import sys
import time

import serial


def open_serial(port, baud):
    """serial.Serial(), plus explicitly forcing RTS/DTR active rather than
    trusting whatever the OS/driver defaults to. If this module has
    RTS/CTS flow control enabled (its D6/D7 pin config) and expects the
    host to hold these lines active, a connection that leaves them
    floating or inactive could have the module silently discard
    everything we send it - "+++" would never register - while it keeps
    transmitting to us just fine (which would look exactly like what
    we're seeing: continuous data OUT, nothing we send ever getting a
    response). Cheap to force explicitly either way."""
    ser = serial.Serial(port, baud, timeout=0.05)
    ser.rts = True
    ser.dtr = True
    return ser

GUARD_TIME_S = 1.1
RESPONSE_TIMEOUT_S = 2.0
IDLE_GAP_S = 0.25


def read_response(ser, timeout=RESPONSE_TIMEOUT_S, idle_gap=IDLE_GAP_S):
    buf = bytearray()
    deadline = time.monotonic() + timeout
    last_byte_time = None
    while time.monotonic() < deadline:
        chunk = ser.read(64)
        if chunk:
            buf += chunk
            last_byte_time = time.monotonic()
        elif last_byte_time is not None and (time.monotonic() - last_byte_time) > idle_gap:
            break
    return buf.decode("ascii", errors="replace")


def enter_command_mode(ser):
    ser.reset_input_buffer()
    ser.reset_output_buffer()
    time.sleep(GUARD_TIME_S)
    ser.write(b"+++")
    resp = read_response(ser, timeout=2.0)
    if "OK" not in resp:
        raise RuntimeError(f'no "OK" after +++ (got {resp!r}) - wrong --connect-baud, wrong --port, or not in AT/transparent mode?')


def send_at(ser, cmd):
    ser.write((cmd + "\r").encode("ascii"))
    return read_response(ser)


def query(ser, param):
    return send_at(ser, f"AT{param}").strip()


# 115200 first - both correction radios checked so far turned out to be
# here, so trying it first skips several seconds of sweeping through lower
# bauds first on every run. The rest stay as fallbacks in ascending order
# in case a future radio turns out to be somewhere else.
COMMON_BAUDS = [115200, 2400, 4800, 9600, 19200, 38400, 57600, 230400]


def find_working_baud(port, candidates):
    """Try each candidate baud in turn, opening a FRESH connection each
    time (not just re-stty'ing the same handle) - closing and reopening
    gives the OS a clean slate rather than leaving stale buffered bytes
    from a failed attempt at the wrong baud sitting around to confuse the
    next one, the same lesson learned the hard way in xbee_configure_at.py's
    own baud-detection loop. Prints whatever comes back on every attempt,
    not just the successful one - garbage-but-present bytes at a WRONG
    baud (as opposed to true silence) means the module is genuinely
    talking, just not at any baud in `candidates`; seeing the actual
    garbage can reveal which one it really is (or at least rule out a
    dead/disconnected module as the cause)."""
    for b in candidates:
        try:
            ser = open_serial(port, b)
        except serial.SerialException as e:
            print(f"Failed to open {port}: {e}")
            return None, None
        try:
            enter_command_mode(ser)
            return b, ser
        except RuntimeError as e:
            print(f"  {b:>7} baud: {e}")
            ser.close()
            time.sleep(0.2)
    return None, None


def try_api_mode(port, candidates):
    """Fallback for when AT/transparent mode (+++) gets no "OK" at any
    baud - that's also exactly what happens if the module is actually in
    API mode (AP=1/2) instead, which speaks a binary framed protocol and
    never answers +++ in plain text regardless of baud. Uses the digi-xbee
    library (same one xbee_configure_p2mp.py used, before this repo moved
    the telemetry radios to AT-only) to check. Requires `pip install
    digi-xbee` - skipped with a note if that's not installed, rather than
    crashing."""
    try:
        from digi.xbee.devices import XBeeDevice
    except ImportError:
        print("  (skipping API-mode check: digi-xbee not installed - `pip install digi-xbee` to enable it)")
        return None, None
    for b in candidates:
        device = XBeeDevice(port, b)
        try:
            device.open()
        except Exception:
            continue
        return device, b
    return None, None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", required=True, help="Serial port, e.g. /dev/cu.usbserial-0001")
    ap.add_argument(
        "--connect-baud",
        type=int,
        default=115200,
        help="Baud to connect at (radio's CURRENT speed, default 115200 - same flag name/default as "
        "xbee_configure_at.py's own --connect-baud, since it's the same concept; both correction radios "
        "checked so far were here, not Digi's own 9600 factory default; pass --detect-baud instead if "
        "that's wrong for a given radio)",
    )
    ap.add_argument(
        "--detect-baud",
        action="store_true",
        help=f"Try common bauds in turn ({', '.join(str(b) for b in COMMON_BAUDS)}) instead of just --connect-baud",
    )
    args = ap.parse_args()

    if args.detect_baud:
        print(f"Trying {args.port} at {', '.join(str(b) for b in COMMON_BAUDS)}...")
        baud, ser = find_working_baud(args.port, COMMON_BAUDS)
        if ser is None:
            print("No \"OK\" after +++ at any common baud in AT/transparent mode.")
            print("Checking whether it's actually in API mode instead...\n")
            device, api_baud = try_api_mode(args.port, COMMON_BAUDS)
            if device is None:
                print("error: not reachable via API mode either, at any common baud.")
                print("  Neither AT nor API mode answered on this port at any of the common bauds -")
                print("  double-check the port itself (`ls /dev/cu.*` before/after plugging it in),")
                print("  and that the module is actually powered and seated correctly in its socket.")
                sys.exit(1)
            print(f"Connected via API mode at {api_baud} baud.\n")

            def get_hex(param):
                try:
                    return device.get_parameter(param).hex().upper()
                except Exception as e:
                    return f"<error: {e}>"

            nid = get_hex("ID")
            try:
                ni = device.get_parameter("NI").decode("ascii", errors="replace")
            except Exception as e:
                ni = f"<error: {e}>"
            sh, sl = get_hex("SH"), get_hex("SL")
            print(f"  {'ID (Network ID)':22s} 0x{nid}")
            print(f"  {'NI (Node Identifier)':22s} {ni or '(blank)'}")
            print(f"  {'SH/SL (Serial number)':22s} {sh}{sl}")

            # Same move as xbee_configure_at.py's own FINAL_AP_MODE: this
            # radio's actual job (relaying RTCM as a plain transparent
            # link) and every other tool in this repo both expect
            # AT/transparent mode, so leave it there rather than in
            # whatever mode it happened to be found in. Set last, since
            # once it takes effect this API-mode session can't send or
            # confirm anything further.
            print(f"\nSetting AP back to 0 (transparent) at {api_baud} baud...")
            device.set_parameter("AP", bytes([0]))
            device.write_changes()
            print("Done - this radio is now in AT/transparent mode. Confirm with:")
            print(f"  python3 {sys.argv[0]} --port {args.port} --connect-baud {api_baud}")
            device.close()
            sys.exit(0)
        print(f"Connected at {baud} baud.\n")
    else:
        print(f"Connecting to {args.port} at {args.connect_baud} baud...")
        try:
            ser = open_serial(args.port, args.connect_baud)
        except serial.SerialException as e:
            print(f"Failed to open {args.port} at {args.connect_baud} baud: {e}")
            sys.exit(1)
        try:
            enter_command_mode(ser)
        except RuntimeError as e:
            print(f"Failed to enter command mode: {e}")
            print(f"  -> Try --detect-baud to sweep common rates automatically, or this module")
            print(f"     may be in API mode rather than AT/transparent mode (see --detect-baud's")
            print(f"     own failure message for more on that).")
            ser.close()
            sys.exit(1)

    try:
        print("Connected - command mode entered.\n")

        nid = query(ser, "ID")
        ni = query(ser, "NI")
        bd = query(ser, "BD")
        sh = query(ser, "SH")
        sl = query(ser, "SL")
        # D6/D7 (RTS/CTS pin function - 0 disabled, 1 flow control enabled)
        # - checked because THIS session needed RTS/DTR forced active just
        # to get any response at all, which is a flow-control-shaped
        # symptom. If these differ from a known-working radio's own
        # values, that's a real lead independent of ID (which already
        # matched); if they're the same, this rules that out too.
        d6 = query(ser, "D6")
        d7 = query(ser, "D7")

        print(f"  {'ID (Network ID)':22s} 0x{nid.upper() or '?'}")
        print(f"  {'NI (Node Identifier)':22s} {ni or '(blank)'}")
        print(f"  {'BD (Baud rate code)':22s} {bd or '?'}")
        print(f"  {'SH/SL (Serial number)':22s} {sh.upper()}{sl.upper()}")
        print(f"  {'D6 (RTS enable)':22s} {d6 or '?'}")
        print(f"  {'D7 (CTS enable)':22s} {d7 or '?'}")

        # Everything above is generic - present on essentially any Digi
        # XBee, correction radio included (see this file's own module
        # comment). Everything below is specific to xbee_configure_at.py's
        # own CONFIG dict (the telemetry radios' actual settings) - same
        # param names, same order, so a mismatch against CONFIG's own
        # values is easy to spot at a glance without cross-referencing the
        # other script by hand. Meaningless on a radio xbee_configure_at.py
        # was never run against (e.g. the SX correction radio) - it'll just
        # read back whatever that module's own factory defaults are.
        to = query(ser, "TO")
        dh = query(ser, "DH")
        dl = query(ser, "DL")
        hp = query(ser, "HP")
        mt = query(ser, "MT")
        ce = query(ser, "CE")

        print(f"\n  xbee_configure_at.py's own CONFIG (expected value in parens):")
        print(f"  {'TO (Transmit Options)':22s} 0x{to.upper() or '?':<6} (0xC0 = DigiMesh)")
        print(f"  {'DH (Dest. address high)':22s} {dh.upper() or '?':<8} (0 = broadcast)")
        print(f"  {'DL (Dest. address low)':22s} {dl.upper() or '?':<8} (FFFF = broadcast)")
        print(f"  {'HP (Preamble ID)':22s} {hp or '?':<8} (0)")
        print(f"  {'MT (Broadcast multi-tx)':22s} {mt or '?':<8} (0 = no extra repeats)")
        print(f"  {'CE (Node messaging opts)':22s} {ce or '?':<8} (2 = routing disabled)")

        send_at(ser, "ATCN")
    finally:
        ser.close()


if __name__ == "__main__":
    main()
