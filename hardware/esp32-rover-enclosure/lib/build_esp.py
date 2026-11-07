"""ArduSimple simpleRTK2B + XBee-PRO S3B (on a SparkFun BOB-08276 breakout) + Adafruit Feather ESP32-S3 REVERSE TFT (5691) +
10000 mAh 1S LiPo, one sealed box on the battery's footprint (v3).

  * LiPo (JLJLUP 60 x 12 x 113, PH2.0 lead) fills the floor, foam on top
  * a printed DECK lies on the foam (located by the walls, clamped by the lid posts through the boards): ArduSimple centre-
    left (same pegs / guide ribs / lid posts as the Pi cases) with the XBee back in its socket, bq24074 charger at the right end,
    S9V11F5 at the left
  * the XBee runs front-to-back with its RP-SMA toward the front; a lid post presses the module into the breakout sockets
  * the Feather hangs SCREEN-UP from the lid over the middle of the ArduSimple, running front-to-back (rotate the TFT 90 deg
    in software); clear window + TPU keypad for D0 / D1 / D2 in the lid; USB-C (charge + program) in the FRONT wall
  * GNSS helix at the left, half-wave whip back-right, lid bulkheads + right-angle pigtails
  * lid screws in small fillets in the inside corners (the battery corners pass them), 1/16 in cord in the rim groove
Usage:  python3 build_esp.py <outdir>
"""
import os, sys, json
os.environ.setdefault("MOUNT", "bands"); os.environ.setdefault("CABLE", "1")
HERE = os.path.dirname(os.path.abspath(__file__))
import build_side3a as E                      # ArduSimple numbers + the rounded outer-body helper
from dsl import *

P, W = E.P, E.W
FLOOR, LID_T = P["floor"], P["top"]
# ------------------------------------------------------------------ battery, deck, ArduSimple heights
LIPO = (113.0, 60.0, 12.0)                       # L (x) x W (y) x H, PH2.0 lead out of the +X end
FOAM = 1.2                                       # foam pad between the pouch and the deck (1.5 mm tape, squeezed)
DECK_Z0 = FLOOR + LIPO[2] + FOAM
DECK_T = 2.0
DECK_TOP = DECK_Z0 + DECK_T
DZ = DECK_TOP + P["standoff_h"] - E.ARD_BOT      # ArduSimple frame shift (Pi cases: board on floor standoffs)
ARD_BOT, ARD_TOP = E.ARD_BOT + DZ, E.ARD_TOP + DZ
HEADER_ROOM = 3.0                                # v12: +3 mm for hand-wired Dupont leads on the ArduSimple's header rows
RIM = 35.5 + HEADER_ROOM                         # lid underside
TOP = RIM + LID_T
# ------------------------------------------------------------------ box (inside faces) = battery + clearance
SIDE_CLR, LEAD_ROOM = 2.8, 4.5
IX0 = -57.8
EXTRA_X = 7.3                                    # v9: room for the bq24074 charger beside the ArduSimple's right end
IX1 = IX0 + SIDE_CLR + LIPO[0] + LEAD_ROOM + EXTRA_X   # 69.8
IY0, IY1 = -(LIPO[1] / 2 + SIDE_CLR), LIPO[1] / 2 + SIDE_CLR
PX0, PX1, PY0, PY1 = IX0 - W, IX1 + W, IY0 - W, IY1 + W
R_ = E.R_
RECTS = [E.rrect(IX0, IX1, IY0, IY1, R_, R_, R_, R_)]
CORNER_A = R_                                    # lid-screw pilot on the inside-corner radius centre: inboard of the cord groove
CORNER_C = 2 * CORNER_A + 2.5 * 2 ** 0.5         # corner block (45 deg leg): 1.2 mm round the M3 pilot
CORBEL_Z0 = 10.9                                 # block starts above the battery corners and widens at 45 deg (prints unsupported)
CORNERS = [(IX0, IY0, 1, 1), (IX0, IY1, 1, -1), (IX1, IY0, -1, 1), (IX1, IY1, -1, -1)]
EARS = [(x + sx * CORNER_A, y + sy * CORNER_A) for x, y, sx, sy in CORNERS]
TOP_PILOT = 11.0                                 # lid screws M3 x 12 self-tapping
GROOVE_W, GROOVE_D = 2.0, 1.2
LIP_OUT, LIP_IN, LIP_H = -0.4, -1.6, 1.6
BAT_X0 = IX0 + SIDE_CLR
BAT = (BAT_X0, BAT_X0 + LIPO[0], -LIPO[1] / 2, LIPO[1] / 2)
LEAD_SLOT = (56.0, IX1, IY0, -20.0)              # deck cut-out, front-right: PH2.0 lead up from the battery end

