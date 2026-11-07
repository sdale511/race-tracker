"""
Side-by-side dust-resistant case: Raspberry Pi 3 A+ in front of the ArduSimple ZED-F9P (+ XBee-PRO S3B), v1.
Built from the Pi Zero 2 W side-by-side case v6 (no inside USB cable: Pi GPIO UART -> XBee, I2C -> ZED-F9P).
Pi 3A+ geometry from the Pi3A+-ArduSimple case (v16). Power: 0.7 in 20000 mAh power bank (147 x 69.6 x 18.0 mm)
in a streamlined sled under the base (v2: along the case's long axis, ports at the front; v3: open-top slot, the case floor is its roof; v4: Neoseek M320 Air display window at the front) -> short USB-C to right-angle micro-USB cable -> Pi power port (front wall).
X/Y = the ArduSimple's STEP X/Y. Z = 0 is the underside of the case floor (the sled is below it).
"""
import sys, os, json, numpy as np
WITTY = os.environ.get("WITTY", "")          # Pi 3A+ family: no Witty by default; "l3v7" for the LiPo battery version
CABLE = os.environ.get("CABLE", "") == "1"
GPIO_ONLY = os.environ.get("CABLE", "") == "gpio"     # backup: no cable bay, no USB-A / XBee USB-C openings - Pi UART -> XBee, I2C -> ZED   # variant: Pi USB-A -> ArduSimple XBee USB-C cable inside, in a right-hand cable bay
SLED = True                                  # power-bank sled under the base (bank 147 x 69.6 x 18.0 mm)          # "", "mini" (Witty Pi 4 Mini, 65x30) or "full" (Witty Pi 4 HAT, 65x56)
from dsl import *

P = dict(
    wall=3.6, floor=2.4, top=2.4,
    standoff_h=3.0, standoff_d=6.5, peg_d=2.4, peg_len=3.2,      # floor standoffs + pegs through the board holes
    post_d=5.0, post_preload=0.15,                               # lid posts press the board (socket for the peg tip)
    xbee_axis_above=8.4,                                         # XBee RP-SMA centre above the board top (Pi 3A+ case v12+)
    rpsma_hole=7.4, rpsma_base_past_edge=4.0, right_wall_extra=1.0,   # v9: RP-SMA end 2 mm shorter (test fit 14 Oct)
    board_len=66.2, board_shift=-1.0,                            # v10: test fit - board sits 1 mm toward the GNSS end (XBee ribs +1, GNSS rib -1)
                                                 # v9: measured ArduSimple length (STEP says 68.58) - sets the end guide ribs
    lid_extra=0.0,                                               # v4: no header wiring in this case -> lid as low as the XBee allows
    side_clr=0.45,                                               # USB-C faces to the inside of the end walls
    yclr=0.6,
    gnss_axis_above=5.0,                                         # SMA centre above the board top (measured on the PiArdu case)
    usbc_above=1.0,                                              # USB-C socket centre above the board top (measured)
    sma_hole=7.4, spotface=2.0,                                  # GNSS SMA hole now the same 7.4 mm as the RP-SMA
    ear_r=4.5, ear_inset=3.6, m3_pilot=2.6, m3_clear=3.4, m3_head_d=6.2, m3_head_h=2.5,
    gasket=True, groove_w=1.8, groove_d=1.6, gasket_w=1.7, gasket_h=1.9, tongue_w=0.8, tongue_h=0.4,
    led_skin=0.4,
)

ARD_HALF = (34.29, 26.67)
ARD_HOLES = [(13.335, -13.716), (13.335, 16.764), (-19.05, 24.13), (-20.32, -24.13)]
ARD_BOT = P["floor"] + P["standoff_h"]; ARD_TOP = ARD_BOT + 1.6
AZ = ARD_BOT - 36.59
def ZA(z): return z + AZ
GNSS = (12.89, ARD_TOP + P["gnss_axis_above"])          # (y, z) of the GNSS SMA axis
XBEE = (1.52, ARD_TOP + P["xbee_axis_above"])           # (y, z) of the XBee RP-SMA axis
SPLIT = XBEE[1]                                          # joint through the RP-SMA centre (as on the Pi 3A+ case)
# Witty Pi stacked on the Pi Zero GPIO header - geometry from the UUGear STEP files (WittyPi4Mini.step / WittyPi4.step).
# Witty Pi 4: board underside 11 mm above the Pi board (2.5 mm Pi header base + 8.5 mm female socket - its STEP's socket
# is exactly 8.5 mm). Witty Pi 4 Mini (UUGear manual): the Pi's pins go up through holes in the Mini into a low socket
# strip on top; 4 mm plastic spacers between the boards -> underside 4 mm above the Pi. STEP frame: PCB top z=0 (1.58 thick), header along y~0, so on the Pi it is turned 180 deg.
# UART wires are soldered (no Dupont plugs fit under the Witty).
W_BOT_ABOVE = float(os.environ["WITTY_LIFT"]) if os.environ.get("WITTY_LIFT") else {"mini": 4.0, "l3v7": 4.0}.get(WITTY, 11.0)   # v3: the Mini has no socket - it sits straight on the Pi's pins, on its 4 mm spacers
W_T = 1.6
BATT = WITTY == "l3v7"                          # Witty Pi 4 L3V7 (Mini size + JST-PH Li-ion input) + battery deck under the base
WSTEP = {"l3v7": dict(hc=3.7, len_y=30.21, top=5.5,              # tallest: JST-PH battery socket (right-angle, faces the board edge)
                      usbc=(11.2, 30.9, 1.6), btn=(66.1, 15.2, 0.5),
                      holes=[(3.5, 3.7), (61.5, 3.7), (3.5, 26.7), (61.5, 26.7)]),
         "mini": dict(hc=3.7, len_y=30.21, top=3.18,             # tallest: USB-C shell (header spacer 2.22)
                      usbc=(11.2, 30.9, 1.6),                    # x centre, socket face y, centre above board top
                      btn=(66.1, 15.2, 0.5),                     # side push button: actuator tip x, y, z above board top
                      holes=[(3.5, 3.7), (61.5, 3.7), (3.5, 26.7), (61.5, 26.7)]),
         "full": dict(hc=4.0, len_y=56.51, top=8.3,              # stacking-header pins stand 8.3 above the board
                      usbc=(53.8, 57.35, 1.6),
                      btn=(70.46, 13.14, 4.0),                   # right-angle button, stem 5.5 past the board edge
                      holes=[(3.5, 4.0), (61.5, 4.0), (3.5, 53.0), (61.5, 53.0)])}.get(WITTY)
_xbee_head = P["xbee_axis_above"] + 3.4 + 1.5
USBC = {"left": (-18.79, -35.35), "right": (-16.60, 35.38)}  # y, socket face x
UZ = ARD_TOP + P["usbc_above"]

XI = 35.35 + P["side_clr"]; YI = ARD_HALF[1] + P["yclr"]
# ---- Pi Zero 2 W in front of the ArduSimple (same floor standoffs)
PI_W, PI_D, PI_T = 65.0, 56.0, 1.4                        # Pi 3 A+
PI_GAP = 3.0                                             # ArduSimple front edge -> Pi back edge (divider ribs sit here)
PI_CY = -ARD_HALF[1] - PI_GAP - PI_D / 2                 # Pi centre y
PI_X0, PI_Y0 = -PI_W / 2, PI_CY - PI_D / 2
PI_BOT = ARD_BOT; PI_TOP = PI_BOT + PI_T
PI_HOLES = [(sx * 29.0, PI_CY + sy * 24.5) for sx in (-1, 1) for sy in (-1, 1)]
# v6: no inside USB cable any more - the Pi talks to the XBee on its GPIO UART and to the ZED-F9P over I2C (wires only),
# so the 12 mm cable channel and the right-hand cable bay are gone; the front wall is back at the Pi's port edge.
YF = PI_Y0 - 2.9                                         # front wall: the Pi 3A+ audio jack overhangs the board 2.5 mm
WIT_BOT = PI_TOP + W_BOT_ABOVE
def WX(wx): return -(wx - 32.5)                                      # Witty STEP -> case (turned 180 deg about Z)
def WY(wy): return PI_Y0 + PI_D - 3.5 - (wy - WSTEP["hc"])           # header centre over the Pi header centre
def WZ(wz): return WIT_BOT + W_T + wz
if WITTY:
    WIT_TOP = WZ(WSTEP["top"])
    WIT_Y0 = WY(WSTEP["len_y"]); WIT_D = WY(0) - WIT_Y0             # front edge, depth
    WIT_HOLES = [(round(WX(x), 3), round(WY(y), 3)) for x, y in WSTEP["holes"]]
    WIT_USBC = (WX(WSTEP["usbc"][0]), WZ(WSTEP["usbc"][2])); WIT_USBC_FACE = WY(WSTEP["usbc"][1])
    WBTN = (WX(WSTEP["btn"][0]), WY(WSTEP["btn"][1]), WZ(WSTEP["btn"][2]))   # side button tip (points -X)
    P["lid_extra"] = max(0.0, max(WIT_TOP + 0.6, WIT_USBC[1] + 3.5 + 0.3) - ARD_TOP - _xbee_head)
