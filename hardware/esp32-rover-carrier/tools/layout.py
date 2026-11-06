"""ESP32 rover carrier board: module positions and the netlist.

Coordinates are millimetres with the origin at the board's front-left corner, x to the right and y towards the back
(the Feather's USB-C is on the front edge). gen_pcb.py turns them into KiCad's y-down page coordinates.

Where the positions come from:
  ArduSimple simpleRTK2B Budget: Arduino Uno R3 header pattern, checked against ArduSimple's "Arduino rails" pinout
    image (D0 = TX1, D1 = RX1, D2 = XBEE TX / GPS RX2, D8 = XBEE RX / GPS TX2, IOREF, 5V IN/OUT, GND).
  Feather ESP32-S3 Reverse TFT (5691): Adafruit's Eagle board file. It plugs in display side up, so its component
    side faces the carrier and the pattern is mirrored.
  Adafruit LIS3DH (2809) and bq24074 charger (4755): Adafruit's Eagle board files.
  Pololu S9V11F5 (2836): Pololu's dimension drawing and photos (VIN, GND, VOUT on 0.1" pitch, GND the square pad).
"""

W = 146.5  # board width
H = 53.34  # board depth: the ArduSimple's Uno outline

# Left to right: the ArduSimple, the charger, the LIS3DH and regulator, then the Feather at the far end. The XBee's
# RP-SMA overhangs the ArduSimple's right edge, over the charger, so nothing sits above the Feather's display and the
# enclosure can have a window over it.

INCH = 25.4


def row(x0, y0, dx, dy, n):
    return [(x0 + dx * i, y0 + dy * i) for i in range(n)]


# Each socket: reference, footprint, pin positions (pin 1 first), a label, the module's pin names,
# and the net on each pin (None = unused).
SOCKETS = []


def socket(ref, fp, pins, label, names, nets):
    names = names.split()
    assert len(pins) == len(nets) == len(names), ref
    SOCKETS.append(dict(ref=ref, fp=fp, pins=pins, label=label, names=names, nets=nets))


# ArduSimple, Uno R3 headers (inches from the board's front-left corner).
AS_TOP = 2.0 * INCH
AS_BOT = 0.1 * INCH
socket('J1', 'PinSocket_1x10', row(0.84 * INCH, AS_TOP, 0.1 * INCH, 0, 10), 'ArduSimple SCL..D8',
       'SCL SDA AREF GND D13/TPS D12/EXTINT D11/GEOFENCE D10 D9 D8/XBEE_RX',
       [None, None, None, 'GND', 'GPS_PPS', 'GPS_EXTINT', None, None, None, 'XB_DIN'])
socket('J2', 'PinSocket_1x08', row(1.9 * INCH, AS_TOP, 0.1 * INCH, 0, 8), 'ArduSimple D7..D0',
       'D7 D6 D5 D4 D3 D2/XBEE_TX D1/RX1 D0/TX1',
       [None, None, None, None, None, 'XB_DOUT', 'GPS_RX', 'GPS_TX'])
socket('J3', 'PinSocket_1x08', row(1.2 * INCH, AS_BOT, 0.1 * INCH, 0, 8), 'ArduSimple power',
       'NC IOREF RESET 3V3 5V_IN/OUT GND GND VIN',
       [None, '3V3', None, None, '5V', 'GND', 'GND', None])
socket('J4', 'PinSocket_1x06', row(2.1 * INCH, AS_BOT, 0.1 * INCH, 0, 6), 'ArduSimple A0..A5',
       'A0/WT A1 A2 A3 A4 A5', [None] * 6)

# bq24074 charger, turned so its USB-C (and its own JST) face the front edge; its header runs front to back on its
# right side, pin 1 (GND) at the back.
BQ = (70.1, 0.0, 33.02, 38.1)
socket('J7', 'PinSocket_1x11', row(100.58, 31.75, 0, -2.54, 11), 'bq24074',
       'GND VLIPO GND OUT ~CHG ~PGOOD ~CE ISET THERM GND VBUS',
       ['GND', 'BATT', 'GND', 'VSYS', 'CHG_N', 'PGOOD_N', 'CHG_DIS', None, None, 'GND', None])

# LIS3DH, long side front to back. The row with VIN..INT1 is on the right.
LIS = (104.0, 7.0, 17.78, 25.4)
socket('J8', 'PinSocket_1x06', row(119.24, 13.35, 0, 2.54, 6), 'LIS3DH',
       'VIN 3Vo GND SCL SDA INT1', ['VSYS', None, 'GND', 'SCL', 'SDA', 'ACC_INT'])
socket('J9', 'PinSocket_1x06', row(106.54, 26.05, 0, -2.54, 6), 'LIS3DH (support)',
       'CS SDO ADC1 ADC2 ADC3 INT2', [None, None, None, None, None, 'ACC_INT2'])

# Pololu S9V11F5 behind the charger: pins along its short edge, body behind them.
REG = (72.0, 40.0, 7.6, 11.4)
socket('J10', 'PinSocket_1x03', row(73.27, 41.27, 2.54, 0, 3), 'S9V11F5', 'VIN GND VOUT', ['VSYS', 'GND', '5V'])

