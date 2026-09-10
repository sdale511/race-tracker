#!/usr/bin/env python3
"""
xbee_configure_p2mp.py

Configure a Digi XBee-PRO S3B (900HP / DigiMesh series) radio for
Point-to-Multipoint ("one to many") operation instead of full DigiMesh
mesh routing, and match it to the rest of the rover/base radio network.

WHAT THIS DOES
    - Sets MM (MAC Mode) = 2  -> Digi Point-to-Multipoint (no mesh hop
      routing; this is the non-mesh "one to many" mode).
    - Sets ID, DH/DL, HP, MT, BD to the values below.
    - Sets CE (base radios) or CD (rover radios) depending on --role.
    - Writes the config to non-volatile memory (so it survives power
      cycling) and reads every value back to confirm it actually stuck.

BEFORE YOU RUN THIS
    pip install digi-xbee

    Run once per radio, passing --role base for the base/committee
    station radio and --role rover for each rover radio. CHANNEL is
    still a placeholder below -- fill it in if your network pins a
    specific channel/channel mask; leave it as None to leave CH alone.

USAGE
    python3 xbee_configure_p2mp.py --port /dev/ttyUSB0 --role base
    python3 xbee_configure_p2mp.py --port /dev/ttyUSB0 --role rover
    python3 xbee_configure_p2mp.py --port /dev/ttyUSB0 --dry-run   # read current config, change nothing
"""

import argparse
import sys

from digi.xbee.devices import XBeeDevice

# ─── CONFIG ─────────────────────────────────────────────────────────────

CONFIG = {
    # Serial baud the radio will run at going forward. The script
    # connects at --connect-baud (its CURRENT speed) and, if different,
    # switches it to this and tells you to reconnect at the new speed
    # next time.
    "TARGET_BAUD": 115200,        # was 9600 by default

    # Network ID (PAN ID), hex string.
    "NETWORK_ID": "0x7FFF",       # default

    # Channel — leave as None to skip (not touched). Set to a hex string
    # (e.g. "0x0") if your network pins a specific channel/channel mask.
    "CHANNEL": None,

    # MAC Mode: 0 = DigiMesh (mesh), 2 = Digi Point-to-Multipoint (no mesh).
    "MAC_MODE": 2,

    # Destination addressing: broadcast (DH=0, DL=0xFFFF) -- default.
    "DH": "00000000",
    "DL": "0000FFFF",

    # Preamble ID / Hopping (HP) -- default.
    "HP": 0,

    # MT: unicast retries -- was 3 by default, set to 0.
    "MT": 0,

    # CE: Coordinator Enable -- applies to BASE radios only. Default 0.
    "CE_BASE": 0,

    # CD: applies to ROVER radios only. Non-default value 2.
    "CD_ROVER": 2,
}

# ─── End config ──────────────────────────────────────────────────────────


