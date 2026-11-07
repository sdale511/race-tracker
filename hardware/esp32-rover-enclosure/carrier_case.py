"""The ESP32 rover case around the carrier board (hardware/esp32-rover-carrier), from the flat-lid concept in the enclosure
handoff (2026-11-07), with every board position read from the carrier's tools/layout.py so the case follows the board.

  LiPo on the floor, 3.5 mm foam, the carrier on two floor posts (H1, H2) with a lid post pressing H3; the ArduSimple and the
  Feather plug into the carrier, the LIS3DH, S9V11F5 and bq24074 are soldered low on it. Flat lid: clear window and a TPU keypad
  (D0, D1, D2) over the Feather, the GNSS helix and the XBee whip on bulkheads. Feather USB-C (console) and charger USB-C
  (charging) through the front wall; four M3 lid screws (three corners + a boss between the charger and the Feather).

Coordinates are the carrier's Gerber frame: x = 100 + board x, y = -153.34 + board y (the board's front edge is y -153.34, its
back edge -100), z up from the outside of the floor.

Usage:  python3 carrier_case.py [outdir]     (needs manifold3d, numpy, pillow)
Writes the STLs, clash_check.txt and the pictures to outdir (default: print/).
"""
import os, sys, json
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))
sys.path.insert(0, os.path.join(HERE, "..", "esp32-rover-carrier", "tools"))
os.environ.setdefault("MANIFOLD_PY", ""); os.environ.setdefault("MOUNT", "bands"); os.environ.setdefault("CABLE", "1")
import layout as L
import build_esp as X, parts_esp as K
from dsl import cyl, box, outline, outline_ring, port_y, U, hull, write_stl
from manifold3d import Manifold, OpType
import zrender as Z
from PIL import Image, ImageDraw, ImageFont

E = X.E; B = K.B; T = Z.tris; P = E.P
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "print")
os.makedirs(OUT, exist_ok=True)


def gx(x): return 100.0 + x
def gy(y): return -153.34 + y


# ---- the stack ----------------------------------------------------------------------------------------------------
SOCK, MALE, LOW = 8.5, 2.5, 2.5                  # female sockets, male-header plastic, soldered-low header plastic
FLOOR, LIPO = 2.4, (113.0, 60.0, 12.0)           # 10000 mAh pouch, 113 x 60 x 12
FOAM_GAP = 3.5                                   # battery top -> carrier underside (header tails into 3 mm foam)
CB = FLOOR + LIPO[2] + FOAM_GAP                  # carrier underside
CT = CB + 1.6                                    # carrier top
BOARD_X1 = gx(L.W)

# ---- boards -------------------------------------------------------------------------------------------------------
# ArduSimple frame (v12) placed on its J1-J4 sockets: same header positions as every carrier revision
ad = (136.83, -126.67, CT + SOCK + MALE - X.ARD_BOT)


# ArduSimple's own STEP (AS-RTK2B-F9P-L1L2-NH-03-R00), one box per solid (tools/step_boxes.py), moved into the carrier frame:
# its two USB-C connectors land on the v12 frame's within 0.04 mm, its PCB's front and back edges on the carrier's, and its
# PCB underside on the J1-J4 sockets (8.5 mm + the 2.5 mm male-header plastic)
STEP_PCB_Z0 = 58.12                               # the PCB underside in the STEP
STEP_SHIFT = (103.60, -165.62, CT + SOCK + MALE - STEP_PCB_Z0)


def ardusimple():
    a = [B(s["lo"][0], s["hi"][0], s["lo"][1], s["hi"][1], s["lo"][2], max(s["hi"][2], s["lo"][2] + 0.01)).translate(STEP_SHIFT)
         for s in json.load(open(os.path.join(HERE, "lib", "ardusimple_step_boxes.json")))]
    return Manifold.batch_boolean(a, OpType.Add)


