#!/usr/bin/env python3
"""
rtcm_listen.py

Listens on a serial port (e.g. the radio that is RECEIVING the RTK correction
link) and tells you what is actually in the byte stream, instead of leaving you
to read hex: how many valid RTCM3 messages (with their types and sizes), UBX
frames and NMEA sentences it found, how much is unrecognised, and when each
second's burst arrived. A frame only counts if its checksum is right (RTCM3
CRC-24Q, UBX Fletcher, NMEA XOR), so "0 valid frames" means the bytes are
corrupted or not one of those protocols - not just that it was hard to read.

USAGE
    pip install pyserial
    python3 rtcm_listen.py --port /dev/cu.usbserial-0001                  # 15 s
    python3 rtcm_listen.py --port /dev/cu.usbserial-0001 --seconds 30 --baud 115200
    python3 rtcm_listen.py --file capture.bin                             # a saved raw capture

Stop any other program (miniterm, cat) using the port first.
"""

import argparse
import collections
import statistics as st
import sys
import time


def crc24q(data):
    crc = 0
    for b in data:
        crc ^= b << 16
        for _ in range(8):
            crc <<= 1
            if crc & 0x1000000:
                crc ^= 0x1864CFB
    return crc & 0xFFFFFF


class StreamScanner:
    """Incremental scanner: feed() bytes in, get recognised frames out. Anything
    that isn't a checksum-valid RTCM3/UBX/NMEA frame is counted as junk."""

    def __init__(self):
        self.buf = bytearray()
        self.junk = 0
        self.frames = []  # (time, kind, label, size)

    def feed(self, data, now):
        self.buf.extend(data)
        buf = self.buf
        i = 0
        while i < len(buf):
            b = buf[i]
            # RTCM3: D3, 6 reserved zero bits + 10-bit length, payload, CRC-24Q
            if b == 0xD3:
                if len(buf) - i < 3:
                    break
                if buf[i + 1] & 0xFC == 0:
                    length = ((buf[i + 1] & 0x03) << 8) | buf[i + 2]
                    total = 3 + length + 3
                    if len(buf) - i < total:
                        break
                    body = bytes(buf[i : i + 3 + length])
                    crc = (buf[i + 3 + length] << 16) | (buf[i + 4 + length] << 8) | buf[i + 5 + length]
                    if crc24q(body) == crc:
                        msg = (body[3] << 4) | (body[4] >> 4) if length >= 2 else None
                        self.frames.append((now, "RTCM", str(msg), total))
                        i += total
                        continue
            # UBX: B5 62 class id len(2) payload ck_a ck_b
            elif b == 0xB5:
                if len(buf) - i < 2:
                    break
                if buf[i + 1] == 0x62:
                    if len(buf) - i < 6:
                        break
                    length = buf[i + 4] | (buf[i + 5] << 8)
                    total = 6 + length + 2
                    if len(buf) - i < total:
                        break
                    ck_a = ck_b = 0
                    for x in buf[i + 2 : i + 6 + length]:
                        ck_a = (ck_a + x) & 0xFF
                        ck_b = (ck_b + ck_a) & 0xFF
                    if ck_a == buf[i + 6 + length] and ck_b == buf[i + 7 + length]:
                        self.frames.append((now, "UBX", f"{buf[i+2]:02X}-{buf[i+3]:02X}", total))
                        i += total
                        continue
            # NMEA: $...*hh\r\n
            elif b == 0x24:
                end = buf.find(b"\n", i, i + 120)
                if end == -1:
                    if len(buf) - i < 120:
                        break
                else:
                    line = bytes(buf[i : end + 1]).rstrip(b"\r\n")
                    star = line.rfind(b"*")
                    if star > 0 and len(line) >= star + 3:
                        x = 0
                        for c in line[1:star]:
                            x ^= c
                        try:
                            if x == int(line[star + 1 : star + 3], 16):
                                self.frames.append((now, "NMEA", line[1:6].decode("ascii", "replace"), end + 1 - i))
                                i = end + 1
                                continue
                        except ValueError:
                            pass
            self.junk += 1
            i += 1
        del buf[:i]


