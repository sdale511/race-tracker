"""Build esp32-rover-carrier.kicad_pcb: place the footprints, route every net, pour ground on both layers.

Run with KiCad's own Python (it provides pcbnew):
  ~/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3 tools/gen_pcb.py
"""
import heapq
import math
import os
import sys

import pcbnew

sys.path.insert(0, os.path.dirname(__file__))
import gen_sch  # noqa: E402
import layout as L  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'esp32-rover-carrier.kicad_pcb')
FPLIB = os.path.expanduser('~/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints/')

OX, OY = 100.0, 100.0  # where the board's front-left corner sits on the KiCad page
CLEAR = 0.2            # copper clearance
EDGE = 0.5             # copper to board edge
HOLE_CLEAR = 0.3       # copper to a non-plated hole
MARGIN = 0.03          # grid rounding allowance
VIA_D, VIA_DRILL = 0.6, 0.3
GRID = 0.1


def kp(x, y):
    """Board millimetres (y towards the back) to a KiCad point (y down the page)."""
    return pcbnew.VECTOR2I_MM(OX + x, OY + (L.H - y))


def bx(p):
    """KiCad point back to board millimetres."""
    return (pcbnew.ToMM(p.x) - OX, L.H - (pcbnew.ToMM(p.y) - OY))


def load(lib, name):
    fp = pcbnew.FootprintLoad(FPLIB + lib + '.pretty', name)
    if fp is None:
        raise SystemExit(f'footprint not found: {lib}:{name}')
    return fp


def pad_pos(fp):
    return {p.GetNumber(): bx(p.GetPosition()) for p in fp.Pads()}


def link(fp, lib, name):
    """Tie the footprint to its schematic symbol (gen_sch.py derives the same UUID from the reference)."""
    fp.SetFPID(pcbnew.LIB_ID(lib, name))
    fp.SetPath(pcbnew.KIID_PATH('/' + gen_sch.symbol_uuid(fp.GetReference())))


def place_socket(board, nets, s):
    n = len(s['pins'])
    fp = load('Connector_PinSocket_2.54mm', f"{s['fp']}_P2.54mm_Vertical")
    fp.SetReference(s['ref'])
    fp.SetValue(s['label'])
    link(fp, 'Connector_PinSocket_2.54mm', f"{s['fp']}_P2.54mm_Vertical")
    board.Add(fp)
    want = s['pins']
    for rot in (0, 90, 180, 270):
        fp.SetOrientationDegrees(rot)
        fp.SetPosition(kp(*want[0]))
        got = pad_pos(fp)
        if all(math.dist(got[str(i + 1)], want[i]) < 0.01 for i in range(n)):
            break
    else:
        raise SystemExit(f"{s['ref']}: no rotation puts the pins where they belong")
    for i, net in enumerate(s['nets']):
        if not net:
            # the name KiCad gives a pin with a no-connect flag, so the board matches the schematic
            net = f"unconnected-({s['ref']}-Pin_{i + 1}-Pad{i + 1})"
            nets[net] = pcbnew.NETINFO_ITEM(board, net)
            board.Add(nets[net])
        fp.FindPadByNumber(str(i + 1)).SetNet(nets[net])
    return fp


def add_line(board, layer, a, b, width=0.12):
    sh = pcbnew.PCB_SHAPE(board)
    sh.SetShape(pcbnew.SHAPE_T_SEGMENT)
    sh.SetStart(kp(*a))
    sh.SetEnd(kp(*b))
    sh.SetLayer(layer)
    sh.SetWidth(pcbnew.FromMM(width))
    board.Add(sh)


def add_rect(board, layer, x, y, w, h, width=0.12):
    pts = [(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)]
    for a, b in zip(pts, pts[1:]):
        add_line(board, layer, a, b, width)


def add_text(board, layer, text, x, y, size=1.0, rot=0, mirror=False):
    t = pcbnew.PCB_TEXT(board)
    t.SetText(text)
    t.SetPosition(kp(x, y))
    t.SetLayer(layer)
    t.SetTextSize(pcbnew.VECTOR2I_MM(size, size))
    t.SetTextThickness(pcbnew.FromMM(size * 0.15))
    t.SetTextAngleDegrees(rot)
    if mirror:
        t.SetMirrored(True)
    board.Add(t)


# --- the grid router ---------------------------------------------------------------------------------------------

