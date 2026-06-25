// Mock of src/button.js for host-side use.
//   onButton(cb)            -> fires on Space (the simple counter)
//   onGesture({onTap,onHold}) -> Space = tap, Enter = hold (the dashboard)
// The smoke test drives them programmatically via _press()/_tap()/_hold().
const callbacks = new Set();
const gestures = new Set();
let wired = false;

function wireKeyboard() {
	if (wired) return;
	wired = true;
	const stdin = process.stdin;
	if (!stdin || typeof stdin.on !== "function") return;
	if (stdin.isTTY) stdin.setRawMode(true);
	stdin.resume();
	stdin.on("data", (buf) => {
		for (const byte of buf) {
			if (byte === 0x20) {
				press(); // Space -> onButton press
				tap(); //          -> onGesture tap
			} else if (byte === 0x0d) {
				hold(); // Enter -> onGesture hold
			} else if (byte === 0x03 || byte === 0x71) {
				process.exit(0); // Ctrl-C or q
			}
		}
	});
}

function press() {
	for (const cb of callbacks) cb();
}
function tap() {
	for (const g of gestures) if (g.onTap) g.onTap();
}
function hold() {
	for (const g of gestures) if (g.onHold) g.onHold();
}

export function onButton(callback) {
	wireKeyboard();
	callbacks.add(callback);
	return () => callbacks.delete(callback);
}

export function onGesture(handlers) {
	wireKeyboard();
	gestures.add(handlers);
	return () => gestures.delete(handlers);
}

// Test helpers: drive the button without keyboard input.
export function _press() {
	press();
}
export function _tap() {
	tap();
}
export function _hold() {
	hold();
}