def corner_fill(grow, z0, z1, corbel=False):
    """Block in each inside corner (45 deg leg CORNER_C + grow). corbel=True: starts at CORBEL_Z0 as a point and widens at
    45 deg (leg sum grows sqrt(2) per mm) to full size, then straight up to z1."""
    from manifold3d import CrossSection, Manifold
    c = CORNER_C + grow; out = []; e = 3.0                          # e: run into the wall
    def tri(cc, za, zb, x, y, sx, sy):
        pts = [(x - sx * e, y - sy * e), (x + sx * cc, y - sy * e), (x + sx * cc, y), (x, y + sy * cc), (x - sx * e, y + sy * cc)]
        if sx * sy < 0: pts = pts[::-1]
        return Manifold.extrude(CrossSection([pts]), zb - za).translate((0, 0, za))
    for x, y, sx, sy in CORNERS:
        if not corbel:
            out.append(S(tri(c, z0, z1, x, y, sx, sy), "")); continue
        zf = CORBEL_Z0 + c / 2 ** 0.5
        h = Manifold.batch_hull([tri(0.05, CORBEL_Z0, CORBEL_Z0 + 0.01, x, y, sx, sy), tri(c, zf, zf + 0.01, x, y, sx, sy)])
        out.append(S(h + tri(c, zf, z1, x, y, sx, sy), ""))
    return U(*out)