class Obstacle:
    """Copper (or a hole) seen by the router: a circle, a rectangle, or a segment, on one or both layers."""

    def __init__(self, kind, net, layers, **g):
        self.kind, self.net, self.layers, self.g = kind, net, layers, g

    def dist(self, x, y):
        g = self.g
        if self.kind == 'circle':
            return math.hypot(x - g['cx'], y - g['cy']) - g['r']
        if self.kind == 'rect':
            dx = max(abs(x - g['cx']) - g['hw'], 0)
            dy = max(abs(y - g['cy']) - g['hh'], 0)
            return math.hypot(dx, dy)
        ax, ay, bx_, by, hw = g['ax'], g['ay'], g['bx'], g['by'], g['hw']
        vx, vy = bx_ - ax, by - ay
        ll = vx * vx + vy * vy
        t = 0 if ll == 0 else max(0, min(1, ((x - ax) * vx + (y - ay) * vy) / ll))
        return math.hypot(x - ax - t * vx, y - ay - t * vy) - hw

    def bbox(self, pad):
        g = self.g
        if self.kind == 'circle':
            return g['cx'] - g['r'] - pad, g['cy'] - g['r'] - pad, g['cx'] + g['r'] + pad, g['cy'] + g['r'] + pad
        if self.kind == 'rect':
            return g['cx'] - g['hw'] - pad, g['cy'] - g['hh'] - pad, g['cx'] + g['hw'] + pad, g['cy'] + g['hh'] + pad
        e = g['hw'] + pad
        return min(g['ax'], g['bx']) - e, min(g['ay'], g['by']) - e, max(g['ax'], g['bx']) + e, max(g['ay'], g['by']) + e


def pad_obstacle(p):
    x, y = bx(p.GetPosition())
    sx, sy = (pcbnew.ToMM(v) for v in (p.GetSize(pcbnew.F_Cu).x, p.GetSize(pcbnew.F_Cu).y))
    ang = round(p.GetOrientationDegrees()) % 180
    if ang == 90:
        sx, sy = sy, sx
    net = p.GetNetname() or None
    if net and net.startswith('unconnected-'):
        net = None
    if p.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH:
        return Obstacle('circle', None, (0, 1), cx=x, cy=y, r=pcbnew.ToMM(p.GetDrillSize().x) / 2 + HOLE_CLEAR - CLEAR)
    layers = (0, 1) if p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH else (0,)
    if p.GetShape(pcbnew.F_Cu) == pcbnew.PAD_SHAPE_CIRCLE or (
            p.GetShape(pcbnew.F_Cu) == pcbnew.PAD_SHAPE_OVAL and abs(sx - sy) < 1e-6):
        return Obstacle('circle', net, layers, cx=x, cy=y, r=sx / 2)
    return Obstacle('rect', net, layers, cx=x, cy=y, hw=sx / 2, hh=sy / 2)


