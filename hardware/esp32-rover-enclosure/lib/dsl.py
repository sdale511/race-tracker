"""Tiny dual Manifold/OpenSCAD geometry DSL shared by the enclosure generators."""
import sys, os, struct, numpy as np
sys.path.insert(0, os.environ.get("MANIFOLD_PY", ""))
import manifold3d
from manifold3d import Manifold

# ------------------------------------------------ dual Manifold/OpenSCAD DSL
def fn(r): return int(max(24, min(96, round(r * 16))))
class S:
    def __init__(s, m, scad): s.m, s.scad = m, scad
    def __add__(a, b): return S(a.m + b.m, f"union(){{\n{a.scad}\n{b.scad}\n}}")
    def __sub__(a, b): return S(a.m - b.m, f"difference(){{\n{a.scad}\n{b.scad}\n}}")
    def __xor__(a, b): return S(a.m ^ b.m, f"intersection(){{\n{a.scad}\n{b.scad}\n}}")
def U(*xs):
    xs = [x for x in xs if x is not None]
    if len(xs) == 1: return xs[0]
    return S(Manifold.batch_boolean([x.m for x in xs], manifold3d.OpType.Add), "union(){\n" + "\n".join(x.scad for x in xs) + "\n}")
def box(x0, x1, y0, y1, z0, z1):
    return S(Manifold.cube((x1 - x0, y1 - y0, z1 - z0)).translate((x0, y0, z0)),
             f"translate([{x0:.3f},{y0:.3f},{z0:.3f}]) cube([{x1-x0:.3f},{y1-y0:.3f},{z1-z0:.3f}]);")
def cyl(cx, cy, z0, z1, r, r2=None):
    r2 = r if r2 is None else r2; n = fn(max(r, r2))
    return S(Manifold.cylinder(z1 - z0, r, r2, n).translate((cx, cy, z0)),
             f"translate([{cx:.3f},{cy:.3f},{z0:.3f}]) cylinder(r1={r:.3f},r2={r2:.3f},h={z1-z0:.3f},$fn={n});")
def cylx(y, z, x0, x1, r):
    n = fn(r)
    return S(Manifold.cylinder(x1 - x0, r, r, n).rotate((0, 90, 0)).translate((x0, y, z)),
             f"translate([{x0:.3f},{y:.3f},{z:.3f}]) rotate([0,90,0]) cylinder(r={r:.3f},h={x1-x0:.3f},$fn={n});")
def cyly(x, z, y0, y1, r):
    n = fn(r)
    return S(Manifold.cylinder(y1 - y0, r, r, n).rotate((-90, 0, 0)).translate((x, y0, z)),
             f"translate([{x:.3f},{y0:.3f},{z:.3f}]) rotate([-90,0,0]) cylinder(r={r:.3f},h={y1-y0:.3f},$fn={n});")
def hull(*xs):
    return S(Manifold.batch_hull([x.m for x in xs]), "hull(){\n" + "\n".join(x.scad for x in xs) + "\n}")
def rrect_z(x0, x1, y0, y1, r, z0, z1):
    return hull(*[cyl(x, y, z0, z1, r) for x in (x0 + r, x1 - r) for y in (y0 + r, y1 - r)])
def port_x(y, z, w, h, r, x0, x1, up_to=None):
    r = min(r, w / 2, h / 2)
    c = hull(*[cylx(y + sy * (w / 2 - r), z + sz * (h / 2 - r), x0, x1, r) for sy in (-1, 1) for sz in (-1, 1)])
    if up_to is not None:
        c = (c ^ box(x0 - 1, x1 + 1, y - w, y + w, z - h, up_to)) + box(x0, x1, y - w / 2, y + w / 2, z, up_to + 0.01)
    return c
def port_y(x, z, w, h, r, y0, y1):
    r = min(r, w / 2, h / 2)
    return hull(*[cyly(x + sx * (w / 2 - r), z + sz * (h / 2 - r), y0, y1, r) for sx in (-1, 1) for sz in (-1, 1)])
def write_stl(m, path):
    mesh = m.to_mesh(); v = np.asarray(mesh.vert_properties)[:, :3].astype(np.float32)
    t = np.asarray(mesh.tri_verts); tri = v[t]
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]); n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    rec = np.zeros(len(t), dtype=[("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]); rec["n"], rec["v"] = n, tri
    with open(path, "wb") as f:
        f.write(b"Pi 3A+ / ArduSimple sealed enclosure".ljust(80, b" ")); f.write(struct.pack("<I", len(t))); f.write(rec.tobytes())


# ---- 2D outlines (union of rectangles), offset and extruded --------------------------
from manifold3d import CrossSection, JoinType
def outline(rects, off, z0, z1, segs=48):
    """rects: [(x0,x1,y0,y1)], unioned, offset by `off` (round joins), extruded z0..z1."""
    def one(r):
        if len(r) == 4 and not hasattr(r[0], "__len__"):
            x0, x1, y0, y1 = r; return CrossSection.square((x1 - x0, y1 - y0)).translate((x0, y0))
        return CrossSection([[tuple(map(float, pt)) for pt in r]])
    cs = CrossSection.batch_boolean([one(r) for r in rects], manifold3d.OpType.Add)
    if abs(off) > 1e-9:
        cs = cs.offset(off, JoinType.Round, 2.0, segs)
    def sc(r):
        if len(r) == 4 and not hasattr(r[0], "__len__"):
            x0, x1, y0, y1 = r; return f"translate([{x0:.3f},{y0:.3f}]) square([{x1-x0:.3f},{y1-y0:.3f}]);"
        return "polygon(points=[" + ",".join(f"[{x:.3f},{y:.3f}]" for x, y in r) + "]);"
    sq = "\n".join(sc(r) for r in rects)
    scad = f"translate([0,0,{z0:.3f}]) linear_extrude({z1-z0:.3f}) offset(r={off:.3f},$fn={segs}) union(){{\n{sq}\n}}" if abs(off) > 1e-9 \
        else f"translate([0,0,{z0:.3f}]) linear_extrude({z1-z0:.3f}) union(){{\n{sq}\n}}"
    return S(Manifold.extrude(cs, z1 - z0).translate((0, 0, z0)), scad)

def outline_ring(rects, off_out, off_in, z0, z1):
    return outline(rects, off_out, z0, z1) - outline(rects, off_in, z0 - 1, z1 + 1)