else:
    WIT_TOP = WIT_Y0 = WIT_D = 0.0; WIT_HOLES = []
P["headroom"] = _xbee_head + P["lid_extra"]     # XBee module top ~3.4 above the RP-SMA axis
CEIL = ARD_TOP + P["headroom"]; TOPZ = CEIL + P["top"]
if WITTY == "full":
    YF = min(YF, WIT_USBC_FACE - 0.3)                    # full HAT overhangs 26 mm in front of the Pi (USB-C face 0.3 from the wall)
# full Witty Pi 4: holes only at its back (over the Pi's back holes) and far front - the front pair gets tall floor posts
WIT_FRONT_HOLES = [h for h in WIT_HOLES if h[1] < PI_Y0 - 5] if WITTY == "full" else []
# Witty side button: horizontal plunger through the -X wall (lid), TPU cap in a pocket outside
WB_GAP, WB_FL = 0.2, 6.0                                 # plunger to actuator gap, flange diameter
WB_HOLE, WB_POCK_D, WB_POCK_H = 4.0, 7.0, 1.2
WB_WALL = min(-XI, WBTN[0] - 2.2) if WITTY else -XI      # inside face of the wall at the button (full: a small pod)
WPOST_D, WPOST_REC_D, WPOST_REC_H = 7.0, 5.4, 2.4         # lid posts on the Witty holes
# ---- L3V7 battery: Adafruit 5035 Li-ion 3.7 V 10050 mAh, 66.6 x 55.3 x 18.7 mm, JST-PH lead
if BATT:
    PH_X, PH_Y = WX(0.06), WY(15.2)                       # PH socket mouth (faces +X), centre y
    PH_Z = WZ(2.2)                                        # plug centre height
    PH_WALL = 45.0                                        # bump inside face: plug (about 4 mm out) + lead bend down
    LEAD_HOLE = (38.6, PH_Y, 8.6)                         # floor hole for the lead (PH plug passes), TPU grommet
BAT_L, BAT_W, BAT_H = 66.6, 55.3, 18.7
BAT_C = (0.0, -16.7)                                      # battery centre under the boards
TRAY_FLOOR, FOAM = 5.5, 1.5                               # floor with strap tunnels; foam pad on top of the battery
TRAY_H = TRAY_FLOOR + BAT_H + FOAM                        # battery deck height below the base (z -TRAY_H .. 0)
TRAY_R = 12.0                                             # big rounded bottom edge (pod look, 45 deg start: prints without supports)
STRAP_W, STRAP_T = 26.0, 3.4                              # strap tunnels: 1 in (25 mm) strap / hose clamp
STRAP_Y = [BAT_C[1] - 15.0, BAT_C[1] + 15.0]
M5_PTS = [(sx * 25.0, BAT_C[1] + sy * 34.0) for sx in (-1, 1) for sy in (-1, 1)]   # 4 x M5, 50 x 68 mm pattern
XR = 39.7 + P["right_wall_extra"]                        # RP-SMA wall (inside face), same as the Pi 3A+ case
# v8: +X end follows the boards: wall at the board edge (like the -X end) except round the XBee tip, where it
# slants parallel to the XBee's angled corners, then a small pod round the RP-SMA hex out to XR.
XW = 39.7                                                # flat in front of the XBee tip (tip at 39.3)
POD_H = 5.6                                              # pod half-width round the RP-SMA axis (hex 9.2 across corners + clearance)
XB_TIP, XB_Y0, XB_Y1, XB_CH, XB_CLR = 39.29, 1.52 - 12.19, 1.52 + 12.19, 5.5, 0.6   # XBee outline: tip x, sides, 45 deg corner size
_k = XB_CLR * 2 ** 0.5
XB_TOPZ = XBEE[1] - 0.55 + 3.95                              # top of the XBee-PRO S3B shield (keep-out only)
XB_JACK_X0 = 34.29 + P["rpsma_base_past_edge"] - 2.5         # inner end of the RP-SMA jack body
XB_HOLD_D = 5.0                                              # v15: hold-down post lands on the XBee logo (bare PCB, silkscreen only),
XB_SOCK_X0, XB_SOCK_LEN = 11.06, 20.55                       #      v16: ArduSimple XBee sockets (MMS-110-01, 10 x 2 mm) from its STEP
XB_PIN4 = XB_SOCK_X0 + (XB_SOCK_LEN - 18.0) / 2 + 2.0 * 6    #      4th pin from the RP-SMA end (pins at 12.34 .. 30.34)
XB_HOLD = (XB_PIN4, XBEE[0])                                 #      centred between the two 4th pins, on the module centre line;
XB_BOARD_TOP = XBEE[1] - 0.38                                #      v17 (Digi STEP XBP9B-XCST-021): the 0.76 mm RP-SMA centre pin lies on the board, so the board top is 0.38 below the axis
XB_HOLD_PAD = 0.0                                            #      v22: post 1 mm longer - foot lands on the board (no rubber pad)
XB_HOLD_Z = XB_BOARD_TOP + XB_HOLD_PAD
def _lo(x): return XB_Y0 + (x - (XB_TIP - XB_CH)) - _k    # wall line parallel to the lower angled corner
def _hi(x): return XB_Y1 - (x - (XB_TIP - XB_CH)) + _k    # ... and the upper one
MAIN = (-XI, XI, YF, YI)
PY0, PY1 = 1.52 - POD_H, 1.52 + POD_H
NOSE = [(XI - 0.01, _lo(XI - 0.01)), (XW, _lo(XW)), (XW, PY0), (XR, PY0), (XR, PY1), (XW, PY1), (XW, _hi(XW)), (XI - 0.01, _hi(XI - 0.01))]
# v3: rounded shape - cavity corners r3 (outside r6.6 in plan), rounded top edge on the lid, rounded bottom edge on the base
CORNER_R = 3.0
def rrect(x0, x1, y0, y1, rbl, rbr, rtr, rtl, n=10):
    pts = []
    for (cx, cy, r, a0) in ((x0 + rbl, y0 + rbl, rbl, 180), (x1 - rbr, y0 + rbr, rbr, 270), (x1 - rtr, y1 - rtr, rtr, 0), (x0 + rtl, y1 - rtl, rtl, 90)):
        if r <= 0:
            pts.append((cx, cy)); continue
        for k in range(n + 1):
            a = np.radians(a0 + 90 * k / n); pts.append((cx + r * np.cos(a), cy + r * np.sin(a)))
    return pts
R_ = CORNER_R
# v5: GNSS antenna cable with a right-angle SMA plug inside on the board jack (cable pointing up); the cable
# leaves through a TPU grommet in the lid top over a pocket at the GNSS end.
GP_X0 = -58.5                                                  # pocket end wall (inside)
GP_Y0 = GNSS[0] - 6.0                                          # pocket front edge (inside)
# v6: GNSS antenna via a 90 deg SMA male -> SMA female adapter on the ArduSimple jack, female port pointing up through
# the lid; the antenna's own straight SMA plug screws on from outside. Typical generic adapter assumed (measure yours):
GA_X = -51.0          # vertical port axis x (male leg: jack thread end at -43.9 -> about 7 mm to the bend)
GA_BODY = 10.0        # elbow body size
GA_TOP_ABOVE = 13.0   # top of the female thread above the SMA axis
GA_TOP = None         # set below (needs GNSS)
GROM = (GA_X, 12.89, 11.0)                                     # lid hole: centred on the adapter port, 11 mm wide (port hex passes as the lid goes on)
STRAP_LID = ((PI_Y0 + 31.45 + 8.5) + 0.9 + 19.6 / 2, 19.6, 0.8)   # v20: 3/4 in strap guide (19.6 mm recess, 0.8 deep) in the gap between the
                                                               #      Pi USB-A (right wall) and the ArduSimple USB-C openings (right wall used, left wall dust-plugged)
SEAT_D, SEAT_Z, SEAT_SKIN = 47.0, 19.8, 2.0                    # v19: antenna seat: 47 mm recess round the GNSS port for the 45 mm antenna,
                                                               #      floor 2.9 mm below the lid top; inside ceiling 17.8 = elbow top + 0.8
