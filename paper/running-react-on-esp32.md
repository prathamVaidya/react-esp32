# Running React on an ESP32: A Component Renderer Without a Browser

**A 32-bit microcontroller, a 0.96″ OLED, and the claim that the DOM was never essential.**

*Working paper / talk companion — React India 2026*

---

## Abstract

React is widely understood as "a library for building web user interfaces," but
architecturally it is two separable parts: a **reconciler** that diffs a tree of
components, and a **renderer** that applies the resulting changes to some target.
`react-dom` and `react-native` are merely two renderers. We test the strongest
form of this claim by removing the browser, the operating system, and the network
entirely: we run a Preact component tree directly on an ESP32 microcontroller and
render it to a 128×64 monochrome OLED over I²C. The JavaScript engine executes on
the chip; the components diff on the chip; a ~140-line custom renderer turns
commits into pixels. We describe the architecture, a host-side simulator that
reproduces the device's framebuffer exactly, and — the paper's main contribution —
eight non-obvious, individually silent failure modes encountered when driving a
modern reconciler on an embedded JavaScript engine (Moddable XS), together with
their fixes. The result is a stable on-device demo, including a button-driven
`useState` counter, in a firmware image of roughly half a megabyte. We argue that
the exercise is pedagogically valuable precisely because each layer that "should"
be necessary — the DOM, `requestAnimationFrame`, an unfrozen `Object.prototype` —
turns out to be replaceable or absent, and the framework keeps working anyway.

---

## 1. Introduction

The custom-renderer idea is not new. Sophie Alpert's "Building a Custom React
Renderer" (React Conf 2017) and projects such as `react-three-fiber` (a 3D scene
graph), `ink` (React for command-line interfaces), and `react-nil` (a renderer
that renders nothing) have all demonstrated that React's reconciliation logic is
independent of the DOM. What these share is a *host*: a browser, Node.js, or a
terminal — all environments with megabytes of RAM, a full JavaScript runtime, and
an operating system.

This paper pushes the substrate as far down as it reasonably goes. The target is
an **ESP32**, a dual-core 32-bit microcontroller with on the order of 520 KB of
SRAM and no operating system in the conventional sense. There is no DOM. There is
no `window`. There is no garbage-collected heap measured in megabytes. There is
not even a guaranteed `setTimeout`. If React's architecture is genuinely
renderer-agnostic, it should survive here. We find that it does — but only after
confronting a series of assumptions baked so deeply into the framework and its
ecosystem that they are invisible on any normal host.

Our contributions are:

1. **A complete, working on-device renderer** (Preact → custom host config → 1bpp
   framebuffer → chunked I²C → SSD1306), running on real hardware.
2. **A host-side simulator** that runs the *same* driver and renderer code against
   a mock I²C bus and reconstructs the exact framebuffer, enabling pixel-exact
   tests without hardware.
3. **A catalogue of eight embedded-JS failure modes** — each silent, each
   discovered only by getting a serial console working on a release-locked build —
   that together constitute a practical guide to running any modern reconciler on
   Moddable XS.

A note on honesty, stated plainly because the audience will notice: **this ships
Preact, not Facebook's React.** The reasons are size (Preact's runtime is a few
kilobytes; React + `react-reconciler` is too heavy for the SRAM budget) and the
fact that `preact-reconciler`, the most literal "host config" library, turns out
to be browser-only (§4.1). The *architecture lesson* — reconciler plus swappable
renderer — is React's, and Preact implements the same model. Everywhere we say
"React" as a concept, the running code is Preact.

---

## 2. Background

### 2.1 Reconciler vs. renderer

A React-style UI library maintains a tree of **elements** (the output of `h()` /
JSX). On each update it **reconciles**: it compares the new element tree to the
previous one and computes a minimal set of mutations. It then **commits** those
mutations to a host through a small, fixed interface — in `react-reconciler`
terminology, a **host config**:

```
createInstance(type, props)      // make a node
createTextInstance(text)         // make a text node
appendChild / insertBefore       // attach/move nodes
removeChild                      // detach a node
commitUpdate(node, ...changes)   // a prop changed
commitTextUpdate(node, text)     // text changed
```

`react-dom` implements these against `document.createElement`,
`element.appendChild`, and so on. The reconciler itself never mentions the DOM.
The thesis of this paper is operational: if you can supply these operations for a
new target, you can render to that target. Our target's `createInstance` allocates
a scene-graph node; our `commitUpdate` records a changed coordinate; our commit
phase paints a monochrome framebuffer.

