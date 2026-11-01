# 02: Hardware

The hardware is settled: a 12 V WS2811 COB strip, a 74AHCT125 level shifter, and a 12 V → 5 V buck converter, all fed from one 12 V supply.

## 1. Board facts that shape the design

**Seeed XIAO ESP32-C3**

- **Chip.** ESP32-C3: a single-core 160 MHz RISC-V CPU with **no floating-point unit**, about 400 KB SRAM and 4 MB flash.
- **Radio.** 2.4 GHz WiFi b/g/n and BLE 5.
- **Antenna.** The board uses the **external U.FL antenna** that comes with it. It must be connected; without it, WiFi range is close to zero.
- **USB.** USB-C goes to the chip's built-in USB-Serial/JTAG, so no extra USB chip is needed for flashing or logs.
- **Buttons.** There are BOOT (GPIO9) and RESET buttons.
- **No user LED.** All status indication has to use the strip itself ([03 §14](03-firmware.md#14-button-and-status-patterns)).
- **No capacitive touch.** The ESP32-C3 has no touch peripheral. A touch control needs an external module such as a TTP223.

## 2. Pin map

| XIAO pin | GPIO | Use | Notes |
|---|---|---|---|
| **D5** | **GPIO7** | **LED data out** → level shifter | Not a strapping pin. Add a 10 kΩ pull-down so the line stays low while the chip boots. |
| BOOT | GPIO9 | Built-in button: toggle, setup, reset | Strapping pin. Holding it during reset enters download mode, but it reads as a normal input once the app is running. |
| D1 | GPIO3 | Optional external button or TTP223 touch module | Active-low, internal pull-up |
| 5V | n/a | Power in from the buck converter | Through a Schottky diode (§4) |
| GND | n/a | Common ground | Mandatory |

Don't use GPIO2, GPIO8 or GPIO9 as outputs, because they are strapping pins. GPIO18/19 carry USB.

## 3. The strip

**BTF-LIGHTING FCOB WS2811, 12 V, RGB, 576 LEDs/m** ([product page](https://www.btf-lighting.com/products/fcob-rgb-ws2811-led-strip-576led)). It has three wires: +12 V, DIN and GND.

| Spec | Value | Consequence |
|---|---|---|
| Supply | 12 V DC | The strip runs straight off the 12 V PSU. Only the XIAO and the shifter use the buck's 5 V. |
| Driver IC | WS2811, single data line | Same 800 kHz protocol family as WS2812, so it uses the SPI-DMA backend ([03 §5](03-firmware.md#5-led-output-pipeline)) |
| Addressable pixels | **16 per meter**: one IC drives a 62.5 mm segment of 36 LEDs | `pixel_count = 16 × length in m`. A full 5 m reel is 80 pixels. |
| Cut points | Every 62.5 mm | Cut only on the marked copper pads |
| Power | Max 8 W/m at 12 V, about 0.67 A/m | Sizing in §5 |
| Width | 10 mm PCB | Fits 10 mm aluminum channels |
| Color order | Not published | Found with the color-order test pattern (§7). The firmware default is `RGB`. Many WS2811 strips are `BRG` or `GRB`. |

**This build: 10 segments per lamp.** Each lamp gets about 24 in of strip, cut at the 10th mark: **625 mm (24.6 in), 10 pixels**. Cutting at the 9th mark instead gives 562.5 mm (22.1 in) and 9 pixels. Both lamps together use 1.25 m, so the smallest (3 m) reel covers them with spare.

**What 10 pixels per lamp means.**
- Each pixel is a 62.5 mm segment of 36 LEDs that all show the same color. Behind a diffuser the light looks continuous, but anything that varies along the strip shows as up to 10 bands.
- Effects that change the whole lamp at once look best: `solid`, `breathe`, `cycle`, `candle` and `sunrise`.
- `gradient` and `rainbow` show as 10 soft bands. A lower `intensity` (hue span) makes `rainbow` gentler.
- `twinkle` lights whole segments, so keep its density low.
- Effects use normalized position ([03 §6](03-firmware.md#6-effects)), so both lamps look the same as long as they have the same pixel count.
- Frame rate is no constraint. 10 pixels take well under 1 ms to send, so the lamp runs at 100 fps.

**Other strips.** The firmware can still drive 5 V WS2812B/SK6812 and RGBW strips through `LedConfig`. Only the wiring and config would change, but those strips are no longer in scope for these docs.

## 4. Wiring

### Level shifter

The C3 outputs 3.3 V logic. A WS2811 expects a "high" of at least 0.7 × its own logic supply, which is about 5 V or a little more on a 12 V strip. A bare GPIO is therefore out of spec and fails unpredictably, especially with longer wires.

A **74AHCT125** (or the single-gate **SN74AHCT1G125**) powered from 5 V accepts 3.3 V input (V<sub>IH</sub> = 2.0 V) and outputs a clean 5 V signal. The "HCT" family also works. Plain "HC" parts do **not**.

> **Check which level shifter you have.** The cheap 4-channel "bidirectional logic level converter" boards (a BSS138 MOSFET with 10 kΩ pull-ups per channel) have slow rising edges. They are often marginal at the WS2811's 800 kHz rate, and a common cause of flicker and wrong colors. One may work on a short wire. If you use one, it has to pass the glitch test (§7, step 7). If it doesn't, replace it with a 74AHCT125.

### Buck converter

- **Set the output before connecting anything.** Adjustable modules (MP1584, LM2596 and similar) often ship at an arbitrary voltage. With 12 V in and nothing on the output, turn the trimmer until a meter reads 5.0–5.1 V. 12 V on the XIAO's 5V pin destroys it. A fixed 5 V module avoids this risk.
- **Rating:** at least 1 A. The XIAO draws peaks of a few hundred mA while transmitting on WiFi. The shifter draws almost nothing.
- **Placement:** keep it a few centimeters away from the U.FL antenna, because switching noise affects WiFi.

### Diagram

```
                     ┌───────────────────────────────────────────────► strip +12V
12 V PSU (+) ─[fuse]─┤                       1000 µF / 25 V across strip +12V and GND, at the strip input
                     └─► buck IN+     buck OUT+ (5.0 V) ─┬─►|──► XIAO 5V          (SS14 Schottky)
                                                         └─────► 74AHCT125 VCC (pin 14), 100 nF to GND

12 V PSU (−) ─────── common ground: buck IN− / OUT−, XIAO GND, 74AHCT125 GND (pin 7), strip GND

XIAO D5 / GPIO7 ──┬──► 74AHCT125 1A (pin 2)     1Y (pin 3) ───[330 Ω]───► strip DIN
                  │                                         (resistor at the strip end)
                10 kΩ
                  │                    74AHCT125 1OE (pin 1) and unused 2A / 3A / 4A ──► GND
                 GND
```

### Connection list

| From | To | Why |
|---|---|---|
| PSU + (through fuse) | Strip +12V | Strip power never flows through the buck or the XIAO |
| PSU + (through fuse) | Buck IN+ | |
| Buck OUT+ (5.0 V) | XIAO 5V pin, through an SS14/1N5819 | The diode stops the buck and the USB port from feeding into each other when both are connected during development |
| Buck OUT+ (5.0 V) | 74AHCT125 VCC, with 100 nF to GND | |
| PSU − | Buck IN−/OUT−, XIAO GND, shifter GND, strip GND | The data signal needs a common reference |
| D5 / GPIO7 | 74AHCT125 1A | 10 kΩ to GND prevents random flashes while the chip boots |
| 74AHCT125 1Y | Strip DIN | 330 Ω series resistor near the strip damps reflections. Keep this wire under ~1 m. |
| 74AHCT125 1OE | GND | Enables the output (active low) |
| Unused 2A/3A/4A | GND | Avoids floating CMOS inputs |
| 1000 µF capacitor (≥ 25 V) | Strip +12V / GND at the input | Absorbs inrush and current spikes |

**USB during development.** With USB plugged in and 12 V off, the XIAO runs and the strip and shifter stay unpowered. That's fine for firmware work. With both connected, the diode keeps the two 5 V sources apart.

## 5. Power

**Sizing.** Full white is 8 W/m, about 0.67 A/m at 12 V. Add about 0.2 A for the buck converter, XIAO and shifter. Pick a PSU with at least 20 % headroom. Set the firmware limit to `0.8 × PSU rating − 200 mA`, because the limiter only counts strip current.

| Strip length | Pixels | Strip at full white | PSU | `max_current_ma` |
|---|---|---|---|---|
| **625 mm (this build)** | **10** | **5 W → 0.42 A** | **12 V 1 A** | **600** (no limiting in practice) |
| 1 m | 16 | 8 W → 0.67 A | 12 V 2 A | 1400 (no limiting in practice) |
| 2 m | 32 | 16 W → 1.33 A | 12 V 2 A | 1400 |
| 3 m | 48 | 24 W → 2.0 A | 12 V 3 A | 2200 |
| 5 m (full reel) | 80 | 40 W → 3.33 A | 12 V 5 A | 3800 |

**This build** draws about 0.62 A at full white, strip plus electronics, which is about 7.5 W. A 12 V 1 A supply has enough headroom. At this length the limiter is only a safety net.

**Firmware current limiter.** This is the automatic brightness limiter ([03 §5](03-firmware.md#5-led-output-pipeline)). The firmware estimates current every frame and scales brightness down to stay under `max_current_ma`. The setup wizard asks which supply is used:

| Choice | Limit |
|---|---|
| "12 V 1 A" (safe default) | 600 mA |
| "12 V 2 A" | 1400 mA |
| "12 V 3 A" | 2200 mA |
| "12 V 5 A" | 3800 mA |
| Custom | entered value |

**Calibration.**
- The default `ma_per_pixel_white` for this strip is **42 mA**: 8 W/m ÷ 16 px/m ÷ 12 V.
- To calibrate, measure the current on the 12 V side at 25 % full white, subtract the current with the lamp off, multiply by 4, and divide by the pixel count.

**Wiring.**
- Fuse the 12 V output above the PSU rating and below the ampacity of the wire.
- At 625 mm, feeding one end is plenty. BTF rates the strip for a 5 m run from one end.

**Heat.** Strip temperature depends on watts per meter, not total length, so a short strip runs as warm as a long one. 8 W/m is enough to need the aluminum channel. Check temperatures in bring-up (§7, step 9).

**Brownouts.** Strip inrush on a weak supply can brown out the C3. The firmware keeps the brownout detector on and fades the strip in at boot rather than switching it straight on.

## 6. Bill of materials (per lamp)

| Qty | Part | Notes |
|---|---|---|
| 1 | Seeed XIAO ESP32-C3 + its U.FL antenna | Mount the antenna away from metal, the buck converter and strip power wires |
| 1 | BTF-LIGHTING FCOB WS2811 12 V RGB strip, 576 LEDs/m | 625 mm per lamp, cut at the 10th 62.5 mm mark (§3). One 3 m reel covers both lamps. |
| 1 | SN74AHCT125N (DIP-14) or SN74AHCT1G125 (SOT-23-5) | Breakouts based on these chips also work. Not a BSS138 bidirectional board (§4). |
| 1 | Buck converter, 12 V → 5 V, ≥ 1 A | Set to 5.0 V before connecting (§4) |
| 1 | 12 V 1 A PSU | Enough for 625 mm (§5) |
| 1 | 330 Ω resistor | Data line, at the strip end |
| 1 | 10 kΩ resistor | Pull-down on GPIO7 |
| 1 | 1000 µF electrolytic capacitor, ≥ 25 V | Across the strip input |
| 1 | 100 nF ceramic capacitor | Decoupling for the shifter |
| 1 | SS14 or 1N5819 Schottky diode | Buck 5 V into the XIAO |
| 1 | Inline fuse + holder, DC jack | |
| 0–1 | Tactile button or TTP223 module | Optional external input on D1 |
| 1 | Aluminum channel (≥ 10 mm) + diffuser, enclosure | Needed for cooling at 8 W/m, and gives the smooth COB look |

## 7. Bring-up checklist

1. **Board only.** Flash the firmware over USB with nothing else connected. Confirm serial logs, and that the setup AP appears.
2. **Buck.** Apply 12 V with nothing on the buck output. Set and confirm 5.0–5.1 V. Only then connect the XIAO and the shifter.
3. **Data line.** With the shifter wired, check D5 idles low and 1Y swings 0 → 5 V. A multimeter or logic probe is enough.
4. **First light.** Use the 12 V 1 A supply, or a bench supply limited to about 0.7 A, and choose "12 V 1 A" in setup. Run the **color order** test, which lights the first pixel red, then green, then blue, and pick the matching order.
5. **Pixel count.** Set `pixel_count` to 16 × the length in meters, which is 10 for this build. The **last pixel** test lights only pixel *n−1* (pixel 9); it must land on the final 62.5 mm segment.
6. **Calibrate.** Measure current at 25 % white and set `ma_per_pixel_white` (§5).
7. **Glitch test.** Run `rainbow` at 100 fps while the phone streams a large download through the same AP. There should be no sparkles or wrong colors down the strip. This step also checks the level shifter (§4).
8. **Boot test.** Power-cycle 20 times. The strip must not flash at power-on, and the restored state must fade in within about 0.5 s.
9. **Heat.** Run 30 minutes at full white at the configured limit and check that the strip, PSU, buck and wiring are warm at most, never hot.
