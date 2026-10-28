# 02: Hardware

## 1. Board facts that shape the design

**Seeed XIAO ESP32-C3**

- **Chip.** ESP32-C3: a single-core 160 MHz RISC-V CPU with **no floating-point unit**, about 400 KB SRAM and 4 MB flash.
- **Radio.** 2.4 GHz WiFi b/g/n and BLE 5.
- **Antenna.** The board uses the **external U.FL antenna** that comes with it. It must be connected; without it, WiFi range is close to zero.
- **USB.** USB-C goes to the chip's built-in USB-Serial/JTAG, so no extra USB chip is needed for flashing or logs.
- **Buttons.** There are BOOT (GPIO9) and RESET buttons.
- **No user LED.** All status indication has to use the strip itself ([03 §13](03-firmware.md#13-button-and-status-patterns)).
- **No capacitive touch.** The ESP32-C3 has no touch peripheral. A touch control needs an external module such as a TTP223.

## 2. Pin map

| XIAO pin | GPIO | Use | Notes |
|---|---|---|---|
| **D5** | **GPIO7** | **LED data out** → level shifter | Not a strapping pin. Add a 10 kΩ pull-down so the line stays low while the chip boots. |
| BOOT | GPIO9 | Built-in button: toggle, setup, reset | Strapping pin. Holding it during reset enters download mode, but it reads as a normal input once the app is running. |
| D1 | GPIO3 | Optional external button or TTP223 touch module | Active-low, internal pull-up |
| 5V | n/a | Power in from the PSU | Through a Schottky diode (§4) |
| GND | n/a | Common ground | Mandatory |

Don't use GPIO2, GPIO8 or GPIO9 as outputs, because they are strapping pins. GPIO18/19 carry USB.

## 3. Strip variants

All of these share the same 3-wire interface and firmware. They differ in `pixel_count`, `color_order`, `channels` and wiring.

| Variant | Typical IC | Supply | One addressable pixel is | Usual order | Notes |
|---|---|---|---|---|---|
| 5 V FCOB | WS2812B / SK6812 | 5 V | one IC per small LED group | GRB | High current. Voltage drops along the strip, so feed power at both ends past ~1 m. |
| 12 V COB | WS2811 | 12 V | one IC per segment of several LEDs | RGB / BRG | The pixel count is the IC count from the listing (e.g. "xx IC/m"), not the LED count. |
| 24 V COB | WS2811 | 24 V | one IC per (longer) segment | RGB / BRG | Lowest current. Best for long runs. |
| RGBW COB | SK6812 RGBW | 5 / 12 V | one IC | GRBW | Set `channels: 4` |

> If the three wires are labeled V+, WW and CW (or similar) instead of V+, DIN and GND, the strip is CCT white rather than addressable. In that case, see assumption A1 in the [README](README.md).

The device UI has test patterns to find `color_order` and confirm `pixel_count` (§7).

## 4. Wiring

### Why a level shifter

The C3 outputs 3.3 V logic. WS281x inputs need about 0.7 × VDD, which is about 3.5 V on a 5 V IC, so a bare GPIO is out of spec and fails unpredictably, especially with longer wires. A **74AHCT125** (or the single-gate **SN74AHCT1G125**) powered from 5 V accepts 3.3 V input (V<sub>IH</sub> = 2.0 V) and outputs a clean 5 V signal. The "HCT" family also works. Plain "HC" parts do **not**.

### 5 V strip

```
PSU +5V ──[fuse]──┬─────────────────────────────────┬───────────► strip V+
                  │                                 │
                  ├──►|──────► XIAO 5V            ══╪══ 1000 µF (≥ 6.3 V)
                  │  SS14 (Schottky)                │
                  └────────► 74AHCT125 VCC (14) ─┬─ 100 nF ─┐
                                                 │          │
PSU GND ──────────┬───────────┬──────────────────┴──────────┴───► strip GND
                  │           │
              XIAO GND    74AHCT125 GND (7), 1OE (1), unused inputs

XIAO D5 / GPIO7 ──┬──► 74AHCT125 1A (2)   1Y (3) ─────────[330 Ω]──► strip DIN
                  │                                 (resistor at the strip end)
                10 kΩ
                  │
                 GND
```

### 12 V / 24 V strip

```
PSU +12/24V ──[fuse]──┬────────────────────────────────► strip V+   (1000 µF across, rated ≥ 1.5 × supply)
                      └──► buck converter → 5 V ──┬──►|── XIAO 5V
                                                  └───── 74AHCT125 VCC
PSU GND ── common ground: buck, XIAO, shifter, strip
Data path: identical to the 5 V diagram
```

### Connection list

| From | To | Why |
|---|---|---|
| PSU + (through fuse) | Strip V+ | Strip power never flows through the XIAO |
| PSU 5 V (or buck output) | XIAO 5V pin, through an SS14/1N5819 | The diode stops the PSU and the USB port from feeding into each other when both are connected during development |
| PSU − | XIAO GND, shifter GND, strip GND | The data signal needs a common reference |
| D5 / GPIO7 | 74AHCT125 1A | 10 kΩ to GND prevents random flashes while the chip boots |
| 74AHCT125 1Y | Strip DIN | 330 Ω series resistor near the strip damps reflections. Keep this wire under ~1 m. |
| 74AHCT125 1OE | GND | Enables the output (active low) |
| Unused 2A/3A/4A | GND | Avoids floating CMOS inputs |
| 1000 µF capacitor | Strip V+ / GND at the input | Absorbs inrush and current spikes |

## 5. Power

**Sizing.** Full-white current is roughly (W/m × length) ÷ volts. Pick a PSU with at least 20 % headroom, or set the firmware limit below the PSU rating.

| Example | Full white | PSU | `max_current_ma` |
|---|---|---|---|
| 5 V strip, 10 W/m × 1.5 m | 15 W → 3.0 A | 5 V 4 A | 3200 |
| 24 V strip, 10 W/m × 2 m | 20 W → 0.83 A | 24 V 1.5 A | 1200 |

**Firmware current limiter.** This is the automatic brightness limiter ([03 §5](03-firmware.md#5-led-output-pipeline)). The firmware estimates current every frame and scales brightness down to stay under `max_current_ma`. The setup wizard asks which supply is used:

| Choice | Limit |
|---|---|
| "USB only" | 500 mA (safe default) |
| "5 V 2 A" | 1600 mA |
| "5 V 4 A" | 3200 mA |
| Custom | entered value |

To calibrate, measure the current at 25 % full white, multiply by 4, divide by the pixel count, and enter the result as `ma_per_pixel_white` (default 60 mA, typical of WS2812B-class pixels).

**Wiring.**
- Fuse the PSU output below the ampacity of the wire.
- For 5 V strips over 1 m at high brightness, feed power at both ends. Without this, the far end turns orange or red.
- Don't power the strip from the XIAO's 5V pin while on USB, except for a few pixels during bring-up.

**Brownouts.** Strip inrush on a weak supply can brown out the C3. The firmware keeps the brownout detector on and fades the strip in at boot rather than switching it straight on.

## 6. Bill of materials (per lamp)

| Qty | Part | Notes |
|---|---|---|
| 1 | Seeed XIAO ESP32-C3 + its U.FL antenna | Mount the antenna away from metal and strip power wires |
| 1 | 3-wire addressable COB strip | See §3 |
| 1 | SN74AHCT125N (DIP-14) or SN74AHCT1G125 (SOT-23-5) | Level-shifter breakouts based on these chips also work |
| 1 | 330 Ω resistor | Data line, at the strip end |
| 1 | 10 kΩ resistor | Pull-down on GPIO7 |
| 1 | 1000 µF electrolytic capacitor | Voltage rating ≥ 1.5 × strip supply |
| 1 | 100 nF ceramic capacitor | Decoupling for the shifter |
| 1 | SS14 or 1N5819 Schottky diode | 5 V into the XIAO |
| 1 | PSU at the strip voltage | Sized per §5 |
| 1 | Buck converter to 5 V (≥ 1 A) | 12 V / 24 V strips only |
| 1 | Inline fuse + holder, DC jack | |
| 0–1 | Tactile button or TTP223 module | Optional external input on D1 |
| 1 | Aluminum channel + diffuser, enclosure | Helps cooling and gives the smooth COB look |

## 7. Bring-up checklist

1. **Board only.** Flash the firmware over USB with no strip connected. Confirm serial logs, and that the setup AP appears.
2. **Data line.** With the shifter wired, check D5 idles low and 1Y swings 0 → 5 V. A multimeter or logic probe is enough.
3. **First light.** Connect the strip with the limit set to "USB only", or use a current-limited bench supply. Run the **color order** test, which lights the first pixel red, then green, then blue, and pick the matching order.
4. **Pixel count.** The **last pixel** test lights only pixel *n−1*. Adjust `pixel_count` until it lands on the final segment.
5. **Calibrate.** Measure current at 25 % white and set `ma_per_pixel_white` (§5).
6. **Glitch test.** Run `rainbow` at full frame rate while the phone streams a large download through the same AP. There should be no sparkles or wrong colors down the strip.
7. **Boot test.** Power-cycle 20 times. The strip must not flash at power-on, and the restored state must fade in within about 0.5 s.
8. **Heat.** Run 30 minutes at the configured limit and check that the strip, PSU and wiring are warm at most, never hot.
