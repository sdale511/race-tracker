#!/usr/bin/env python3
"""
xbee_configure_at.py

Configure a Digi XBee-PRO S3B (900HP / DigiMesh series) radio for
Point-to-Multipoint ("one to many") operation instead of full DigiMesh
mesh routing, and match it to the rest of the rover/base radio network -
entirely over AT Command Mode (the plain "+++" / "ATxx" dialect any
serial terminal speaks), the same way you'd do it by hand, just scripted
with read-back verification on every parameter.

Every command name/value below is taken from Digi's own XBee-PRO 900HP/XSC
RF Modules S3 and S3B User Guide (docs.digi.com, document 90002173) - an
earlier version of this script guessed at a "MM" (MAC Mode) command and a
CE(base)/CD(rover) role split by analogy with other XBee product lines,
neither of which actually exist on THIS module (confirmed live against a
real, already-correctly-configured radio: both returned "ERROR"). See
WHAT THIS DOES below for what the real commands are.

WHY AT COMMAND MODE, NOT THE digi-xbee LIBRARY
    digi-xbee can only talk to a radio already in API mode (AP=1/2) - but
    race-tracker itself needs the radio in AT/transparent mode (AP=0, see
    README's "Radio configuration"), so using it would mean flipping AP
    to 1 by hand first, then back to 0 again afterward before the app
    could talk to the radio again. Speaking AT Command Mode directly
    (plain pyserial, no digi-xbee) avoids that entirely - the radio never
    leaves AT/transparent mode, so there's no mode to flip either way.

WHAT THIS DOES
    - Sets TO (Transmit Options) bits 6:7 to Point-to-Multipoint (0x40) -
      THE actual delivery-method switch on this module (0x80 = directed
      broadcast/repeater, 0xC0 = DigiMesh mesh routing). There is no "MM"
      command on this module at all.
    - Sets ID, DH/DL, HP, MT, BD to the values below.
    - Sets CE (Node Messaging Options) to disable routing on this node
      (bit 1) - there's no base/rover distinction at the radio level on
      this module (no "CD" command exists here either), so every radio
      gets the same config regardless of which end of the link it is.
    - Writes the config to non-volatile memory (so it survives power
      cycling) and reads every value back to confirm it actually stuck.

BEFORE YOU RUN THIS
    pip install pyserial

    Run once per radio - base/committee station and every rover, all get
    the identical config below. CHANNEL_MASK is still a placeholder below
    -- fill it in (see the CM command in the user guide) if your network
    pins a specific channel set; leave it as None to leave CM alone.

    Only one process can hold a serial port at a time - stop any running
    `npm run base`/`npm run boat`/`npm run radio-test` (or XCTU, a
    terminal session, etc.) using this same port before running this.

USAGE
    python3 xbee_configure_at.py --port /dev/ttyUSB0
    python3 xbee_configure_at.py --port /dev/ttyUSB0 --dry-run   # read current config, change nothing
"""

import argparse
import sys
import time

import serial

# ─── CONFIG ─────────────────────────────────────────────────────────────

