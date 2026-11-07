"""Minimal Gerber (RS-274X, KiCad) rasterizer for a quick look: lines, flashes (C/R/O/macros as their bounding circle/rect), regions.
usage: python3 gerb_render.py out.png layer1.gbr:color [layer2.gbr:color ...]  (first file sets nothing special; board 100..234 x -153.34..-100)"""
import re, sys, math
from PIL import Image, ImageDraw
X0, X1, Y0, Y1, S = 98.0, 236.0, -155.5, -98.0, 12.0     # mm window, px per mm
W, H = int((X1 - X0) * S), int((Y1 - Y0) * S)
def px(x, y): return ((x - X0) * S, (Y1 - y) * S)
img = Image.new("RGB", (W, H), (20, 60, 30)); d = ImageDraw.Draw(img)
def render(path, col):
    t = open(path).read()
    ap = {}; cur = None; x = y = 0.0; region = False; poly = []; mode = "G01"; fmt = 6
    m = re.search(r"%FSLAX(\d)(\d)Y", t); fmt = int(m.group(2)) if m else 6
    for mm in re.finditer(r"%ADD(\d+)([A-Za-z_0-9]+),?([^*]*)\*%", t):
        n, kind, par = int(mm.group(1)), mm.group(2), [float(v) for v in mm.group(3).split("X") if v] if mm.group(3) else []
        if kind == "C": ap[n] = ("C", par[0] / 2, par[0] / 2)
        elif kind in ("R", "O"): ap[n] = (kind, par[0] / 2, par[1] / 2)
        else: ap[n] = ("C", 0.4, 0.4)
    body = re.sub(r"%[^%]*%", "", t)
    for cmd in body.split("*"):
        cmd = cmd.strip()
        if not cmd: continue
        if cmd.startswith("G36"): region = True; poly = []; continue
        if cmd.startswith("G37"):
            if len(poly) > 2: d.polygon([px(*p) for p in poly], fill=col)
            region = False; continue
        g = re.match(r"G0([123])", cmd)
        if g: mode = "G0" + g.group(1)
        dm = re.match(r"(?:G0[123])?D(\d+)$", cmd)
        if dm and int(dm.group(1)) >= 10: cur = int(dm.group(1)); continue
        m = re.match(r"(?:G0[123])?(?:X(-?\d+))?(?:Y(-?\d+))?(?:I(-?\d+))?(?:J(-?\d+))?D0([123])$", cmd)
        if not m: continue
        nx = int(m.group(1)) / 10 ** fmt if m.group(1) else x
        ny = int(m.group(2)) / 10 ** fmt if m.group(2) else y
        op = m.group(5)
        if region:
            if op == "2": poly = [(nx, ny)]
            else: poly.append((nx, ny))
        elif op == "1" and cur in ap:
            r = max(ap[cur][1], 0.08)
            d.line([px(x, y), px(nx, ny)], fill=col, width=max(1, int(2 * r * S)))
        elif op == "3" and cur in ap:
            k, a, b = ap[cur]; cx, cy = px(nx, ny)
            if k == "C": d.ellipse([cx - a * S, cy - a * S, cx + a * S, cy + a * S], fill=col)
            else: d.rectangle([cx - a * S, cy - b * S, cx + a * S, cy + b * S], fill=col)
        x, y = nx, ny
for arg in sys.argv[2:]:
    p, c = arg.rsplit(":", 1)
    render(p, tuple(int(c[i:i + 2], 16) for i in (0, 2, 4)))
img.save(sys.argv[1])