class Router:
    def __init__(self, board):
        self.nx = int(L.W / GRID) + 1
        self.ny = int(L.H / GRID) + 1
        self.obst = [pad_obstacle(p) for p in board.GetPads()]
        self.paths = {}   # net -> list of [(x, y, layer), ...] polylines in grid cells
        self.vias = []    # (x, y, net)

    def blocked(self, net, inflate):
        """Per-layer bytearrays: 1 where a track centre (or via, inflate=via radius) of `net` may not go."""
        nx, ny = self.nx, self.ny
        out = [bytearray(nx * ny), bytearray(nx * ny)]
        e = EDGE + inflate + MARGIN
        for layer in (0, 1):
            m = out[layer]
            for j in range(ny):
                y = j * GRID
                for i in range(nx):
                    x = i * GRID
                    if x < e or y < e or x > L.W - e or y > L.H - e:
                        m[j * nx + i] = 1
        need = CLEAR + inflate + MARGIN
        for o in self.obst:
            if o.net is not None and o.net == net:
                continue
            x0, y0, x1, y1 = o.bbox(need)
            for j in range(max(0, int(y0 / GRID)), min(ny, int(y1 / GRID) + 2)):
                for i in range(max(0, int(x0 / GRID)), min(nx, int(x1 / GRID) + 2)):
                    if o.dist(i * GRID, j * GRID) < need:
                        for layer in o.layers:
                            out[layer][j * nx + i] = 1
        return out

    def route_net(self, net, pads, width):
        hw = width / 2
        tr = self.blocked(net, hw)
        via = self.blocked(net, VIA_D / 2)
        vb = bytearray(a | b for a, b in zip(*via))
        nx = self.nx
        prefer_b = net in L.PREFER_BOTTOM
        layer_cost = (1.25, 1.0) if prefer_b else (1.0, 1.25)

        def cell(pt):
            return int(round(pt[0] / GRID)), int(round(pt[1] / GRID))

        # Pad cells themselves are free for their own net (the pad centre may sit inside the inflated keep-out
        # of a neighbouring pad only if the pads are too close for any track anyway).
        # pads: [((x, y), layers)]; plated pads are on both layers, test pads only on top
        tree = set()
        pads = sorted(pads, key=lambda p: len(p[1]), reverse=True)
        first, first_layers = pads[0]
        ci, cj = cell(first)
        for layer in first_layers:
            tree.add((ci, cj, layer))
        todo = sorted(pads[1:], key=lambda p: math.dist(p[0], first))
        polylines = []
        tees = []
        dirs = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]
        for p, p_layers in todo:
            si, sj = cell(p)
            # A*: state (i, j, layer, dir)
            best = {}
            pq = []
            for layer in p_layers:
                st = (si, sj, layer, -1)
                best[st] = 0.0
                heapq.heappush(pq, (0.0, 0.0, st))
            prev = {}
            found = None
            tree_l = tree
            # heuristic: octile distance to nearest tree cell, using a coarse list of tree cells
            sample = list(tree)[:: max(1, len(tree) // 200)] + [t for t in tree if (t[0], t[1]) == (ci, cj)]

            def heur(i, j):
                bd = 1e9
                for (ti, tj, _) in sample:
                    dx, dy = abs(i - ti), abs(j - tj)
                    d = max(dx, dy) + 0.414 * min(dx, dy)
                    if d < bd:
                        bd = d
                return bd

            hcache = {}
            while pq:
                f, g, st = heapq.heappop(pq)
                if g > best.get(st, 1e18) + 1e-9:
                    continue
                i, j, layer, d = st
                if (i, j, layer) in tree_l and (i, j) != (si, sj):
                    found = st
                    break
                for k, (di, dj) in enumerate(dirs):
                    ni, nj = i + di, j + dj
                    if not (0 <= ni < nx and 0 <= nj < self.ny):
                        continue
                    idx = nj * nx + ni
                    if tr[layer][idx] and (ni, nj, layer) not in tree_l:
                        continue
                    if di and dj:
                        # no squeezing diagonally between two blocked cells
                        if tr[layer][j * nx + ni] and tr[layer][nj * nx + i]:
                            continue
                    step = (1.4142 if di and dj else 1.0) * layer_cost[layer]
                    turn = 0 if d in (-1, k) else (0.6 if (k - d) % 8 in (1, 7) else 2.0)
                    ng = g + step + turn
                    ns = (ni, nj, layer, k)
                    if ng < best.get(ns, 1e18) - 1e-9:
                        best[ns] = ng
                        prev[ns] = st
                        key = (ni, nj)
                        if key not in hcache:
                            hcache[key] = heur(ni, nj)
                        heapq.heappush(pq, (ng + hcache[key], ng, ns))
                # via
                idx = j * nx + i
                if not vb[idx] and (i, j) != (si, sj):
                    ol = 1 - layer
                    ns = (i, j, ol, -1)
                    ng = g + 25.0
                    if ng < best.get(ns, 1e18) - 1e-9:
                        best[ns] = ng
                        prev[ns] = st
                        heapq.heappush(pq, (ng + hcache.get((i, j), 0), ng, ns))
            if found is None:
                raise SystemExit(f'could not route {net} to pad at {p}')
            path = []
            st = found
            while st in prev:
                path.append(st)
                st = prev[st]
            path.append(st)
            path.reverse()
            cells = [(s[0], s[1], s[2]) for s in path]
            polylines.append(dict(cells=cells, start=p, end_tree=True))
            tees.append(cells[-1])
            for c in cells:
                tree.add(c)
            for layer in p_layers:
                tree.add((si, sj, layer))
            # new copper becomes an obstacle for later nets right away
        self.paths[net] = (polylines, tees, width, [q for q, _ in pads])
        for pl in polylines:
            cells = pl['cells']
            for a, b in zip(cells, cells[1:]):
                if a[2] == b[2]:
                    self.obst.append(Obstacle('seg', net, (a[2],), ax=a[0] * GRID, ay=a[1] * GRID,
                                              bx=b[0] * GRID, by=b[1] * GRID, hw=width / 2))
                else:
                    self.obst.append(Obstacle('circle', net, (0, 1), cx=a[0] * GRID, cy=a[1] * GRID, r=VIA_D / 2))


def emit(board, nets, router):
    layers = (pcbnew.F_Cu, pcbnew.B_Cu)
    for net, (polylines, tees, width, pads) in router.paths.items():
        tee_pts = {(c[0], c[1]) for c in tees}
        padcells = {(int(round(p[0] / GRID)), int(round(p[1] / GRID))): p for p in pads}
        for pl in polylines:
            cells = pl['cells']
            # split into same-layer runs; a layer change is a via
            runs = [[cells[0]]]
            for c in cells[1:]:
                if c[2] != runs[-1][-1][2]:
                    v = pcbnew.PCB_VIA(board)
                    v.SetPosition(kp(c[0] * GRID, c[1] * GRID))
                    v.SetWidth(pcbnew.FromMM(VIA_D))
                    v.SetDrill(pcbnew.FromMM(VIA_DRILL))
                    v.SetNet(nets[net])
                    board.Add(v)
                    runs.append([c])
                else:
                    runs[-1].append(c)
            for run in runs:
                pts = [(c[0] * GRID, c[1] * GRID) for c in run]
                # keep corners, vias and tee points; drop points in the middle of a straight run
                keep = [0]
                for k in range(1, len(run) - 1):
                    a, b, c = run[k - 1], run[k], run[k + 1]
                    if (b[0] - a[0], b[1] - a[1]) != (c[0] - b[0], c[1] - b[1]) or (b[0], b[1]) in tee_pts:
                        keep.append(k)
                keep.append(len(run) - 1)
                poly = [pts[k] for k in keep]
                # snap the ends that sit on a pad to the pad centre
                for end in (0, -1):
                    cc = (run[end][0], run[end][1])
                    if cc in padcells:
                        poly.insert(0 if end == 0 else len(poly), padcells[cc])
                for a, b in zip(poly, poly[1:]):
                    if math.dist(a, b) < 1e-6:
                        continue
                    t = pcbnew.PCB_TRACK(board)
                    t.SetStart(kp(*a))
                    t.SetEnd(kp(*b))
                    t.SetWidth(pcbnew.FromMM(width))
                    t.SetLayer(layers[run[0][2]])
                    t.SetNet(nets[net])
                    board.Add(t)


def stitch(board, nets, router, pitch=5.0):
    """GND vias on a grid wherever one fits, so ground islands boxed in by tracks still join the pours."""
    free = router.blocked('GND', VIA_D / 2 + 0.1)
    both = [a | b for a, b in zip(*free)]
    # keep off every hole, ground pads included (the keep-out above lets a via sit on its own net's copper)
    holes = [bx(p.GetPosition()) for p in board.GetPads() if p.GetDrillSize().x > 0]
    holes += [bx(t.GetPosition()) for t in board.GetTracks() if t.Type() == pcbnew.PCB_VIA_T]
    n = 0
    y = pitch / 2
    while y < L.H:
        x = pitch / 2
        while x < L.W:
            i, j = int(round(x / GRID)), int(round(y / GRID))
            if not both[j * router.nx + i] and all(math.dist((i * GRID, j * GRID), h) > 2.0 for h in holes):
                v = pcbnew.PCB_VIA(board)
                v.SetPosition(kp(i * GRID, j * GRID))
                v.SetWidth(pcbnew.FromMM(VIA_D))
                v.SetDrill(pcbnew.FromMM(VIA_DRILL))
                v.SetNet(nets['GND'])
                board.Add(v)
                n += 1
            x += pitch
        y += pitch
    print('stitching vias:', n)


def add_zone(board, net, layer):
    z = pcbnew.ZONE(board)
    z.SetLayer(layer)
    z.SetNet(net)
    o = z.Outline()
    o.NewOutline()
    for x, y in ((0, 0), (L.W, 0), (L.W, L.H), (0, L.H)):
        o.Append(kp(x, y))
    z.SetLocalClearance(pcbnew.FromMM(0.3))
    z.SetMinThickness(pcbnew.FromMM(0.25))
    z.SetThermalReliefGap(pcbnew.FromMM(0.4))
    z.SetThermalReliefSpokeWidth(pcbnew.FromMM(0.5))
    z.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL)
    z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)
    board.Add(z)


