import sys, os, json, numpy as np
sys.path.insert(0, os.environ["MANIFOLD_PY"])
from PIL import Image, ImageDraw, ImageFont
try:
    import build_enclosure as E
except ImportError:
    E = None
from manifold3d import Manifold

def tris(m, off=(0, 0, 0)):
    mesh = m.to_mesh(); v = np.asarray(mesh.vert_properties)[:, :3] + np.array(off)
    return v[np.asarray(mesh.tri_verts)]

def render(objs, az, el, W=900, H=700, scale=None, center=(0, 0, 28)):
    a, e = np.radians(az), np.radians(el)
    fwd = -np.array([np.cos(e) * np.cos(a), np.cos(e) * np.sin(a), np.sin(e)])   # view dir (camera looks along fwd)
    right = np.cross(fwd, [0, 0, 1]); right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    light = -fwd * 0.6 + up * 0.6 + right * 0.3; light /= np.linalg.norm(light)
    img = np.ones((H, W, 3)) * 0.97; zb = np.full((H, W), np.inf)
    allv = np.concatenate([t.reshape(-1, 3) for t, _ in objs]) - center
    if scale is None:
        ext = max(np.abs(allv @ right).max() / (W * 0.45), np.abs(allv @ up).max() / (H * 0.45)); scale = 1 / ext
    for T, col in objs:
        T = T - center
        n = np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]); n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        shade = 0.25 + 0.75 * np.abs(n @ light)
        back = (n @ fwd) > 0
        sx = (T @ right) * scale + W / 2; sy = H / 2 - (T @ up) * scale; sz = T @ fwd
        for i in range(len(T)):
            x, y, z = sx[i], sy[i], sz[i]
            x0, x1 = int(max(np.floor(x.min()), 0)), int(min(np.ceil(x.max()), W - 1))
            y0, y1 = int(max(np.floor(y.min()), 0)), int(min(np.ceil(y.max()), H - 1))
            if x1 < x0 or y1 < y0: continue
            X, Y = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
            d = (y[1] - y[2]) * (x[0] - x[2]) + (x[2] - x[1]) * (y[0] - y[2])
            if abs(d) < 1e-12: continue
            l0 = ((y[1] - y[2]) * (X - x[2]) + (x[2] - x[1]) * (Y - y[2])) / d
            l1 = ((y[2] - y[0]) * (X - x[2]) + (x[0] - x[2]) * (Y - y[2])) / d
            l2 = 1 - l0 - l1
            m = (l0 >= -1e-6) & (l1 >= -1e-6) & (l2 >= -1e-6)
            if not m.any(): continue
            Z = l0 * z[0] + l1 * z[1] + l2 * z[2]
            sub = zb[y0:y1 + 1, x0:x1 + 1]
            m &= Z < sub
            sub[m] = Z[m]
            c = np.array(col) * (shade[i] * (0.75 if back[i] else 1.0))
            img[y0:y1 + 1, x0:x1 + 1][m] = c
    # simple edge darkening from depth discontinuities
    zf = np.where(np.isinf(zb), 1e3, zb)
    edge = (np.abs(np.diff(zf, axis=0, prepend=zf[:1])) > 1.5) | (np.abs(np.diff(zf, axis=1, prepend=zf[:, :1])) > 1.5)
    img[edge] *= 0.45
    return Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8))

def stack(dz=0):
    d = json.load(open('/home/claude/solids.json')); out = []
    for s in d:
        if s['name'] == 'COMPOUND' and s['solid'] == 298 and s['lo'][2] < 0: continue
        lo, hi = np.array(s['lo']), np.array(s['hi'])
        if np.prod(hi - lo) < 0.3: continue
        lo[2] += E.ZOFF + dz; hi[2] += E.ZOFF + dz
        out.append(tris(Manifold.cube(tuple(hi - lo)).translate(tuple(lo))))
    return np.concatenate(out)

if __name__ == "__main__":
    base, lid, pl = E.build_base(), E.build_lid(), E.build_plunger()
    B, Lc, R, G = (0.36, 0.56, 0.84), (0.85, 0.64, 0.36), (0.8, 0.25, 0.2), (0.25, 0.65, 0.35)
    ST = stack()
    views = [
        ("Exploded (lid raised 30 mm)", [(tris(base.m), B), (ST, G), (tris(lid.m, (0, 0, 30)), Lc), (tris(pl.m, (0, 0, 30)), R)], -60, 25),
        ("Front: Pi micro-USB / mini-HDMI windows", [(tris(base.m), B), (ST, G), (tris(lid.m), Lc), (tris(pl.m), R)], -90, 12),
        ("Left: microSD, USB-C, JST-GH, SMA", [(tris(base.m), B), (ST, G), (tris(lid.m), Lc), (tris(pl.m), R)], 180, 12),
        ("Right: USB-C", [(tris(base.m), B), (ST, G), (tris(lid.m), Lc), (tris(pl.m), R)], 0, 12),
        ("Top: button, slide-switch well, LED holes, Qwiic slot", [(tris(base.m), B), (tris(lid.m), Lc), (tris(pl.m), R)], -90, 89.9),
        ("Lid underside", [(tris(lid.m.rotate((180, 0, 0)).translate((0, 0, 60))), Lc), (tris(pl.m.rotate((180, 0, 0)).translate((0, 0, 60))), R)], -60, 35),
    ]
    tiles = []
    font = ImageFont.load_default(size=22) if hasattr(ImageFont, "load_default") else None
    for title, objs, az, el in views:
        im = render(objs, az, el, 800, 600, center=(0, 0, 30) if "Lid underside" not in title else (0, 0, 2))
        ImageDraw.Draw(im).text((14, 10), title, fill=(30, 30, 30), font=font)
        tiles.append(im)
    sheet = Image.new("RGB", (1600, 1800), "white")
    for i, t in enumerate(tiles): sheet.paste(t, ((i % 2) * 800, (i // 2) * 600))
    sheet.save("out/preview_sheet.png")
