#!/usr/bin/env python3
"""
xbee_configure_at.py

Configure a Digi XBee-PRO S3B (900HP / DigiMesh series) radio for DigiMesh
delivery with routing/relaying disabled on every node (this fleet is
single-hop only - no boat ever needs to relay another boat's signal, so
there's nothing for mesh routing to actually do), with an identical config
on every radio in the fleet - base/committee station and every boat alike,
no role-specific settings. Entirely over AT Command Mode (the plain "+++" /
"ATxx" dialect any serial terminal speaks), the same way you'd do it by
hand, just scripted with read-back verification on every parameter,
followed by an actual soft-reset-and-reverify pass (see "Verifying
persistence" in main()) to confirm every value survives a reboot, not
just this session.

Every command name/value below is taken from Digi's own XBee-PRO 900HP/XSC
RF Modules S3 and S3B User Guide (docs.digi.com, document 90002173).

Note: Point-to-Multipoint (TO=0x40) was tried as the default twice. The
first time, it appeared to produce no traffic at all - that turned out to
be an unrelated bug in this script (a baud-rate write's response went
unchecked after the post-baud-change reconnect, so a radio whose BD didn't
actually survive a reboot still reported success; fixed, see the reset-
and-reverify pass below). Once that was fixed and persistence was directly
confirmed on both radios (every parameter, including TO=0x40 itself,
verified to survive an actual reset), traffic STILL failed between two
correctly, persistently P2MP-configured radios - a real, reproducible P2MP
incompatibility on this hardware, not a config or persistence issue.
DigiMesh (0xC0) is the confirmed-working delivery method, hence the
default here. One lead for anyone revisiting P2MP later: DigiMesh's own
broadcasts already reuse the Directed-Broadcast/Repeater wire format
(0x80), not unique DigiMesh framing - real mesh-routing framing only
applies to unicasts - and this app's traffic is 100% broadcast
(DH=0/DL=0xFFFF), so the "working" DigiMesh config was never actually
exercising DigiMesh-specific behavior for this app's own traffic pattern
in the first place.

WHY AT COMMAND MODE, NOT THE digi-xbee LIBRARY
    digi-xbee can only talk to a radio already in API mode (AP=1/2) - but
    race-tracker itself needs the radio in AT/transparent mode (AP=0, see
    README's "Radio configuration"), so using it would mean flipping AP
    to 1 by hand first, then back to 0 again afterward before the app
    could talk to the radio again. Speaking AT Command Mode directly
    (plain pyserial, no digi-xbee) avoids that entirely - the radio never
    leaves AT/transparent mode, so there's no mode to flip either way.

WHAT THIS DOES
    - Sets TO (Transmit Options) bits 6:7 to DigiMesh (0xC0) - the
      delivery-method switch on this module (0x40 = Point-to-Multipoint,
      0x80 = directed broadcast/repeater).
    - Sets ID, DH/DL, HP, MT, BD to the values below.
    - Sets CE (Node Messaging Options) to disable routing on this node
      (bit 1) - this fleet is single-hop, so no node should ever act as
      an intermediate relay for another's traffic, regardless of TO.
    - Writes the config to non-volatile memory (so it survives power
      cycling), reads every value back within THIS session to confirm it
      stuck, then does a real soft reset and re-checks everything again
      to confirm it actually survives a reboot (see main()).

BEFORE YOU RUN THIS
    pip install pyserial

    Run once per radio - base/committee station and every rover, all get
    the identical config below. Channel selection (the CM command - a
    64-bit channel mask, not a simple index) isn't touched by this script
    at all; set it by hand first if your network needs to avoid specific
    frequencies (see CM in the user guide).

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

    # TO (Transmit Options), bits 6:7 are the delivery method: 0x40 =
    # Point-to-Multipoint, 0x80 = directed broadcast/repeater, 0xC0 =
    # DigiMesh (mesh routing) - confirmed working on real hardware, see
    # the top-of-file Note on why this is 0xC0 rather than 0x40. Bits 0-3
    # (ack/route-discovery/NACK/trace-route options) left at 0 - ordinary
    # acked, routed unicasts.
    "TRANSMIT_OPTIONS": 0xC0,

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
    # routing on this node, so it won't relay other nodes' DigiMesh/
    # broadcast traffic - this fleet is single-hop only, nothing should
    # ever need relaying. Same value on every radio in the fleet.
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


def compare_row(label, current_raw, target_hex, decode=None):
    """Print one dry-run row: the radio's CURRENT value for one parameter
    next to what this script would set it TO - always, even when they
    already match, so the full current/target picture stays visible. Only
    an actual mismatch (or an unreadable current value) gets a trailing
    status flag - a matching row's status is left blank rather than
    spelling out "already correct" on every single line. Returns True if
    applying the script would actually change this parameter, so the
    caller can tally how many will. decode(int)->str, if given, appends a
    human-readable label to both sides (e.g. TO's delivery method, BD's
    baud rate)."""
    cur_val = hex_to_int(current_raw)
    tgt_val = hex_to_int(target_hex)
    cur_str = f"0x{cur_val:X}" if cur_val is not None else f"<no response: {current_raw!r}>"
    tgt_str = f"0x{tgt_val:X}"
    if decode:
        if cur_val is not None:
            cur_str += f" ({decode(cur_val)})"
        tgt_str += f" ({decode(tgt_val)})"
    will_change = cur_val is None or cur_val != tgt_val
    status = ""
    if cur_val is None:
        status = "*** currently unreadable - would attempt to set anyway ***"
    elif will_change:
        status = "*** WILL CHANGE ***"
    print(f"  {label:28s} current={cur_str:<26} target={tgt_str:<26} {status}")
    return will_change


def dry_run_report(ser, target_baud):
    """Same parameters read_config reads, but as a current-vs-target diff
    against CONFIG (and --target-baud for BD) - so --dry-run answers "what
    would actually change" directly, not just "what's there now" (which
    left it up to you to compare against CONFIG by eye). Every parameter
    gets a row regardless of whether it matches (see compare_row); a
    trailing summary line says how many of them actually would change.
    Returns the number of mismatches - 0 means everything already matches
    CONFIG, which main() also uses as its actual proof of persistence: it
    re-runs this against the radio after a real reset (see "Verifying
    persistence" below), not just against the same still-running session
    a set-and-verify readback would trust."""
    changed = 0

    changed += compare_row("TO (Transmit Options)", query(ser, "TO"), format(CONFIG["TRANSMIT_OPTIONS"], "X"),
                            decode=lambda v: TO_DELIVERY_LABELS.get((v >> 6) & 0b11, "unknown"))

    nid = CONFIG["NETWORK_ID"]
    nid_hex = nid[2:] if nid.lower().startswith("0x") else nid
    changed += compare_row("ID (Network ID)", query(ser, "ID"), nid_hex)

    changed += compare_row("DH (Dest high)", query(ser, "DH"), CONFIG["DH"])
    changed += compare_row("DL (Dest low)", query(ser, "DL"), CONFIG["DL"])
    changed += compare_row("HP (Preamble ID)", query(ser, "HP"), format(CONFIG["HP"], "X"))
    changed += compare_row("MT (Broadcast Multi-Tx)", query(ser, "MT"), format(CONFIG["MT"], "X"))
    changed += compare_row("CE (Node Msg Options)", query(ser, "CE"), format(CONFIG["CE"], "X"))

    total = 7  # TO, ID, DH, DL, HP, MT, CE - kept in sync with the calls above

    bd_code = BAUD_CODE_MAP.get(target_baud)
    if bd_code is not None:
        changed += compare_row("BD (Baud rate)", query(ser, "BD"), format(bd_code, "X"),
                                decode=lambda v: f"{BAUD_CODE_TO_RATE.get(v, 'code ' + str(v))} baud")
        total += 1
    else:
        print(f"  {'BD (Baud rate)':28s} no code mapping for --target-baud {target_baud}, skipping comparison")

    if changed == 0:
        print(f"\nAll {total} parameters already match - running for real would be a no-op.")
    else:
        print(f"\n{changed} of {total} parameters would change.")
    return changed


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
    hint and exits for the two failure modes actually seen in practice.
    Prints which baud it's trying BEFORE attempting anything, not just on
    success - a wrong --connect-baud is the single most common way this
    fails, and the baud actually being tried needs to be visible right
    next to that failure, not buried in a success message that never
    prints."""
    print(f"Connecting to {port} at {baud} baud...")
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
        print(f"Failed to enter command mode at {baud} baud: {e}")
        print(f"  -> If this radio was already configured before (e.g. RADIO_BAUD=115200 in "
              f"race-tracker's own .env, or a prior run of this script), it's likely no longer at the "
              f"XBee factory default (9600) - retry with --connect-baud matching its CURRENT speed, "
              f"e.g. --connect-baud 115200.")
        print(f"  -> On a genuinely factory-fresh radio (9600 IS correct), a totally empty response "
              f"more often means: wrong --port (double check with `ls /dev/cu.*` before/after "
              f"plugging it in), TX/RX swapped on the wiring, or the radio not actually getting "
              f"power/a solid USB connection. Try the same +++ by hand in a plain terminal (`screen "
              f"{port} {baud}`) to see whether the problem is this script or the link itself.")
        ser.close()
        sys.exit(1)
    print(f"Connected at {baud} baud - command mode entered.")
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

    try:
        if args.dry_run:
            print("\nCurrent radio configuration vs. what this script would set (nothing written yet):")
            dry_run_report(ser, args.target_baud)
            send_at(ser, "ATCN")
            print("\n--dry-run: not changing anything.")
            return

        print("\n--- BEFORE ---")
        read_config(ser)

        print("\nApplying config...")
        all_ok = True

        all_ok &= set_and_verify(ser, "TO", format(CONFIG["TRANSMIT_OPTIONS"], "X"), "TO (Transmit Options)")

        nid = CONFIG["NETWORK_ID"]
        nid_hex = nid[2:] if nid.lower().startswith("0x") else nid
        all_ok &= set_and_verify(ser, "ID", nid_hex, "ID (Network ID)")

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
                wr_resp = send_at(ser, "ATWR")
                if "OK" not in wr_resp:
                    print(f"  *** BD write (WR) did not return OK (got {wr_resp!r}) - baud rate may "
                          f"NOT survive a reboot. Re-run this script to confirm/retry. ***")
                    all_ok = False
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
                # write again now that we're talking to it at the new baud, and
                # actually check the response this time (a prior version of
                # this script silently discarded it - if this particular WR
                # ever failed, BD would revert to its old value on the next
                # power cycle with no indication anything was wrong).
                wr_resp = send_at(ser, "ATWR")
                if "OK" not in wr_resp:
                    print(f"  *** BD write (WR) after baud-switch did not return OK (got {wr_resp!r}) - "
                          f"baud rate may NOT survive a reboot. Re-run this script to confirm/retry. ***")
                    all_ok = False
                else:
                    # Belt-and-suspenders read-only check (no re-set, so it
                    # can't undo the WR above) - confirms the NEW baud is
                    # what's actually stored, not just that WR said OK.
                    bd_readback = hex_to_int(query(ser, "BD"))
                    if bd_readback != bd_code:
                        print(f"  *** BD (Baud rate, post-reconnect)     readback={bd_readback} "
                              f"expected={bd_code} *** MISMATCH ***")
                        all_ok = False
                    else:
                        print(f"  {'BD (Baud rate, post-reconnect)':28s} readback={bd_readback:<10} OK")
                bd_changed = True

        print("\n--- AFTER (this session's own memory - not proof of persistence) ---")
        read_config(ser)

        # A set-and-verify readback, and even the "AFTER" dump above, only
        # prove a parameter is correct in the device's CURRENT session -
        # exactly what silently masked the earlier BD-not-surviving-reboot
        # bug (its own WR response went unchecked, so nothing here would
        # have caught it either). A real soft reset via FR (Force Reset)
        # exercises the actual load-from-NVM-on-boot path a power cycle
        # would, so reconnecting afterward and re-diffing against CONFIG
        # (reusing dry_run_report - same check --dry-run does) is the
        # first thing in this script that actually proves persistence
        # rather than assuming it from an "OK" string.
        print("\n--- Verifying persistence (soft reset) ---")
        verify_baud = target_baud if (target_baud != 0 and target_baud in BAUD_CODE_MAP) else args.connect_baud
        fr_resp = send_at(ser, "ATFR")
        if "OK" not in fr_resp:
            print(f"  *** FR (Force Reset) did not return OK (got {fr_resp!r}) - could not verify "
                  f"persistence. Re-run this script to confirm settings actually survive a reboot. ***")
            all_ok = False
        else:
            ser.close()
            time.sleep(1.5)  # let the module actually finish rebooting before reconnecting
            ser = open_and_enter_command_mode(args.port, verify_baud)
            print("Reconnected after reset - re-checking every parameter against CONFIG:")
            mismatches = dry_run_report(ser, verify_baud)
            if mismatches:
                print(f"*** {mismatches} parameter(s) reverted after reset - see above. Re-run this "
                      f"script; if it keeps happening, something below the script's own visibility "
                      f"(e.g. power cut before a flash write physically completes) is the real cause. ***")
                all_ok = False

        print("\n" + ("All parameters verified OK and confirmed to survive a reset." if all_ok else
                       "*** One or more parameters did not verify or did not survive a reset -- "
                       "check output above. ***"))

        if bd_changed:
            print(f"\nNote: radio's serial baud rate is now {target_baud}. "
                  f"Reconnect future sessions with --connect-baud {target_baud}.")

        send_at(ser, "ATCN")

    except serial.SerialException as e:
        # A mid-session OS-level read/write failure - not a bug in this
        # script's own AT-command logic (that would show up as garbled or
        # missing responses, not an exception from pyserial itself). This
        # means the OS lost the underlying device: the USB-serial adapter
        # or the radio disconnected/reset mid-session, another process
        # grabbed the port out from under us, or a marginal
        # cable/connector dropped out under the intermittent current draw
        # of a live radio.
        print(f"\n*** Lost the connection to {args.port} mid-session: {e} ***")
        print("  -> Check the physical USB connection (reseat the cable/adapter, try a different "
              "port, avoid unpowered hubs), confirm nothing else opened this port during the run, "
              "and re-run once the link is solid. If this keeps happening on one specific radio, "
              "suspect that radio/its connector rather than this script.")
        sys.exit(1)

    finally:
        # A port that just raised SerialException may already be in a bad
        # state at the OS level - closing it should be harmless, but this
        # is cleanup code, not somewhere a second exception should get to
        # mask or crash past the one already being handled/reported above.
        try:
            ser.close()
        except serial.SerialException:
            pass


if __name__ == "__main__":
    main()