def to_bytes_min(value_int):
    """Smallest big-endian byte representation of a non-negative int."""
    length = max(1, (value_int.bit_length() + 7) // 8)
    return value_int.to_bytes(length, "big")


def set_and_verify(device, param, value_bytes, label):
    device.set_parameter(param, value_bytes)
    readback = device.get_parameter(param)
    ok = readback == value_bytes
    print(f"  {label:28s} set={value_bytes.hex().upper():<12} "
          f"readback={readback.hex().upper():<12} {'OK' if ok else '*** MISMATCH ***'}")
    return ok


# Reverse of the BD code map used when writing, for showing a human baud
# value when reading a radio's current config.
BAUD_CODE_TO_RATE = {3: 9600, 4: 19200, 5: 38400, 6: 57600, 7: 115200}

MM_LABELS = {0: "DigiMesh (mesh)", 2: "Point-to-Multipoint (non-mesh)"}


def read_param(device, param):
    """Read one AT parameter; return None (and print a note) if unsupported."""
    try:
        return device.get_parameter(param)
    except Exception as e:
        print(f"  {param:28s} <could not read: {e}>")
        return None


def read_config(device):
    """Read and print every parameter this script cares about, decoded
    into human-readable form where possible. Safe to call any time --
    read-only, never writes anything."""
    print("\nCurrent radio configuration:")

    mm = read_param(device, "MM")
    if mm is not None:
        mm_val = mm[0]
        print(f"  {'MM (MAC mode)':28s} {mm_val}  -> {MM_LABELS.get(mm_val, 'unknown')}")

    nid = read_param(device, "ID")
    if nid is not None:
        print(f"  {'ID (Network ID)':28s} 0x{nid.hex().upper()}")

    ch = read_param(device, "CH")
    if ch is not None:
        print(f"  {'CH (Channel)':28s} 0x{ch.hex().upper()}")

    dh = read_param(device, "DH")
    dl = read_param(device, "DL")
    if dh is not None and dl is not None:
        broadcast = dh == bytes(4) and dl.hex().upper() == "0000FFFF"
        print(f"  {'DH/DL (Destination)':28s} {dh.hex().upper()}/{dl.hex().upper()}"
              f"{'  (broadcast)' if broadcast else ''}")

    hp = read_param(device, "HP")
    if hp is not None:
        print(f"  {'HP':28s} {int.from_bytes(hp, 'big')}")

    mt = read_param(device, "MT")
    if mt is not None:
        print(f"  {'MT (unicast retries)':28s} {int.from_bytes(mt, 'big')}")

    ce = read_param(device, "CE")
    if ce is not None:
        print(f"  {'CE (base role)':28s} {int.from_bytes(ce, 'big')}")

    cd = read_param(device, "CD")
    if cd is not None:
        print(f"  {'CD (rover role)':28s} {int.from_bytes(cd, 'big')}")

    bd = read_param(device, "BD")
    if bd is not None:
        bd_val = int.from_bytes(bd, "big")
        rate = BAUD_CODE_TO_RATE.get(bd_val, f"code {bd_val} (unmapped)")
        print(f"  {'BD (Baud rate)':28s} {rate}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", required=True, help="Serial port, e.g. /dev/ttyUSB0 or COM5")
    ap.add_argument("--connect-baud", type=int, default=9600,
                     help="Baud to connect at (radio's CURRENT speed, default 9600 factory default)")
    ap.add_argument("--target-baud", type=int, default=CONFIG["TARGET_BAUD"],
                     help=f"Baud to SET the radio to (BD parameter, default {CONFIG['TARGET_BAUD']}). "
                          f"Pass --target-baud 0 to leave BD untouched.")
    ap.add_argument("--role", default="rover", choices=["base", "rover"],
                     help="base -> sets CE; rover -> sets CD (default: rover)")
    ap.add_argument("--dry-run", action="store_true", help="Read current config only, change nothing")
    args = ap.parse_args()

    device = XBeeDevice(args.port, args.connect_baud)
    try:
        device.open()
    except Exception as e:
        print(f"Failed to open {args.port} at {args.connect_baud} baud: {e}")
        sys.exit(1)

    try:
        print(f"Connected to {args.port} @ {args.connect_baud} baud (role: {args.role})")
        print(f"  Node ID:        {device.get_node_id()}")
        print(f"  Hardware ver:   {device.get_hardware_version()}")
        print(f"  Firmware ver:   {device.get_firmware_version().hex().upper()}")
        print(f"  64-bit address: {device.get_64bit_addr()}")

        if args.dry_run:
            read_config(device)
            print("\n--dry-run: not changing anything.")
            return

        print("\n--- BEFORE ---")
        read_config(device)

        print("\nApplying Point-to-Multipoint config...")
        all_ok = True

        # MM: MAC Mode -> 2 = Point-to-Multipoint (non-mesh)
        all_ok &= set_and_verify(device, "MM", bytes([CONFIG["MAC_MODE"]]), "MM (MAC mode)")

        # ID: Network/PAN ID
        nid = int(CONFIG["NETWORK_ID"], 16)
        all_ok &= set_and_verify(device, "ID", to_bytes_min(nid), "ID (Network ID)")

        # CH: channel, only if specified
        if CONFIG["CHANNEL"] is not None:
            ch = int(CONFIG["CHANNEL"], 16)
            all_ok &= set_and_verify(device, "CH", to_bytes_min(ch), "CH (Channel)")

        # DH/DL: destination addressing (broadcast by default)
        all_ok &= set_and_verify(device, "DH", bytes.fromhex(CONFIG["DH"]), "DH (Dest high)")
        all_ok &= set_and_verify(device, "DL", bytes.fromhex(CONFIG["DL"]), "DL (Dest low)")

        # HP: preamble/hopping
        all_ok &= set_and_verify(device, "HP", to_bytes_min(CONFIG["HP"]), "HP")

        # MT: unicast retries
        all_ok &= set_and_verify(device, "MT", to_bytes_min(CONFIG["MT"]), "MT (unicast retries)")

        # CE (base) or CD (rover), role-dependent
        if args.role == "base":
            all_ok &= set_and_verify(device, "CE", to_bytes_min(CONFIG["CE_BASE"]), "CE (base)")
        else:
            all_ok &= set_and_verify(device, "CD", to_bytes_min(CONFIG["CD_ROVER"]), "CD (rover)")

        # BD: baud rate (change last, since it changes how we talk to it)
        baud_code_map = {9600: 3, 19200: 4, 38400: 5, 57600: 6, 115200: 7}
        target_baud = args.target_baud
        if target_baud == 0:
            print("  Skipping BD: --target-baud 0 given, leaving baud rate untouched.")
        elif target_baud in baud_code_map:
            bd_code = baud_code_map[target_baud]
            all_ok &= set_and_verify(device, "BD", bytes([bd_code]), "BD (Baud rate)")
        else:
            print(f"  Skipping BD: no code mapping for {target_baud} baud, set manually if needed.")
            target_baud = 0  # nothing changed, don't try to reconnect below

        # Write to non-volatile memory so it survives power cycling
        device.write_changes()
        print("\nConfig written to non-volatile memory (WR).")

        # If BD changed, the radio has already switched speed, but our
        # open serial connection is still at the old baud -- reconnect
        # at the new speed before reading anything back.
        bd_changed = target_baud != 0 and target_baud in baud_code_map and target_baud != args.connect_baud
        if bd_changed:
            print(f"\nReconnecting at {target_baud} baud (radio switched speed)...")
            device.close()
            device = XBeeDevice(args.port, target_baud)
            device.open()

        print("\n--- AFTER ---")
        read_config(device)

        print("\n" + ("All parameters verified OK." if all_ok else
                       "*** One or more parameters did not verify -- check output above. ***"))

        if bd_changed:
            print(f"\nNote: radio's serial baud rate is now {target_baud}. "
                  f"Reconnect future sessions with --connect-baud {target_baud}.")

    finally:
        device.close()


if __name__ == "__main__":
    main()
