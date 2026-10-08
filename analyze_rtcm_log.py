#!/usr/bin/env python3
"""
analyze_rtcm_log.py

Summarises a PyGPSClient "parsed" data log (File > data logging, format
"Parsed") captured from the ArduSimple/ZED-F9P RTK base: which RTCM messages
it sent and how often, how big each epoch is, what the base itself reports
(fix type, satellites, position), and whether the station position in the
1005 message agrees with the receiver's own position. Standard library only.

Sizes are CALCULATED from the RTCM 3.x MSM4/MSM7 bit layouts and the satellite/
signal counts in each message, not measured on the wire - they include the
3-byte RTCM frame header and 3-byte CRC. 1005 is a fixed 25 bytes; 1230 with
no biases set (as seen on this board) is 10 bytes.

USAGE
    python3 analyze_rtcm_log.py ~/Downloads/pygpsdata-20261007172023.log
    python3 analyze_rtcm_log.py capture.log --json     # machine-readable
"""

import argparse
import collections
import json
import math
import re
import statistics as st
import sys

MSM4_TYPES = {1074: "GPS", 1084: "GLONASS", 1094: "Galileo", 1124: "BeiDou"}
MSM7_TYPES = {1077: "GPS", 1087: "GLONASS", 1097: "Galileo", 1127: "BeiDou"}
SIZE_1005 = 25
SIZE_1230 = 10
RADIO_PAYLOAD = 100  # this fleet's XBee-PRO 900HP 200K NP (bytes)
TOW_FIELDS = ("DF004", "DF034", "DF248", "DF427")  # GPS, GLONASS, Galileo, BeiDou epoch time


def split_objects(text):
    parts = re.split(r"(?<=\))>\s*(?=<)", text)
    return [p.strip().lstrip("<").rstrip(">") for p in parts if p.strip()]


def num(obj, key):
    m = re.search(r"\b" + re.escape(key) + r"=(-?[\d.]+(?:e-?\d+)?)", obj)
    return float(m.group(1)) if m else None


def word(obj, key):
    m = re.search(r"\b" + re.escape(key) + r"=([^,)\s]+)", obj)
    return m.group(1) if m else None


def msm_bytes(obj, msm):
    ns, nsig, ncell = int(num(obj, "NSat")), int(num(obj, "NSig")), int(num(obj, "NCell"))
    sat_bits, cell_bits = (18, 48) if msm == 4 else (36, 80)
    bits = 169 + ns * nsig + sat_bits * ns + cell_bits * ncell
    return math.ceil(bits / 8) + 6


def epoch_time(obj):
    for key in TOW_FIELDS:
        v = num(obj, key)
        if v is not None:
            return int(v)
    return None


def ecef_to_llh(x, y, z):
    a = 6378137.0
    f = 1 / 298.257223563
    e2 = f * (2 - f)
    lon = math.atan2(y, x)
    p = math.hypot(x, y)
    lat = math.atan2(z, p * (1 - e2))
    h = 0.0
    for _ in range(8):
        n = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
        h = p / math.cos(lat) - n
        lat = math.atan2(z, p * (1 - e2 * n / (n + h)))
    return math.degrees(lat), math.degrees(lon), h


def distance_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def stats3(values):
    return {"min": min(values), "mean": round(st.mean(values), 1), "max": max(values)} if values else None


