# Preact on ESP32

Run **Preact on the ESP32 itself** and render `Hello world` to a 0.96" SSD1306
OLED. No browser, no web server — the microcontroller executes the JavaScript,
diffs the component tree, and paints the pixels.

This is the live-demo backbone for a conference talk on running React in non-web
environments. The thesis: React/Preact is a **reconciler** (diffs a component
tree) plus a **renderer** (mutates a target). Swap the renderer and you swap the
target. Here the target is a physical OLED.

> **Honesty note for the stage:** this ships **Preact**, not Facebook's React.
> The API and the architecture lesson are React's; Preact is the size-forced
> choice for ~520KB of SRAM. Say so plainly.

---

## How it works

```
JSX  ──babel──▶  h() calls  ──Preact reconciler──▶  host config  ──▶  framebuffer  ──I2C──▶  OLED
(App.jsx)        (build/)     (diffing, hooks)       (renderer.js)     (display.js)         (SSD1306)
```

Preact has its diff built in and drives its target through a DOM-shaped
interface (`document.createElement`, `node.appendChild`, `node.setAttribute`).
So our **custom renderer** is a *minimal in-memory DOM*: a fake `document` plus
`Element`/`Text` nodes whose mutation methods **are** the host operations —
`createInstance`, `appendChild`, `insertBefore`, `removeChild`, `commitUpdate`,
`commitTextUpdate`. Each mutation edits a tiny scene graph and marks the screen
dirty; a coalesced microtask repaints the 1bpp framebuffer and flushes only the
changed 128-byte pages over I2C.

The element vocabulary is `<text>`, `<rect>`, `<pixel>` instead of
`<div>`/`<span>` (see [`src/renderer.js`](src/renderer.js)).

> **Why not `preact-reconciler`?** It exposes the exact react-reconciler
> host-config API and would be the textbook fit — but v0.2.3 is **browser-only**:
> it subclasses `HTMLElement`, calls `customElements.define`, and relies on
> `super.appendChild` / `ownerSVGElement`, none of which exist under Moddable XS.
> The minimal-DOM host shim here is the on-chip path the POC plan anticipated;
> the architecture lesson is identical.

---

## Hardware & wiring

- ESP32-WROOM devkit
- 0.96" SSD1306 OLED, 128×64, monochrome, **I2C**

| OLED pin | ESP32 pin |
|----------|-----------|
| VCC      | 3V3       |
| GND      | GND       |
| SDA      | GPIO21    |
| SCL      | GPIO22    |

Default I2C address `0x3C`. Change pins/address in [`src/main.js`](src/main.js).

### Buttons

The **BOOT button (GPIO0)** is always available and drives the whole UI on its own
(**tap** = next/change, **hold ≥0.5 s** = select/confirm/back). Two **optional**
buttons make the dashboard easier to drive — wire each from the pin **to GND**
(internal pull-ups are enabled, so an unwired pin idles HIGH and never fires):

| Button   | ESP32 pin | Action          |
|----------|-----------|-----------------|
| BOOT     | GPIO0     | tap / hold      |
| NEXT     | GPIO25 → GND | next / change |
| SELECT   | GPIO26 → GND | select / back |

GPIO25/26 are non-strapping and free on a WROOM, so leaving them unwired never
affects boot. Override the pins via `onControls({ pinNext, pinSelect })` in
[`src/button.js`](src/button.js).

---

## Project layout

```
src/
  main.js       entry: build Display, mount <App/>
  App.jsx       the UI — <text>Hello world</text> (+ bonus <Counter/>)
  renderer.js   custom Preact renderer = minimal-DOM host config -> framebuffer
  display.js    1bpp framebuffer + SSD1306 init + dirty-page I2C flush
  button.js     debounced BOOT-button (GPIO0) input
  font.js       5x7 bitmap font
manifest.json   Moddable build manifest (modules, preload, memory)
babel.config.json   JSX -> h() (pragma: h)
build/          generated: babel output that mcconfig compiles
test/           host-side smoke test (mock I2C bus) — runs without hardware
scripts/        flash.sh (build + flash), patch-preact.mjs (XS assign fix)
paper/          "Running React on an ESP32" write-up + interactive figures
  figures/index.html        animated render pipeline (button press → pixels)
  figures/dirty-page.html   interactive dirty-page-flush / I2C model
```

> The two figures in `paper/figures/` are self-contained HTML — open them in a
> browser, or `python3 -m http.server --directory paper/figures` (also wired into
> `.claude/launch.json` as the `figures` preview server).

---

## Build & run

### 0. JS deps + host smoke test (no hardware needed)

```sh
npm install
npm test          # builds JSX, runs the real renderer/display against a mock I2C bus
```

`npm test` exercises `display.js` + `renderer.js` + the compiled `App`/`Counter`
end to end and asserts the reconstructed framebuffer matches the font, pixel for
pixel. Run this first whenever you touch the rendering code.

### Simulate the OLED (no hardware, no toolchain)

```sh
npm run sim            # live <Counter/> — press SPACE to increment
npm run sim app        # static "Hello world"
```

This runs the **real** `display.js` + `renderer.js` against a mock I2C bus and
prints the reconstructed 128×64 framebuffer using Unicode half-blocks (two
pixels per character row). What you see is what the SSD1306 would show — same
driver, same renderer, same Preact diff; only the physical I2C write (and the
button GPIO) is mocked. In the counter, **Space** stands in for the BOOT button;
`q` or Ctrl-C quits. (`SIM_FRAMES=N` exits after N frames for non-interactive use.)