SEAT_EAR = 1                                                   # the back-left ear sits in the seat: deeper head seat, M3 x 8 there
GA_TOL = 1.0                                                   # +/- along X (adapter leg length varies): the hole is a short slot
POCKET_P = rrect(GP_X0, -XI + 0.01, GP_Y0, YI, R_, 0, 0, R_)
MAIN_P = rrect(-XI, XI, YF, YI, R_, R_, R_, R_)
RECTS = [MAIN_P, NOSE, POCKET_P]
# CABLE variant: bay on the right end from the Pi USB-A to the ArduSimple XBee USB-C, wide enough for right-angle plugs
CB_X = 35.38 + 12.5                                           # bay inside face: 12.5 mm past the XBee USB-C face
CB_Y0, CB_Y1 = PI_Y0 + 31.45 - 12.0, -9.6                     # from below the Pi USB-A to just short of the XBee nose
if CABLE:
    RECTS.append(rrect(XI - 0.01, CB_X, CB_Y0, CB_Y1, 0, R_, R_, 0))
if BATT:                                                       # L3V7: bump in the right wall for the JST-PH plug and its lead
    RECTS.append(rrect(XI - 0.01, PH_WALL, PH_Y - 7.0, PH_Y + 7.0, 0, 3.0, 3.0, 0))
if WITTY and WB_WALL < -XI:                                    # full Witty Pi 4: its button stem sticks 5.5 mm past the board
    RECTS.append(rrect(WB_WALL, -XI + 0.01, WBTN[1] - 5.5, WBTN[1] + 5.5, 1.5, 0, 0, 1.5))
TOP_R, BOT_R = 5.0, 3.0                                        # edge rounding: lid top, base bottom
def edge_inset(d, rr):
    """Rounded edge profile: inset at depth d from the face; 45 deg at the face (prints without supports), vertical by d = rr."""
    d0 = rr * (1 - 2 ** -0.5)
    if d < d0: return 2 * d0 - d
    return rr - np.sqrt(max(rr * rr - (rr - d) ** 2, 0.0))
W = P["wall"]; e = P["ear_inset"]
EARS = [(-XI - e, YF - e), (GP_X0 - e, YI + e), (XI + e, YF - e), (XI + e, YI + e)]

SW = (-17.1, -9.11); SW_TOP = ZA(40.69); SWH = (8.4, 4.4)
BTN = (3.55, 18.8); BTN_TOP = ZA(39.70)
GH = (-1.7, ARD_TOP + 2.1)                       # JST-GH 6-pin side-entry socket on the -X edge: (y, z) of the opening
QWIIC = (-25.2, 22.6); QWH = (7.5, 9.0)          # JST-SH 4-pin (Qwiic) top-entry socket: lid hole above it
LEDS = [(-32.5, -24.76), (-32.51, 6.21), (-32.64, -11.18)]
TUBE_IN, TUBE_OUT, TUBE_LEN = 4.0, 6.6, 3.0
POCKET_D, POCKET_H = 9.2, 1.6          # v5: recessed pocket for the TPU button cap (no raised collar -> lid prints flat)

def outer_body(z0, z1, step=0.4, rb=None, rt=None):
    parts = [cyl(x, y, z0, z1, P["ear_r"]) for x, y in EARS]
    rb = (BOT_R if abs(z0) <= 0.01 and not (BATT or SLED) else 0.0) if rb is None else rb   # base: rounded bottom edge (not on the battery deck)
    rt = (TOP_R if z1 >= TOPZ - 0.01 else 0.0) if rt is None else rt
    BOT_R_, TOP_R_ = rb, rt
    lo = z0 + rb
    hi = z1 - rt
    parts.append(outline(RECTS, W, lo - (0.01 if lo > z0 else 0.0), hi + (0.01 if hi < z1 else 0.0)))
    if lo > z0:
        for za in np.arange(z0, lo, step):
            zb = min(za + step, lo); parts.append(outline(RECTS, W - edge_inset((za + zb) / 2 - z0, BOT_R_), za, zb + 0.01))
    if hi < z1:
        for za in np.arange(hi, z1, step):
            zb = min(za + step, z1); parts.append(outline(RECTS, W - edge_inset(z1 - (za + zb) / 2, TOP_R_), za - 0.01, zb))
    return U(*parts)

def pi3a_cutters():
    """Pi 3A+ HDMI (front wall) and USB-A (+X wall): they reach the gasket groove, so they are cut through the joint
    (half in the base, the top edge in the lid) with a gap in the gasket, like the RP-SMA."""
    hz = PI_TOP + 3.25; az = PI_TOP + 3.6; ay = PI_Y0 + 31.45
    return {"Pi HDMI": (port_y(PI_X0 + 32.0, hz, 21.0, 10.0, 2.0, YF - W - 1, YF + 1), hz - 5.0, hz + 5.0,
                        (PI_X0 + 32.0 - 12.0, PI_X0 + 32.0 + 12.0, YF - W - 1, YF + 1)),
            "Pi USB-A": (port_x(ay, az, 17.0, 10.0, 2.0, XI - 1, XI + W + 1), az - 5.0, az + 5.0,
                         (XI - 1, XI + W + 1, ay - 10.0, ay + 10.0))}

def witty_cutters():
    """Witty USB-C opening (front wall) and side-button plunger hole + cap pocket (-X wall), with their gasket gaps."""
    if not WITTY:
        c = pi3a_cutters()
        if CABLE or GPIO_ONLY: c.pop("Pi USB-A")          # USB-A plugs into the inside cable / is sealed (GPIO version)
        return c
    ux, uz = WIT_USBC; x0 = WB_WALL - W
    return {"Witty USB-C": (port_y(ux, uz, 13.0, 8.0, 3.0, YF - W - 1, YF + 1), uz - 4.0, uz + 4.0,
                            (ux - 7.5, ux + 7.5, YF - W - 1, YF + 1)),
            "Witty button": (U(cylx(WBTN[1], WBTN[2], x0 - 1, WB_WALL + 1, WB_HOLE / 2),
                               cylx(WBTN[1], WBTN[2], x0 - 1, x0 + WB_POCK_H, WB_POCK_D / 2)),
                             WBTN[2] - WB_POCK_D / 2, WBTN[2] + WB_POCK_D / 2, (x0 - 1, WB_WALL + 1, WBTN[1] - 4.5, WBTN[1] + 4.5))}
def _crosses(z0, z1): return z0 < SPLIT + 0.5 and z1 > SPLIT - P["groove_d"] - 0.5

def joint_cutters():
    """Openings crossing the joint: cut from base, lid, ridge and gasket."""
    c = {k: v[0] for k, v in witty_cutters().items() if _crosses(v[1], v[2])}
    r = P["sma_hole"] / 2
    c["XBee RP-SMA"] = U(cylx(XBEE[0], XBEE[1], XR - 1, XR + W + 1, P["rpsma_hole"] / 2),
                         cylx(XBEE[0], XBEE[1], XR + W - P["spotface"], XR + W + 1, 7.6))
    return c

def base_only_cutters():
    c = {}
    r = P["sma_hole"] / 2
    c["USB-C left"] = port_x(USBC["left"][0], UZ, 13.0, 8.0, 3.0, -XI - W - 1, -XI + 1)
    if not (CABLE or GPIO_ONLY):
        c["USB-C right"] = port_x(USBC["right"][0], UZ, 13.0, 8.0, 3.0, XI - 1, XI + W + 1)   # v6: XBee USB-C back on the outside (XCTU on the bench)
    FY = (YF - W - 1, YF + 1)
    c["Pi micro-USB power"] = port_y(PI_X0 + 10.6, PI_TOP + 1.35, 12.0, 8.0, 2.0, *FY)   # power bank cable (as on the Pi3A+ v16)
    return c

def board_guides():
    """Ribs beside the board's short edges (floor to board top), clear of the USB-C ports and both SMAs."""
    c = 0.3; f = P["floor"] - 0.01
    hl, dx = P["board_len"] / 2, P["board_shift"]                     # measured board, 1 mm toward -X of its hole centre
    return [box(-XI, -hl + dx - c, 18.0, 25.5, f, ARD_TOP),           # -X: behind the GNSS SMA (USB-C and SMA stay clear)
            box(hl + dx + c, XI, 15.0, 25.0, f, ARD_TOP),             # +X back
            box(hl + dx + c, XI, -26.5, -23.8, f, ARD_TOP),           # +X front corner, beside the USB-C
            # dividers between the boards (ArduSimple front edge / Pi back edge), clear of the Pi GPIO header
            *[box(*sorted((sx * 28.0, sx * 33.0)), PI_Y0 + PI_D + c, -ARD_HALF[1] - c, f, ARD_TOP) for sx in (-1, 1)],
            # Pi ends: corner blocks clear of the microSD card (-X) and camera socket (+X)
            *[box(*sorted((sx * XI, sx * (PI_W / 2 + c))), y0, y1, f, PI_TOP + 1.0) for sx in (-1, 1)
              for y0, y1 in ((PI_Y0 + 0.5, PI_Y0 + 6.0), (PI_Y0 + PI_D - 5.0, PI_Y0 + PI_D - 0.5))]]