ard = ardusimple(); xb = K.xbee().translate(ad); kk = K.keepouts()
xplug = kk["XBee right-angle RP-SMA plug (inside)"].translate(ad)
_gy, _gz = E.GNSS[0], E.GNSS[1] + X.DZ
gplug = (K.cx(-53.0, -35.5, _gy, _gz, 4.5) + B(-53.0, -45.0, _gy - 4.5, _gy + 4.5, _gz - 7.0, _gz)).translate(ad)   # GNSS plug, cable down
ARD_TOP = X.ARD_TOP + ad[2]

# Feather on 8.5 mm stacking headers in J5/J6, display up, USB-C on the front edge
FXL = gx(L.FX0)
FEATHER_RAISE = 8.5
FPCB0 = CT + SOCK + MALE + FEATHER_RAISE          # Feather board underside (parts side)
fdz = (FPCB0 + 1.57) - X.FB
fth = K.feather().translate((FXL - X.FX0, gy(0) - X.FY0, fdz))
def FX(ys): return FXL + ys
def FY(xs): return gy(xs)
def FZ(zs): return FPCB0 + 1.57 - zs

# bq24074, soldered low: its 38.1 edge front to back from BQ_Y, its 33.02 edge left to right from BQ_X
CX0, CY0 = gx(L.BQ[0]), gy(L.BQ[1])
def cb(bx0, bx1, by0, by1, z0, z1): return B(CX0 + by0, CX0 + by1, CY0 + bx0, CY0 + bx1, z0, z1)
t = CT + LOW + 1.6                                # charger top
chg = (cb(0, 38.1, 0, 33.02, CT + LOW, t) + cb(-1.02, 6.91, 5.69, 14.63, t, t + 3.2)   # board, USB-C
       + cb(-3.22, 12.03, 15.22, 28.22, t, t + 6.5)                                    # DC jack (to the board's front edge)
       + cb(28.54, 37.54, 5.7, 15.89, t, t + 6.0) + cb(28.54, 37.54, 17.12, 27.33, t, t + 6.0))   # BATT, SYSOUT JSTs (empty)
j7x = gx(L.SOCKETS[[s['ref'] for s in L.SOCKETS].index('J7')]['pins'][0][0])
chg_pins = B(j7x - 1.0, j7x + 1.0, CY0 + 2.0, CY0 + 36.0, t, t + 3.0)                # header pin tips above the charger
CHG_USB = (CX0 + 10.16, t + 1.6)

lx, ly, lw, lh = L.LIS
lis = B(gx(lx), gx(lx + lw), gy(ly), gy(ly + lh), CT + LOW, CT + LOW + 1.6) + B(gx(lx + 3), gx(lx + lw - 3), gy(ly + 3), gy(ly + lh - 3), CT + LOW + 1.6, CT + LOW + 2.9)
rx, ry, rw, rh = L.REG
reg = B(gx(rx), gx(rx + rw), gy(ry), gy(ry + rh), CT + LOW, CT + LOW + 3.8)
j11 = [o for o in L.OTHER if o['ref'] == 'J11'][0]['at']
jst = B(gx(j11[0] - 4.1), gx(j11[0] + 2.1), gy(45.5), gy(L.H), CT, CT + 6.0)          # S2B-PH-K body, opening on the back edge
jplug = B(gx(j11[0] - 3.6), gx(j11[0] + 1.6), gy(L.H), gy(L.H + 8.0), CT, CT + 5.5)  # PH plug + lead bending down behind the board
carrier = B(100, BOARD_X1, -153.34, -100, CB, CT)

