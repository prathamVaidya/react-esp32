// ESM resolver hook that maps the Moddable bare-specifier imports
// ("font", "display", "renderer", "pins/i2c", "timer", "App") to local files
// or mocks, so the firmware modules can be exercised under Node unchanged.
const map = {
	font: new URL("../src/font.js", import.meta.url).href,
	display: new URL("../src/display.js", import.meta.url).href,
	renderer: new URL("../src/renderer.js", import.meta.url).href,
	App: new URL("../build/App.js", import.meta.url).href,
	Counter: new URL("../build/Counter.js", import.meta.url).href,
	Dashboard: new URL("../build/Dashboard.js", import.meta.url).href,
	button: new URL("./mock-button.mjs", import.meta.url).href,
	"pins/i2c": new URL("./mock-i2c.mjs", import.meta.url).href,
	timer: new URL("./mock-timer.mjs", import.meta.url).href,
};

export async function resolve(specifier, context, next) {
	if (map[specifier]) return { url: map[specifier], shortCircuit: true };
	return next(specifier, context);
}