def gap_boxes(z0, z1):
    return U(box(XR - 1, XR + W + 1, XBEE[0] - 4.5, XBEE[0] + 4.5, z0, z1),                 # XBee RP-SMA
             *[box(*v[3], z0, z1) for v in witty_cutters().values() if _crosses(v[1], v[2])])    # Mini: USB-C + button cross the joint

# ---------------------------------------------------------------------- BASE
def build_base():
    b = outer_body(0, SPLIT) - outline(RECTS, 0, P["floor"], SPLIT + 1)
    posts = []
    for x, y in ARD_HOLES + PI_HOLES:
        tip = ARD_BOT + P["peg_len"]
        posts += [cyl(x, y, P["floor"] - 0.01, ARD_BOT, P["standoff_d"] / 2),
                  cyl(x, y, ARD_BOT - 0.01, tip - 0.8, P["peg_d"] / 2),
                  cyl(x, y, tip - 0.81, tip, P["peg_d"] / 2, P["peg_d"] / 2 - 0.6)]
    for x, y in WIT_FRONT_HOLES:                       # full Witty Pi 4: its two front holes overhang the Pi -> tall floor posts
        tip = WIT_BOT + P["peg_len"]
        posts += [cyl(x, y, P["floor"] - 0.01, WIT_BOT, 2.75),                 # slimmer: clears the mini-HDMI plug
                  cyl(x, y, WIT_BOT - 0.01, tip - 0.8, P["peg_d"] / 2),
                  cyl(x, y, tip - 0.81, tip, P["peg_d"] / 2, P["peg_d"] / 2 - 0.6)]
    b = U(b, *posts, *board_guides())
    holes = list(joint_cutters().values()) + list(base_only_cutters().values()) + (ear_holes_two_screw() if MOUNT == "bands" else
                                                                                    [cyl(x, y, -1, SPLIT + 1, P["m3_clear"] / 2) for x, y in EARS] if (BATT or SLED) else    # battery deck: long M3 screws lid -> base -> deck
                                 [cyl(x, y, SPLIT - 12, SPLIT + 1, P["m3_pilot"] / 2) for x, y in EARS])
    if P["gasket"]:
        holes.append(outline_ring(RECTS, W / 2 + P["groove_w"] / 2, W / 2 - P["groove_w"] / 2, SPLIT - P["groove_d"], SPLIT + 1))
    if BATT:
        holes.append(cyl(LEAD_HOLE[0], LEAD_HOLE[1], -1, P["floor"] + 1, LEAD_HOLE[2] / 2))   # battery lead up from the deck
    return b - U(*holes)

# ----------------------------------------------------------------------- LID
def build_lid():
    l = outer_body(SPLIT, TOPZ) - outline(RECTS, 0, SPLIT - 1, CEIL)
    adds = []
    if P["gasket"]:
        adds.append(outline_ring(RECTS, W / 2 + P["tongue_w"] / 2, W / 2 - P["tongue_w"] / 2, SPLIT - P["tongue_h"], SPLIT + 0.01) - gap_boxes(SPLIT - 1, SPLIT + 1))
    post_bot = ARD_TOP - P["post_preload"]
    wpost = WIT_BOT + W_T - P["post_preload"]          # with a Witty, the Pi-side posts press on the Witty board instead
    adds += [cyl(x, y, post_bot, CEIL + 0.1, P["post_d"] / 2) for x, y in ARD_HOLES]
    pi_post = PI_TOP - P["post_preload"]               # Pi 3A+ is 1.4 mm thick: its posts reach 0.2 lower
    adds += [cyl(x, y, pi_post, CEIL + 0.1, P["post_d"] / 2) for x, y in ([] if WITTY else PI_HOLES)]
    wposts = [cyl(x, y, wpost, CEIL + 0.1, WPOST_D / 2) for x, y in WIT_HOLES]
    if wposts:                                         # trim the Witty posts 0.3 clear of the Witty's own parts (STEP)
        adds += [U(*wposts) - U(*witty_part_boxes(0.3, CEIL + 1))]
    adds.append(cyl(*BTN, CEIL - TUBE_LEN, CEIL + 0.1, TUBE_OUT / 2))
    adds.append(cyl(*XB_HOLD, XB_HOLD_Z, CEIL + 0.1, XB_HOLD_D / 2))   # v14: XBee hold-down post (lid -> XBee board behind the RP-SMA jack)
    l = U(l, *adds)
    l = U(l, cyl(GA_X, GNSS[0], SEAT_Z - SEAT_SKIN, CEIL + 0.05, SEAT_D / 2 + (TOPZ + 1 - SEAT_Z) + 2.0) ^ outline(RECTS, 0, SEAT_Z - SEAT_SKIN, CEIL + 0.05))   # dropped ceiling under the seat; v23: reaches 2 mm past the chamfer so the seat floor joins the lid (v19-v22 left a 0.5 mm slit round the edge)
    peg_above = P["peg_len"] - 1.6
    holes = list(joint_cutters().values())
    holes += [cyl(x, y, post_bot - 1, ARD_TOP + peg_above + 0.6, P["peg_d"] / 2 + 0.25) for x, y in ARD_HOLES]
    holes += [cyl(x, y, pi_post - 1, PI_BOT + P["peg_len"] + 0.6, P["peg_d"] / 2 + 0.25) for x, y in ([] if WITTY else PI_HOLES)]
    # Witty posts: ring presses the board round the hole; the recess clears an M2.5 screw head (if standoffs are fitted)
    # and the floor-post peg tips at the full Witty's front holes
    holes += [cyl(x, y, wpost - 1, wpost + WPOST_REC_H, WPOST_REC_D / 2) for x, y in WIT_HOLES]
    # battery -> Witty USB-C (front wall); Witty button plunger (-X wall): lid only when clear of the joint
    holes += [v[0] for v in witty_cutters().values() if not _crosses(v[1], v[2])]
    holes.append(cyl(*BTN, CEIL - TUBE_LEN - 1, TOPZ + 1, TUBE_IN / 2))
    holes.append(cyl(*BTN, TOPZ - POCKET_H, TOPZ + 1, POCKET_D / 2))
    holes.append(hull(*[cyl(GROM[0] + d, GROM[1], SEAT_Z - SEAT_SKIN - 1, TOPZ + 1, GROM[2] / 2) for d in (-GA_TOL, GA_TOL)]))   # GNSS adapter port slot
    sy, sw, sd = STRAP_LID                             # strap guide: shallow recess right across the lid top (over the Pi)
    holes.append(box(-200, 200, sy - sw / 2, sy + sw / 2, TOPZ - sd, TOPZ + 1))
    _ch = TOPZ + 1 - SEAT_Z
    holes.append(cyl(GA_X, GNSS[0], SEAT_Z, TOPZ + 1, SEAT_D / 2, SEAT_D / 2 + _ch))    # v23: antenna seat, 45 deg chamfered edge (prints without a hard step)
    _inseat = lambda x, y: (x - GA_X) ** 2 + (y - GNSS[0]) ** 2 < (SEAT_D / 2 + (TOPZ - SEAT_Z) + 1.6) ** 2
    _instrap = lambda y: abs(y - sy) < sw / 2 + 1.6
    holes += [cyl(x, y, CEIL - 1, TOPZ - (sd if _instrap(y) else 0) - P["led_skin"], 1.6) for x, y in LEDS if not _inseat(x, y)]   # v23: no LED window under the antenna (solid floor)   # v20: LED skin under the strap recess
    for i, (x, y) in enumerate(EARS):
        hs = SEAT_Z - P["m3_head_h"] if i == SEAT_EAR else TOPZ - P["m3_head_h"]      # v19: head flush with the seat floor
        holes += [cyl(x, y, SPLIT - 1, TOPZ + 1, P["m3_clear"] / 2), cyl(x, y, hs, TOPZ + 1, P["m3_head_d"] / 2)]
    return l - U(*holes)

SUP_GAP, SUP_W, SUP_PITCH, SUP_CLR = 0.2, 0.6, 4.0, 0.6     # v21: breakaway support under the antenna seat (print orientation)

