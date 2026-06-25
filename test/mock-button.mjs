// Mock of src/button.js for host-side use.
//   onButton(cb)                  -> Space (the simple counter)
//   onControls({onNext,onSelect}) -> Space = next, Enter = select (the dashboard;
//                                    on hardware these map to BOOT tap/hold +
//                                    optional NEXT/SELECT buttons)
// The smoke test drives them via _press()/_next()/_select().
const callbacks = new Set();
const controls = new Set();
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
				next(); //          -> onControls next
			} else if (byte === 0x0d) {
				select(); // Enter -> onControls select
			} else if (byte === 0x03 || byte === 0x71) {
				process.exit(0); // Ctrl-C or q
			}
		}
	});
}

function press() {
	for (const cb of callbacks) cb();
}
function next() {
	for (const c of controls) if (c.onNext) c.onNext();
}
function select() {
	for (const c of controls) if (c.onSelect) c.onSelect();
}

export function onButton(callback) {
	wireKeyboard();
	callbacks.add(callback);
	return () => callbacks.delete(callback);
}

export function onControls(handlers) {
	wireKeyboard();
	controls.add(handlers);
	return () => controls.delete(handlers);
}

// Test helpers: drive the inputs without keyboard input.
export function _press() {
	press();
}
export function _next() {
	next();
}
export function _select() {
	select();
}