def report(raw, scanner, seconds):
    n = len(raw)
    print(f"\nBytes received: {n} in {seconds:.1f}s ({n / seconds:.0f} B/s)")
    if n == 0:
        print("Nothing arrived. The radio isn't delivering anything to this port (settings mismatch, no signal, or flow control holding it).")
        return
    kinds = collections.Counter(f[1] for f in scanner.frames)
    valid_bytes = sum(f[3] for f in scanner.frames)
    print(f"Recognised (checksum-valid) frames: {dict(kinds) or 'none'}  - {valid_bytes} of {n} bytes ({valid_bytes / n * 100:.0f}%)")
    rtcm = [f for f in scanner.frames if f[1] == "RTCM"]
    if rtcm:
        types = collections.Counter(f[2] for f in rtcm)
        print("RTCM message types:")
        for t, k in sorted(types.items()):
            sizes = [f[3] for f in rtcm if f[2] == t]
            print(f"  {t:>5}: {k} messages, {min(sizes)}-{max(sizes)} bytes")
        by_sec = collections.defaultdict(list)
        t0 = rtcm[0][0]
        for f in rtcm:
            by_sec[int(f[0] - t0)].append(f[0] - t0)
        widths = [(max(v) - min(v)) * 1000 for v in by_sec.values() if len(v) > 1]
        if widths:
            print(f"Per-second bursts: {len(by_sec)} seconds seen, burst width {min(widths):.0f}-{max(widths):.0f} ms (mean {st.mean(widths):.0f})")
    hist = collections.Counter(raw)
    top = ", ".join(f"0x{b:02X} {k / n * 100:.0f}%" for b, k in hist.most_common(5))
    printable = sum(k for b, k in hist.items() if 32 <= b < 127 or b in (9, 10, 13)) / n * 100
    print(f"Byte mix: {len(hist)} distinct values; most common {top}; {printable:.0f}% printable ASCII")
    print()
    if not scanner.frames:
        print("VERDICT: no valid RTCM, UBX or NMEA frame in the whole stream. These bytes are corrupted or aren't one of those")
        print("protocols - typically a serial speed/format mismatch somewhere between the sender and this port, or noise. More")
        print("hex won't help; fix the mismatch (check the baud of every serial hop) and re-run this.")
    elif valid_bytes / n < 0.5:
        print("VERDICT: some valid frames, but most of the stream is unrecognised - a partly corrupted or mixed link.")
    else:
        print("VERDICT: mostly clean. If RTCM types are missing compared with what the base sends, check the base's message settings.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", help="Serial port to listen on")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--seconds", type=float, default=15.0)
    ap.add_argument("--file", help="Analyse a saved raw byte capture instead of a live port")
    args = ap.parse_args()

    scanner = StreamScanner()
    raw = bytearray()
    if args.file:
        data = open(args.file, "rb").read()
        raw.extend(data)
        scanner.feed(data, 0.0)
        report(bytes(raw), scanner, max(args.seconds, 1.0))
        return
    if not args.port:
        ap.error("give --port or --file")
    try:
        import serial
    except ImportError:
        print("pip install pyserial")
        sys.exit(1)
    try:
        ser = serial.Serial(args.port, args.baud, timeout=0.05)
    except serial.SerialException as e:
        print(f"could not open {args.port}: {e}")
        sys.exit(1)
    print(f"Listening on {args.port} @ {args.baud} for {args.seconds:.0f}s ...")
    start = time.time()
    try:
        while time.time() - start < args.seconds:
            chunk = ser.read(512)
            if chunk:
                raw.extend(chunk)
                scanner.feed(chunk, time.time())
    finally:
        ser.close()
    report(bytes(raw), scanner, time.time() - start)


if __name__ == "__main__":
    main()