# Feather at the far right, display up, USB-C at the front edge. Left row = Eagle JP1 (pin 1 = the far end), right
# row = JP3.
FX0 = 123.0
FEATHER = (FX0, 0.0, 22.86, 50.8)
socket('J5', 'PinSocket_1x16', row(FX0 + 1.27, 44.45, 0, -2.54, 16), 'Feather left',
       'TXD0 TX/GPIO39 RX/GPIO38 MISO MOSI SCK A5/GPIO8 A4/GPIO14 A3/GPIO15 A2/GPIO16 A1/GPIO17 A0/GPIO18 GND 3V 3V RST',
       [None, 'GPS_RX', 'GPS_TX', None, None, None, None, 'ACC_INT2', 'CHG_DIS', 'GPS_EXTINT', 'GPS_PPS', 'GPS_EN',
        'GND', '3V3', '3V3', None])
# Feather TX drives the ZED's RX1; Feather RX hears TX1.
socket('J6', 'PinSocket_1x12', row(FX0 + 21.59, 16.51, 0, 2.54, 12), 'Feather right',
       'BAT EN USB D13 D12 D11 D10 D9 D6 D5 SCL SDA',
       ['VSYS', 'FEATHER_EN', None, None, 'PGOOD_N', 'CHG_N', 'ACC_INT', None, 'XB_DIN', 'XB_DOUT', 'SCL', 'SDA'])

# Battery: JST PH right angle under the charger, opening at the front edge. Pin 1 = GND, pin 2 = + (as on the Feather).
OTHER = [
    dict(ref='J11', lib='Connector_JST', fp='JST_PH_S2B-PH-K_1x02_P2.00mm_Horizontal', at=(80.0, 6.5), rot=0,
         nets={'1': 'GND', '2': 'BATT'}),
    # Charger bypass: shunt fitted only when no bq24074 is plugged in.
    dict(ref='JP1', lib='Connector_PinHeader_2.54mm', fp='PinHeader_1x02_P2.54mm_Vertical', at=(94.0, 17.54), rot=0,
         nets={'1': 'BATT', '2': 'VSYS'}),
    # Ground probe beside JP1; JP1's pins are BATT and VSYS, the S9V11F5 socket carries 5V.
    dict(ref='TP1', lib='TestPoint', fp='TestPoint_Pad_D1.5mm', at=(97.0, 11.5), rot=0, nets={'1': 'GND'}),
    # Wire pad for the S9V11F5's EN (a through-hole on the module, not a header pin): Feather A0 cuts the GPS supply.
    dict(ref='TP2', lib='TestPoint', fp='TestPoint_THTPad_D2.0mm_Drill1.0mm', at=(84.0, 46.0), rot=0,
         nets={'1': 'GPS_EN'}),
    # The Feather's EN: short the two pins to switch the Feather off.
    dict(ref='J12', lib='Connector_PinHeader_2.54mm', fp='PinHeader_1x02_P2.54mm_Vertical', at=(109.0, 40.0), rot=0,
         nets={'1': 'FEATHER_EN', '2': 'GND'}),
]

OTHER_VALUES = {'J11': 'Battery JST-PH', 'JP1': 'Charger bypass: shunt only without bq24074', 'TP1': 'GND',
                'TP2': 'GPS_EN wire to S9V11F5 EN', 'J12': 'Feather off: short EN to GND'}

HOLES = [
    # Carrier to case, M3
    ('H1', 'MountingHole_3.2mm_M3', (3.5, 3.5)),
    ('H2', 'MountingHole_3.2mm_M3', (3.5, H - 3.5)),
    ('H3', 'MountingHole_3.2mm_M3', (112.9, H - 3.5)),
    ('H16', 'MountingHole_3.2mm_M3', (112.9, 3.5)),
    # bq24074 standoffs (its own corner holes), M2.5
    ('H4', 'MountingHole_2.7mm_M2.5', (72.64, 2.54)),
    ('H5', 'MountingHole_2.7mm_M2.5', (100.58, 2.54)),
    ('H6', 'MountingHole_2.7mm_M2.5', (72.64, 35.56)),
    ('H7', 'MountingHole_2.7mm_M2.5', (100.58, 35.56)),
    # LIS3DH standoffs, M2.5
    ('H8', 'MountingHole_2.7mm_M2.5', (106.54, 9.54)),
    ('H9', 'MountingHole_2.7mm_M2.5', (119.24, 9.54)),
    ('H10', 'MountingHole_2.7mm_M2.5', (106.54, 29.86)),
    ('H11', 'MountingHole_2.7mm_M2.5', (119.24, 29.86)),
    # Feather standoffs, M2
    ('H12', 'MountingHole_2.2mm_M2', (FX0 + 20.32, 2.54)),
    ('H13', 'MountingHole_2.2mm_M2', (FX0 + 2.54, 2.54)),
    ('H14', 'MountingHole_2.2mm_M2', (FX0 + 1.841, 48.26)),
    ('H15', 'MountingHole_2.2mm_M2', (FX0 + 20.955, 48.26)),
]

# Track width per net (mm); everything else 0.25.
WIDTH = {'5V': 0.6, 'VSYS': 0.6, 'BATT': 0.6, '3V3': 0.4, 'GND': 0.5}
# Power nets prefer the bottom layer, signals the top.
PREFER_BOTTOM = {'5V', 'VSYS', 'BATT', '3V3', 'GND'}
ROUTE_ORDER = ['5V', 'VSYS', 'BATT', '3V3', 'GPS_TX', 'GPS_RX', 'XB_DOUT', 'XB_DIN', 'GPS_PPS', 'GPS_EXTINT', 'SCL',
               'SDA', 'ACC_INT', 'ACC_INT2', 'CHG_N', 'PGOOD_N', 'CHG_DIS', 'GPS_EN', 'FEATHER_EN']
