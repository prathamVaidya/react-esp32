// Like loader.mjs, but maps "timer" to a real-timer implementation so the live
// OLED preview actually ticks. Used by test/preview.mjs.
const map = {
	font: new URL("../src/font.js", import.meta.url).href,
	display: new URL("../src/display.js", import.meta.url).href,
	renderer: new URL("../src/renderer.js", import.meta.url).href,
	App: new URL("../build/App.js", import.meta.url).href,
	Counter: new URL("../build/Counter.js", import.meta.url).href,
	Dashboard: new URL("../build/Dashboard.js", import.meta.url).href,
	button: new URL("./mock-button.mjs", import.meta.url).href,
	"pins/i2c": new URL("./mock-i2c.mjs", import.meta.url).href,
	timer: new URL("./node-timer.mjs", import.meta.url).href,
};

export async function resolve(specifier, context, next) {
	if (map[specifier]) return { url: map[specifier], shortCircuit: true };
	return next(specifier, context);
}
