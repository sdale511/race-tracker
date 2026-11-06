"""Build esp32-rover-carrier.kicad_sch from layout.py: one connector symbol per socket, every pin named and labelled.

Plain Python 3 (no KiCad module needed):  python3 tools/gen_sch.py
Symbol UUIDs are derived from the reference, so gen_pcb.py can link each footprint to its symbol.
"""
import os
import re
import sys
import uuid

sys.path.insert(0, os.path.dirname(__file__))
import layout as L  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'esp32-rover-carrier.kicad_sch')
SYMLIB = os.path.expanduser('~/Applications/KiCad/KiCad.app/Contents/SharedSupport/symbols/')
PROJECT = 'esp32-rover-carrier'
NS = uuid.UUID('6d1c9f0e-2b7a-4f43-9a51-7e2f0c3b8a11')
ROOT = str(uuid.uuid5(NS, 'root'))


def g(v):
    """Snap to the 2.54 mm schematic grid."""
    return round(v / 2.54) * 2.54


def uid(*parts):
    return str(uuid.uuid5(NS, '/'.join(parts)))


def symbol_uuid(ref):
    return uid('symbol', ref)


def lib_symbol(lib, name):
    text = open(SYMLIB + lib + '.kicad_sym').read()
    i = text.index(f'(symbol "{name}"')
    depth = 0
    for k in range(i, len(text)):
        if text[k] == '(':
            depth += 1
        elif text[k] == ')':
            depth -= 1
            if depth == 0:
                break
    block = text[i:k + 1]
    pins = [(float(x), float(y)) for x, y in re.findall(r'\(pin \w+ \w+\s*\(at (-?[\d.]+) (-?[\d.]+)', block)]
    return block.replace(f'(symbol "{name}"', f'(symbol "{lib}:{name}"', 1), pins


def q(s):
    return '"' + s.replace('"', '\\"') + '"'


def font(size=1.27, justify=None, hide=False):
    j = f' (justify {justify})' if justify else ''
    h = ' (hide yes)' if hide else ''
    return f'(effects (font (size {size} {size})){j}{h})'


class Sheet:
    def __init__(self):
        self.libs = {}
        self.items = []

    def use(self, lib, name):
        key = f'{lib}:{name}'
        if key not in self.libs:
            self.libs[key] = lib_symbol(lib, name)
        return key, self.libs[key][1]

    def text(self, s, x, y, size=1.27, justify='left'):
        self.items.append(f'(text {q(s)} (exclude_from_sim no) (at {x:.2f} {y:.2f} 0) {font(size, justify)} '
                          f'(uuid {q(uid("text", s, str(x), str(y)))}))')

    def label(self, net, x, y):
        # global labels, so the nets keep their bare names (GND, not /GND) and match the board
        self.items.append(f'(global_label {q(net)} (shape passive) (at {x:.2f} {y:.2f} 180) {font(1.27, "right")} '
                          f'(uuid {q(uid("label", net, str(x), str(y)))}))')

    def no_connect(self, x, y):
        self.items.append(f'(no_connect (at {x:.2f} {y:.2f}) (uuid {q(uid("nc", str(x), str(y)))}))')

    def symbol(self, lib, name, ref, value, footprint, x, y, nets, names=None, in_bom=True):
        key, pins = self.use(lib, name)
        su = symbol_uuid(ref)
        props = [
            f'(property "Reference" {q(ref)} (at {x:.2f} {y - (len(pins) / 2 + 1.5) * 2.54:.2f} 0) {font()})',
            f'(property "Value" {q(value)} (at {x:.2f} {y + (len(pins) / 2 + 1.5) * 2.54:.2f} 0) {font()})',
            f'(property "Footprint" {q(footprint)} (at {x:.2f} {y:.2f} 0) {font(hide=True)})',
            f'(property "Datasheet" "" (at {x:.2f} {y:.2f} 0) {font(hide=True)})',
        ]
        pin_uuids = ' '.join(f'(pin {q(str(i + 1))} (uuid {q(uid("pin", ref, str(i + 1)))}))' for i in range(len(pins)))
        self.items.append(
            f'(symbol (lib_id {q(key)}) (at {x:.2f} {y:.2f} 0) (unit 1) (exclude_from_sim no) '
            f'(in_bom {"yes" if in_bom else "no"}) '
            f'(on_board yes) (dnp no) (uuid {q(su)}) {" ".join(props)} {pin_uuids} '
            f'(instances (project {q(PROJECT)} (path {q("/" + ROOT)} (reference {q(ref)}) (unit 1)))))')
        for i, (px, py) in enumerate(pins):
            cx, cy = x + px, y - py
            net = nets[i] if i < len(nets) else None
            if net:
                self.label(net, cx, cy)
            else:
                self.no_connect(cx, cy)
            if names:
                self.text(names[i], x + 2.54, cy, 1.0)

    def write(self, path):
        libs = '\n'.join(block for block, _ in self.libs.values())
        body = '\n'.join(self.items)
        tb = ('(title_block (title "ESP32 rover carrier") (rev "B") (company "race-tracker") '
              '(comment 1 "Feather S3 Reverse TFT, ArduSimple Budget, LIS3DH, S9V11F5, optional bq24074"))')
        with open(path, 'w') as f:
            f.write(f'(kicad_sch (version 20250114) (generator "gen_sch.py") (generator_version "10.0") '
                    f'(uuid {q(ROOT)}) (paper "A3") {tb}\n(lib_symbols\n{libs}\n)\n{body}\n'
                    f'(sheet_instances (path "/" (page "1")))\n(embedded_fonts no)\n)\n')


