// Visual OLED preview — runs the REAL display.js + renderer.js against a mock
// I2C bus and prints the reconstructed 128x64 framebuffer to the terminal using
// Unicode half-blocks (two vertical pixels per character row). What you see is
// what the SSD1306 would show.
//
//   npm run sim            # live <Counter/> (Space = +1)
//   npm run sim app        # static "Hello world"
//   npm run sim dash       # menu dashboard (Space = tap, Enter = hold)
//
// Ctrl-C or q to quit.

import { h } from "preact";
import Display from "display";
import { mount } from "renderer";
import App from "App";
import Counter from "Counter";
import Dashboard from "Dashboard";

const arg = (process.argv[2] || "counter").toLowerCase();
const live = arg !== "app";
const Component = arg === "app" ? App : arg === "dash" || arg === "dashboard" ? Dashboard : Counter;
const HINT =
	arg === "dash" || arg === "dashboard"
		? "[Space] next   [Enter] select   [q]/Ctrl-C quit"
		: "[Space] press button +1    [q] / Ctrl-C quit";

const display = new Display({ sda: 21, scl: 22, address: 0x3c });
mount(h(Component, null), display);

const W = 128;
const H = 64;

function frame(i2c) {
	const top = "┌" + "─".repeat(W) + "┐";
	const bot = "└" + "─".repeat(W) + "┘";
	const lines = [top];
	for (let y = 0; y < H; y += 2) {
		let row = "│";
		for (let x = 0; x < W; x++) {
			const a = i2c.getPixel(x, y); // top pixel
			const b = i2c.getPixel(x, y + 1); // bottom pixel
			row += a && b ? "█" : a ? "▀" : b ? "▄" : " ";
		}
		lines.push(row + "│");
	}
	lines.push(bot);
	return lines.join("\n");
}

function paintTerminal() {
	const out = frame(display.i2c);
	if (live) {
		// Redraw in place: home the cursor, write the frame + hint, then erase
		// anything left below it. No scrolling, no stacked frames, minimal flicker.
		process.stdout.write("\x1b[H" + out + "\n" + HINT + "\x1b[0J");
	} else {
		process.stdout.write(out + "\n");
	}
}

if (!live) {
	// Static: one render, one print.
	setTimeout(() => {
		paintTerminal();
		process.exit(0);
	}, 50);
} else {
	process.stdout.write("\x1b[2J\x1b[?25l"); // clear screen, hide cursor
	const restore = () => process.stdout.write("\x1b[?25h\n"); // show cursor
	// mock-button puts stdin in raw mode and exits on Ctrl-C/q, so SIGINT may
	// not fire — restore the cursor on any exit path.
	process.on("exit", restore);

	// SIM_FRAMES=N exits after N frames (handy for non-interactive capture).
	const maxFrames = parseInt(process.env.SIM_FRAMES || "0", 10);
	let frames = 0;
	const id = setInterval(() => {
		paintTerminal();
		if (maxFrames && ++frames >= maxFrames) {
			clearInterval(id);
			process.exit(0); // 'exit' handler restores the cursor
		}
	}, 200);
	process.on("SIGINT", () => process.exit(0));
}
