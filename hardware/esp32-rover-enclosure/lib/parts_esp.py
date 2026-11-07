"""Keep-out models for the ESP case (v3): ArduSimple (STEP boxes), XBee on its breakout, Feather (STL boxes), plugs, LiPo."""
import os, json, numpy as np
import build_esp as X
E = X.E
from manifold3d import Manifold, CrossSection, OpType
OP = OpType.Add
HERE = os.path.dirname(os.path.abspath(__file__))
DZ = X.DZ
def B(x0, x1, y0, y1, z0, z1): return Manifold.cube((x1 - x0, y1 - y0, z1 - z0)).translate((x0, y0, z0))
def cx(x0, x1, y, z, r): return Manifold.cylinder(x1 - x0, r, r, 48).rotate((0, 90, 0)).translate((x0, y, z))
def cz(x, y, z0, z1, r): return Manifold.cylinder(z1 - z0, r, r, 48).translate((x, y, z0))

def ardusimple():
    d = json.load(open('/home/claude/solids.json')); a = []
    for s in d:
        lo, hi = np.array(s['lo']), np.array(s['hi'])
        if s['name'] == 'COMPOUND' or lo[2] < 34 or s['name'].startswith('USB4105'): continue
        if s['name'] == 'SMA-long-thread.step': lo = lo.copy(); lo[0] = -33.87
        if s['name'] == 'pcb' and hi[0] - lo[0] > 60:
            lo = lo.copy(); hi = hi.copy(); lo[0] = -E.P['board_len'] / 2 + E.P['board_shift']; hi[0] = E.P['board_len'] / 2 + E.P['board_shift']
        lo[2] += E.AZ + DZ; hi[2] += E.AZ + DZ; hi = np.maximum(hi, lo + 0.01)
        a.append(Manifold.cube(tuple(hi - lo)).translate(tuple(lo)))
    uz = E.UZ + DZ
    return Manifold.batch_boolean(a, OP) + B(-35.35, -27.8, -18.79 - 4.5, -18.79 + 4.5, uz - 1, uz + 1) + B(27.8, 35.38, -16.6 - 4.5, -16.6 + 4.5, uz - 1, uz + 1)

def xbee():
    """XBee-PRO S3B in the ArduSimple socket (STEP boxes), as in the Pi cases."""
    ax = E.XBEE[1] + DZ
    xs = json.load(open(os.path.join(HERE, "xbee_s3b_solids.json")))
    def xb(name):
        s = [q for q in xs if q["name"] == name][0]; lo, hi = s["lo"], s["hi"]; Xf = lambda zs: 21.59 - zs
        return B(Xf(hi[2]), Xf(lo[2]), 1.52 + lo[0], 1.52 + hi[0], lo[1] + ax - 3.71, hi[1] + ax - 3.71)
    tip = [(-12.19, 16.47), (-12.19, -9.94), (-6.48, -15.66), (-5.67, -16.47), (5.67, -16.47), (6.48, -15.66), (12.19, -9.94), (12.19, 16.47)]
    pcb = Manifold.extrude(CrossSection([[(21.59 - zs, 1.52 + xs_) for xs_, zs in tip]]), 0.79).translate((0, 0, 2.54 + ax - 3.71))
    rb = 34.29 + E.P["rpsma_base_past_edge"]
    return Manifold.batch_boolean([pcb, xb("Shield"), xb("Header 1"), xb("Header 2"), cx(rb - 2.5, rb, 1.52, ax, 3.9)], OP)

def charger():
    """Adafruit bq24074 (4755) from its .brd: board + USB-C, DC jack, PH BATT / SYSOUT, chip (parts up)."""
    def bb(bx0, bx1, by0, by1, z0, z1):                 # board frame -> case (board x -> +Y, board y -> -X)
        return B(X.CX(by1), X.CX(by0), X.CY(bx0), X.CY(bx1), z0, z1)
    t = X.CHG_TOP
    return Manifold.batch_boolean([bb(0, X.CHG_W, 0, X.CHG_L, X.CHG_Z0, t), bb(-1.02, 6.91, 5.69, 14.63, t, t + 3.2), bb(-3.22, 12.03, 15.22, 28.22, t, t + 6.5),
                                   bb(28.54, 37.54, 5.7, 15.89, t, t + 6.0), bb(28.54, 37.54, 17.12, 27.33, t, t + 6.0), bb(19.9, 23.3, 13.9, 17.8, t, t + 1.0)], OP)