def silkscreen(board):
    S, FAB = pcbnew.F_SilkS, pcbnew.F_Fab
    FX = L.FX0
    # module outlines on the fab layer, short corner marks on silk
    for name, (x, y, w, h) in [('ArduSimple simpleRTK2B Budget', (0, 0, 68.58, L.H)), ('Feather', L.FEATHER),
                               ('bq24074', L.BQ), ('LIS3DH', L.LIS), ('S9V11F5', L.REG)]:
        add_rect(board, FAB, x, y, w, h, 0.1)
    add_text(board, S, 'RACE-TRACKER ESP32 ROVER CARRIER  rev B', 34.0, 41.0, 1.2)
    add_text(board, S, 'ArduSimple: solder male headers underneath, plug in here', 34.0, 38.5, 0.9)
    add_text(board, S, 'switch DOWN (5V IN, IOREF N/C)', 34.0, 36.3, 0.9)
    add_text(board, S, 'BATT  - +', 81.0, 10.5, 0.9)
    add_text(board, S, 'FEATHER  display up, on stacking headers', FX + 11.43, 26.0, 0.9, rot=90)
    add_text(board, S, 'USB-C', FX + 11.43, 1.5, 0.9)
    add_text(board, S, 'bq24074 charger (optional)', 85.0, 27.0, 0.9)
    add_text(board, S, 'USB-C', 92.0, 1.5, 0.9)
    add_text(board, S, 'JP1: shunt ONLY', 87.5, 22.6, 0.9)
    add_text(board, S, 'without charger', 87.5, 21.2, 0.9)
    add_text(board, S, 'LIS3DH', 112.9, 20.0, 0.9)
    add_text(board, S, 'GND', 97.0, 9.3, 0.9)
    add_text(board, S, 'BATT', 90.2, 17.54, 0.9)  # JP1 pin 1
    add_text(board, S, 'VSYS', 90.2, 15.0, 0.9)
    add_text(board, S, 'S9V11F5', 75.8, 47.5, 0.9)
    add_text(board, S, 'IN G OUT', 75.8, 43.8, 0.9)
    add_text(board, S, 'wire to', 84.0, 50.0, 0.9)
    add_text(board, S, 'S9V11F5 EN', 84.0, 48.6, 0.9)
    add_text(board, S, 'FEATHER OFF', 109.0, 42.6, 0.9)
    add_text(board, S, 'EN', 111.4, 40.0, 0.9)  # J12 pin 1
    add_text(board, S, 'GND', 111.8, 37.46, 0.9)


