/*
 * main.js — Moddable entry point. Wires the OLED to the Preact renderer and
 * mounts the app. The chip runs this; nothing is on a laptop at runtime.
 *
 * The trace() lines are no-ops in a release build (serial console disabled) and
 * visible at 115200 in an instrumented build (mcconfig -i) for bring-up.
 */

import { h } from "preact";
import Display from "display";
import { mount } from "renderer";
// import App from "App";          // Hello world milestone
import Counter from "Counter"; // button-driven demo (BOOT button = GPIO0)

trace("##BOOT##\n");

try {
	// I2C SSD1306 at 0x3C, SDA -> GPIO21, SCL -> GPIO22 (the POC plan's wiring).
	const display = new Display({ sda: 21, scl: 22, address: 0x3c, hz: 400000 });
	trace("##DISPLAY-OK##\n");

	// mount(h(App, null), display);     // Hello world
	mount(h(Counter, null), display); // press BOOT (GPIO0) to increment
	trace("##MOUNT-OK##\n");
} catch (e) {
	trace(`##ERR: ${e}##\n`);
}
