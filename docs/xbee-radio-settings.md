# XBee radio settings: original ArduSimple LR radio vs. this project's presets

What the stock ArduSimple "LR" correction radio was set to when we read it, next to what
`xbee_configure_at.py` would set on an XBee-PRO 900HP (S3B) for each way we might use it.

The LR radio is a Digi **XBee SX** (Model XBSX); the telemetry radios are **XBee-PRO 900HP (S3B)
200K** (max RF payload `NP` = 100 bytes). They are different radio families on the same 902-928 MHz
band: an SX and a 900HP cannot talk to each other, so swapping the correction link to 900HPs means
replacing the radio on **both** ends (base and every rover).

## The settings side by side

| Parameter | What it controls | Original LR radio (XBee SX, read 2026-10-08) | Telemetry radio (S3B, `--role telemetry`) | RTK-base radio on a shared network (S3B, see below) | Separate RTCM network (S3B, `--role rtcm`) |
|---|---|---|---|---|---|
| `TO` Transmit Options | Delivery method | `0x40` point-to-multipoint | `0x40` point-to-multipoint | `0x40` | `0x40` |
| `ID` Network ID | Radios only talk if this matches | `0x1985` | `0x7FFF` | `0x7FFF` (same as every node) | `0x1985` |
| `HP` Preamble ID | Second filter; must also match | `0` | `0` | `0` (same as every node) | `1` |
| `DH` / `DL` Destination | `0` / `0xFFFF` = broadcast to all | `0` / `0xFFFF` | `0` / `0xFFFF` | `0` / `0xFFFF` | `0` / `0xFFFF` |
| `MT` Broadcast multi-transmits | Extra repeats of each broadcast (sent MT+1 times) | **`1`** | `0` | `1` | `1` |
| `CE` Node messaging options | Routing / relay | `0` | `2` (routing off, single hop) | `2` | `2` |
| `D7` CTS flow control | `1` = radio drives CTS; `0` = off | `1` | `1` (`--flow-control cts`) | `0` (`--flow-control none`) | `0` |
| `D6` RTS flow control | `1` = radio waits for the host's RTS | `0` | `0` | `0` | `0` |
| `BD` Baud rate | Serial speed to the host | `0x7` = 115200 | `0x7` = 115200 | `0x7` = 115200 | `0x7` = 115200 |

Differences from the original LR radio that matter:

- **`MT`**: the LR repeats each broadcast once; the telemetry preset does not. Corrections have no
  acknowledgements, so the RTK-base radio keeps `MT=1`.
- **`ID` / `HP`**: the LR pair is on network `0x1985`. In the shared-radio design every node must use
  the **same** `ID` and `HP`; in a two-radios-per-yacht design the correction radio gets its own
  `ID` and `HP`, so the yacht's two radios never form one network.
- **`CE`**: the LR leaves routing on (`0`); the S3B presets turn it off, since everything is single-hop.
- **Flow control**: the ArduSimple board's UART2 does not use hardware flow control, so a radio that
  plugs into it should have `D7=0`, `D6=0`.

## How each column is produced

| Column | Command |
|---|---|
| Original LR radio | `python3 xbee_configure_at.py --port <port> --dry-run` (read only - do **not** run it for real on an LR radio) |
| Telemetry radio (rovers and the telemetry base) | `python3 xbee_configure_at.py --port <port>` |
| RTK-base radio on a shared network | `python3 xbee_configure_at.py --port <port> --role telemetry --mt 1 --flow-control none` |
| Separate RTCM network | `python3 xbee_configure_at.py --port <port> --role rtcm` |

## Not captured here

The script reads only the settings above. These were not recorded for the LR radio, and are worth
reading with XCTU before it is taken out of service: `BR` (RF data rate), `PL` (transmit power),
`CM` (channel mask), `RO` (packetization timeout), `RR` (retries), and the firmware version.
`CM` in particular is not touched by the script, so two 900HP networks on one yacht still hop
across the same frequencies.

## Raw output (dry run of the original LR radio, 2026-10-08)

The "target" column here is the telemetry preset, so the "WILL CHANGE" flags are differences from the
LR radio's own settings, not changes that were made.

```
  TO (Transmit Options)        current=0x40 (Point-to-Multipoint) target=0x40 (Point-to-Multipoint)
  ID (Network ID)              current=0x1985                     target=0x7FFF                     *** WILL CHANGE ***
  DH (Dest high)               current=0x0                        target=0x0
  DL (Dest low)                current=0xFFFF                     target=0xFFFF
  HP (Preamble ID)             current=0x0                        target=0x0
  MT (Broadcast Multi-Tx)      current=0x1                        target=0x0                        *** WILL CHANGE ***
  CE (Node Msg Options)        current=0x0                        target=0x2                        *** WILL CHANGE ***
  D7 (CTS flow control)        current=0x1 (flow control)         target=0x1 (flow control)
  D6 (RTS flow control)        current=0x0 (disabled)             target=0x0 (disabled)
  BD (Baud rate)               current=0x7 (115200 baud)          target=0x7 (115200 baud)
```