def feather():
    a = []
    for s in json.load(open(os.path.join(HERE, "feather_solids.json"))):
        lo, hi = s["lo"], s["hi"]
        a.append(B(X.FX(lo[1]), X.FX(hi[1]), X.FYy(lo[0]), X.FYy(hi[0]), X.FZ(hi[2]), max(X.FZ(lo[2]), X.FZ(hi[2]) + 0.01)))
    return Manifold.batch_boolean(a, OP)

def lis3dh():
    x0, y0, z0, z1 = X.LIS_X0, X.LIS_Y0, X.LIS_Z0, X.LIS_TOP
    m = B(x0, x0 + X.LIS_W, y0, y0 + X.LIS_L, z0, z1)
    m += B(x0 + 3.5, x0 + 14.3, y0 + 3.5, y0 + 21.9, z1, z1 + 1.3)                       # chip, regulator, passives
    m += B(x0 + 5.9, x0 + 11.9, y0 - 0.6, y0 + 4.3, z1, z1 + 3.0) + B(x0 + 5.9, x0 + 11.9, y0 + LIS_L_ - 4.3, y0 + LIS_L_ + 0.6, z1, z1 + 3.0)   # JST-SH x 2
    return m

LIS_L_ = X.LIS_L

# ArduSimple Arduino-R3 header rows (its left mounting holes sit exactly on an Uno's: offset -34.29, -26.67)
HDR_POWER = {n: (27.94 + 2.54 * i - 34.29, 2.54 - 26.67) for i, n in enumerate(["NC", "IOREF", "RESET", "3V3", "5V", "GND", "GND2", "VIN"])}
HDR_DIGITAL = {f"D{i}": (63.5 - 2.54 * i - 34.29, 50.8 - 26.67) for i in range(8)}
def dupont_leads():
    """Hand-wired leads: front (power) row pins bent flat, Duponts lying flat (6 mm tall): IOREF / 5V toward the middle, the GNDs along the edge;
    back (digital) row right-angle Duponts on straight pins (11.5 mm tall, lead toward the back wall)."""
    t = X.ARD_TOP
    front = [B(x - 1.4, x + 1.4, y - 1.3, y + 15.3, t, t + 6.0) for n, (x, y) in HDR_POWER.items() if n in ("IOREF", "5V")]      # toward the middle
    front += [B(x - 1.3, x + 16.0, y - 1.4 + dy, y + 1.4 + dy, t, t + 6.0) for n, (x, y), dy in
              ((n, HDR_POWER[n], dy) for n, dy in (("GND", 0.0), ("GND2", 0.0)))]                                              # GNDs along the edge, toward VIN
    back = [B(x - 1.3, x + 1.3, y - 1.3, y + 6.0, t, t + 11.5) for x, y in HDR_DIGITAL.values()]
    return Manifold.batch_boolean(front, OP), Manifold.batch_boolean(back, OP)

def lipo():
    x0, x1, y0, y1 = X.BAT
    return B(x0, x1, y0, y1, X.FLOOR, X.FLOOR + X.LIPO[2])