# ------------------------------------------------------------------ Feather ESP32-S3 Reverse TFT (5691). Adafruit's S3 board file is the S2 (5345)
# layout with the S3-MINI-1 module (same 15.4 x 20.5 x 2.4 footprint): outline, holes, TFT, buttons, USB-C, PH, STEMMA identical, so the
# S2 STL is used for the parts. (STL frame: board z 0..1.57,
# TFT + buttons on z < 0, parts on z > 0, USB-C at x = -1.11).  Case: screen up, STL x -> +Y (USB-C to the front wall),
# STL y -> +X (PH socket side toward +X), STL z -> -Z.
FB = ARD_TOP + 10.1 + HEADER_ROOM                # TFT face of the board: 6.7 mm under the Feather for flat Duponts on the front (power) header row
F_STANDOFF = RIM - FB
FX0 = -17.0                                      # STL y = 0 (between the ArduSimple lid posts and clear of the helix)
FY0 = IY0 + 1.11                                 # STL x = 0: USB-C receptacle face flush with the inside of the front wall
def FX(ys): return FX0 + ys
def FYy(xs): return FY0 + xs
def FZ(zs): return FB - zs
F_HOLES = [(FX(2.54), FYy(2.54)), (FX(20.32), FYy(2.54)), (FX(1.8415), FYy(48.26)), (FX(20.955), FYy(48.26))]   # 4 x M2: 2.5 / 2.2 mm holes (S3 .brd)
F_POST_D, F_PILOT = 4.4, 1.6
TFT = (FX(2.52), FX(20.07), FYy(11.05), FYy(42.71))          # display module outline
WIN_SHORTEN = 4.0                                # v9: window 4 mm shorter at the end away from the buttons (the TFT edge showed)
WIN = (TFT[0] + 1.0, TFT[1] - 1.0, TFT[2] + 1.0, TFT[3] - 1.0 - WIN_SHORTEN)
WIN_BORDER, WIN_T = 1.6, 1.0
WIN_PANE = (WIN[0] - WIN_BORDER, WIN[1] + WIN_BORDER, WIN[2] - WIN_BORDER, WIN[3] + WIN_BORDER)
BTNS = [(FX(y), FYy(7.62)) for y in (4.44, 11.43, 18.42)]     # D0, D1, D2
BTN_TOP = FZ(-1.9)
KEY_HOLE, KEY_T, KEY_STEM, KEY_GAP = 5.4, 1.0, 2.6, 0.3
KP = (BTNS[0][0] - 3.0, BTNS[2][0] + 3.0, BTNS[0][1] - 2.1, BTNS[0][1] + 2.1)
USBC = (FX(11.43), FZ(2.77))                                  # (X, Z) of the Feather USB-C, front wall
USB_OPEN = (12.6, 7.0)
PH = (FX(22.45), FYy(6.84), FYy(14.74), FZ(6.37), FZ(1.57))  # PH2.0 socket: entry face x, y0, y1, z0, z1 (plug toward +X)
# ------------------------------------------------------------------ XBee-PRO S3B back in the ArduSimple socket (v9), hold-down post on the lid
XB_AX = E.XBEE[1] + DZ                           # RP-SMA axis
XB_HOLD = E.XB_HOLD; XB_HOLD_Z = E.XB_HOLD_Z + DZ; XB_HOLD_D = E.XB_HOLD_D
# ------------------------------------------------------------------ Adafruit bq24074 charger (4755) from Adafruit_BQ24074.brd: 38.1 x 33.02,
# 4 x 2.5 mm holes at (2.54|35.56, 2.54|30.48); USB-C + DC jack on the x = 0 edge, PH BATT + SYSOUT on the x = 38.1 edge.
# Case: board x -> +Y (USB-C / DC edge at the front), board y -> -X (board y = 0 at the right); flat on the deck so its low middle
# passes under the XBee's right-angle plug.
CHG_W, CHG_L, CHG_T = 38.1, 33.02, 1.6
CHG_X1, CHG_Y0 = IX1 - 0.5, -15.5
CHG_STANDOFF = 2.0
CHG_Z0 = DECK_TOP + CHG_STANDOFF; CHG_TOP = CHG_Z0 + CHG_T
def CX(by): return CHG_X1 - by
def CY(bx): return CHG_Y0 + bx
CHG_HOLES = [(CX(by), CY(bx)) for bx in (2.54, 35.56) for by in (2.54, 30.48)]
CHG_PILOT, CHG_BOSS_D = 2.1, 5.0                 # M2.5 x 5 self-tapping, blind pilots like the LIS3DH
CHG_USB = (CX(10.16), CY(-1.02), CHG_TOP + 1.6)  # charger USB-C (x, face y, z)
# panel-mount USB-C (round, threaded, 16 mm hole) in the front wall, short USB-C cable to the charger
PANEL_USB_D, PANEL_USB_X, PANEL_USB_Z = 16.0, 46.0, 24.0
# ------------------------------------------------------------------ antennas
BOSS_T, BOSS_R, BULK_HOLE = 0.6, 8.0, 6.5
HELIX_C = (-40.1, 3.0)                           # bulkhead off the ArduSimple's left end, just in front of the GNSS plug (clears the LIS3DH)
WHIP_C = (IX1 - 9.5, 1.5)                        # v9: right end, over the charger's low middle, beside the XBee plug
SPACING = ((WHIP_C[0] - HELIX_C[0]) ** 2 + (WHIP_C[1] - HELIX_C[1]) ** 2) ** 0.5
HW_LEN = 142.0
BOOST = (-45.0, 23.2, 7.62, 11.43, 3.8)          # Pololu S9V11F5 (0.30 x 0.45 in, 0.15 in tall) back-left of the deck: x, y, w, l, height
# clip-in cradle: board on two 1.2 mm ledges (solder stubs clear), side walls with snap lips at mid-length, end stop at the back,
# open toward the front for the 3 pins (VIN / GND / VOUT on the short edge)
REG_PCB, REG_LEDGE, REG_CLR, REG_WALL, REG_LIP, REG_LIP_H = 1.6, 1.2, 0.2, 1.2, 0.5, 0.8
REG_Z0 = DECK_TOP + REG_LEDGE                    # board underside
# ------------------------------------------------------------------ Adafruit LIS3DH (2809, STEMMA QT version) from Adafruit-LIS3DH-Breakout-PCB/Adafruit LIS3DH.brd:
# 17.78 x 25.4 board, 4 x 2.5 mm holes at (2.54|15.24, 2.54|22.86), JST-SH on both short ends, 6-pin rows at x 2.54 / 15.24
LIS_W, LIS_L, LIS_T = 17.78, 25.4, 1.6
LIS_X0, LIS_Y0 = -52.6, -28.2                    # front-left of the deck, edges square to the box (board x -> case X, board y -> case Y)
LIS_STANDOFF = 2.0
LIS_Z0 = DECK_TOP + LIS_STANDOFF; LIS_TOP = LIS_Z0 + LIS_T
LIS_HOLES = [(LIS_X0 + hx, LIS_Y0 + hy) for hx in (2.54, 15.24) for hy in (2.54, 22.86)]
LIS_PILOT, LIS_BOSS_D = 2.1, 5.0                 # M2.5 x 5 self-tapping (blind pilot, stops 0.5 above the deck underside)