CONFIG = {
    # Serial baud the radio will run at going forward. The script
    # connects at --connect-baud (its CURRENT speed) and, if different,
    # switches it to this and reconnects to confirm.
    "TARGET_BAUD": 115200,        # was 9600 by default

    # Network ID (PAN ID), 0 - 0x7FFF. Coincidentally already the factory
    # default too, but set explicitly so it's never left to chance.
    "NETWORK_ID": "0x7FFF",

    # Channel Mask (CM) — leave as None to skip (not touched). This module
    # has no simple "CH" channel-index command; channel selection is this
    # 64-bit bitfield instead (see the CM command in the user guide) if
    # your network needs to avoid specific frequencies.
    "CHANNEL_MASK": None,

    # TO (Transmit Options), bits 6:7 are the delivery method: 0x40 =
    # Point-to-Multipoint, 0x80 = directed broadcast/repeater, 0xC0 =
    # DigiMesh (mesh routing) - the actual mode switch on this module,
    # there is no separate "MM" command here. Bits 0-3 (ack/route-discovery/
    # NACK/trace-route options) left at 0 - ordinary acked, routed unicasts.
    "TRANSMIT_OPTIONS": 0x40,

    # Destination addressing: broadcast (DH=0, DL=0xFFFF) -- default.
    "DH": "0",
    "DL": "FFFF",

    # Preamble ID (HP) -- default.
    "HP": 0,

    # MT (Broadcast Multi-Transmits) -- how many EXTRA times a broadcast
    # is repeated (packets sent = MT+1). Was 3 by default, set to 0.
    "MT": 0,

    # CE (Node Messaging Options), a bitfield for the (unused here)
    # Indirect Messaging sleep/polling feature - bit 1 (value 2) disables
    # routing on this node, appropriate for a non-mesh Point-to-Multipoint
    # network. Same value on every radio - this module has no CE/CD
    # base-vs-rover role split (no "CD" command exists at all).
    "CE": 2,
}

# ─── End config ──────────────────────────────────────────────────────────

# Must exceed the module's own guard time (the "GT" parameter, 1000ms by
# default) both before AND after "+++", or the module reads it as three
# ordinary data bytes instead of the command-mode escape sequence. We only
# need to guarantee the BEFORE side here - the AFTER side falls out for
# free since we always wait for a response before sending anything else.
GUARD_TIME_S = 1.1

RESPONSE_TIMEOUT_S = 2.0
# Stop reading early once this long has passed since the last byte
# arrived, rather than always waiting the full RESPONSE_TIMEOUT_S for a
# short "OK\r" - keeps a config run from taking forever over ~20 commands.
IDLE_GAP_S = 0.25

BAUD_CODE_MAP = {2400: 1, 4800: 2, 9600: 3, 19200: 4, 38400: 5, 57600: 6, 115200: 7, 230400: 8}
BAUD_CODE_TO_RATE = {v: k for k, v in BAUD_CODE_MAP.items()}

# TO (Transmit Options) bits 6:7 - see TRANSMIT_OPTIONS's own comment above.
TO_DELIVERY_LABELS = {0b00: "<invalid>", 0b01: "Point-to-Multipoint", 0b10: "Directed broadcast/repeater",
                       0b11: "DigiMesh (mesh)"}


def hex_to_int(s):
    """Parse a stripped hex string (as AT command mode returns/accepts,
    no 0x prefix) to an int, or None if it doesn't look like one - e.g. an
    empty/garbled response from a wrong baud or a command this firmware
    doesn't support."""
    s = (s or "").strip()
    if not s:
        return None
    try:
        return int(s, 16)
    except ValueError:
        return None


def read_response(ser, timeout=RESPONSE_TIMEOUT_S, idle_gap=IDLE_GAP_S):
    """Read whatever the radio sends back after a command, stopping once
    idle_gap has passed with no new bytes (response is almost certainly
    complete) or timeout is hit outright (nothing coming back at all -
    wrong baud, not actually an XBee, etc.)."""
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
    """Send the "+++" escape sequence and confirm the module answers
    "OK" - the same thing typing it into a terminal does. Raises
    RuntimeError (not a bare assert) since the caller wants to print a
    specific, actionable message rather than a stack trace."""
    ser.reset_input_buffer()
    ser.reset_output_buffer()
    time.sleep(GUARD_TIME_S)
    ser.write(b"+++")
    resp = read_response(ser, timeout=2.0)
    if "OK" not in resp:
        raise RuntimeError(
            f"no \"OK\" after +++ (got {resp!r}) - wrong --connect-baud, wrong --port, "
            f"or this isn't an XBee currently in AT/transparent mode?"
        )


def send_at(ser, cmd):
    """Write one AT command (without the trailing \\r - added here) and
    return whatever comes back, stripped of surrounding whitespace."""
    ser.write((cmd + "\r").encode("ascii"))
    return read_response(ser)


def query(ser, param):
    """Read-only: AT<param> with no value queries the current setting."""
    return send_at(ser, f"AT{param}").strip()


