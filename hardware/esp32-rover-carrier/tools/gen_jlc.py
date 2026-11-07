"""JLCPCB assembly files for the 5-board run: JLCPCB solders the parts that go on the carrier itself (the female sockets,
the battery JST and the two 2-pin headers); the charger, LIS3DH and S9V11F5 are soldered on by hand afterwards.

Run with KiCad's python3 (as gen_pcb.py): writes fab/jlcpcb/bom.csv and fab/jlcpcb/cpl.csv.
Positions are each part's pad centre, in the same page coordinates as the Gerbers (y up, so negative), top side.
"""
import csv, os
import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
PCB = os.path.join(HERE, "..", "esp32-rover-carrier.kicad_pcb")
OUT = os.path.join(HERE, "..", "fab", "jlcpcb")

# ref -> (comment, LCSC part). Stocked at JLCPCB when checked (2026-11-07).
PARTS = {
    "J1": ("Female header 1x10 2.54mm 8.5mm (KH-2.54FH-1X10P-H8.5)", "C2905418"),
    "J2": ("Female header 1x08 2.54mm 8.5mm (KH-2.54FH-1X8P-H8.5)", "C2905417"),
    "J3": ("Female header 1x08 2.54mm 8.5mm (KH-2.54FH-1X8P-H8.5)", "C2905417"),
    "J4": ("Female header 1x06 2.54mm 8.5mm (KH-2.54FH-1X6P-H8.5)", "C2905416"),
    "J5": ("Female header 1x16 2.54mm 8.5mm (KH-2.54FH-1X16P-H8.5)", "C2905421"),
    "J6": ("Female header 1x12 2.54mm 8.5mm (KH-2.54FH-1X12P-H8.5)", "C2905419"),
    "J11": ("JST PH 2-pin right angle (S2B-PH-K-S)", "C173752"),
    "J12": ("Male header 1x02 2.54mm", "C32713268"),
    "JP1": ("Male header 1x02 2.54mm", "C32713268"),
}

board = pcbnew.LoadBoard(PCB)
os.makedirs(OUT, exist_ok=True)
rows = []
for fp in sorted(board.GetFootprints(), key=lambda f: f.GetReference()):
    ref = fp.GetReference()
    if ref not in PARTS:
        continue
    pads = list(fp.Pads())
    x = sum(pcbnew.ToMM(p.GetPosition().x) for p in pads) / len(pads)
    y = sum(pcbnew.ToMM(p.GetPosition().y) for p in pads) / len(pads)
    rot = fp.GetOrientationDegrees() % 360
    rows.append((ref, fp.GetFPID().GetLibItemName().wx_str(), x, -y, rot))
missing = set(PARTS) - {r[0] for r in rows}
assert not missing, f"not on the board: {missing}"

with open(os.path.join(OUT, "cpl.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["Designator", "Mid X", "Mid Y", "Layer", "Rotation"])
    for ref, _, x, y, rot in rows:
        w.writerow([ref, f"{x:.3f}mm", f"{y:.3f}mm", "Top", f"{rot:.0f}"])

groups = {}
for ref, footprint, *_ in rows:
    comment, lcsc = PARTS[ref]
    groups.setdefault((comment, footprint, lcsc), []).append(ref)
with open(os.path.join(OUT, "bom.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["Comment", "Designator", "Footprint", "LCSC Part #"])
    for (comment, footprint, lcsc), refs in groups.items():
        w.writerow([comment, ",".join(refs), footprint, lcsc])
print(f"wrote {len(rows)} placements, {len(groups)} BOM lines to {OUT}")
