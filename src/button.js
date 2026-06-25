/*
 * button.js — a debounced push-button input (on-device implementation).
 *
 * Defaults to GPIO0, the BOOT button present on most ESP32-WROOM devkits. (The
 * ESP32 has no dedicated "power" button; EN is a hard reset and can't be read,
 * so BOOT is the usable onboard button.) Wire an external button to any GPIO and
 * pass { pin } to use that instead.
 *
 * The sim swaps this module for test/mock-button.mjs (Space key) — same API, so
 * the component code is identical on hardware and on the laptop.
 */

import Digital from "pins/digital";
import Monitor from "pins/digital/monitor";

const BOOT_BUTTON = 0; // GPIO0 (always present)

// Optional extra buttons. Wire each to GND; the internal pull-up holds an
// unwired pin HIGH so it never fires — they're genuinely optional. GPIO25/26 are
// free on a WROOM, are NOT strapping pins (so leaving them unwired never affects
// boot), and support a pull-up. Override via onControls({ pinNext, pinSelect }).
const PIN_NEXT = 25; // optional "next / change" button -> GND
const PIN_SELECT = 26; // optional "select / confirm / back" button -> GND

/**
 * Call `callback` once per button press. Returns an unsubscribe function.
 *   const off = onButton(() => ...);  // later: off();
 */
export function onButton(callback, options = {}) {
	const pin = options.pin === undefined ? BOOT_BUTTON : options.pin;
	const debounceMs = options.debounceMs === undefined ? 50 : options.debounceMs;

	// Active-low button: idle reads high (pull-up), pressed pulls low -> Falling.
	const monitor = new Monitor({
		pin,
		mode: Digital.InputPullUp,
		edge: Monitor.Falling,
	});

	let debouncing = false;
	monitor.onChanged = function () {
		if (debouncing) return;
		debouncing = true;
		// global setTimeout is installed by renderer.js (Moddable Timer-backed).
		setTimeout(() => (debouncing = false), debounceMs);
		callback();
	};

	return () => monitor.close();
}

/**
 * Tap-vs-hold gesture input on a single button. Watches both edges and times the
 * press: a release before `holdMs` fires onTap, longer fires onHold.
 *   const off = onGesture({ onTap, onHold });
 */
export function onGesture(handlers, options = {}) {
	const pin = options.pin === undefined ? BOOT_BUTTON : options.pin;
	const holdMs = options.holdMs === undefined ? 500 : options.holdMs;

	const monitor = new Monitor({
		pin,
		mode: Digital.InputPullUp,
		edge: Monitor.Rising | Monitor.Falling,
	});

	let pressAt = 0;
	monitor.onChanged = function () {
		const pressed = this.read() === 0; // active-low
		const now = Date.now();
		if (pressed) {
			pressAt = now;
			return;
		}
		const dur = now - pressAt;
		if (dur < 25) return; // ignore contact bounce
		if (dur >= holdMs) handlers.onHold && handlers.onHold();
		else handlers.onTap && handlers.onTap();
	};

	return () => monitor.close();
}

/**
 * Wire all three UI inputs at once. Returns one unsubscribe for everything.
 *   - BOOT (GPIO0):    tap -> onNext, hold -> onSelect   (works with one button)
 *   - NEXT button:     press -> onNext                   (optional, GPIO25)
 *   - SELECT button:   press -> onSelect                 (optional, GPIO26)
 * The extra buttons just make navigation easier; nothing breaks if they're absent.
 */
export function onControls(handlers, options = {}) {
	const onNext = handlers.onNext || (() => {});
	const onSelect = handlers.onSelect || (() => {});
	const pinNext = options.pinNext === undefined ? PIN_NEXT : options.pinNext;
	const pinSelect = options.pinSelect === undefined ? PIN_SELECT : options.pinSelect;

	const offs = [
		onGesture({ onTap: onNext, onHold: onSelect }, { pin: BOOT_BUTTON, holdMs: options.holdMs }),
		onButton(onNext, { pin: pinNext }),
		onButton(onSelect, { pin: pinSelect }),
	];
	return () => offs.forEach((o) => o());
}