ARD_HOLES = E.ARD_HOLES

def outer_body(z0, z1, rb=0.0, rt=0.0):
    E.RECTS, E.EARS = RECTS, []
    return E.outer_body(z0, z1, rb=rb, rt=rt)

def board_guides(z0):
    c = 0.3; hl, dx = P["board_len"] / 2, P["board_shift"]; XI = E.XI
    return [box(-XI, -hl + dx - c, 18.0, 25.5, z0, ARD_TOP), box(hl + dx + c, XI, 15.0, 25.0, z0, ARD_TOP),
            box(hl + dx + c, XI, -26.5, -23.8, z0, ARD_TOP)]

# ---------------------------------------------------------------------------------------------- BASE
def build_base():
    b = outer_body(0, RIM, rb=E.BOT_R) - outline(RECTS, 0, FLOOR, RIM + 1)
    b = U(b, corner_fill(0.0, FLOOR - 0.01, RIM, corbel=True) ^ outline(RECTS, 0.01, 0, RIM))
    holes = [cyl(x, y, RIM - TOP_PILOT, RIM + 1, P["m3_pilot"] / 2) for x, y in EARS]
    holes.append(outline_ring(RECTS, W / 2 + GROOVE_W / 2, W / 2 - GROOVE_W / 2, RIM - GROOVE_D, RIM + 1))
    holes.append(port_y(USBC[0], USBC[1], USB_OPEN[0], USB_OPEN[1], 2.0, PY0 - 1, IY0 + 1))
    holes.append(cyly(PANEL_USB_X, PANEL_USB_Z, PY0 - 1, IY0 + 1, PANEL_USB_D / 2))                 # panel-mount USB-C (charging)
    return b - U(*holes)