def build_seat_support(lid=None):
    """Breakaway ribs that fill the antenna seat recess when the lid prints top-down: they stand on the bed and stop
    0.2 mm (one layer) short of the seat floor, so the floor bridges onto them and they snap out afterwards.
    Ribs run along Y, 0.6 mm wide, 4 mm apart, kept 0.6 mm clear of the recess wall, the case edge and the holes."""
    from manifold3d import Manifold as _M, CrossSection as _CS
    lid = lid if lid is not None else build_lid().m
    reg = (lid ^ _M.cylinder(0.1, SEAT_D / 2 - SUP_CLR, SEAT_D / 2 - SUP_CLR, 128).translate((GA_X, GNSS[0], SEAT_Z - 0.1))).slice(SEAT_Z - 0.05)
    reg = reg.offset(-SUP_CLR, _CS.JoinType.Round if hasattr(_CS, "JoinType") else 1)
    h = TOPZ - (SEAT_Z + SUP_GAP)
    area = _M.extrude(reg, h).translate((0, 0, SEAT_Z + SUP_GAP))
    x0 = GA_X - SEAT_D / 2
    ribs = [box(x0 + k * SUP_PITCH, x0 + k * SUP_PITCH + SUP_W, GNSS[0] - SEAT_D / 2, GNSS[0] + SEAT_D / 2, SEAT_Z + SUP_GAP, TOPZ).m
            for k in range(int(SEAT_D / SUP_PITCH) + 1)]
    return _M.batch_boolean(ribs, manifold3d.OpType.Add) ^ area

def build_plunger():
    tip = BTN_TOP + 0.2
    fl0 = CEIL - TUBE_LEN - 0.2 - 1.2
    return U(cyl(*BTN, tip, fl0 + 0.01, 1.5), cyl(*BTN, fl0, fl0 + 1.2, 3.0),
             cyl(*BTN, fl0 + 1.19, TOPZ - POCKET_H, (TUBE_IN - 0.5) / 2))   # stem top just under the cap

def witty_part_boxes(clr, ztop):
    """Top-side Witty parts near its holes, from the UUGear STEP (witty_<mini|full>_solids.json), as clearance boxes."""
    ws = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), f"witty_{WITTY}_solids.json")))
    out = []
    for s_ in ws:
        lo, hi = s_["lo"], s_["hi"]
        if s_["name"] == "Board" or hi[2] < 0.05: continue
        x0, x1, y0, y1 = WX(hi[0]) - clr, WX(lo[0]) + clr, WY(hi[1]) - clr, WY(lo[1]) + clr
        if any(x0 - 5 < hx < x1 + 5 and y0 - 5 < hy < y1 + 5 for hx, hy in WIT_HOLES):
            out.append(box(x0, x1, y0, y1, WZ(max(lo[2], 0.0)) - 0.2, ztop))
    return out

def pod_section(inset=0.0):
    """Plan shape of the battery deck: convex hull of the case outline and its screw ears (smooth pod, ears blended in)."""
    from manifold3d import CrossSection, JoinType
    cs = outline(RECTS, W, 0, 1).m.project()
    ears = [CrossSection.circle(P["ear_r"], 48).translate((x, y)) for x, y in EARS]
    h = CrossSection.batch_boolean([cs] + ears, manifold3d.OpType.Add).hull()
    return h.offset(-inset, JoinType.Round, 2.0, 48) if inset > 1e-6 else h

def pod_body(z0, z1, step=0.4):
    """Pod deck body: flanks straight, bottom edge rounded with TRAY_R (45 deg at the face)."""
    def slab(cs, za, zb):
        pts = [tuple(map(float, q)) for poly in cs.to_polygons() for q in poly]
        return S(Manifold.extrude(cs, zb - za).translate((0, 0, za)),
                 f"translate([0,0,{za:.3f}]) linear_extrude({zb-za:.3f}) polygon(points=[" + ",".join(f"[{x:.3f},{y:.3f}]" for x, y in pts) + "]);")
    parts = [slab(pod_section(), z0 + TRAY_R - 0.01, z1)]
    for za in np.arange(z0, z0 + TRAY_R, step):
        zb = min(za + step, z0 + TRAY_R); parts.append(slab(pod_section(edge_inset((za + zb) / 2 - z0, TRAY_R)), za, zb + 0.01))
    return U(*parts)

def build_tray():
    """Battery deck under the base: open-top tray with the case outline, big rounded bottom edge, ribs that locate the
    battery, two 26 x 3.4 mm strap tunnels through the floor (1 in strap / hose clamp round a tube), 4 captive M5 nuts
    (bolt it to a bracket from below) and M3 pilot holes in the corner ears (4 x M3 x 35 through lid + base)."""
    z0 = -TRAY_H; ft = z0 + TRAY_FLOOR
    t = pod_body(z0, 0.0) - outline(RECTS, 0, ft, 1.0)
    # sealed lightening pockets in the filled corners of the pod (2 mm skins, closed under a 2 mm top skin)
    from manifold3d import CrossSection
    vcs = pod_section(W) - outline(RECTS, W + 2.0, 0, 1).m.project() \
          - CrossSection.batch_boolean([CrossSection.circle(P["ear_r"] + 2.0, 48).translate((x, y)) for x, y in EARS], manifold3d.OpType.Add)
    vcs = vcs.offset(-0.5, manifold3d.JoinType.Round, 2.0, 24).offset(0.5, manifold3d.JoinType.Round, 2.0, 24)
    if vcs.area() > 1.0:
        t = t - S(Manifold.extrude(vcs, -2.0 - ft).translate((0, 0, ft)), "")
    bx, by = BAT_L / 2 + 0.5, BAT_W / 2 + 0.5; cx, cy = BAT_C; rib_top = ft + 10.0
    ribs = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            ribs += [box(*sorted((cx + sx * bx, cx + sx * (bx + 2.0))), *sorted((cy + sy * (by - 12), cy + sy * (by + 2.0))), ft - 0.01, rib_top),
                     box(*sorted((cx + sx * (bx - 12), cx + sx * (bx + 2.0))), *sorted((cy + sy * by, cy + sy * (by + 2.0))), ft - 0.01, rib_top)]
    t = U(t, *ribs)
    t = t - outline_ring(RECTS, W / 2 + 1.0, W / 2 - 1.0, -0.6, 1.0)            # groove for the flat TPU deck gasket
    cut = [box(-120, 120, y - STRAP_W / 2, y + STRAP_W / 2, z0 + 1.2, z0 + 1.2 + STRAP_T) for y in STRAP_Y]
    for x, y in M5_PTS:
        cut += [cyl(x, y, z0 - 1, ft + 1, 2.75), cyl(x, y, ft - 4.3, ft + 1, 8.0 / 3 ** 0.5 + 0.15)]   # M5 bolt + nut pocket (8 mm AF)
    cut += [cyl(x, y, -16.0, 1.0, P["m3_pilot"] / 2) for x, y in EARS]
    return t - U(*cut)

def build_tray_gasket():
    return outline_ring(RECTS, W / 2 + 0.95, W / 2 - 0.95, 0, 1.0)

# ---------------------------------------------------------------- power-bank sled
# v2: bank along the case's long axis (Y): ports end at the front, under the Pi micro-USB power port
BANK = (147.0, 69.6, 18.0)                 # 0.7 in 20000 mAh bank: 5.79 x 2.74 x 0.71 in (length along Y); ports on the front short end
SL_PAD = 1.2                               # TPU pad on the slot ceiling (0.2 mm squeeze on the bank)
SL_FLOOR, SL_TOP = 6.0, 2.4                # floor with strap tunnels, ceiling under the case
SL_SLOT_H = BANK[2] + SL_PAD - 0.2         # TPU pad takes the bank-thickness tolerance
SL_H = SL_FLOOR + SL_SLOT_H                # v3: open-top slot - the case base floor is the roof over the bank
SL_TAIL_CLR = 0.4                          # gap between the raised tail cover and the case base
SL_R = 12.0                                # rounded bottom edge
SL_CAP_T = 4.0                             # end cap at the ports end (front)
# v4: Neoseek M320 Air - % display on the top face near the ports end: the bank sticks out 33 mm in front of the
# case so the display sits under a short front roof with a clear window; nothing sticks out at the back any more.
BK_Y0 = YF - W - 25.5                      # bank ports end (v5: 25.5 mm past the case front - just enough for the display)
SL_YE = BK_Y0 - 1.0 - SL_CAP_T             # sled front face (end cap)
# v5: window only over the % LEDs: from the product photo they sit on the button side of the ports end, about
# 5..21 mm in from the end and 4..26 mm off the centre line - with the ports end at the front that is the -X (left) half
DISP = (-15.0, BK_Y0 + 13.0, 28.0, 16.0)
LENS_T, LENS_LIP = 1.0, 2.0                # clear PETG lens in a rebate on the roof top
BK_C = (0.0, BK_Y0 + BANK[0] / 2)          # bank centre (x, y)
SL_STRAP_Y = [BK_C[1] - 40.0, BK_C[1] + 40.0]; SL_STRAP_W, SL_STRAP_T = 26.0, 3.4   # two 1 in strap tunnels across (along X)
SL_M5 = [(sx * 22.0, BK_C[1] + sy * 20.0) for sx in (-1, 1) for sy in (-1, 1)]       # 4 x M5 captive nuts, 44 x 40 mm
SL_CAP_SCREWS = [sx * (BANK[1] / 2 + 6.0) for sx in (-1, 1)]                          # 2 x M3 through the cap into the sled (x)