def keepouts():
    gy, gz = E.GNSS[0], E.GNSS[1] + DZ; ax = E.XBEE[1]
    bz = X.RIM - X.BOSS_T
    from dsl import port_y
    k = {"GNSS right-angle SMA plug (inside)": cx(-53.0, -35.5, gy, gz, 4.5) + B(-53.0, -45.0, gy - 4.5, gy + 4.5, gz, gz + 7.0),
         "XBee right-angle RP-SMA plug (inside)": cx(38.5, 52.0, 1.52, ax + DZ, 4.5) + B(44.0, 52.0, 1.52 - 4.5, 1.52 + 4.5, ax + DZ - 7.0, ax + DZ),
         "helix SMA bulkhead": cz(*X.HELIX_C, bz - 12, bz, 5.0),
         "whip RP-SMA bulkhead": cz(*X.WHIP_C, bz - 12, bz, 5.0),
         "PH2.0 plug in the Feather": B(X.PH[0], X.PH[0] + 8.0, X.PH[1] - 0.3, X.PH[2] + 0.3, X.PH[3], X.PH[4]),
         "USB-C plug (charge cable, outside)": port_y(X.USBC[0], X.USBC[1], 12.0, 6.4, 2.0, X.PY0 - 25, X.IY0 - 0.6).m,
         "USB-C plug shell (in the socket)": B(X.USBC[0] - 4.2, X.USBC[0] + 4.2, X.IY0 - 0.6, X.IY0 + 6.6, X.USBC[1] - 1.3, X.USBC[1] + 1.3),
         "M2 screw heads (Feather, 3.5 mm)": Manifold.batch_boolean([cz(x, y, X.FZ(1.57) - 1.4, X.FZ(1.57), 1.75) for x, y in X.F_HOLES], OP),
         "5V regulator (S9V11F5) on the deck": B(X.BOOST[0] - X.BOOST[2] / 2, X.BOOST[0] + X.BOOST[2] / 2, X.BOOST[1] - X.BOOST[3] / 2, X.BOOST[1] + X.BOOST[3] / 2, X.REG_Z0, X.REG_Z0 + X.REG_PCB)
             + B(X.BOOST[0] - X.BOOST[2] / 2 + X.REG_LIP + 0.1, X.BOOST[0] + X.BOOST[2] / 2 - X.REG_LIP - 0.1, X.BOOST[1] - X.BOOST[3] / 2, X.BOOST[1] + X.BOOST[3] / 2, X.REG_Z0 + X.REG_PCB, X.REG_Z0 + X.BOOST[4])
             + B(X.BOOST[0] - 4.0, X.BOOST[0] + 4.0, X.BOOST[1] - X.BOOST[3] / 2 - 6.0, X.BOOST[1] - X.BOOST[3] / 2, X.REG_Z0, X.REG_Z0 + X.BOOST[4]),   # board, parts (inside the lips), wires off the front end
         "charger PH plugs (BATT + SYSOUT)": B(X.CX(27.6), X.CX(5.4), X.CY(37.54), X.CY(37.54) + 7.0, X.CHG_TOP, X.CHG_TOP + 5.6),
         "M2.5 screw heads (charger)": Manifold.batch_boolean([cz(x, y, X.CHG_TOP, X.CHG_TOP + 1.8, 2.3) for x, y in X.CHG_HOLES], OP),
         "panel USB-C (body inside the wall + nut)": Manifold.cylinder(3.0, 9.5, 9.5, 48).rotate((-90, 0, 0)).translate((X.PANEL_USB_X, X.IY0, X.PANEL_USB_Z))
                                                    + Manifold.cylinder(9.0, 7.5, 7.5, 48).rotate((-90, 0, 0)).translate((X.PANEL_USB_X, X.IY0, X.PANEL_USB_Z)),
         "panel USB-C cable (rear plug + bend)": B(X.PANEL_USB_X - 5.0, X.PANEL_USB_X + 5.0, X.IY0 + 9.0, X.IY0 + 13.0, X.PANEL_USB_Z - 4.0, X.PANEL_USB_Z + 4.0),
         "right-angle USB-C plug into the charger": B(X.CHG_USB[0] - 4.4, X.CHG_USB[0] + 4.4, X.CHG_USB[1] - 9.0, X.CHG_USB[1] + 0.6, X.CHG_USB[2] - 2.9, X.CHG_USB[2] + 2.9)
             + B(X.PANEL_USB_X + 7.6, X.CHG_USB[0] + 2.0, X.CHG_USB[1] - 9.0, X.CHG_USB[1] - 5.0, X.CHG_USB[2] - 2.0, X.CHG_USB[2] + 2.0),   # cable back to the panel port
         "M2.5 screw heads (LIS3DH)": Manifold.batch_boolean([cz(x, y, X.LIS_TOP, X.LIS_TOP + 1.8, 2.3) for x, y in X.LIS_HOLES], OP),
         "LIS3DH wires (soldered to the left 6-pin row)": B(X.LIS_X0 + 1.0, X.LIS_X0 + 4.1, X.LIS_Y0 + 5.0, X.LIS_Y0 + 20.4, X.LIS_TOP, X.LIS_TOP + 4.0),
         "foam pad on the pouch": B(X.BAT[0] + 5, X.BAT[1] - 5, X.BAT[2] + 5, X.BAT[3] - 5, X.FLOOR + X.LIPO[2], X.DECK_Z0)}
    return k
