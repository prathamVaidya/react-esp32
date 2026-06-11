// Mock of src/button.js for host-side use. In the sim it fires on the Space key
// (read from stdin in raw mode); the smoke test fires it programmatically via
// the exported _press() helper. Same onButton() API as the device module.
const callbacks = new Set();
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
			if (byte === 0x20 || byte === 0x0d) press(); // Space or Enter
			else if (byte === 0x03 || byte === 0x71) process.exit(0); // Ctrl-C or q
		}
	});
}

function press() {
	for (const cb of callbacks) cb();
}

export function onButton(callback) {
	wireKeyboard();
	callbacks.add(callback);
	return () => callbacks.delete(callback);
}

// Test helper: simulate a press without keyboard input.
export function _press() {
	press();
}