# ---------------------------------------------------------------------------------------------- DECK
def build_deck():
    d = outline(RECTS, -0.4, DECK_Z0, DECK_TOP) - corner_fill(0.4, DECK_Z0 - 1, DECK_TOP + 1)
    posts = []
    for x, y in ARD_HOLES:
        tip = ARD_BOT + P["peg_len"]
        posts += [cyl(x, y, DECK_TOP - 0.01, ARD_BOT, P["standoff_d"] / 2), cyl(x, y, ARD_BOT - 0.01, tip - 0.8, P["peg_d"] / 2),
                  cyl(x, y, tip - 0.81, tip, P["peg_d"] / 2, P["peg_d"] / 2 - 0.6)]
    d = U(d, U(*posts) ^ outline(RECTS, -0.4, DECK_Z0, RIM), *board_guides(DECK_TOP - 0.01))
    d = U(d, *[cyl(x, y, DECK_TOP - 0.01, LIS_Z0, LIS_BOSS_D / 2) for x, y in LIS_HOLES], reg_cradle(),
          *[cyl(x, y, DECK_TOP - 0.01, CHG_Z0, CHG_BOSS_D / 2) for x, y in CHG_HOLES])
    holes = [box(*LEAD_SLOT, DECK_Z0 - 1, DECK_TOP + 1), *[cyl(x, y, DECK_Z0 + 0.5, LIS_Z0 + 1, LIS_PILOT / 2) for x, y in LIS_HOLES],
             *[cyl(x, y, DECK_Z0 + 0.5, CHG_Z0 + 1, CHG_PILOT / 2) for x, y in CHG_HOLES],
             box(PANEL_USB_X - PANEL_USB_D / 2 - 1, PANEL_USB_X + PANEL_USB_D / 2 + 1, IY0 - 1, IY0 + 10.0, DECK_Z0 - 1, DECK_TOP + 1)]   # panel USB-C body
    return d - U(*holes)

def reg_cradle():
    bx, by, w, l, _ = BOOST
    x0, x1, y0, y1 = bx - w / 2 - REG_CLR, bx + w / 2 + REG_CLR, by - l / 2 - REG_CLR, by + l / 2 + REG_CLR
    zl = REG_Z0 + REG_PCB + 0.1                                  # lip underside: 0.1 mm over the board
    z0 = DECK_TOP - 0.01
    parts = [box(x0 - REG_WALL, x0, y0 + 1.0, y1, z0, zl + REG_LIP_H), box(x1, x1 + REG_WALL, y0 + 1.0, y1, z0, zl + REG_LIP_H),   # side walls
             box(x0 - REG_WALL, x1 + REG_WALL, y1, y1 + REG_WALL, z0, REG_Z0 + REG_PCB),                                       # end stop (back)
             box(x0, x0 + 1.0, y0 + 1.0, y1, z0, REG_Z0), box(x1 - 1.0, x1, y0 + 1.0, y1, z0, REG_Z0)]                         # ledges
    ym = by; lh = 2.0                                                                                                        # lips: 4 mm long at mid-length
    for xw, sx in ((x0, 1), (x1, -1)):
        parts.append(hull(box(*sorted((xw, xw + sx * REG_LIP)), ym - lh, ym + lh, zl, zl + 0.3),
                          box(*sorted((xw, xw + sx * 0.01)), ym - lh, ym + lh, zl + REG_LIP_H - 0.01, zl + REG_LIP_H)))   # 45-ish lead-in on top
    return U(*parts)

