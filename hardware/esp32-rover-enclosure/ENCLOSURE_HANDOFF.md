# ESP32 rover enclosure: handoff for the carrier PCB (2026-11-07)

## What's in this zip
- **ESP32TFT-ArduSimple-HalfWave-LiPo_v12.zip**: the latest printable case (v12).
  - It's for the hand-wired build: Feather, ArduSimple, XBee in its socket, bq24074, LIS3DH, S9V11F5 and the 10000 mAh LiPo.
  - Case size: 134.8 × 72.8 × 40.9 mm.
  - It holds the STLs, scripts, the parts list PDF and the clash check.
  - It does **not** fit the carrier PCB.
- **carrier_concept/**: the flat-lid concept case for the carrier PCB.
  - Built around my rev B proposal, a 134 × 53.34 mm board. This is an image concept only, not a printable version.
  - Includes the scripts plus `gerb_render.py`, a quick Gerber rasterizer.
  - `carrier_case_flat.py` imports the v12 modules (`build_esp`, `parts_esp`, `dsl`, `zrender`). Unzip v12 and point the `sys.path` line at it, then set `MANIFOLD_PY`.
- **images/**:
  - `CARRIER_CASE_FLAT*.png`: the concept.
  - `CARRIER_REVB_PROPOSAL.png`: the board layout the concept assumes.
  - `NEW_PCB_CHECK.png`: the 2026-11-06 gerbers checked against the case. Red marks a clash.

## Coordinates
All positions are in Gerber coordinates in mm.
- The board origin is the back-left corner at (100, −100).
- The front edge is at y = −153.34.
- KiCad y is the negative of Gerber y.

Heights are in mm above the outside bottom of the case.

## Fixed stack (the concept assumes these)
| Item | z (mm) |
|---|---|
| Floor | 0 to 2.4 |
| LiPo, 113 × 60 × 12 | 2.4 to 14.4 |
| Foam gap, header tails, battery lead | 14.4 to 17.9 |
| **Carrier board** | **17.9 to 19.5** |
| Free space under the ArduSimple, for low parts only | 19.5 to 29.0 |
| ArduSimple on 8.5 mm sockets + 2.5 mm male header plastic | underside about 30.5, top 32.1 |
| XBee body | 36.6 to 44.4 |
| XBee RP-SMA right-angle plug | 33.5 to 45.0 |
| Feather on 8.5 mm sockets + 8.5 mm stacking header, display up | board 39.0 to 40.6, TFT top 42.1 |
| Lid, flat (prints top-down with no supports) | underside 45.4, top 47.8 |

## Box rules
**Size**
- Inside length = left end of the board − 21 mm (room for the GNSS right-angle SMA plug), to right end of the board + 1.5 mm.
- Every mm of board length is a mm of case length.
- Inside depth is 65.6 mm, set by the battery (60 + 2 × 2.8).
- Walls are 3.6 mm thick.

**Front wall**
- The inside face of the front wall is **1.1 mm in front of the board's front edge**. That's where the Feather's USB-C face sits.
- So at the front edge, only USB-C receptacle faces may reach the edge, and they may stick out no more than about 1.1 mm.
- No plug may go in from the front edge.

**Back gap**
- The board's back edge has **about 11 mm** to the back wall.
- That gap is the place for a battery connector whose plug faces the back. The LiPo lead comes up behind the board.

**Corners**
- Each inside corner has a lid-screw block. Each leg is 9.5 mm, measured as dx + dy from the inside corner.
- Keep board parts out of that triangle wherever they rise above the battery.

## What the PCB needs for the case to fit
1. **Battery JST.**
   - Put it at the **back edge**, with the plug facing the back wall.
   - Not at the front edge: the 2026-11-06 board has it there, under the charger, and its plug faces the wall.
2. **bq24074 charger** (Adafruit 4755, 38.1 × 33.02 mm).
   - The battery and output connect through its 11-pin header: VLIPO is pin 2 and OUT is pin 4. Its BATT and SYSOUT JSTs stay empty.
   - The DC jack sticks out 3.22 mm past the board edge, so **inset the charger 3.22 mm from the front edge**. Its USB-C then sits about 2.2 mm behind the wall, and the case adds an outside recess.
   - It can't sit at the ArduSimple's height where it overlaps the ArduSimple outline (x ≤ 171.12). The 11-06 board overlaps by 1 mm.
   - In the XBee-plug zone, the charger's parts must stay **below z 33.0**. Its JST bodies are 6 mm tall.
   - Soldered low (2.5 mm header) or on 6 mm standoffs both work if nothing taller than about 2 mm (low) or about 5 mm (standoffs) sits under it.
   - The JP1 2-pin header under it can't be fitted when the charger is low.
3. **XBee RP-SMA plug keepout:** x 175.3 to 188.8, y −129.7 to −120.7, z 33.5 to 45.0.
4. **XBee body keepout:** x 141.9 to 175.1, y −137.3 to −113.0, z 36.6 to 44.4.
5. **Mount holes.**
   - Holes left of the battery (x ≤ 107) sit on floor posts.
   - Any hole over the battery (x 107.5 to 220.5) is pressed down by a post from the lid. Keep a clear column about 5 mm across from the board up to z 45.4, with no spacer.
6. **Feather.**
   - Display up, USB-C on the front edge, at the right end.
   - The TFT window and the TPU keypad over D0, D1 and D2 come through the flat lid, so keep the area above the Feather clear.
7. **Antenna bulkheads in the lid.**
   - About 10 mm across, reaching down to about z 33.
   - The helix sits over (96.7, −123.7) and the whip near the back-right, around (219, −96). Place them clear of the Feather and of tall parts.
8. **S9V11F5 regulator** (7.6 × 11.4 × 3.8 mm). It fits under the ArduSimple, with 9.5 mm of clearance there.

## The 2026-11-06 board against these rules (see NEW_PCB_CHECK.png)
**What fits**
- The ArduSimple headers and the left holes didn't change.
- The Feather's front-to-back position works.
- The charger rotation is correct. My concept had it mirrored.

**What doesn't fit**
- The battery JST at the front edge (rule 1).
- The DC jack running 2.1 mm into the front wall (rule 2).
- The charger's height conflict: on sockets it hits the XBee plug and the ArduSimple edge, and soldered low it lands on the JST and JP1.
- The board is 146.5 mm long instead of 134, so the case is about 176 mm long. Moving the LIS3DH back under the ArduSimple would recover the 12.5 mm.

**Fallback if the board can't change**
Make the box about 4.7 mm deeper and slide the stack 3.2 mm toward the back, which gives a 9 mm front gap and an 8 mm back gap. Then:
- both USB-C ports become tunnels through the front wall with TPU plugs;
- the charger sits on 6 mm M2.5 standoffs;
- JP1 is left empty;
- the case is about 176 × 77.5 × 47.8 mm.