def set_and_verify(ser, param, value_hex, label):
    """AT<param><value_hex> to set it, then a bare query to read it back -
    set-then-confirm, entirely over AT Command Mode text (no digi-xbee,
    no binary API frames). Compares as integers (not raw strings) since a
    readback may come back with different leading-zero padding than what
    was sent, without that being a real mismatch."""
    resp = send_at(ser, f"AT{param}{value_hex}")
    set_ok = "OK" in resp
    readback = query(ser, param)
    a, b = hex_to_int(value_hex), hex_to_int(readback)
    match = set_ok and a is not None and a == b
    print(f"  {label:28s} set={value_hex:<10} readback={readback.upper():<10} "
          f"{'OK' if match else '*** MISMATCH ***'}")
    return match


def read_config(ser):
    """Read and print every parameter this script cares about, decoded
    into human-readable form where possible. Safe to call any time -
    read-only, never writes anything."""
    to = query(ser, "TO")
    to_val = hex_to_int(to)
    if to_val is not None:
        delivery = TO_DELIVERY_LABELS.get((to_val >> 6) & 0b11, "unknown")
        print(f"  {'TO (Transmit Options)':28s} 0x{to_val:02X}  -> {delivery}")
    else:
        print(f"  {'TO (Transmit Options)':28s} <no response: {to!r}>")

    nid = query(ser, "ID")
    print(f"  {'ID (Network ID)':28s} 0x{nid.upper() or '?'}")

    dh, dl = query(ser, "DH"), query(ser, "DL")
    broadcast = hex_to_int(dh) == 0 and hex_to_int(dl) == 0xFFFF
    print(f"  {'DH/DL (Destination)':28s} {dh.upper()}/{dl.upper()}{'  (broadcast)' if broadcast else ''}")

    hp = query(ser, "HP")
    print(f"  {'HP (Preamble ID)':28s} {hex_to_int(hp)}")

    mt = query(ser, "MT")
    print(f"  {'MT (Broadcast Multi-Tx)':28s} {hex_to_int(mt)}")

    ce = query(ser, "CE")
    print(f"  {'CE (Node Msg Options)':28s} {hex_to_int(ce)}")

    bd = query(ser, "BD")
    bd_val = hex_to_int(bd)
    rate = BAUD_CODE_TO_RATE.get(bd_val, f"code {bd_val} (unmapped)") if bd_val is not None else "?"
    print(f"  {'BD (Baud rate)':28s} {rate}")