# ---- box ----------------------------------------------------------------------------------------------------------
W = X.W
IX0, IX1 = 79.0, BOARD_X1 + 1.5                   # GNSS right-angle plug (21 mm) ... carrier right end
IY0 = FY(-1.11)                                    # Feather USB-C face flush with the inside of the front wall
IY1 = IY0 + LIPO[1] + 2 * 2.8
RIM = ARD_TOP + 13.3                               # headroom over the ArduSimple: XBee, plugs
TOP = RIM + X.LID_T
BAT = (107.5, 107.5 + LIPO[0], (IY0 + IY1) / 2 - LIPO[1] / 2, (IY0 + IY1) / 2 + LIPO[1] / 2)
lipo = B(BAT[0], BAT[1], BAT[2], BAT[3], FLOOR, FLOOR + LIPO[2])
R_ = X.R_
X.RECTS = [E.rrect(IX0, IX1, IY0, IY1, R_, R_, R_, R_)]
# lid screws: three corners + a boss on the front wall between the charger and the Feather (the front-right corner is the Feather's)
X.CORNERS = [(IX0, IY0, 1, 1), (IX0, IY1, 1, -1), (IX1, IY1, -1, -1)]
FB_X0, FB_X1 = CX0 + 33.02 + 0.4, FXL - 0.3       # front boss: between the charger's right edge and the Feather
FB_Z0 = CT + LOW + 1.7                             # its underside: over the charger board's height
SCREWS = [(IX0 + R_, IY0 + R_), (IX0 + R_, IY1 - R_), (IX1 - R_, IY1 - R_), ((FB_X0 + FB_X1) / 2, IY0 + 3.6)]
hole_at = {ref: at for ref, _, at in L.HOLES}
HOLES_C = [(gx(hole_at[r][0]), gy(hole_at[r][1])) for r in ('H1', 'H2')]   # carrier holes on floor posts
HOLE3 = (gx(hole_at['H3'][0]), gy(hole_at['H3'][1]))                      # pressed by a lid post (the battery is under it)
HELIX_C = (96.73, -123.67)
WHIP_C = (219.0, IY1 - 7.2)
TFT = (FX(2.52), FX(20.07), FY(11.05), FY(42.71))
WIN = (TFT[0] + 1.0, TFT[1] - 1.0, TFT[2] + 1.0, TFT[3] - 1.0 - 4.0)
WIN_PANE = (WIN[0] - 1.6, WIN[1] + 1.6, WIN[2] - 1.6, WIN[3] + 1.6)
BTNS = [(FX(y), FY(7.62)) for y in (4.44, 11.43, 18.42)]
KP = (BTNS[0][0] - 3.0, BTNS[2][0] + 3.0, BTNS[0][1] - 2.1, BTNS[0][1] + 2.1)
BTN_TOP = FZ(-1.9)
KEY_HOLE, KEY_T, KEY_STEM, KEY_GAP = 5.4, 1.0, 2.6, 0.3
USB_OPEN = (12.6, 7.0)
FUSB = (FX(11.43), FZ(2.77))                       # Feather USB-C (x, z) on the front wall


def base():
    b = X.outer_body(0, RIM, rb=E.BOT_R) - outline(X.RECTS, 0, FLOOR, RIM + 1)
    b = U(b, X.corner_fill(0.0, FLOOR - 0.01, RIM) ^ outline(X.RECTS, 0.01, 0, RIM))
    boss = hull(box(FB_X0, FB_X1, IY0 - 1, IY0 + 0.01, FB_Z0, FB_Z0 + 0.01), box(FB_X0, FB_X1, IY0 - 1, IY0 + 7.0, FB_Z0 + 7.0, FB_Z0 + 7.01))
    b = U(b, boss, box(FB_X0, FB_X1, IY0 - 1, IY0 + 7.0, FB_Z0 + 7.0, RIM))
    b = U(b, *[cyl(x, y, FLOOR - 0.01, CB, 3.5) for x, y in HOLES_C])
    fence = outline_ring([(BAT[0] - 0.6, BAT[1] + 0.6, BAT[2] - 0.6, BAT[3] + 0.6)], 1.6, 0.0, FLOOR - 0.01, FLOOR + 4.0) ^ outline(X.RECTS, -0.01, 0, 20)
    b = U(b, fence)
    holes = [cyl(x, y, RIM - 11, RIM + 1, P["m3_pilot"] / 2) for x, y in SCREWS]
    holes += [cyl(x, y, CB - 8, CB + 1, P["m3_pilot"] / 2) for x, y in HOLES_C]
    holes.append(outline_ring(X.RECTS, W / 2 + 1.0, W / 2 - 1.0, RIM - 1.2, RIM + 1))                              # cord groove
    holes.append(port_y(FUSB[0], FUSB[1], USB_OPEN[0], USB_OPEN[1], 2.0, IY0 - W - 1, IY0 + 1))                  # Feather USB-C (console)
    holes.append(port_y(CHG_USB[0], CHG_USB[1], USB_OPEN[0], USB_OPEN[1], 2.0, IY0 - W - 1, IY0 + 1))           # charger USB-C (charging)
    holes.append(box(CHG_USB[0] - 9, CHG_USB[0] + 9, IY0 - W - 1, IY0 - 1.6, CHG_USB[1] - 6, CHG_USB[1] + 6))   # outside recess: the plug reaches the charger
    return b - U(*holes)


