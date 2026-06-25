// Host-side smoke test: runs the REAL display.js + renderer.js + compiled App
// against a mock I2C bus, then checks the reconstructed framebuffer matches what
// the 5x7 font says "Hello world" should look like. Catches pipeline bugs
// (scene graph, page packing, glyph drawing) before any hardware is involved.
//
// Run:  npm test   (which is: node --import ./test/register.mjs test/smoke.mjs)

import { h } from "preact";
import { useState, useEffect } from "preact/hooks";
import { glyphFor, FONT_WIDTH, FONT_HEIGHT } from "font";
import Display from "display";
import { mount, forceRepaint } from "renderer";
import App from "App";
import Counter from "Counter";

let failures = 0;
function check(cond, msg) {
	if (cond) {
		console.log(`  ok   ${msg}`);
	} else {
		console.log(`  FAIL ${msg}`);
		failures++;
	}
}
const tick = () => new Promise((r) => setTimeout(r, 0));
// preact/hooks flushes effects on a ~35ms fallback timer when there's no rAF.
const flushEffects = () => new Promise((r) => setTimeout(r, 60));

// Compute the set of lit pixels the font implies for a string at (x0, y0),
// mirroring display.drawText's layout (advance = FONT_WIDTH + 1).
function expectedPixels(str, x0, y0) {
	const lit = new Set();
	let cx = x0;
	for (const ch of str) {
		const g = glyphFor(ch);
		for (let row = 0; row < FONT_HEIGHT; row++)
			for (let col = 0; col < FONT_WIDTH; col++)
				if (g[row] & (1 << (FONT_WIDTH - 1 - col)))
					lit.add(`${cx + col},${y0 + row}`);
		cx += FONT_WIDTH + 1;
	}
	return lit;
}

function litPixels(i2c) {
	const lit = new Set();
	for (let y = 0; y < 64; y++)
		for (let x = 0; x < 128; x++)
			if (i2c.getPixel(x, y)) lit.add(`${x},${y}`);
	return lit;
}

console.log("Test 1: <App/> renders 'Hello world'");
{
	const display = new Display({ sda: 21, scl: 22, address: 0x3c });
	mount(h(App, null), display);
	await tick(); // let the coalesced repaint microtask run

	const got = litPixels(display.i2c);
	const want = expectedPixels("Hello world", 0, 0);

	check(got.size > 0, "framebuffer has lit pixels");
	check(got.size === want.size, `lit pixel count matches font (${got.size} === ${want.size})`);

	let mismatched = 0;
	for (const p of want) if (!got.has(p)) mismatched++;
	for (const p of got) if (!want.has(p)) mismatched++;
	check(mismatched === 0, `every lit pixel matches the expected glyphs (${mismatched} off)`);
}

console.log("Test 2: <Counter/> increments on button press");
{
	const { _press } = await import("button");
	const display = new Display({ sda: 21, scl: 22, address: 0x3c });
	mount(h(Counter, null), display);
	await flushEffects(); // let useEffect run and subscribe to the button

	const before = litPixels(display.i2c);
	const wantZero = expectedPixels("Count: 0", 0, 12);
	let zeroOk = true;
	for (const p of wantZero) if (!before.has(p)) zeroOk = false;
	check(zeroOk, "initial frame shows 'Count: 0'");

	_press(); // simulate a button press -> setN(v => v + 1)
	await tick();
	const after = litPixels(display.i2c);
	const wantOne = expectedPixels("Count: 1", 0, 12);
	let oneOk = true;
	for (const p of wantOne) if (!after.has(p)) oneOk = false;
	check(oneOk, "after one press shows 'Count: 1' (reconciler diffed + recommitted)");
}

console.log("Test 3: incremental render matches a full repaint (no ghosting)");
{
	const { _press } = await import("button");
	const display = new Display({ sda: 21, scl: 22, address: 0x3c });
	mount(h(Counter, null), display);
	await flushEffects();
	for (let i = 0; i < 12; i++) {
		_press(); // 0 -> 12: also exercises the '9'->'10' width change
		await tick();
	}
	const incremental = Uint8Array.from(display.i2c.fb); // snapshot after incremental updates
	forceRepaint(); // redraw the same tree from scratch
	let diff = 0;
	for (let i = 0; i < incremental.length; i++)
		if (incremental[i] !== display.i2c.fb[i]) diff++;
	check(diff === 0, `framebuffer identical to full repaint (${diff} bytes differ)`);
}

console.log("Test 4: dirty-rectangle cuts I2C traffic on a localized update");
{
	const { _press } = await import("button");
	const display = new Display({ sda: 21, scl: 22, address: 0x3c });
	mount(h(Counter, null), display);
	await flushEffects();

	display.i2c.resetCounters();
	_press(); // one increment -> only the "Count: N" line changes
	await tick();
	const incrementalBytes = display.i2c.bytes;

	display.i2c.resetCounters();
	forceRepaint(); // what a naive full-screen flush would cost
	const fullBytes = display.i2c.bytes;

	const ratio = (fullBytes / incrementalBytes).toFixed(1);
	console.log(`       one-increment update: ${incrementalBytes} B  vs  full repaint: ${fullBytes} B  (${ratio}x less)`);
	check(incrementalBytes < fullBytes / 2, `localized update ships <half the bytes of a full repaint`);
}

console.log("Test 5: useEffect([]) runs once across re-renders (hooks sanity)");
{
	let effectRuns = 0;
	let cleanupRuns = 0;
	let setN;
	function Probe() {
		const [n, set] = useState(0);
		setN = set;
		useEffect(() => {
			effectRuns++;
			return () => {
				cleanupRuns++;
			};
		}, []);
		return h("text", { x: 0, y: 0 }, "n=" + n);
	}
	const display = new Display({ sda: 21, scl: 22, address: 0x3c });
	mount(h(Probe, null), display);
	await flushEffects();
	for (let i = 0; i < 5; i++) {
		setN((v) => v + 1); // re-render without changing the (empty) deps
		await tick();
	}
	await flushEffects();
	check(effectRuns === 1, `effect ran once across 5 re-renders (ran ${effectRuns}x)`);
	check(cleanupRuns === 0, `cleanup did not misfire (${cleanupRuns}x)`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
