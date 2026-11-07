"""STEP -> per-solid axis-aligned boxes [{name, solid, lo, hi}], the format of the v12 case's solids.json."""
import sys, json
from OCP.STEPControl import STEPControl_Reader
from OCP.TopAbs import TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
r = STEPControl_Reader()
assert r.ReadFile(sys.argv[1]) == 1
r.TransferRoots()
shp = r.OneShape()
tr = r.WS().TransferReader()
out = []; ex = TopExp_Explorer(shp, TopAbs_SOLID); n = 0
while ex.More():
    s = ex.Current(); n += 1
    nm = "?"
    try:
        ent = tr.EntityFromShapeResult(s, 1)
        if ent is not None and hasattr(ent, "Name") and ent.Name() is not None: nm = ent.Name().ToCString()
    except Exception: pass
    b = Bnd_Box(); BRepBndLib.Add_s(s, b, False)
    p0, p1 = b.CornerMin(), b.CornerMax(); x0, y0, z0, x1, y1, z1 = p0.X(), p0.Y(), p0.Z(), p1.X(), p1.Y(), p1.Z()
    out.append(dict(name=nm, solid=n, lo=[x0, y0, z0], hi=[x1, y1, z1])); ex.Next()
json.dump(out, open(sys.argv[2], "w"))
print(len(out), "solids")