### 2.2 The hardware

- **MCU:** ESP32-D0WD-V3 (Xtensa LX6, dual-core, 240 MHz, ~520 KB SRAM, 4 MB
  external flash). A "WROOM"-class part — the tightest reasonable target.
- **Display:** 0.96″ SSD1306 OLED, 128×64 pixels, 1 bit per pixel (monochrome),
  I²C at address `0x3C`. The framebuffer is 128×64/8 = **1024 bytes**.
- **Input:** the on-board **BOOT button on GPIO0** (the ESP32 has no dedicated
  user button; EN is a hard reset and cannot be read).
- **Wiring:** `VCC→3V3, GND→GND, SCL→GPIO22, SDA→GPIO21`.

### 2.3 The JavaScript engine

We use the **Moddable SDK**, whose **XS** engine is a small, modern-JavaScript
interpreter designed for microcontrollers. XS compiles JavaScript (and our JSX,
after a Babel pass) to bytecode *at build time* on the laptop, links it against
the firmware, and the chip executes the bytecode. Crucially, XS supports ES
modules, `Promise`, and most of the language — enough to run Preact unmodified in
principle. The friction, as §6 documents, is in the runtime *environment* XS
provides (or omits), not the language.

---

## 3. System architecture

The system has a clean build-time/run-time split.

```
BUILD TIME (laptop)                         RUN TIME (ESP32)
──────────────────                          ────────────────
JSX  (<text>, <rect>, <group>)              XS bytecode boots
   │ babel (pragma: h)                      main.js
   ▼                                           │ new Display() → I²C + framebuffer
h() hyperscript                                │ mount(<App/>, display)
   │ Moddable xsc                              ▼
XS bytecode  ─────flash over USB────────►   Preact reconciler (diff)
                                               │ commit → Host Config
                                               ▼
                                            Scene graph (Element/Text nodes)
                                               │ paint (coalesced)
                                               ▼
                                            1bpp framebuffer (1024 B)
                                               │ flush dirty pages, 32-byte chunks
                                               ▼
                                            I²C driver → SSD1306 → photons
```

The only target-specific code we write is the renderer (`renderer.js`), the
display driver (`display.js`), a bitmap font (`font.js`), and a debounced button
(`button.js`). Everything above the host config is stock Preact.

> **Animated figure.** [`paper/figures/index.html`](figures/index.html) — *"The
> journey of a button press"* — auto-plays a single increment through all seven
> layers (input → `useState` → reconcile → host config → scene graph →
> framebuffer → I²C), with a pulse travelling the pipeline, a per-stage code
> trace, and the OLED updating `Count: 7 → 8` at the end. Play/pause, step, and
> speed controls included.

### 3.1 The renderer as a minimal DOM

Preact, unlike `react-reconciler`, has its diff built in and talks to its target
through a *DOM-shaped* object: it calls `document.createElement(...)`,
`node.appendChild(...)`, `node.setAttribute(...)`. So rather than implement an
abstract host config, our renderer provides a **minimal in-memory DOM**: a fake
`document` plus `Element` and `Text` classes whose mutation methods *are* the host
operations. We never build a real DOM; each method edits an in-memory scene graph
and marks the screen dirty. The correspondence is exact:

| react-reconciler host op | our minimal-DOM method                     |
|--------------------------|--------------------------------------------|
| `createInstance`         | `document.createElementNS(ns, type)`       |
| `createTextInstance`     | `document.createTextNode(text)`            |
| `appendChild`            | `Element.appendChild`                       |
| `insertBefore`           | `Element.insertBefore`                      |
| `removeChild`            | `Element.removeChild`                       |
| `commitUpdate`           | `Element.setAttribute` / `removeAttribute` |
| `commitTextUpdate`       | `Text.data` setter                          |

The element vocabulary is the display's, not the web's: `<text x y>`, `<rect x y w
h fill>`, `<pixel x y>`, and any unknown tag (e.g. `<group>`) is treated as a
transparent container whose children still render. A component returns these:

```jsx
export default function App() {
  return <text x={0} y={0}>Hello world</text>;
}
```

### 3.2 Commit → paint