def main():
    board = pcbnew.BOARD()
    ds = board.GetDesignSettings()
    ds.SetCopperLayerCount(2)
    nets = {}
    names = set()
    for s in L.SOCKETS:
        names.update(n for n in s['nets'] if n)
    for o in L.OTHER:
        names.update(o['nets'].values())
    for n in sorted(names):
        ni = pcbnew.NETINFO_ITEM(board, n)
        board.Add(ni)
        nets[n] = ni

    add_rect(board, pcbnew.Edge_Cuts, 0, 0, L.W, L.H, 0.1)
    for s in L.SOCKETS:
        place_socket(board, nets, s)
    for o in L.OTHER:
        fp = load(o['lib'], o['fp'])
        fp.SetReference(o['ref'])
        fp.SetValue(L.OTHER_VALUES[o['ref']])
        link(fp, o['lib'], o['fp'])
        fp.SetOrientationDegrees(o['rot'])
        fp.SetPosition(kp(*o['at']))
        board.Add(fp)
        for num, net in o['nets'].items():
            fp.FindPadByNumber(num).SetNet(nets[net])
    for ref, name, at in L.HOLES:
        fp = load('MountingHole', name)
        if not name.endswith('M3'):
            # module standoffs sit under their module, beside its header: drop the screw-head courtyard
            for item in list(fp.GraphicalItems()):
                if item.GetLayer() in (pcbnew.F_CrtYd, pcbnew.B_CrtYd):
                    fp.Remove(item)
        fp.SetReference(ref)
        fp.SetFPID(pcbnew.LIB_ID('MountingHole', name))
        fp.SetBoardOnly(True)
        fp.SetPosition(kp(*at))
        board.Add(fp)
    for fp in board.GetFootprints():
        fp.Reference().SetVisible(False)
        fp.Value().SetVisible(False)
    silkscreen(board)

    router = Router(board)
    for net in L.ROUTE_ORDER:
        pads = [(bx(p.GetPosition()), (0, 1) if p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH else (0,))
                for p in board.GetPads() if p.GetNetname() == net]
        router.route_net(net, pads, L.WIDTH.get(net, 0.25))
        print(f'routed {net}: {len(pads)} pads', flush=True)
    emit(board, nets, router)
    stitch(board, nets, router)

    add_zone(board, nets['GND'], pcbnew.F_Cu)
    add_zone(board, nets['GND'], pcbnew.B_Cu)
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    pcbnew.SaveBoard(OUT, board)
    print('wrote', os.path.normpath(OUT))


if __name__ == '__main__':
    main()