def sled_section(inset=0.0):
    """Sled plan: hull of the case footprint (with ears) and the bank envelope; flat at the front (ports end), rounded tail at +Y."""
    from manifold3d import CrossSection, JoinType
    cs = outline(RECTS, W, 0, 1).m.project()
    ears = [CrossSection.circle(P["ear_r"], 48).translate((x, y)) for x, y in EARS]
    xb0, xb1 = BK_C[0] - BANK[1] / 2 - 8.0, BK_C[0] + BANK[1] / 2 + 8.0
    rt = (xb1 - xb0) / 2
    y_back = max(BK_Y0 + BANK[0] + 3.0, YI + P["ear_inset"] + P["ear_r"])          # v5: no further back than the case ears
    tail = [CrossSection.circle(rt, 96).translate(((xb0 + xb1) / 2, y_back - rt))]
    rf = 8.0                                               # front corners of the nose
    front = [CrossSection.circle(rf, 48).translate((x, SL_YE + rf)) for x in (xb0 + rf, xb1 - rf)]
    h = CrossSection.batch_boolean([cs] + ears + tail + front, manifold3d.OpType.Add).hull()
    h = h ^ CrossSection.square((400, 400)).translate((-200, SL_YE))
    return h.offset(-inset, JoinType.Round, 2.0, 48) if inset > 1e-6 else h

def _sled_body(z0, z1, step=0.4):
    def slab(cs, za, zb):
        pts = [tuple(map(float, q)) for poly in cs.to_polygons() for q in poly]
        return S(Manifold.extrude(cs, zb - za).translate((0, 0, za)),
                 f"translate([0,0,{za:.3f}]) linear_extrude({zb-za:.3f}) polygon(points=[" + ",".join(f"[{x:.3f},{y:.3f}]" for x, y in pts) + "]);")
    parts = [slab(sled_section(), z0 + SL_R - 0.01, z1)]
    for za in np.arange(z0, z0 + SL_R, step):
        zb = min(za + step, z0 + SL_R); parts.append(slab(sled_section(edge_inset((za + zb) / 2 - z0, SL_R)), za, zb + 0.01))
    return U(*parts)

def build_sled_full():
    from manifold3d import CrossSection
    z0 = -SL_H; fz = z0 + SL_FLOOR
    t = _sled_body(z0, 0.0)
    cut = [box(BK_C[0] - BANK[1] / 2 - 0.6, BK_C[0] + BANK[1] / 2 + 0.6, SL_YE - 1, BK_Y0 + BANK[0] + 0.6, fz, 1.0)]   # open top
    cut += [box(-200, 200, y - SL_STRAP_W / 2, y + SL_STRAP_W / 2, z0 + 1.3, z0 + 1.3 + SL_STRAP_T) for y in SL_STRAP_Y]
    for x, y in SL_M5:
        cut += [cyl(x, y, z0 - 1, fz + 1, 2.75), cyl(x, y, fz - 4.3, fz + 1, 8.0 / 3 ** 0.5 + 0.15)]
    cut += [cyl(x, y, -16.0, 1.0, P["m3_pilot"] / 2) for x, y in EARS]
    # sealed lightening pockets either side of the slot (2 mm skins)
    keep = CrossSection.batch_boolean([CrossSection.square((BANK[1] + 2 * 0.6 + 4.0, 400)).translate((BK_C[0] - BANK[1] / 2 - 2.6, -200))]
                                      + [CrossSection.circle(P["ear_r"] + 2.5, 48).translate((x, y)) for x, y in EARS]
                                      + [CrossSection.circle(3.5, 32).translate((x, SL_YE + SL_CAP_T + 6.0)) for x in SL_CAP_SCREWS], manifold3d.OpType.Add)
    front = CrossSection.square((400, SL_CAP_T + 14.0)).translate((-200, SL_YE))
    vcs = sled_section(2.4) - keep - front
    if vcs.area() > 1.0:
        cut.append(S(Manifold.extrude(vcs, -SL_TOP - (fz + 2.0)).translate((0, 0, fz + 2.0)), ""))
    keep2 = CrossSection.batch_boolean([keep] + [CrossSection.square((400, SL_STRAP_W + 4.0)).translate((-200, y - SL_STRAP_W / 2 - 2.0)) for y in SL_STRAP_Y]
                                       + [CrossSection.circle(7.0, 32).translate((x, y)) for x, y in SL_M5], manifold3d.OpType.Add)
    vlo = sled_section(7.5) - keep2 - front
    if vlo.area() > 1.0:
        cut.append(S(Manifold.extrude(vlo, SL_FLOOR).translate((0, 0, z0 + 2.0)), ""))
    for x in SL_CAP_SCREWS:                                   # end-cap screw pilots (M3 x 16 through the cap)
        cut.append(cyly(x, fz + SL_SLOT_H / 2, SL_YE - 1, SL_YE + SL_CAP_T + 13.0, P["m3_pilot"] / 2))
    return U(t - U(*cut), build_tail_cover())

def case_footprint(clr=0.0):
    from manifold3d import CrossSection, JoinType
    cs = outline(RECTS, W, 0, 1).m.project()
    ears = [CrossSection.circle(P["ear_r"], 48).translate((x, y)) for x, y in EARS]
    f = CrossSection.batch_boolean([cs] + ears, manifold3d.OpType.Add)
    return f.offset(clr, JoinType.Round, 2.0, 48) if clr > 0 else f

def build_tail_cover():
    """Roof over the part of the bank that sticks out of the case footprint (v4: the front, over the % display):
    raised 2.4 mm cover, 0.4 mm clear of the case, with the display window and a rebate for the clear lens."""
    from manifold3d import CrossSection
    bank_band = CrossSection.square((BANK[1] + 2 * 0.6 + 2 * 3.0, YF - (SL_YE + SL_CAP_T))).translate((BK_C[0] - BANK[1] / 2 - 3.6, SL_YE + SL_CAP_T))   # front only
    reg = (sled_section() ^ bank_band) - case_footprint(SL_TAIL_CLR)
    parts = []
    for k, (za, zb) in enumerate(((0.0, 1.2), (1.2, 1.8), (1.8, SL_TOP))):
        r = reg if k == 0 else (reg ^ sled_section(0.6 if k == 1 else 1.2))
        parts.append(Manifold.extrude(r, zb - za + 0.01).translate((0, 0, za - 0.005)))
    roof = S(Manifold.batch_boolean(parts, manifold3d.OpType.Add), "")
    dx, dy, dw, dh = DISP
    win = rrect_z(dx - dw / 2, dx + dw / 2, dy - dh / 2, dy + dh / 2, 3.0, -1, SL_TOP + 1)
    reb = rrect_z(dx - dw / 2 - LENS_LIP, dx + dw / 2 + LENS_LIP, dy - dh / 2 - LENS_LIP, dy + dh / 2 + LENS_LIP, 3.0 + LENS_LIP, SL_TOP - LENS_T, SL_TOP + 1)
    return roof - U(win, reb)

def build_lens():
    """Clear lens for the display window (print in transparent PETG, 100 % infill, or cut from 1 mm polycarbonate)."""
    dx, dy, dw, dh = DISP
    return rrect_z(-dw / 2 - LENS_LIP + 0.15, dw / 2 + LENS_LIP - 0.15, -dh / 2 - LENS_LIP + 0.15, dh / 2 + LENS_LIP - 0.15, 3.0 + LENS_LIP - 0.15, 0, LENS_T - 0.05)

def build_sled():
    return build_sled_full() - box(-200, 200, SL_YE - 1, SL_YE + SL_CAP_T, -SL_H - 1, 1)

def build_sled_cap():
    """End cap at the front: closes the ports end of the slot; window for the bank's ports/cable, 2 x M3 x 16 into the sled."""
    z0 = -SL_H; fz = z0 + SL_FLOOR
    c = (_sled_body(z0, 0.0) ^ box(-200, 200, SL_YE, SL_YE + SL_CAP_T, z0 - 1, 1))
    win = port_y(BK_C[0], fz + SL_SLOT_H / 2 + 0.5, 62.0, 16.0, 3.0, SL_YE - 1, SL_YE + SL_CAP_T + 1)   # built-in cable root, 2 x USB-C, button
    holes = [cyly(x, fz + SL_SLOT_H / 2, SL_YE - 1, SL_YE + SL_CAP_T + 1, P["m3_clear"] / 2) for x in SL_CAP_SCREWS]
    heads = [cyly(x, fz + SL_SLOT_H / 2, SL_YE - 1, SL_YE + 1.5, P["m3_head_d"] / 2) for x in SL_CAP_SCREWS]
    return c - U(win, *holes, *heads)