Every host mutation records *which* drawable node changed — the host config
already knows: a `commitTextUpdate` on one text node, a `setAttribute` on one rect
— and schedules a single repaint via a microtask, coalescing a burst of commits
into one paint. The painter then erases and redraws only the **dirty rectangle**
(the union of the changed nodes' old and new bounding boxes) and flushes only the
framebuffer pages that rectangle spans (§3.3); structural or ambiguous changes
fall back to a full repaint, which is always correct. Because all of Preact's
mutations pass through our node methods, state-driven re-renders (`useState`,
hooks) are caught automatically — no integration with Preact's internals is
required.

### 3.3 Dirty-page flush

The SSD1306 stores its image as eight 128-byte "pages," each byte holding eight
vertically-stacked pixels. We keep the framebuffer in exactly that layout, so
flushing a page is a straight copy with no bit-shuffling, and we track which pages
changed since the last flush. Only dirty pages are transmitted — and the renderer
(§3.2) drives this directly from the reconciler's diff, so the minimal-diff
property actually *pays off* on this target. A one-character counter update,
`Count: 7 → 8`, touches only the two pages that line spans, so the flush ships
**280 bytes instead of the 1,120 a full-screen repaint sends — 4.0× less I²C
traffic** (measured by counting bytes on the simulator's mock bus; the figure
below models the identical transaction). A naive renderer that cleared and
re-flushed the whole framebuffer on every commit — the obvious first
implementation — pays the full 1,120 every time.

> **Interactive figure.** [`paper/figures/dirty-page.html`](figures/dirty-page.html)
> is a self-contained browser model of `display.js`: hover any pixel to see its
> `page`/byte-index/bit mapping, watch pages go dirty as you draw or tick the
> counter, and press **Flush** to animate the I²C transaction (addressing commands
> + 32-byte data chunks) with a live byte counter comparing dirty-only vs.
> full-repaint traffic. Open the file directly, or
> `python3 -m http.server --directory paper/figures`.

---

## 4. Implementation notes

### 4.1 Why not `preact-reconciler`?

The textbook choice would be `preact-reconciler`, which exposes the exact
`react-reconciler` host-config API for Preact. Reading its source (v0.2.3)
revealed it is **browser-only**: it subclasses `HTMLElement`, calls
`customElements.define("preact-reconciler", ...)`, and relies on
`super.appendChild` and `ownerSVGElement`. None of these exist under XS. Its trick
is to register a custom element and let the browser's custom-elements machinery
drive the host config — elegant on the web, impossible off it. The minimal-DOM
shim (§3.1) is the on-device equivalent and keeps the pedagogy intact: the node
methods are still, recognizably, a host config.

### 4.2 Host-side simulator

To iterate without flashing (a multi-minute cycle), we built a Node harness that
runs the **real** `display.js` and `renderer.js` against a **mock I²C bus**. The
mock emulates the SSD1306's horizontal addressing mode — `COLUMN_ADDR`/`PAGE_ADDR`
set a window and each data byte advances an auto-incrementing pointer — so it
reconstructs the framebuffer exactly as the panel would, even though the driver
streams pages in sub-40-byte chunks (§6.3). A module loader maps the Moddable bare
specifiers (`pins/i2c`, `timer`, `pins/digital/monitor`) to mocks. On top of this
we provide:

- **A pixel-exact test:** mount `<App/>`, then assert the set of lit framebuffer
  pixels equals the set the 5×7 font implies for "Hello world" — 123 pixels,
  zero mismatches. The same test fires a mock button press and asserts the
  counter advances from `Count: 0` to `Count: 1`.
- **A terminal preview** that renders the framebuffer with Unicode half-blocks
  (two pixels per character cell), so `npm run sim` shows an OLED-like image and
  the live counter, no hardware required.

This harness caught every *logic* bug before hardware and gave us a ground-truth
oracle for the device.

---

## 5. The toolchain (and why it is the first obstacle)

Producing a firmware image is not "downloading a runtime." On a microcontroller
there is no OS waiting to load a program; the flashed image *is* the whole stack —
your JavaScript-as-bytecode, the XS engine (C), Moddable's driver glue (C), and
**ESP-IDF** (Espressif's SDK: FreeRTOS, drivers, bootloader, the Xtensa
cross-compiler, the memory map) — linked into one binary. XS is C source; to put
it on the chip you compile that C with the Xtensa toolchain and link it against
ESP-IDF, because the engine calls ESP-IDF's I²C and GPIO drivers and needs
FreeRTOS to have a task to run in. There is no prebuilt "XS for ESP32" because
what is baked in depends on *your* manifest (which modules, what memory sizes) —
and Moddable even *preloads your JavaScript* into the image.

In practice the verified combination (macOS, mid-2026) was **Moddable SDK + ESP-IDF
v6.0**. Two toolchain frictions are worth recording because they cost real time:

- **Python version.** ESP-IDF v6.0's installer is incompatible with Homebrew's
  then-current default `python3` (3.14). The fix is to run `install.sh` *and*
  `export.sh` with Python 3.13 on `PATH` — and the two must agree, because
  `install.sh` builds a versioned virtualenv (`idf6.0_py3.13_env`) that
  `export.sh` later looks up by the active Python's version.
- **No GUI debugger, headless.** `mcconfig -d` (debug) launches the `xsbug` GUI,
  which a command-line-tools install never builds; `make all` then aborts *before*
  flashing. Driving `make build` + `make deploy` (or flashing the bins directly
  with `esptool`) sidesteps it.

---

## 6. Eight silent failure modes (the main contribution)

What makes embedded React hard is not the architecture; it is that a modern
reconciler and its ecosystem assume a *runtime environment* the chip does not
provide, and the violations are **silent** — the code compiles, and often the
first frame even appears, before something downstream breaks. The single most
valuable tool was getting **plain-text `trace()` over serial**: release builds set
`CONFIG_ESP_CONSOLE_NONE`, disabling the console entirely, so the chip ran our app
in total silence. Only an *instrumented* build re-enables the UART, at which point
each of the following became diagnosable.

We present them in the order encountered; each was a distinct debugging cycle.

**(1) A submodule that isn't in the manifest → boot loop.**
The button uses Moddable's `Monitor` class, imported as `pins/digital/monitor`.
The base `pins/digital` manifest does *not* register that submodule; it needs its
own include. Worse, the Hello-world build pulled the button in transitively
(`App.jsx` imported it at module scope), so even the minimal demo crash-looped
with `XS abort: module "pins/digital/monitor" not found` *before any of our code
ran*. Fix: a dedicated manifest include, and keeping button-dependent UI in its
own module so the base demo has zero GPIO dependency.

**(2) The I²C 40-byte write limit → blank screen.**
Moddable's `pins/i2c` caps a single `write()` at 40 bytes (`unsigned char
buffer[40]` in the driver). Our flush sent a 128-byte page (plus a control byte)
in one call and threw `Error: 40 byte write limit` *inside the `Display`
constructor* — so the panel was never even initialized. Fix: stream each page in
32-data-byte chunks; the SSD1306's auto-incrementing column pointer stitches them
back together. This is also why the simulator's mock had to model the column
pointer (§4.2).

**(3) Preload freezes objects.**
XS can "preload" modules into ROM at build time to save RAM. Preloading Preact
froze its internals and produced `TypeError: set constructor: not writable` on
render. Fix: preload only pure-data modules (the font); let Preact load into RAM.
(This was a *partial* fix — the same error returned later for a deeper reason; see
(8).)

**(4) The default stack is too small → stack overflow.**
With Preact loaded into RAM, mounting threw `XS abort: JavaScript stack overflow`.
The default per-build XS stack on this target is 384–512 slots — too shallow for
Preact's recursive diff plus the document-shim call layers. Fix:
`creation.stack: 2048`. The stack is allocated once and cheap.

**(5) Oversizing the heap → boot-time hardware fault.**
Over-correcting by also enlarging the heap and chunk pools (128 KB each) produced
a native `Guru Meditation LoadStoreError` at ~136 ms — the allocation exceeded
free DRAM and dereferenced null during machine creation. Fix: keep heap/chunk at
the platform defaults (which had already proven sufficient to render) and override
*only* the stack. The lesson: on this class of device the JS slot-stack and the
DRAM heap are different resources with very different costs; enlarge the cheap one.

**(6) `<Fragment>` throws.**
The counter wrapped its children in `<Fragment>`. Preact instantiates `Fragment`
as a *component* and runs `h.constructor = Fragment`, which throws `set
constructor: not writable` on XS. Fix: use a plain host wrapper element
(`<group>`). Our renderer already treats unknown tags as transparent groups that
recurse their children, so this costs nothing and avoids the component path
entirely.

**(7) Effects never fire — there is no `setTimeout`.**
`preact/hooks` schedules effect flushes through a global `setTimeout` /
`requestAnimationFrame`. XS provides neither as a global (it has a `Timer`
module). So `useEffect` silently never ran, and the button — registered inside an
effect — was never wired up. Fix: the renderer installs `setTimeout` /
`setInterval` shims backed by Moddable's `Timer`, guarded so they don't clobber a
real host (e.g. Node, during tests).

**(8) Every re-render throws — the deepest bug.**
With everything above fixed, the first frame rendered correctly but *every state
update* (each button press) threw `set constructor: not writable`. Bisection
showed mount worked and the first re-render failed — a literal-vs-assignment
distinction. The root cause: **Moddable XS freezes `Object.prototype` in ROM**, so
`Object.prototype.constructor` is non-writable. Preact's vnodes carry an own
enumerable `constructor: void 0` property (used to distinguish vnodes from other
objects), and Preact's `assign` helper

```js
function m(n, l) { for (var u in l) n[u] = l[u]; return n; }
```

copies it via `assign({}, vnode)` on **every update** inside `renderComponent`.
That assignment, `({}).constructor = void 0`, walks the prototype chain, finds the
frozen non-writable property, and throws in strict mode. The initial mount uses an
object *literal* (`{constructor: void 0}` — defining an own property, which is
permitted even when the inherited one is frozen); updates use *assignment* (which
goes through the frozen prototype). That asymmetry is exactly why mount works and
the first increment crashes. **Fix:** patch Preact's `assign` to set
`constructor` via `Object.defineProperty` (an own-property definition that bypasses
the frozen prototype) and copy everything else normally. We apply this as an
idempotent `postinstall` script so dependency installs cannot silently reintroduce
the bug. This is a *general* Preact-on-XS requirement, not specific to our app.

#### Why these matter

Read as a set, the eight bugs map the gap between "a reconciler is renderer-
agnostic" (true, and the architecture held up) and "therefore React just runs
anywhere" (false). The reconciler was never the problem. The problems were the
*ambient assumptions*: that there is a console, a `setTimeout`, a deep stack, a
large heap, an unfrozen `Object.prototype`, and that `Fragment` is free. None of
these are in the host config; all of them are in the environment.

---

## 7. Evaluation

We report what we can measure honestly; we did not build a rigorous benchmark
harness, and we avoid inventing latency or frame-rate numbers.

- **It runs.** On the target hardware the firmware boots once (no reset loop),
  initializes I²C, mounts the tree, and renders. The serial trace reads
  `##BOOT## ##DISPLAY-OK## ##MOUNT-OK##`. "Hello world" appears on the OLED. The
  button-driven `useState` counter increments on each BOOT press, confirming that
  reconciliation, the commit phase, and the dirty-page flush all work on-device.
- **Footprint.** The flashed application image (`xs_esp32.bin`) is roughly
  **0.5 MB** (≈ 502 KB for the Hello-world release build; ≈ 546 KB for the
  instrumented counter build), plus an 18 KB bootloader and a 3 KB partition
  table, in a 4 MB flash. The framebuffer is 1 KB of the SRAM budget.
- **Correctness oracle.** The host simulator runs the identical driver and
  renderer and matches the device's framebuffer; its pixel-exact test (123 lit
  pixels for "Hello world", and `Count: 0` → `Count: 1` on a simulated press)
  passes. This gives confidence that what the simulator shows is what the panel
  shows.