def lid():
    l = X.outer_body(RIM, TOP, rt=2.0)
    # locating lip inside the rim, cut back round the corner screw blocks (0.4 mm clear) and the front boss
    adds = [outline_ring(X.RECTS, -0.4, -1.6, RIM - 1.6, RIM + 0.01) - X.corner_fill(0.4, RIM - 10, RIM + 1)
            - U(*[cyl(x, y, RIM - 3, RIM + 1, 4.9) for x, y in SCREWS]) - box(FB_X0 - 0.5, FB_X1 + 0.5, IY0 - 1, IY0 + 8, RIM - 3, RIM + 1)]
    ah = [(x + ad[0], y + ad[1]) for x, y in E.ARD_HOLES]
    adds += [cyl(x, y, ARD_TOP - 0.15, RIM + 0.1, 2.5) for x, y in ah]                                           # press the ArduSimple
    adds.append(cyl(E.XB_HOLD[0] + ad[0], E.XB_HOLD[1] + ad[1], E.XB_HOLD_Z + X.DZ + ad[2], RIM + 0.1, E.XB_HOLD_D / 2))   # XBee hold-down
    adds.append(cyl(*HOLE3, CT - 0.1, RIM + 0.1, 2.2))                                                         # press the carrier at H3
    adds += [cyl(*c, RIM - 0.6, RIM + 0.1, 8.0) ^ outline(X.RECTS, -1.6, RIM - 2, RIM + 1) for c in (HELIX_C, WHIP_C)]
    l = U(l, *adds)
    holes = [box(*WIN, RIM - 1, TOP + 1), box(*WIN_PANE, TOP - 1.0, TOP + 1)]                                  # window + 1 mm pane rebate
    holes += [box(*KP, TOP - KEY_T, TOP + 1)] + [cyl(x, y, RIM - 1, TOP, KEY_HOLE / 2) for x, y in BTNS]       # TPU keypad
    holes += [cyl(*c, RIM - 2, TOP + 1, 3.25) for c in (HELIX_C, WHIP_C)]                                       # bulkheads
    for x, y in SCREWS: holes += [cyl(x, y, RIM - 1, TOP + 1, 1.7), cyl(x, y, TOP - 1.2, TOP + 1, 3.1)]
    return l - U(*holes)


def keypad():
    k = box(KP[0] + 0.2, KP[1] - 0.2, KP[2] + 0.2, KP[3] - 0.2, TOP - KEY_T, TOP)
    return U(k, *[cyl(x, y, BTN_TOP + KEY_GAP, TOP - KEY_T + 0.01, KEY_STEM / 2) for x, y in BTNS])


def pane():
    return box(WIN_PANE[0] + 0.15, WIN_PANE[1] - 0.15, WIN_PANE[2] + 0.15, WIN_PANE[3] - 0.15, TOP - 1.0, TOP)


b, l, kp, pn = base().m, lid().m, keypad().m, pane().m
hb = Manifold.cylinder(12, 5, 5, 48).translate((*HELIX_C, RIM - 12.6)); wb = Manifold.cylinder(12, 5, 5, 48).translate((*WHIP_C, RIM - 12.6))
boards = {"ArduSimple": ard, "XBee": xb, "XBee plug": xplug, "GNSS plug": gplug, "Feather": fth, "charger": chg, "charger pins": chg_pins,
          "LIS3DH": lis, "regulator": reg, "battery JST": jst, "battery plug": jplug, "LiPo": lipo, "carrier": carrier,
          "helix bulkhead": hb, "whip bulkhead": wb}