> Note: Moddable's own desktop simulator (`mcconfig -p mac`) won't show this
> panel — it doesn't model an SSD1306 behind `pins/i2c`. For a full *chip*
> simulation (virtual ESP32 + virtual OLED), Wokwi can run a compiled firmware
> binary, but that still requires the toolchain below to build the binary first.

### 1. Install the Moddable SDK + ESP32 toolchain

Verified working combo (macOS, June 2026): **Moddable SDK** + **ESP-IDF v6.0**.

```sh
# Homebrew deps
brew install cmake ninja dfu-util python3

# ESP-IDF v6.0  (pinned — Moddable's esp32 doc states the supported version)
git clone -b v6.0 --recursive --shallow-submodules \
  https://github.com/espressif/esp-idf.git ~/esp32/esp-idf-v6.0
cd ~/esp32/esp-idf-v6.0 && ./install.sh esp32     # see Python note below

# Moddable SDK + host tools
git clone --depth 1 https://github.com/Moddable-OpenSource/moddable ~/Projects/moddable
cd ~/Projects/moddable/build/makefiles/mac && make
export MODDABLE=~/Projects/moddable
export PATH="$MODDABLE/build/bin/mac/release:$PATH"
```

> **Python note:** ESP-IDF v6.0 is not compatible with Homebrew's current
> default `python3` (3.14). Run `install.sh`/`export.sh` with **python3.13** on
> `PATH` (the [`scripts/flash.sh`](scripts/flash.sh) helper does this via a
> `/tmp/pyshim`, which also shadows any pyenv `python` shim).

Docs: <https://github.com/Moddable-OpenSource/moddable/blob/public/documentation/devices/esp32.md>

### 2. Build + flash the firmware

```sh
npm run flash                    # release build (console off, smallest)
npm run flash:debug              # instrumented (serial console @115200, for trace())
UPLOAD_PORT=/dev/cu.usbserial-XXXX npm run flash   # override the port

# or via make (run `make` with no target for the full list):
make flash                       # release
make flash-debug                 # instrumented
make flash PORT=/dev/cu.usbserial-XXXX
make monitor                     # read the serial console @115200
```

(All of these call [`scripts/flash.sh`](scripts/flash.sh) — run it directly if you prefer.)
The script logs each step, sets the Moddable + ESP-IDF env, runs `npm run build:jsx`,
builds with `mcconfig`, **frees the serial port** (closes any `idf.py monitor`
holding it), and flashes the bins with `esptool`. It deliberately does **not** use
`mcconfig -d` (that needs the xsbug GUI app, which the CLI install doesn't build).
To watch `trace()` output, use an `instrument` build and read the port at 115200
(e.g. `idf.py -p <port> monitor`, or any serial terminal).

### 3. Run the button counter (the default)

[`src/main.js`](src/main.js) mounts `<Counter />` by default. Each press of the
**BOOT button (GPIO0)** bumps the count, proving the reconciler diffs and the host
config re-commits live. To show plain `Hello world` instead, swap the mount in
`main.js` to `<App />` (and you can drop the `monitor` include from `manifest.json`).

The button is debounced in [`src/button.js`](src/button.js); wire an external
button to any GPIO and pass `{ pin }` to `onButton`. (The ESP32 has no dedicated
power button — EN is a hard reset and can't be read, so BOOT is the usable one.)

---

## Moddable XS gotchas (all hit during bring-up)

These are silent — code compiles and often the first render works:

- **Serial console is OFF in release builds** (`CONFIG_ESP_CONSOLE_NONE`). Build
  `instrument` to get plain-text `trace()` at 115200.
- **`pins/digital/monitor` needs its own manifest include**
  (`$(MODDABLE)/modules/pins/digital/monitor/manifest.json`) — the base
  `pins/digital` manifest doesn't register it.
- **I2C `write()` caps at 40 bytes.** `display.js` streams each page in 32-byte
  chunks (SSD1306 auto-advances its column pointer).
- **No global `setTimeout`** — `renderer.js` shims it from the `Timer` module so
  `preact/hooks` effects flush.
- **Don't preload `preact`** — XS freezes preloaded objects; only `font` is
  preloaded.
- **Bump the XS stack, not the heap** — `creation.stack: 2048` (default 384 is too
  small for Preact's recursion); oversizing heap/chunk panics at boot.
- **`<Fragment>` throws** (`set constructor: not writable`) — preact instantiates
  it as a component. Use a host `<group>` wrapper (the renderer recurses unknown
  tags).
- **Re-renders need the preact `assign` patch** — XS's frozen
  `Object.prototype.constructor` breaks `assign({}, vnode)` on every update.
  [`scripts/patch-preact.mjs`](scripts/patch-preact.mjs) runs on `postinstall`.

## Other troubleshooting

- **Blank screen / no I2C ACK** — re-check SDA→21, SCL→22, 3V3, GND. Some panels
  use address `0x3D`; try it in `main.js`. Confirm the panel is I2C, not SPI.
- **Mirrored or offset image** — `SEG_REMAP` / `COM_SCAN_DEC` / `SET_COM_PINS`
  in [`src/display.js`](src/display.js) are panel-dependent.
- **`termios: Invalid argument` when flashing** — the USB-serial line got wedged;
  `stty -f <port> raw 115200` clears it (flash.sh does this).

---

## Status vs. the POC plan

**Done and running on real hardware:** framebuffer + chunked I2C driver, custom
Preact renderer/host config, `Hello world`, button-driven `useState` counter,
host-side smoke test + terminal simulator, full Moddable/ESP-IDF build + flash.
Verified on an ESP32-D0WD-V3 (WROOM) with a 0.96″ SSD1306.