- **I²C traffic (measured).** With dirty-rectangle rendering (§3.2), a one-increment
  counter update ships **280 bytes** over I²C versus **1,120 bytes** for a
  full-screen repaint — **4.0× less** — counted by instrumenting the simulator's
  mock bus. A regression test asserts the incrementally-rendered framebuffer is
  byte-identical to a from-scratch repaint (no ghosting), including the `9 → 10`
  width change.
- **Memory (measured live).** The instrumented build's own telemetry, read over
  serial, reports ~**177 KB** of system heap free after mount, with XS holding a
  32 KB chunk heap (~26 KB used, dropping to ~9 KB after GC), a ~38 KB slot heap,
  and a runtime stack peaking at **9 KB of its 32 KB** — closely matching the
  ~170 KB free we had projected from the manifest's `creation` sizes. GC fires
  frequently under full re-renders.
- **Build economics.** The first firmware build (cold-compiling all of ESP-IDF +
  XS) takes ~10–15 minutes; incremental rebuilds after a source change take
  seconds. Iteration speed therefore comes almost entirely from the host
  simulator, not the device.

The I²C-traffic and memory figures above are measured; a fuller quantitative
evaluation — GC-pause distribution under rapid state changes and worst-case update
latency in milliseconds — remains future work (§9).