# ---- clash check --------------------------------------------------------------------------------------------------
def vol(a, c): return round((a ^ c).volume(), 2)
lines = []
expected = {("lid", "carrier"): "intended: the H3 post presses the carrier 0.1 mm",
            ("lid", "ArduSimple"): "intended: 4 posts press its holes 0.15 mm"}
for pname, pm in (("base", b), ("lid", l), ("keypad", kp), ("window pane", pn)):
    hits = {k: vol(pm, v) for k, v in boards.items() if vol(pm, v) > 0.01}
    lines.append(f"{pname:12s}-> " + (", ".join(f"{k} {v}" + (f" ({expected[(pname, k)]})" if (pname, k) in expected else "") for k, v in hits.items()) or "clear"))
pieces = {"base": b, "lid": l, "keypad": kp, "pane": pn}
pp = [(a, c, vol(pieces[a], pieces[c])) for i, a in enumerate(pieces) for c in list(pieces)[i + 1:]]
lines.append("printed parts vs each other: " + (", ".join(f"{a}/{c} {v}" for a, c, v in pp if v > 0.01) or "clear"))
names = list(boards)
bb_hits = [(a, c, vol(boards[a], boards[c])) for i, a in enumerate(names) for c in names[i + 1:]
           if (a, c) not in {("ArduSimple", "XBee"), ("XBee", "XBee plug"), ("ArduSimple", "GNSS plug"), ("charger", "charger pins"),
                             ("battery JST", "carrier"), ("battery JST", "battery plug"), ("ArduSimple", "XBee plug")}]
lines.append("boards vs each other: " + (", ".join(f"{a}/{c} {v}" for a, c, v in bb_hits if v > 0.01) or "clear"))
bbx = b.bounding_box()
lines.append(f"size {bbx[3] - bbx[0]:.1f} x {bbx[4] - bbx[1]:.1f} x {TOP:.1f} mm;  carrier z {CB:.1f}..{CT:.1f};  ArduSimple top {ARD_TOP:.1f};"
             f"  lid underside {RIM:.1f};  TFT top {FZ(-1.52):.1f} (gap to the lid {RIM - FZ(-1.52):.1f});  charger top {t:.1f}, its JSTs {t + 6:.1f}"
             f" under the XBee plug from {xplug.bounding_box()[2]:.1f}")
lines.append("pieces: " + "  ".join(f"{n} {m.decompose().__len__()}" for n, m in pieces.items()))
lines.append("ArduSimple from its STEP (AS-RTK2B-F9P-L1L2-NH-03-R00), one box per part; XBee and Feather from the v12 boxes.")
report = "\n".join(lines)
print(report)
open(os.path.join(OUT, "clash_check.txt"), "w").write(report + "\n")

# ---- STLs (print orientation) -------------------------------------------------------------------------------------
write_stl(b, os.path.join(OUT, "rover_case_base.stl"))
write_stl(l.rotate((180, 0, 0)).translate((0, 0, TOP)), os.path.join(OUT, "rover_case_lid.stl"))      # top face on the bed
write_stl(kp.rotate((180, 0, 0)).translate((0, 0, TOP)), os.path.join(OUT, "TPU_rover_keypad.stl"))
write_stl(E.build_port_plug(*USB_OPEN).m, os.path.join(OUT, "TPU_usbc_dust_plug.stl"))                   # print two
def r2(v): return round(v, 2) if isinstance(v, float) else [r2(x) for x in v] if isinstance(v, (list, tuple)) else {k: r2(x) for k, x in v.items()} if isinstance(v, dict) else v
json.dump(r2(dict(size=[bbx[3] - bbx[0], bbx[4] - bbx[1], TOP], window_pane=[WIN_PANE[1] - WIN_PANE[0] - 0.3, WIN_PANE[3] - WIN_PANE[2] - 0.3, 1.0],
                  lid_screws=SCREWS, carrier_holes={"H1": HOLES_C[0], "H2": HOLES_C[1], "H3 (lid post)": HOLE3})),
          open(os.path.join(OUT, "rover_case_dims.json"), "w"))