def analyze(path):
    with open(path, errors="replace") as fh:
        objs = split_objects(fh.read())
    kinds = collections.Counter(o.split("(")[0] for o in objs)
    rtcm = [o for o in objs if o.startswith("RTCM(")]
    pvt = [o for o in objs if o.startswith("UBX(NAV-PVT")]
    svin = [o for o in objs if o.startswith("UBX(NAV-SVIN")]
    by_type = collections.defaultdict(list)
    for o in rtcm:
        by_type[int(re.match(r"RTCM\((\d+)", o).group(1))].append(o)

    out = {"file": path, "objects": dict(kinds), "rtcm_counts": {str(t): len(v) for t, v in sorted(by_type.items())}}

    if pvt:
        first, last = pvt[0], pvt[-1]
        out["time"] = {
            "start_utc": "%04d-%02d-%02d %02d:%02d:%02d"
            % tuple(int(num(first, k)) for k in ("year", "month", "day", "hour", "min", "second")),
            "end_utc": "%04d-%02d-%02d %02d:%02d:%02d"
            % tuple(int(num(last, k)) for k in ("year", "month", "day", "hour", "min", "second")),
            "epochs": len(pvt),
        }
        fix_types = collections.Counter(int(num(o, "fixType")) for o in pvt)
        out["receiver"] = {
            "fixType_counts": dict(fix_types),
            "gnssFixOk_all": all(int(num(o, "gnssFixOk")) == 1 for o in pvt),
            "numSV": stats3([int(num(o, "numSV")) for o in pvt]),
            "lat": num(last, "lat"),
            "lon": num(last, "lon"),
            "height_ellipsoid_m": num(last, "height") / 1000.0,
            "hMSL_m": num(last, "hMSL") / 1000.0,
            "hAcc_mm": num(last, "hAcc"),
            "position_constant": len({(num(o, "lat"), num(o, "lon")) for o in pvt}) == 1,
        }
    if svin:
        out["survey"] = {
            "active": any(int(num(o, "active")) for o in svin),
            "valid": any(int(num(o, "valid")) for o in svin),
            "max_duration_s": max(int(num(o, "dur")) for o in svin),
        }

    # Epoch cadence per message type (all should be 1000 ms apart).
    cadence = {}
    for t, objs_t in sorted(by_type.items()):
        times = [epoch_time(o) for o in objs_t]
        if None in times or t in (1005, 1230):
            continue
        diffs = collections.Counter(b - a for a, b in zip(times, times[1:]))
        cadence[str(t)] = {"epochs": len(times), "intervals_ms": dict(diffs)}
    out["cadence"] = cadence

    # 1005 station position vs the receiver's own.
    if by_type.get(1005):
        o = by_type[1005][-1]
        x, y, z = num(o, "DF025"), num(o, "DF026"), num(o, "DF027")
        lat, lon, h = ecef_to_llh(x, y, z)
        out["station_1005"] = {"lat": round(lat, 7), "lon": round(lon, 7), "height_m": round(h, 3), "count": len(by_type[1005])}
        if "receiver" in out:
            out["station_1005"]["distance_to_receiver_m"] = round(distance_m(lat, lon, out["receiver"]["lat"], out["receiver"]["lon"]), 3)

    # Per-constellation sizes.
    constellations = {}
    per_epoch4, per_epoch7 = collections.defaultdict(int), collections.defaultdict(int)
    for t, name in MSM4_TYPES.items():
        objs_t = by_type.get(t, [])
        if not objs_t:
            continue
        b4 = [msm_bytes(o, 4) for o in objs_t]
        b7 = [msm_bytes(o, 7) for o in objs_t]
        cnr = [float(x) for o in objs_t for x in re.findall(r"DF403_\d+=([\d.]+)", o)]
        constellations[name] = {
            "type": t,
            "satellites": stats3([int(num(o, "NSat")) for o in objs_t]),
            "signal_cells": stats3([int(num(o, "NCell")) for o in objs_t]),
            "signals": dict(collections.Counter(re.findall(r"CELLSIG_\d+=(\w+)", " ".join(objs_t)))),
            "cnr_dbhz": {"mean": round(st.mean(cnr), 1), "min": min(cnr)} if cnr else None,
            "msm4_bytes": stats3(b4),
            "msm7_bytes_equivalent": stats3(b7),
            "msm4_over_radio_payload": sum(1 for b in b4 if b > RADIO_PAYLOAD),
            "messages": len(b4),
        }
        for i, (a, b) in enumerate(zip(b4, b7)):
            per_epoch4[i] += a
            per_epoch7[i] += b
    out["constellations"] = constellations

    if per_epoch4:
        extra = SIZE_1005 * bool(by_type.get(1005)) + SIZE_1230 * bool(by_type.get(1230))
        e4 = [per_epoch4[i] + extra for i in sorted(per_epoch4)]
        e7 = [per_epoch7[i] + extra for i in sorted(per_epoch7)]
        mean4 = st.mean(e4)
        out["epoch_bytes"] = {
            "msm4_with_1005_1230": stats3(e4),
            "msm7_equivalent": stats3(e7),
            "msm7_over_msm4": round(st.mean(e7) / mean4, 2),
            "serial_ms_115200": round(mean4 * 10 / 115.2),
            "serial_ms_38400": round(mean4 * 10 / 38.4),
            "rf_ms_10kbps_raw": round(mean4 * 8 / 10.0),
            "rf_ms_110kbps_raw": round(mean4 * 8 / 110.0),
            "share_of_11_5_kBps_channel_pct": round(mean4 / 11500 * 100, 1),
        }
        # What dropping each constellation would save, in bytes per epoch.
        saving = {}
        for name, c in constellations.items():
            s = c["msm4_bytes"]["mean"] + (SIZE_1230 if name == "GLONASS" and by_type.get(1230) else 0)
            saving[name] = {"bytes": round(s), "pct_of_epoch": round(s / mean4 * 100)}
        out["drop_savings"] = saving

    # Things worth flagging.
    flags = []
    present = {t for t in by_type}
    if 1005 not in present:
        flags.append("No 1005 (station position) message - a rover cannot do RTK without it.")
    if present & set(MSM7_TYPES):
        flags.append("MSM7 messages present alongside MSM4 - duplicate observations." if present & set(MSM4_TYPES) else "MSM7 only.")
    if not (present & set(MSM4_TYPES)) and not (present & set(MSM7_TYPES)):
        flags.append("No observation messages (MSM4/MSM7) at all.")
    for t, c in cadence.items():
        if set(c["intervals_ms"]) - {1000}:
            flags.append(f"{t}: epochs are not all 1000 ms apart: {c['intervals_ms']}")
    counts = {t: len(v) for t, v in by_type.items() if t in MSM4_TYPES or t in (1005, 1230)}
    if len(set(counts.values())) > 1:
        flags.append(f"Message counts differ between types (missed epochs?): {counts}")
    if "receiver" in out and set(out["receiver"]["fixType_counts"]) == {0}:
        flags.append("Receiver reported no fix (fixType 0) for the whole capture.")
    if "station_1005" in out and out["station_1005"].get("distance_to_receiver_m", 0) > 1.0:
        flags.append("1005 station position differs from the receiver's own position by more than 1 m.")
    out["flags"] = flags
    return out