def main():
    sh = Sheet()
    # columns of sockets; positions are on the 1.27 mm schematic grid
    cols = {
        'J1': (60, 50), 'J2': (60, 100), 'J3': (60, 140), 'J4': (60, 185),
        'J5': (150, 70), 'J6': (150, 140),
        'J7': (240, 60), 'J8': (240, 120), 'J9': (240, 160), 'J10': (240, 195),
    }
    for s in L.SOCKETS:
        n = len(s['pins'])
        x, y = cols[s['ref']]
        sh.symbol('Connector_Generic', f'Conn_01x{n:02d}', s['ref'], s['label'],
                  f"Connector_PinSocket_2.54mm:{s['fp']}_P2.54mm_Vertical", g(x), g(y), s['nets'], s['names'])
    other_pos = {'J11': (320, 60), 'JP1': (320, 100), 'TP1': (320, 140), 'TP2': (320, 165), 'J12': (320, 190)}
    names = {'J11': ['-', '+'], 'JP1': ['BATT', 'VSYS'], 'J12': ['EN', 'GND']}
    values = L.OTHER_VALUES
    for o in L.OTHER:
        x, y = other_pos[o['ref']]
        if o['ref'].startswith('TP'):
            lib, name = 'Connector', 'TestPoint'
        else:
            lib, name = 'Connector_Generic', 'Conn_01x02'
        nets = [o['nets'][str(i + 1)] for i in range(len(o['nets']))]
        sh.symbol(lib, name, o['ref'], values[o['ref']], f"{o['lib']}:{o['fp']}", g(x), g(y), nets,
                  names.get(o['ref']), in_bom=not o['ref'].startswith('TP'))
    notes = [
        'Plug-in carrier: every module sits on sockets. Nets join by label name.',
        'ArduSimple: male headers soldered underneath; power switch DOWN (5V IN, IOREF N/C); --role rover (UART2 off).',
        'Feather on 8.5 mm stacking headers (housings on the display side), tails into J5/J6; display up, USB-C at the front. LIS3DH runs from VSYS (its own 3.3 V regulator).',
        'bq24074 optional: fitted -> JP1 open, battery feeds the charger, charger OUT feeds VSYS.',
        'No bq24074 -> fit the JP1 shunt (BATT to VSYS). Never both: the shunt would bypass the charger.',
        '~CHG and ~PGOOD are open drain to Feather D11 / D12 (read with INPUT_PULLUP); the firmware does not use them yet.',
        'Optional, unused by the firmware so far: TIMEPULSE -> A1, EXTINT <- A2, bq ~CE <- A3 (high stops charging; '
        '10k pull-down on the bq), LIS3DH INT2 -> A4.',
        'GPS_EN: Feather A0 to pad TP2; wire TP2 to the S9V11F5 EN hole. Build with -DGPS_POWER_PIN=18 to cut the GPS '
        'and XBee in deep sleep.',
        'J12: short EN to GND to switch the Feather off (the regulator and ArduSimple stay on battery power).',
    ]
    for k, t in enumerate(notes):
        sh.text(t, g(30), g(240 + k * 5), 1.5)
    sh.write(OUT)
    print('wrote', os.path.normpath(OUT))


if __name__ == '__main__':
    main()
