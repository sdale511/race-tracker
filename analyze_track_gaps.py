#!/usr/bin/env python3
"""
analyze_track_gaps.py

Compares what each boat LOGGED (its own SD log, the full-rate truth) with what the base RECEIVED over the radio,
so you can see whether live tracks are missing fixes - and where. A fix the boat logged that the base never heard
shows up as a "missing" fix; a run of them is a straight chord on the live map.

USAGE
    python3 analyze_track_gaps.py \
        --base base-logs/<regatta>/base_station_received_2026-10-11.csv \
        --boats boat-logs \
        --from 2026-10-11T06:49:30Z --to 2026-10-11T06:58:00Z

  --base   the base's received-fixes CSV for the day
  --boats  the folder with the boats' own CSV logs (boatNNNNN_<date>T<hh-mm>.csv)
  --from / --to   only look at fixes in this UTC window (the race you want), ISO format
  --gap    report gaps in what the base heard longer than this many seconds (default 1.5)

For each boat it prints how many fixes it logged, how many the base heard, and its biggest gaps with the time into
the track and the speed there. A boat that logged a fix the base never heard, in a block, right after a turn, is
the slot's frames backing up (see "Sending in the slot" in the README). Fixes the boat deliberately thinned (the
TX_SLOT_MAX_HZ / slot-capacity cap) count as missing too, so judge the blocks and the gaps, not the percentage.
"""

import argparse
import bisect
import csv
import datetime as dt
import glob
import os
import re
from collections import defaultdict


def ts(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", required=True)
    ap.add_argument("--boats", default="boat-logs")
    ap.add_argument("--from", dest="t_from", required=True)
    ap.add_argument("--to", dest="t_to", required=True)
    ap.add_argument("--gap", type=float, default=1.5)
    args = ap.parse_args()
    lo, hi = ts(args.t_from), ts(args.t_to)

    heard = defaultdict(list)
    with open(args.base) as f:
        for r in csv.DictReader(f):
            t = ts(r["fix_time_iso"])
            if lo <= t <= hi:
                heard[r["boat_id"]].append((t, float(r["speed_kn"])))

    rows = []
    for path in sorted(glob.glob(os.path.join(args.boats, "boat*_*.csv"))):
        m = re.match(r"boat(\w+?)_", os.path.basename(path))
        if not m:
            continue
        boat = m.group(1)
        with open(path) as f:
            log = [(ts(r["timestamp_iso"]), float(r["speed_kn"])) for r in csv.DictReader(f)]
        log = [x for x in log if lo <= x[0] <= hi]
        got = sorted(heard.get(boat, []))
        if not log or not got:
            continue
        times = [t for t, _ in got]
        missing = 0
        runs = []  # blocks of consecutive logged fixes the base never heard
        run = []
        for t, sp in log:
            i = bisect.bisect_left(times, t - 0.06)
            ok = i < len(times) and times[i] <= t + 0.06
            if ok:
                if len(run) >= 3:
                    runs.append(run)
                run = []
            else:
                missing += 1
                run.append((t, sp))
        if len(run) >= 3:
            runs.append(run)
        t0 = log[0][0]
        gaps = sorted(
            ((times[i] - times[i - 1], times[i - 1] - t0, got[i - 1][1]) for i in range(1, len(times)) if times[i] - times[i - 1] > args.gap),
            reverse=True,
        )[:3]
        rows.append((boat, len(log), missing, runs, gaps))

    rows.sort(key=lambda r: -r[2])
    tot = sum(r[1] for r in rows)
    miss = sum(r[2] for r in rows)
    print(f"{len(rows)} boats; boats logged {tot} fixes, the base never heard {miss} of them ({100 * miss / tot:.1f}%)\n" if tot else "no data in that window")
    print("boat   logged  missing  blocks(>=3)  longest block (fixes, s)   biggest gaps heard: (gap s, at s into track, speed kn)")
    for boat, n, miss_n, runs, gaps in rows[:20]:
        longest = max(runs, key=len) if runs else []
        span = f"{len(longest)} fixes, {longest[-1][0] - longest[0][0]:.1f} s" if longest else "-"
        print(f"{boat:6s} {n:6d} {miss_n:8d} {len(runs):12d}  {span:26s} {[(round(g, 1), round(at), round(sp)) for g, at, sp in gaps]}")


if __name__ == "__main__":
    main()