---

## 8. Related work

- **Custom React renderers.** Alpert's React Conf 2017 talk established the
  reconciler/renderer split as a public API (`react-reconciler`).
- **Non-DOM renderers.** `react-three-fiber` (WebGL scene graphs), `ink` (CLI),
  `react-nil` (no output), `react-pdf`, and `react-tv` all render React trees to
  non-DOM targets — but on hosts with abundant resources.
- **JavaScript on microcontrollers.** Moddable XS, Espruino, and MicroPython (for
  Python) show that high-level languages are viable on MCUs. Moddable in
  particular targets the ESP32 and provides the I²C/GPIO modules we build on.
- **Embedded UI frameworks.** LVGL and Adafruit-GFX are the conventional way to
  drive an SSD1306; they are imperative C/C++ libraries. Our contribution is not a
  better display library but the demonstration that a *declarative, diffing*
  component model from the web stack can sit on top of one.

To our knowledge, the specific combination — a React-family reconciler running
*on* a microcontroller (not streaming from a host) and driving a physical display,
together with the XS-specific failure catalogue — has not been documented.

---

## 9. Limitations and future work

- **Preact, not React.** Stated up front (§1). Porting full React +
  `react-reconciler` would require either much more SRAM or substantial slimming;
  the host-config interface, however, is the same, so the architecture argument is
  unaffected.