def open_and_enter_command_mode(port, baud):
    """Shared by the initial connect and the post-baud-change reconnect
    below - opens the port and enters command mode, or prints a specific
    hint and exits for the two failure modes actually seen in practice."""
    try:
        ser = serial.Serial(port, baud, timeout=0.05)
    except serial.SerialException as e:
        print(f"Failed to open {port} at {baud} baud: {e}")
        msg = str(e).lower()
        if "lock" in msg or "temporarily unavailable" in msg:
            print("  -> Something else already has this port open. Only one process can hold a "
                  "serial port at a time -- stop any running `npm run base`/`npm run boat`/"
                  "`npm run radio-test`, XCTU, or other serial terminal using this port, then retry.")
        sys.exit(1)
    try:
        enter_command_mode(ser)
    except RuntimeError as e:
        print(f"Failed to enter command mode: {e}")
        ser.close()
        sys.exit(1)
    return ser


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", required=True, help="Serial port, e.g. /dev/ttyUSB0 or COM5")
    ap.add_argument("--connect-baud", type=int, default=9600,
                     help="Baud to connect at (radio's CURRENT speed, default 9600 factory default)")
    ap.add_argument("--target-baud", type=int, default=CONFIG["TARGET_BAUD"],
                     help=f"Baud to SET the radio to (BD parameter, default {CONFIG['TARGET_BAUD']}). "
                          f"Pass --target-baud 0 to leave BD untouched.")
    ap.add_argument("--dry-run", action="store_true", help="Read current config only, change nothing")
    args = ap.parse_args()

    ser = open_and_enter_command_mode(args.port, args.connect_baud)
    print(f"Connected to {args.port} @ {args.connect_baud} baud - command mode entered")

    try:
        if args.dry_run:
            print("\nCurrent radio configuration:")
            read_config(ser)
            send_at(ser, "ATCN")
            print("\n--dry-run: not changing anything.")
            return

        print("\n--- BEFORE ---")
        read_config(ser)

        print("\nApplying Point-to-Multipoint config...")
        all_ok = True

        all_ok &= set_and_verify(ser, "TO", format(CONFIG["TRANSMIT_OPTIONS"], "X"), "TO (Transmit Options)")

        nid = CONFIG["NETWORK_ID"]
        nid_hex = nid[2:] if nid.lower().startswith("0x") else nid
        all_ok &= set_and_verify(ser, "ID", nid_hex, "ID (Network ID)")

        if CONFIG["CHANNEL_MASK"] is not None:
            cm = CONFIG["CHANNEL_MASK"]
            cm_hex = cm[2:] if cm.lower().startswith("0x") else cm
            all_ok &= set_and_verify(ser, "CM", cm_hex, "CM (Channel Mask)")

        all_ok &= set_and_verify(ser, "DH", CONFIG["DH"], "DH (Dest high)")
        all_ok &= set_and_verify(ser, "DL", CONFIG["DL"], "DL (Dest low)")
        all_ok &= set_and_verify(ser, "HP", format(CONFIG["HP"], "X"), "HP (Preamble ID)")
        all_ok &= set_and_verify(ser, "MT", format(CONFIG["MT"], "X"), "MT (Broadcast Multi-Tx)")
        all_ok &= set_and_verify(ser, "CE", format(CONFIG["CE"], "X"), "CE (Node Msg Options)")

        # Write everything set so far, BEFORE touching baud - once BD
        # changes, this session's own connection (still at connect-baud)
        # may stop working mid-command, so anything not saved yet by then
        # would be lost.
        wr_resp = send_at(ser, "ATWR")
        print(f"\nConfig (excl. baud) written to non-volatile memory (WR): "
              f"{'OK' if 'OK' in wr_resp else wr_resp.strip()!r}")

        target_baud = args.target_baud
        bd_changed = False
        if target_baud == 0:
            print("Skipping BD: --target-baud 0 given, leaving baud rate untouched.")
        elif target_baud not in BAUD_CODE_MAP:
            print(f"Skipping BD: no code mapping for {target_baud} baud, set manually if needed.")
        else:
            bd_code = BAUD_CODE_MAP[target_baud]
            if target_baud == args.connect_baud:
                # Already at the target baud - set/verify/write normally,
                # no reconnect dance needed.
                all_ok &= set_and_verify(ser, "BD", format(bd_code, "X"), "BD (Baud rate)")
                send_at(ser, "ATWR")
            else:
                print(f"\nSetting BD to {target_baud} (code {bd_code}) - this switches the radio's "
                      f"actual serial speed, so this session (still at {args.connect_baud}) may stop "
                      f"responding right after. Reconnecting at {target_baud}...")
                send_at(ser, f"ATBD{bd_code:X}")  # response may or may not still arrive at the old baud
                ser.close()
                time.sleep(0.3)
                ser = open_and_enter_command_mode(args.port, target_baud)
                # The BD change itself may not have made it into non-volatile
                # memory if the switch happened before WR was processed -
                # write again now that we're talking to it at the new baud.
                send_at(ser, "ATWR")
                bd_changed = True

        print("\n--- AFTER ---")
        read_config(ser)

        print("\n" + ("All parameters verified OK." if all_ok else
                       "*** One or more parameters did not verify -- check output above. ***"))

        if bd_changed:
            print(f"\nNote: radio's serial baud rate is now {target_baud}. "
                  f"Reconnect future sessions with --connect-baud {target_baud}.")

        send_at(ser, "ATCN")

    finally:
        ser.close()


if __name__ == "__main__":
    main()