# ---------------------------------------------------------------------------------------------- LID
def build_lid():
    l = outer_body(RIM, TOP, rt=min(E.TOP_R, LID_T - 0.4))
    cf = corner_fill(0.4, RIM - 10, RIM + 1)
    adds = [outline_ring(RECTS, LIP_OUT, LIP_IN, RIM - LIP_H, RIM + 0.01) - cf]
    post_bot = ARD_TOP - P["post_preload"]
    adds += [cyl(x, y, post_bot, RIM + 0.1, P["post_d"] / 2) for x, y in ARD_HOLES]
    adds.append(cyl(*XB_HOLD, XB_HOLD_Z, RIM + 0.1, XB_HOLD_D / 2))
    adds += [(cyl(*c, RIM - BOSS_T, RIM + 0.1, BOSS_R) ^ outline(RECTS, LIP_IN - 0.01, RIM - 2, RIM + 1)) - cf for c in (HELIX_C, WHIP_C)]
    adds += [cyl(x, y, FB, RIM + 0.1, F_POST_D / 2) for x, y in F_HOLES]
    l = U(l, *adds)
    peg_above = P["peg_len"] - 1.6
    holes = [cyl(x, y, post_bot - 1, ARD_TOP + peg_above + 0.6, P["peg_d"] / 2 + 0.25) for x, y in ARD_HOLES]
    holes += [cyl(*c, RIM - 2, TOP + 1, BULK_HOLE / 2) for c in (HELIX_C, WHIP_C)]
    for x, y in EARS:
        holes += [cyl(x, y, RIM - 1, TOP + 1, P["m3_clear"] / 2), cyl(x, y, TOP - 1.2, TOP + 1, P["m3_head_d"] / 2)]
    holes += [cyl(x, y, FB - 1, RIM + 1.0, F_PILOT / 2) for x, y in F_HOLES]
    holes += [box(*WIN, RIM - 1, TOP + 1), box(*WIN_PANE, TOP - WIN_T, TOP + 1)]
    holes += [box(*KP, TOP - KEY_T, TOP + 1)] + [cyl(x, y, RIM - 1, TOP, KEY_HOLE / 2) for x, y in BTNS]
    return l - U(*holes)

def build_keypad():
    k = box(KP[0] + 0.2, KP[1] - 0.2, KP[2] + 0.2, KP[3] - 0.2, TOP - KEY_T, TOP)
    return U(k, *[cyl(x, y, BTN_TOP + KEY_GAP, TOP - KEY_T + 0.01, KEY_STEM / 2) for x, y in BTNS])

def window_pane():
    return box(WIN_PANE[0] + 0.15, WIN_PANE[1] - 0.15, WIN_PANE[2] + 0.15, WIN_PANE[3] - 0.15, TOP - WIN_T, TOP)

def dims():
    return dict(size=[PX1 - PX0, PY1 - PY0], height=TOP, rim=RIM, deck=[DECK_Z0, DECK_TOP], ard_top=ARD_TOP, feather_face=FB,
                feather_standoff=F_STANDOFF, spacing=SPACING, lis=[LIS_X0, LIS_Y0, LIS_Z0], helix_c=HELIX_C, whip_c=WHIP_C,
                helix_from_edges=[HELIX_C[0] - PX0, PY1 - HELIX_C[1]], whip_from_edges=[PX1 - WHIP_C[0], PY1 - WHIP_C[1]],
                pane=[WIN_PANE[1] - WIN_PANE[0] - 0.3, WIN_PANE[3] - WIN_PANE[2] - 0.3], usb=USBC, lipo=LIPO, xbee_axis=XB_AX,
                charger=[CX(CHG_L), CHG_X1, CY(0), CY(CHG_W)], panel_usb=[PANEL_USB_X, PANEL_USB_Z, PANEL_USB_D])

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    base, deck, lid, kp = build_base(), build_deck(), build_lid(), build_keypad()
    write_stl(base.m, f"{out}/esp_case_base.stl")
    write_stl(deck.m.translate((0, 0, -DECK_Z0)), f"{out}/esp_case_deck.stl")
    write_stl(lid.m.rotate((180, 0, 0)).translate((0, 0, TOP)), f"{out}/esp_case_lid.stl")
    write_stl(kp.m.rotate((180, 0, 0)).translate((0, 0, TOP)), f"{out}/TPU_esp_keypad.stl")
    write_stl(E.build_port_plug(*USB_OPEN).m, f"{out}/TPU_usbc_dust_plug.stl")
    json.dump(dims(), open(f"{out}/esp_dims.json", "w"), indent=1, default=float)
    print(json.dumps(dims(), default=lambda v: round(float(v), 2)))