- **Monochrome, tiny tree.** The demo keeps the component tree deliberately small.
  Memory pressure and GC behavior under large or rapidly-changing trees are
  unmeasured.
- **A dependency patch.** Re-renders depend on patching Preact's `assign` (§6.8).
  Upstreaming an XS-safe `assign` (or an XS option to keep `Object.prototype`
  mutable) would remove the patch. This is the most important loose end.
- **The hybrid fallback.** If on-chip execution were ever blocked, the same host
  config could run in Node on a laptop and stream draw operations over serial to a
  thin blit-only firmware. The architecture story would be identical; only the
  location of the reconciler changes. We did not need this path, but it bounds the
  risk.
- **Benchmarks.** Bus-traffic and post-mount memory are now measured (§7: 280 vs
  1,120 bytes per update; ~177 KB free). GC-pause distribution and worst-case
  update latency in milliseconds remain.

---

## 10. Conclusion

We set out to falsify, as strongly as possible, the idea that React needs the
browser. We removed the browser, the OS, the network, the DOM, and even the global
`setTimeout`, and ran a component tree on a $5 microcontroller, painting pixels to
an OLED. The reconciler — the part everyone associates with "React" — ported
without modification. What fought back was the environment: a frozen
`Object.prototype`, a missing console, a 40-byte I²C ceiling, a shallow stack, an
absent timer, and a `Fragment` that secretly costs a component. Each was silent;
each was fixable; none lived in the host config.

The practical takeaway for anyone retargeting a reconciler is therefore inverted
from the intuition: do not worry about the diffing algorithm — it is genuinely
portable. Worry about the ten things the framework assumes about its host that no
one ever wrote down. We wrote eight of them down here.

The DOM was never essential. The proof is now sitting on a desk, blinking.

---

## Appendix A: Reproducing

```sh
# Host (no hardware): pixel-exact tests + terminal simulator
npm install          # also runs scripts/patch-preact.mjs (postinstall)
npm test             # real driver+renderer vs mock I²C, asserts the framebuffer
npm run sim          # live counter in the terminal; press SPACE

# Device: build + flash (Moddable SDK + ESP-IDF v6.0 required)
scripts/flash.sh                 # release build
scripts/flash.sh instrument      # serial console on, for trace()
```

## Appendix B: Source map

| File | Role |
|------|------|
| `src/renderer.js` | custom Preact renderer = minimal-DOM host config → framebuffer |
| `src/display.js`  | 1bpp framebuffer + SSD1306 init + dirty-page, chunked I²C flush |
| `src/font.js`     | 5×7 bitmap font |
| `src/button.js`   | debounced BOOT-button (GPIO0) input via `Monitor` |
| `src/App.jsx`     | `Hello world` |
| `src/Counter.jsx` | button-driven `useState` counter (host `<group>` wrapper) |
| `src/main.js`     | entry: wire OLED to renderer, mount |
| `manifest.json`   | Moddable build manifest (modules, preload, `creation`) |
| `scripts/patch-preact.mjs` | XS-safe `assign` patch (postinstall) |
| `scripts/flash.sh` | one-command build + flash |
| `test/`           | host simulator, mock I²C/timer/button, pixel-exact tests |

---

*Companion to the React India 2026 talk on running React in non-web environments.
The running code is Preact; the architecture lesson is React's.*