# ---- pictures -----------------------------------------------------------------------------------------------------
Bc, Lc = (0.36, 0.56, 0.84), (0.85, 0.64, 0.36)
pt = TOP; hx, hy = HELIX_C; wx, wy = WHIP_C
helix = cyl(hx, hy, pt, pt + 3, 6).m + cyl(hx, hy, pt + 3, pt + 58, 22.5, 19.5).m
whip = cyl(wx, wy, pt, pt + 14, 5.0).m + cyl(wx, wy, pt + 14, pt + 142, 4.1, 3.0).m
inner = [(T(carrier), (0.1, 0.35, 0.15)), (T(ard), (0.25, 0.65, 0.35)), (T(xb), (0.2, 0.55, 0.3)), (T(xplug + gplug), (0.15, 0.15, 0.15)), (T(fth), (0.15, 0.25, 0.6)),
         (T(chg), (0.6, 0.2, 0.75)), (T(lis), (0.1, 0.45, 0.6)), (T(reg), (0.85, 0.15, 0.15)), (T(jst + jplug), (0.95, 0.85, 0.1)), (T(lipo), (0.75, 0.75, 0.2)), (T(hb + wb), (0.15, 0.15, 0.15))]
f = ImageFont.load_default(size=22); fbig = ImageFont.load_default(size=27)
c = ((bbx[0] + bbx[3]) / 2, (bbx[1] + bbx[4]) / 2)
openb = b - B(-500, 500, -500, 500, RIM - 0.01, 500)
cut = FXL + 11.43
views = [(f"Assembled: {bbx[3]-bbx[0]:.0f} x {bbx[4]-bbx[1]:.0f} x {TOP:.0f} mm", [(T(l), Lc), (T(b), Bc), (T(helix), (0.88, 0.88, 0.86)), (T(whip), (0.12, 0.12, 0.12)), (T(pn), (0.75, 0.9, 0.95))], -55, 25, (c[0], c[1], 50), 2.1),
         ("Lid off: carrier rev C on posts over the LiPo", [(T(openb), Bc)] + inner, -55, 40, (c[0], c[1], 22), None),
         ("Front: Feather USB-C (console) + charger USB-C (recessed)", [(T(l), Lc), (T(b), Bc), (T(helix), (0.88, 0.88, 0.86)), (T(whip), (0.12, 0.12, 0.12))], -90, 6, (c[0], c[1], 30), 2.6),
         ("Section through the Feather", [(T(b - B(-500, cut, -500, 500, -10, 500)), Bc), (T(l - B(-500, cut, -500, 500, -10, 500)), Lc)]
          + [(T(m - B(-500, cut, -500, 500, -10, 500)), col) for m, col in ((fth, (0.15, 0.25, 0.6)), (carrier, (0.1, 0.35, 0.15)), (lipo, (0.75, 0.75, 0.2)), (pn, (0.75, 0.9, 0.95)))],
          -180 + 0.01, 3, (cut, c[1], 25), 5.0)]
tiles = []
for tt, o, az, el, cc, sc in views:
    im = Z.render(o, az, el, 800, 600, scale=sc, center=cc); ImageDraw.Draw(im).text((14, 10), tt, fill=(20, 20, 20), font=f); tiles.append(im)
s = Image.new("RGB", (1600, 1260), "white")
ImageDraw.Draw(s).text((16, 16), "ESP32 rover case, carrier rev C", fill=(20, 20, 20), font=fbig)
for i, im in enumerate(tiles): s.paste(im, ((i % 2) * 800, 60 + (i // 2) * 600))
s.save(os.path.join(OUT, "rover_case.png"))