# ---------------------------------------------------------------- v7 option: two clamp bands instead of the sled
MOUNT = os.environ.get("MOUNT", "sled")            # "sled" or "bands"
BD_W = 34.0                                       # v12: band width along Y - a 1 in (25.4 mm) Dual Lock strip under each bar with margin
DL_W, DL_L = 25.4, 66.0                           # 3M SJ3550 Dual Lock strip under each band bar (width across, length along the bar)
BD_ARM, BD_BAR, BD_LINER = 3.6, 6.0, 0.0          # side arm thickness, bottom bar thickness; v18: no TPU liner
BD_BANK_TOP = 0.0                                 # v18: no TPU pad - bank top straight against the case floor
BD_BANK_BOT = BD_BANK_TOP - BANK[2]
BD_BAR_TOP = BD_BANK_BOT - 0.2                    # v18: 0.2 mm clearance under the bank; crush ribs take it up
BD_RIB_H, BD_RIB_W, BD_RIB_DY = 0.6, 1.2, 8.0     # 2 crush ribs per bar, across the bank: 0.4 mm interference
BD_Z0 = BD_BAR_TOP - BD_BAR                       # band underside
BD_BOSS_R, BD_WEB = 4.5, 7.0                      # screw columns under the case ears, top web depth
BD_FRONT_Y = YF - P["ear_inset"]                  # front band centred on the front ears
BD_BACK_Y = BK_Y0 + BANK[0] - BD_W / 2 + 4.0      # back band: its end-stop lip just behind the bank end

# v10: two screws per corner - top M3 x 12 (lid -> base), bottom M3 x 12 (band -> base corner post from below), so the
# bands come off without opening the lid. v11: both self-tapping (no inserts).
TOP_PILOT_Z0 = 7.4                                # top screw pilot from here up to the joint (M3 x 12 tip at z 8.2)
INS_D, INS_H = P["m3_pilot"], 6.8                # v11: all self-tapping - bottom screw pilot (M3 x 12 tip at z 6.0) from the base underside
BD_CB_D, BD_CB_TOP = 6.0, -6.0                    # band column: counterbore for the M3 pan head (5.6 mm), up to 6 mm under the case

def ear_holes_two_screw():
    h = []
    for x, y in EARS:
        h += [cyl(x, y, TOP_PILOT_Z0, SPLIT + 1, P["m3_pilot"] / 2),       # top screw pilot
              cyl(x, y, -1, INS_H, INS_D / 2)]                            # bottom screw pilot
    return h

def build_band(back=False):
    """Clamp band: bottom bar under the bank (strap tunnel + 2 x M5), side arms, screw columns under the two case ears
    on its side of the case (long M3 through lid + base into the columns), webs joining arms and columns under the
    case floor. Back band: end-stop lips (bottom ridge + side lips) at the bank's rear end."""
    yc = BD_BACK_Y if back else BD_FRONT_Y
    y0, y1 = yc - BD_W / 2, yc + BD_W / 2
    hx = BANK[1] / 2 + 0.6                         # half slot width
    xa = hx + BD_ARM
    parts = [box(-xa, xa, y0, y1, BD_Z0, BD_BAR_TOP),                                   # bar
             box(-xa, -hx, y0, y1, BD_BAR_TOP - 0.01, 0.0), box(hx, xa, y0, y1, BD_BAR_TOP - 0.01, 0.0)]   # arms
    ears = [(x, y) for x, y in EARS if (y > 0) == back]
    for x, y in ears:
        parts.append(cyl(x, y, BD_Z0, 0.0, BD_BOSS_R))                                  # column from the bed up to the case
        xs = -xa if x < 0 else xa
        parts.append(box(*sorted((xs - (0.01 if x < 0 else -0.01), x)), y - 4.0, y + 4.0, -BD_WEB, 0.0))   # web
        parts.append(box(*sorted((xs, x)), y - 2.0, y + 2.0, BD_Z0, 0.0))               # rib under the web
    if back:
        ye = BK_Y0 + BANK[0] + 0.5                 # bank end + 0.5
        parts += [box(-hx - 0.01, hx + 0.01, ye, ye + 3.0, BD_BAR_TOP - 0.01, BD_BAR_TOP + 6.0),           # bottom ridge
                  box(-hx - 0.01, -hx + 8.0, ye, ye + 3.0, BD_BAR_TOP - 0.01, -2.0), box(hx - 8.0, hx + 0.01, ye, ye + 3.0, BD_BAR_TOP - 0.01, -2.0)]
    b = U(*parts) - box(-hx, hx, y0 - 1, y1 + 1, BD_BAR_TOP, 0.5)          # keep the slot clear (columns shaved flush)
    if back:                                       # ... but keep the end-stop lips
        ye = BK_Y0 + BANK[0] + 0.5
        b = U(b, box(-hx - 0.01, hx + 0.01, ye, ye + 3.0, BD_BAR_TOP - 0.01, BD_BAR_TOP + 6.0),
              box(-hx - 0.01, -hx + 8.0, ye, ye + 3.0, BD_BAR_TOP - 0.01, -2.0), box(hx - 8.0, hx + 0.01, ye, ye + 3.0, BD_BAR_TOP - 0.01, -2.0))
    # v12: no strap tunnel - solid bar under the Dual Lock; 0.8 mm wide x 0.4 mm deep guide lines on the bed face mark the strip
    b = U(b, *[box(-hx + 2.0, hx - 2.0, yc + d - BD_RIB_W / 2, yc + d + BD_RIB_W / 2, BD_BAR_TOP - 0.01, BD_BAR_TOP + BD_RIB_H) for d in (-BD_RIB_DY, BD_RIB_DY)])   # v18 crush ribs
    cut = [box(-DL_L / 2 - 0.4, DL_L / 2 + 0.4, yc + sy * (DL_W / 2 + 0.5) - 0.4, yc + sy * (DL_W / 2 + 0.5) + 0.4, BD_Z0 - 1, BD_Z0 + 0.4) for sy in (-1, 1)]
    cut += [box(sx * (DL_L / 2 + 0.5) - 0.4, sx * (DL_L / 2 + 0.5) + 0.4, yc - DL_W / 2 - 0.9, yc + DL_W / 2 + 0.9, BD_Z0 - 1, BD_Z0 + 0.4) for sx in (-1, 1)]
    cut += [cyl(x, yc, BD_Z0 - 1, BD_BAR_TOP + 1, 2.75) for x in (-18.0, 18.0)]                          # 2 x M5 through
    cut += [cyl(x, yc, BD_BAR_TOP - 4.3, BD_BAR_TOP + 1, 8.0 / 3 ** 0.5 + 0.15) for x in (-18.0, 18.0)]  # nut pockets (from the top)
    cut += [cyl(x, y, BD_CB_TOP - 0.01, 1.0, P["m3_clear"] / 2) for x, y in ears]                       # M3 clearance (top 6 mm)
    cut += [cyl(x, y, BD_Z0 - 1, BD_CB_TOP, BD_CB_D / 2) for x, y in ears]                              # socket-head counterbore from below
    return b - U(*cut)

def build_band_liner():
    """TPU liner strip for a band bar (under the bank)."""
    return box(0, BANK[1] - 2.0, 0, BD_W - 4.0, 0, BD_LINER)

def build_sled_pad():
    """TPU pad on the bank top, from 35 mm behind the ports end (clear of the % display): the case floor squeezes it 0.2 mm."""
    return box(0, BANK[1] - 6.0, 0, BANK[0] - 40.0, 0, SL_PAD)

def build_witty_plunger():
    """Horizontal plunger for the Witty side button: flange inside the -X wall presses the actuator; stem through the wall
    ends under the TPU cap in the outside pocket. Push the cap -> Witty button."""
    y, z = WBTN[1], WBTN[2]
    xin = WBTN[0] - WB_GAP                       # face toward the actuator
    x0 = WB_WALL - W + WB_POCK_H + 0.1           # stem end, just under the cap
    return U(cylx(y, z, WB_WALL + 0.2, xin, WB_FL / 2), cylx(y, z, x0, WB_WALL + 0.21, (WB_HOLE - 0.5) / 2))

def build_witty_cap(x=0, y=0):
    """TPU cap: presses into the 7 mm pocket over the Witty button plunger, 0.8 mm proud."""
    return cyl(x, y, 0, WB_POCK_H + 0.8, WB_POCK_D / 2 + 0.05)

# ------------------------------------------------------------------ TPU parts
def build_gasket():
    g = outline_ring(RECTS, W / 2 + P["gasket_w"] / 2, W / 2 - P["gasket_w"] / 2, 0, P["gasket_h"])
    return g - gap_boxes(-1, 5)

def build_button_cap(x=0, y=0):
    """TPU disc that presses into the lid pocket (0.1 mm interference), standing 0.8 mm proud; press it to work the button."""
    return cyl(x, y, 0, POCKET_H + 0.8, POCKET_D / 2 + 0.05)

