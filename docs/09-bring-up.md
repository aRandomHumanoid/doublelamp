# 09: Bring-up guide

This guide takes the two finished lamps from "wired and on the bench" to "linked, in Apple Home, updating over the air". It assumes:

- Both lamps are built and wired as in [02 Hardware](02-hardware.md): 625 mm of strip, 74AHCT125, buck converter, 12 V 1 A supply each.
- A Windows PC, an iPhone (for Apple Home), and one 2.4 GHz WiFi network that the PC, the phone and both lamps can all join.
- The server runs on the PC for now, on that same WiFi ([05 §13](05-server.md#13-deployment), "Development on one WiFi"). Cloudflare and the domain come later (step 14).

Allow about two hours the first time. Each step ends with **✔ Check:** what you should see before moving on.

---

## 1. Before powering anything

Do bring-up steps 1–3 from [02 §7](02-hardware.md#7-bring-up-checklist) on each lamp:

1. **Buck converter.** With 12 V in and nothing connected to its output, set it to **5.0–5.1 V**. 12 V on the XIAO's 5V pin destroys it.
2. **Data path.** XIAO D5 → 74AHCT125 pin 2; pin 3 → 330 Ω → strip DIN. The strip's arrow points away from the XIAO. 10 kΩ from D5 to GND. Pins 1, 7 and the unused inputs to GND.
3. **Grounds.** PSU −, buck −, XIAO GND, shifter GND and strip GND are all connected.

✔ Check: a meter shows 5.0–5.1 V at the buck output, and continuity on every ground.

## 2. Install the software (once)

Open **PowerShell** (not as administrator) for everything below.

### 2.1 Allow local scripts

ESP-IDF's environment script is a PowerShell script:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### 2.2 ESP-IDF v5.5.6

ESP-IDF is already installed on this PC: the framework at `C:\Users\aling\esp\esp-idf-v5.5.6` and the toolchain in `C:\Users\aling\.espressif`. On another PC, install it the same way:

```powershell
mkdir $HOME\esp; cd $HOME\esp
git -c core.longpaths=true clone -b v5.5.6 --recursive --depth 1 --shallow-submodules https://github.com/espressif/esp-idf.git esp-idf-v5.5.6
.\esp-idf-v5.5.6\install.ps1 esp32c3
```

Keep the path short: Windows' path-length limit breaks ESP-IDF builds in deep folders.

In **every new PowerShell window** that builds or flashes firmware, run:

```powershell
. $HOME\esp\esp-idf-v5.5.6\export.ps1
```

✔ Check: `idf.py --version` prints `ESP-IDF v5.5.6`.

### 2.3 Node.js 24 LTS

Install **Node.js 24 LTS** from [nodejs.org](https://nodejs.org) with the default options. A portable copy is also at `C:\Users\aling\esp\tools\node`; add that folder to your PATH if you'd rather not install.

✔ Check: `node --version` prints `v24.…` and `npm --version` prints a version.

### 2.4 The Apple Home SDK

Apple Home support uses Espressif's open-source esp-homekit-sdk ([ADR-0004](adr/0004-apple-home-via-hap.md)). It isn't in the repo yet. Add it as a pinned submodule:

```powershell
cd $HOME\Documents\GitHub\doublelamp
git submodule add https://github.com/espressif/esp-homekit-sdk.git firmware/third_party/esp-homekit-sdk
git -C firmware/third_party/esp-homekit-sdk checkout 676fabac
git -C firmware/third_party/esp-homekit-sdk submodule update --init --recursive
```

The firmware was compile-tested against exactly this commit. The SDK is licensed for non-commercial use only, which fits this project. Without it the firmware still builds, just without Apple Home, and the build log warns you.

### 2.5 JavaScript dependencies

```powershell
cd $HOME\Documents\GitHub\doublelamp
npm install
```

If npm says some packages' install scripts are not allowed, approve the two that need them, then run `npm install` again:

```powershell
npm install-scripts approve better-sqlite3 esbuild
```

✔ Check: `npm test` ends with every test passing.

### 2.6 The firmware signing key

The lamps only accept updates signed with this key ([07 §6](07-security.md#6-firmware-supply-chain)). Create it once:

```powershell
. $HOME\esp\esp-idf-v5.5.6\export.ps1
cd $HOME\Documents\GitHub\doublelamp\firmware
mkdir keys
espsecure.py generate_signing_key --version 2 --scheme rsa3072 keys\signing_key.pem
```

**Back up `keys\signing_key.pem` in two places**, for example a password manager and a USB stick. If it's lost, the lamps can only be updated over USB again. It's in `.gitignore`: never commit it.

## 3. Flash lamp A

1. Leave the 12 V supply **off** for now. Plug the XIAO of lamp A into the PC with a USB-C data cable.
2. Find its port: **Device Manager → Ports (COM & LPT) → USB Serial Device (COM5)**. The number varies.
3. In a PowerShell window with the ESP-IDF environment loaded:

   ```powershell
   cd $HOME\Documents\GitHub\doublelamp\firmware
   .\lamp.ps1 flash -Port COM5
   ```

   This is a **development build**. It accepts the plain `ws://` server on your PC ([03 §10](03-firmware.md#10-cloud-link)). The first build takes 5–10 minutes; later ones take seconds.

To use VS Code's ESP-IDF extension instead, see [VS Code instead of `lamp.ps1`](#vs-code-instead-of-lampps1).

If flashing can't connect: hold the XIAO's **BOOT** button, tap **RESET**, release BOOT, and run the command again.

✔ Check: the serial monitor shows lines like

```
I (…) main: DoubleLamp 1.0.0 (3fa2c1d4) dl-3fa2c1
I (…) wifi: setup mode: open access point DoubleLamp-3FA2C1 on channel 6
I (…) api: local API on :80
```

Press **Ctrl+]** to leave the monitor. The lamp keeps running.

## 4. First light

Switch on lamp A's 12 V supply (USB can stay plugged in).

✔ Check: the strip breathes **slow blue**. That's setup mode, at low brightness.

No light at all? Check 12 V at the strip, then 5 V at the shifter's pin 14, then the strip's DIN arrow direction. Flicker or random colors? See the level-shifter warning in [02 §4](02-hardware.md#4-wiring).

## 5. Set up lamp A

1. On the iPhone: **Settings → Wi-Fi → DoubleLamp-3FA2C1** (open network). The setup page opens by itself. If it doesn't, open Safari and go to `http://192.168.4.1`.
2. Go through the wizard:
   - **Blink**, to make sure you're talking to the right lamp.
   - **WiFi**: pick your 2.4 GHz network and enter its password.
   - **Name**: "Lamp A". Then an **admin password** of 8+ characters. It protects the lamp's settings and is also the lamp's direct-mode WiFi password.
   - **Strip & power**: 0.625 m (10 pixels), **12 V 1 A**.
   - **Server**: **Skip** for now. Pairing comes in step 10.
3. **Connecting…** takes 5–20 s. The lamp gives two green blinks, then turns on warm white.
4. **Done** shows the lamp's address, such as `http://doublelamp-3fa2c1.local` and its IP, plus the **Apple Home setup code**. Write both down.

The setup network closes 60 s later. Switch the phone back to your home WiFi.

If the phone drops off the lamp's network while it's connecting, rejoin it and reopen `http://192.168.4.1`, or read the lamp's IP from the serial monitor (`wifi: online, IP 192.168.1.57`).

✔ Check: on home WiFi, `http://<lamp IP>/` opens the lamp's page and controls the light.

## 6. Calibrate the strip

On the lamp's page: **Settings** → log in with the admin password → **LEDs**.

1. **Color order test.** The first segment lights in three colors, one second each. Write them down in order. They spell the strip's color order: green, red, blue means `GRB`; blue, red, green means `BRG`. Set **Color order** to that and save. Many WS2811 strips are `BRG` or `GRB`.
2. **Last pixel test.** Only the last 62.5 mm segment should light. If a different one does, fix **Pixel count**; it's 10 for 625 mm.
3. Optional: **25 % white** plus a meter, to calibrate current ([02 §5](02-hardware.md#5-power)). At 10 pixels the limiter is only a safety net.

✔ Check: solid red on the lamp's page looks red, and the color wheel matches the strip.

## 7. Check lamp A on its own

- Change brightness, color and effects from the lamp's page. `candle`, `breathe` and `cycle` look best with 10 pixels.
- **Button:** one press toggles, a double press goes to the next preset (once you have presets), holding 3 s enters setup mode, and holding 10 s factory-resets.
- Switch the 12 V off and on: the lamp comes back in its last state within about half a second, without a flash.

✔ Check: all of the above behave as described.

## 8. Add lamp A to Apple Home

The iPhone must be on the same WiFi as the lamp. No home hub is needed ([03 §11](03-firmware.md#11-apple-home-homekit)).

1. **Home** app → **+** → **Add Accessory** → **More options…** → pick **Lamp A**.
2. Enter the setup code from step 5. If you lost it, it's in the lamp's page under **Settings → Apple Home**.
3. At **"Uncertified Accessory"**, tap **Add Anyway**. Pairing takes 10–30 s.

✔ Check: on/off, brightness and color work from the Home app and from Siri ("Hey Siri, turn Lamp A blue"). A change on the lamp's page shows up in the Home app.

## 9. Start the server on the PC

1. Find the PC's address: `ipconfig` → your WiFi adapter → **IPv4 Address**, for example `192.168.1.20`. Give the PC a DHCP reservation in your router so the address doesn't change.
2. Create `server\.env` (copy `server\.env.example`) with:

   ```ini
   PUBLIC_URL=http://192.168.1.20:8080
   DEV_INSECURE=1
   APP_PASSWORD=choose-a-12+-character-password
   ```

3. Build the web app and start the server:

   ```powershell
   cd $HOME\Documents\GitHub\doublelamp
   npm run build:web
   npm start
   ```

4. Let the server through **Windows Firewall**. Accept the prompt for **Private networks**, or run this once in an **administrator** PowerShell:

   ```powershell
   New-NetFirewallRule -DisplayName "DoubleLamp server" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Private
   ```

   Also make sure your WiFi is set to **Private**: **Settings → Network & internet → Wi-Fi → (your network) → Private network**.
5. On the phone, open `http://192.168.1.20:8080`. Log in with `APP_PASSWORD` and give the phone a name, such as "Alex's iPhone".

✔ Check: the web app loads and says there are no lamps yet.

If you rebuild the web app later, restart the server: it checks for `web\dist` when it starts.

**Optional: try it with simulated lamps first.** In the web app, **Settings → Add lamp** gives a code. Then in a second PowerShell window:

```powershell
cd $HOME\Documents\GitHub\doublelamp
npm run virtual-lamp -- --server http://192.168.1.20:8080 --code K7QM-4ZTX --name "Virtual A"
```

A strip of colored blocks appears in the terminal and follows the web app. Keys: `o` toggles power, `+`/`-` change brightness, `c` changes color, `e` changes effect, `x` goes offline and back, `q` quits. Remove virtual lamps afterwards on each lamp's screen in the web app (**Unpair**), so they don't stay in the group with your real lamps.

## 10. Pair lamp A with the server

1. Web app → **Settings → Add lamp**. It shows a code like `K7QM-4ZTX`, valid for 10 minutes.
2. Lamp A's page → **Settings → Server** → URL `http://192.168.1.20:8080`, then the code → **Pair**.

✔ Check: Lamp A appears in the web app, online, and the web app's controls move the light.

## 11. Bring up lamp B

Repeat steps 3–8 for lamp B with two differences:

- In the wizard's **Server** step, enter `http://192.168.1.20:8080` and a **new** pairing code from the web app. The lamp then joins WiFi and the server in one pass.
- Name it "Lamp B".

✔ Check: both lamps are online in the web app, and both are in the Home app.

## 12. Link the lamps

1. Web app → **Home** → the link toggle between the two tiles → confirm **"Match Lamp B to Lamp A?"**.
2. Change color or effect in the web app: both lamps change together.
3. Change Lamp A from its own page, its button or Apple Home: Lamp B follows within a fraction of a second.

**Measure the sync** ([08 §1.7](08-testing-and-roadmap.md#17-measuring-sync-between-lamps)):

1. Set the effect to **Sync test**. Both lamps flash white once a second.
2. Film both in slow motion (240 fps). Count the frames between the two flashes; each frame is about 4 ms.

✔ Check: the flashes are under 7 frames apart, and usually 1–3.

## 13. Update over the air

1. Change `set(PROJECT_VER "1.0.0")` to `"1.0.1"` in `firmware\CMakeLists.txt`, then build:

   ```powershell
   .\lamp.ps1 build
   ```

2. Web app → **Settings → Firmware** → upload `firmware\build-dev\doublelamp.bin` → **Update both**.

✔ Check: one lamp downloads, reboots and reports 1.0.1, then the other does the same. The light keeps going during the download. A deliberately broken build rolls back by itself and shows three amber blinks ([03 §15](03-firmware.md#15-ota-and-partitions)).

## 14. Later: Cloudflare and release firmware

When the domain is ready:

1. Set up the server on its always-on machine with Cloudflare Tunnel ([05 §13](05-server.md#13-deployment)):
   - In `server\.env`: `PUBLIC_URL=https://lamps.<your-domain>`, `TRUST_PROXY=cloudflare`, no `DEV_INSECURE`.
   - In a `.env` next to `docker-compose.yml` (the repo root, not `server\`): `TUNNEL_TOKEN=…` from the Cloudflare dashboard.
   - `docker compose --profile tunnel up -d`, then apply the Cloudflare settings table in [05 §13](05-server.md#13-deployment).
2. Build release firmware with `.\lamp.ps1 build -Release` and install it: by USB with `.\lamp.ps1 flash -Port COM5 -Release`, or by OTA from the dev server, since it's signed with the same key. Release firmware refuses `http://`/`ws://` servers.
3. Pair each lamp again with the `https://` URL (lamp page → **Settings → Server**).

---

## Reference

### Firmware helper (`firmware\lamp.ps1`)

| Command | Does |
|---|---|
| `.\lamp.ps1 build` | Development build into `build-dev` |
| `.\lamp.ps1 flash -Port COM5` | Build, flash, and open the serial monitor (Ctrl+] quits) |
| `.\lamp.ps1 monitor -Port COM5` | Serial monitor only |
| `.\lamp.ps1 size` | Flash and RAM use |
| `.\lamp.ps1 erase -Port COM5` | Wipes the whole flash, including WiFi, settings and Apple Home pairings. Then flash again. |
| `-Release` | The same, as a release build into `build-release` |
| `.\lamp.ps1 fullclean` | Run after editing `sdkconfig.defaults` or `sdkconfig.dev` |

### VS Code instead of `lamp.ps1`

Espressif's **ESP-IDF** extension builds and flashes the same way. It uses the ESP-IDF from step 2.2; don't let it install a second copy.

1. Open the **`firmware`** folder in its own VS Code window (`code firmware`), not the repo root. The extension treats the opened folder as the project.
2. Point the extension at ESP-IDF. In `firmware\.vscode\settings.json`, `idf.customExtraVars` sets `IDF_PATH`, `IDF_TOOLS_PATH` and `IDF_PYTHON_ENV_PATH`. This file is gitignored because the paths are per machine. Then run **ESP-IDF: Select Current ESP-IDF Version** from the Command Palette and pick v5.5.6.
3. Pick a build in the status bar (or **ESP-IDF: Select Project Configuration**). **Development** and **Release** come from `firmware\CMakePresets.json`, with the same folders and settings as `lamp.ps1`.
4. Pick the port in the status bar, then use **Build**, **Flash** and **Monitor** there, or **ESP-IDF: Build, Flash and Start a Monitor on Your Device**.

`lamp.ps1` checks two things the extension doesn't. Without the signing key, the build fails at the signing step. Without the Apple Home SDK, the only notice is the warning in the build log.

### Resets

| Do this | You get |
|---|---|
| Hold the button 3 s, release | Setup mode. WiFi is kept; if nobody runs setup within 10 min, the lamp goes back to normal. |
| Power-cycle 5 times, each under 5 s | Setup mode, for when the button is out of reach |
| Hold the button 10 s (red bar fills) | Factory reset: WiFi, settings, presets and Apple Home pairings are erased. Letting go early cancels. |
| Lamp page → Settings → Apple Home → Reset | Removes all Apple Home pairings, keeps the code. The lamp restarts. Also remove it in the Home app. |
| `.\lamp.ps1 erase -Port COM5` | Everything, including the firmware's saved data |

### Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| No COM port appears | Charge-only cable. Try another USB-C cable or port. |
| Flash fails with "Failed to connect" | Hold BOOT, tap RESET, release BOOT, then retry |
| Build stops with "No firmware signing key" | Do step 2.6 |
| Build warns "esp-homekit-sdk not found" | Do step 2.4. Without it there's no Apple Home. |
| Strip shows wrong colors | Color order (step 6) |
| Sparkles or flicker, worse when WiFi is busy | Level shifter: a BSS138 board is too slow; use the 74AHCT125 ([02 §4](02-hardware.md#4-wiring)). Also check the 330 Ω resistor and the common ground. |
| Setup page doesn't open on the phone | Browse to `http://192.168.4.1` while on the lamp's WiFi. Turn off "Private Wi-Fi Address" or VPNs if it still won't load. |
| Setup says "Wrong password" or "Network not found" | 5 GHz-only networks aren't supported. Pick the 2.4 GHz one. |
| `doublelamp-xxxxxx.local` doesn't open (often on Android) | Use the IP shown on the Done page or in the serial monitor |
| Lamp page says "Server: re-pair needed" | The server forgot this lamp. Pair it again (step 10). |
| Lamp never shows online in the web app | Windows Firewall (step 9.4); a `PUBLIC_URL` that isn't the PC's current IP; a release build, which refuses `http://` servers |
| Web app says "Reconnecting…" forever | The server stopped, or the PC's IP changed. Restart `npm start` and check `PUBLIC_URL`. |
| `npm start` says it refuses an `http://` PUBLIC_URL | Add `DEV_INSECURE=1` to `server\.env` (development on one WiFi only) |
| The Home app shows "No Response" | The iPhone isn't on the same WiFi as the lamp, or the lamp was reset. Remove it from the Home app and add it again. |
| Free heap in the log drops below ~30 KB | Note what was running and report it. The lamp reboots itself cleanly if memory stays low ([03 §16](03-firmware.md#16-fault-handling)). |