def print_report(r):
    print(f"File: {r['file']}")
    t = r.get("time")
    if t:
        print(f"Capture: {t['start_utc']} to {t['end_utc']} UTC ({t['epochs']} one-second epochs)")
    print(f"Objects: {r['objects']}")
    print(f"RTCM messages: {r['rtcm_counts']}")
    rec = r.get("receiver")
    if rec:
        print(
            f"Receiver: fixType {rec['fixType_counts']} (5 = time-only, normal for a fixed-position base), "
            f"satellites {rec['numSV']}, hAcc {rec['hAcc_mm']} mm"
        )
        print(f"  position {rec['lat']}, {rec['lon']}  height {rec['height_ellipsoid_m']:.2f} m ellipsoid / {rec['hMSL_m']:.2f} m MSL"
              f"  (constant: {rec['position_constant']})")
    if "survey" in r:
        print(f"Survey-in: {r['survey']}")
    if "station_1005" in r:
        print(f"1005 station: {r['station_1005']}")
    print("Cadence:", {k: v["intervals_ms"] for k, v in r["cadence"].items()})
    for name, c in r["constellations"].items():
        print(
            f"{name:8s} {c['type']}: sats {c['satellites']['min']}-{c['satellites']['max']} (mean {c['satellites']['mean']}), "
            f"C/N0 mean {c['cnr_dbhz']['mean']} min {c['cnr_dbhz']['min']}, MSM4 {c['msm4_bytes']['mean']:.0f} B "
            f"({c['msm4_bytes']['min']}-{c['msm4_bytes']['max']}), MSM7 equiv {c['msm7_bytes_equivalent']['mean']:.0f} B, "
            f"{c['msm4_over_radio_payload']}/{c['messages']} over {RADIO_PAYLOAD} B"
        )
    e = r.get("epoch_bytes")
    if e:
        print(f"Epoch (MSM4 + 1005 + 1230): {e['msm4_with_1005_1230']} B; MSM7 equivalent {e['msm7_equivalent']['mean']} B ({e['msm7_over_msm4']}x)")
        print(
            f"  serial: {e['serial_ms_115200']} ms @115200, {e['serial_ms_38400']} ms @38400; raw RF: "
            f"{e['rf_ms_110kbps_raw']} ms @110 kb/s, {e['rf_ms_10kbps_raw']} ms @10 kb/s; "
            f"{e['share_of_11_5_kBps_channel_pct']}% of an 11.5 kB/s channel"
        )
    print("Drop savings:", r.get("drop_savings"))
    print("Flags:" if r["flags"] else "Flags: none")
    for f in r["flags"]:
        print("  -", f)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("log", help="PyGPSClient parsed data log")
    ap.add_argument("--json", action="store_true", help="print the full result as JSON")
    args = ap.parse_args()
    try:
        r = analyze(args.log)
    except OSError as e:
        print(f"could not read {args.log}: {e}")
        sys.exit(1)
    if args.json:
        print(json.dumps(r, indent=2))
    else:
        print_report(r)


if __name__ == "__main__":
    main()