def build_switch_plug(x=0, y=0, wh=None):
    w, h = wh or SWH
    return U(box(x - w / 2 - 1.5, x + w / 2 + 1.5, y - h / 2 - 1.5, y + h / 2 + 1.5, 0, 1.2),
             box(x - w / 2 + 0.05, x + w / 2 - 0.05, y - h / 2 + 0.05, y + h / 2 - 0.05, 1.19, 1.2 + P["top"] + 0.8),
             box(x - w / 2 - 0.25, x + w / 2 + 0.25, y - h / 2 - 0.25, y + h / 2 + 0.25, 1.2 + P["top"], 1.2 + P["top"] + 0.6))

def build_usbc_plug(x=0, y=0):
    """TPU dust plug for an unused USB-C opening: grip flange outside, 12.6 x 7.6 body that presses into the 13 x 8 opening."""
    body = hull(*[cyl(x + sx * (6.3 - 2.8), y + sy * (3.8 - 2.8), 1.5, 1.5 + W - 0.5, 2.8) for sx in (-1, 1) for sy in (-1, 1)])
    flange = hull(*[cyl(x + sx * (8.5 - 2), y + sy * (5.5 - 2), 0, 1.5, 2) for sx in (-1, 1) for sy in (-1, 1)])
    tab = box(x - 3, x + 3, y + 5, y + 12, 0, 1.5)
    return U(flange, body, tab)

def build_port_plug(w, h, r=2.0):
    """TPU dust plug for an opening w x h (corner r): grip flange outside, body 0.2 mm under size each side, pull tab."""
    bw, bh = w / 2 - 0.2, h / 2 - 0.2; rr = min(r, bw, bh) - 0.01
    body = hull(*[cyl(sx * (bw - rr), sy * (bh - rr), 1.5, 1.5 + W - 0.5, rr) for sx in (-1, 1) for sy in (-1, 1)])
    flange = hull(*[cyl(sx * (bw + 2.0 - 2.0), sy * (bh + 2.0 - 2.0), 0, 1.5, 2.0) for sx in (-1, 1) for sy in (-1, 1)])
    return U(flange, body, box(-3, 3, bh + 1.5, bh + 8.5, 0, 1.5))

def build_gnss_collar():
    """TPU split collar for the lid slot round the antenna plug's coupling nut / adapter port: oblong (fits the 11 x 13 mm
    slot), bore grips the 8 mm hex (9.0 mm) side to side and allows +/-1 mm front to back; flanges over and under the lid top."""
    t = SEAT_SKIN; r = GROM[2] / 2
    def ob(rr, z0, z1, ext=GA_TOL): return hull(*[cyl(d, 0, z0, z1, rr) for d in (-ext, ext)])
    g = U(ob(r + 1.9, 0, 1.2), ob(r + 0.1, 1.19, 1.21 + t), ob(r + 1.9, 1.2 + t, 2.4 + t))
    return g - U(ob(4.5, -1, 4 + t), box(0, 3 * r, -0.3, 0.3, -1, 4 + t))

def build_grommet(bore=3.0, x=0.0, gd=None):
    """TPU split grommet for the GNSS cable in the lid top: snaps into the 11 mm hole (flange each side of the
    2.4 mm top), slit so it wraps round the cable after the SMA plug has gone through the hole."""
    gd, t = gd or GROM[2], P["top"]
    g = U(cyl(x, 0, 0, 1.2, gd / 2 + 1.9), cyl(x, 0, 1.19, 1.21 + t, gd / 2 + 0.1), cyl(x, 0, 1.2 + t, 2.4 + t, gd / 2 + 1.9))
    return g - U(cyl(x, 0, -1, 4 + t, bore / 2), box(x, x + gd, -0.3, 0.3, -1, 4 + t))

def build_washer():
    return cyl(0, 0, 0, 1.5, 7.3) - cyl(0, 0, -1, 3, 3.3)

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    base, lid, pl = build_base(), build_lid(), build_plunger()
    gasket, cap, plug, uplug, washer = build_gasket(), build_button_cap(), build_switch_plug(), build_usbc_plug(), build_washer()
    write_stl(base.m, f"{out}/side3a_base.stl")
    write_stl(lid.m.rotate((180, 0, 0)).translate((0, 0, TOPZ)), f"{out}/side3a_lid.stl")      # top face flat on the bed; v23: no built-in support (slicer supports under the seat)
    plm = pl.m; write_stl(plm.translate((0, 0, -plm.bounding_box()[2])), f"{out}/side3a_button_plunger.stl")
    if WITTY:
        wp = build_witty_plunger().m.rotate((0, 90, 0)); write_stl(wp.translate((0, 0, -wp.bounding_box()[2])), f"{out}/side_witty{WITTY}_witty_button_plunger.stl")
        write_stl(build_witty_cap().m, f"{out}/TPU_witty_button_cap.stl")
    if SLED and MOUNT == "bands":
        for nm, bk in (("front", False), ("back", True)):
            bd = build_band(bk).m; write_stl(bd.translate((0, 0, -bd.bounding_box()[2])), f"{out}/side3a_bank_band_{nm}.stl")
        write_stl(build_port_plug(21.0, 10.0).m, f"{out}/TPU_hdmi_dust_plug.stl")
        if not (CABLE or GPIO_ONLY): write_stl(build_port_plug(17.0, 10.0).m, f"{out}/TPU_usba_dust_plug.stl")
    elif SLED:
        sl = build_sled(); write_stl(sl.m.translate((0, 0, SL_H)), f"{out}/side3a_powerbank_sled.stl")
        cp = build_sled_cap().m.rotate((90, 0, 0)); write_stl(cp.translate((0, 0, -cp.bounding_box()[2])), f"{out}/side3a_sled_end_cap.stl")
        write_stl(build_sled_pad().m, f"{out}/TPU_sled_pad.stl")      # sticks to the bank top
        write_stl(build_lens().m, f"{out}/CLEAR_display_lens.stl")
        write_stl(build_port_plug(21.0, 10.0).m, f"{out}/TPU_hdmi_dust_plug.stl")
        if not (CABLE or GPIO_ONLY): write_stl(build_port_plug(17.0, 10.0).m, f"{out}/TPU_usba_dust_plug.stl")
    if BATT:
        tr = build_tray(); write_stl(tr.m.translate((0, 0, TRAY_H)), f"{out}/side_witty{WITTY}_battery_deck.stl")
        write_stl(build_tray_gasket().m, f"{out}/TPU_battery_deck_gasket.stl")
        write_stl(build_grommet(2.4, 0.0, LEAD_HOLE[2]).m, f"{out}/TPU_battery_lead_grommet.stl")
    # v18: no printed gasket - 1/16 in (1.6 mm) silicone cord goes in the base groove (see the parts list)
    write_stl(cap.m.rotate((180, 0, 0)).translate((0, 0, cap.m.bounding_box()[5])), f"{out}/TPU_button_cap.stl")
    write_stl(U(uplug, build_usbc_plug(0, 30)).m, f"{out}/TPU_usbc_dust_plug_x2.stl")
    write_stl(washer.m, f"{out}/TPU_sma_washer.stl")
    write_stl(build_gnss_collar().m, f"{out}/TPU_gnss_adapter_collar.stl")
    with open(f"{out}/side3a_enclosure.scad", "w") as f:
        f.write("// Side-by-side Pi Zero 2 W + ArduSimple enclosure (generated from build_side.py)\n")
        f.write('part = "base"; // [base, lid, plunger, gasket, button_cap, switch_plug, usbc_plug, washer]\n\n')
        for n, o in (("base", base), ("lid", lid), ("plunger", pl), ("gasket", gasket), ("button_cap", cap),
                     ("switch_plug", plug), ("usbc_plug", uplug), ("washer", washer)):
            f.write(f"module {n}(){{\n{o.scad}\n}}\n")
        f.write('\nif (part=="base") base(); else if (part=="lid") lid(); else if (part=="plunger") plunger();\n'
                'else if (part=="gasket") gasket(); else if (part=="button_cap") button_cap(); else if (part=="switch_plug") switch_plug();\n'
                'else if (part=="usbc_plug") usbc_plug(); else if (part=="washer") washer();\n')
    bb = base.m.bounding_box()
    print(json.dumps(dict(box=[round(bb[3] - bb[0], 1), round(bb[4] - bb[1], 1), round(TOPZ, 1)], ARD_BOT=ARD_BOT, ARD_TOP=ARD_TOP, XBEE=XBEE, GNSS=GNSS,
                          SPLIT=SPLIT, CEIL=CEIL, WIT_TOP=WIT_TOP, WIT_USBC=WIT_USBC if WITTY else None, WBTN=WBTN if WITTY else None, WIT_HOLES=WIT_HOLES, status=[str(x.m.status()) for x in (base, lid, pl, gasket, cap, plug, uplug, washer)]), default=float))
