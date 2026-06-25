/*
 * Dashboard.jsx — a real-world, menu-driven device UI for the 128x64 OLED.
 *
 * The whole app is a finite-state machine in a single useReducer: TAP, HOLD and
 * TICK actions behave differently per `view`. This is the "complex state
 * management" demo — navigation, a settings toggle list, an adjustable value,
 * and live timer-driven data, all flowing through one reducer.
 *
 * Interaction (one button — BOOT/GPIO0):
 *   TAP  (short press / Space) = move / change       (next item, +10, ...)
 *   HOLD (long press  / Enter) = select / confirm / back
 *
 * Screens are plain functions returning a host <group> of <text>/<rect> nodes
 * (no nested components, so re-renders stay shallow on XS).
 */

import { h } from "preact";
import { useReducer, useEffect, useMemo } from "preact/hooks";
import { onControls } from "button";

const merge = (a, b) => Object.assign({}, a, b); // robust on XS (no object-spread)

const MENU = ["Status", "Network", "Settings", "Brightness"];
const SET_ITEMS = ["LED", "Sound", "Sleep", "Back"];
const SET_KEY = { LED: "led", Sound: "sound", Sleep: "sleep" };

const initial = {
	view: "menu",
	menuCursor: 0,
	setCursor: 0,
	settings: { led: true, sound: false, sleep: true },
	brightness: 60,
	uptime: 0,
	pkts: 1042,
};

function reducer(s, a) {
	switch (a.type) {
		case "TICK":
			return merge(s, { uptime: s.uptime + 1, pkts: s.pkts + 3 });

		case "TAP":
			switch (s.view) {
				case "menu":
					return merge(s, { menuCursor: (s.menuCursor + 1) % MENU.length });
				case "settings":
					return merge(s, { setCursor: (s.setCursor + 1) % SET_ITEMS.length });
				case "brightness":
					return merge(s, { brightness: (s.brightness + 10) % 110 });
				default:
					return s; // status / network are read-only
			}

		case "HOLD":
			switch (s.view) {
				case "menu":
					return merge(s, { view: MENU[s.menuCursor].toLowerCase() });
				case "settings": {
					const item = SET_ITEMS[s.setCursor];
					if (item === "Back") return merge(s, { view: "menu" });
					const k = SET_KEY[item];
					return merge(s, { settings: merge(s.settings, { [k]: !s.settings[k] }) });
				}
				default:
					return merge(s, { view: "menu" }); // status/network/brightness -> back
			}

		default:
			return s;
	}
}

// ---- layout helpers ----
function titleBar(t) {
	return [
		h("rect", { x: 0, y: 0, w: 128, h: 11, fill: true }),
		h("text", { x: 3, y: 2, color: "off" }, t),
	];
}
function footer(t) {
	return h("text", { x: 0, y: 56 }, t);
}
// A row that is highlighted (inverted) when selected.
function row(y, label, selected) {
	if (!selected) return h("text", { x: 4, y }, label);
	return h(
		"group",
		null,
		h("rect", { x: 0, y: y - 1, w: 128, h: 9, fill: true }),
		h("text", { x: 4, y, color: "off" }, label),
	);
}

// ---- screens (plain functions -> vnodes) ----
function MenuScreen(s) {
	const rows = MENU.map((label, i) => row(15 + i * 10, label, i === s.menuCursor));
	return h("group", null, ...titleBar("MAIN MENU"), ...rows, footer("tap:next  hold:open"));
}

function StatusScreen(s, mmss) {
	const load = 20 + ((s.uptime * 7) % 70);
	const barW = Math.max(1, ((load * 124) / 100) | 0);
	return h(
		"group",
		null,
		...titleBar("STATUS"),
		h("text", { x: 2, y: 15 }, "Uptime " + mmss),
		h("text", { x: 2, y: 26 }, "Load " + load + "%"),
		h("rect", { x: 2, y: 36, w: 124, h: 8 }),
		h("rect", { x: 2, y: 36, w: barW, h: 8, fill: true }),
		footer("Pkts " + s.pkts + "  hold:back"),
	);
}

function NetworkScreen(s) {
	const sig = 1 + (s.uptime % 4); // 1..4 bars, walking
	const bars = [0, 1, 2, 3].map((i) =>
		h("rect", { x: 92 + i * 8, y: 44 - (i + 1) * 4, w: 6, h: (i + 1) * 4, fill: i < sig }),
	);
	return h(
		"group",
		null,
		...titleBar("NETWORK"),
		h("text", { x: 2, y: 15 }, "SSID react-india"),
		h("text", { x: 2, y: 27 }, "IP 192.168.1.42"),
		h("text", { x: 2, y: 39 }, "Signal"),
		...bars,
		footer("hold:back"),
	);
}

function SettingsScreen(s) {
	const rows = SET_ITEMS.map((item, i) => {
		const label =
			item === "Back" ? "< Back" : item + ": " + (s.settings[SET_KEY[item]] ? "ON" : "off");
		return row(15 + i * 10, label, i === s.setCursor);
	});
	return h("group", null, ...titleBar("SETTINGS"), ...rows, footer("tap:move  hold:set"));
}

function BrightnessScreen(s) {
	const w = Math.max(1, ((s.brightness * 124) / 100) | 0);
	return h(
		"group",
		null,
		...titleBar("BRIGHTNESS"),
		h("text", { x: 2, y: 17 }, "Level " + s.brightness + "%"),
		h("rect", { x: 2, y: 30, w: 124, h: 13 }),
		h("rect", { x: 2, y: 30, w, h: 13, fill: true }),
		footer("tap:+10  hold:save"),
	);
}

export default function Dashboard() {
	const [state, dispatch] = useReducer(reducer, initial);

	useEffect(() => {
		const id = setInterval(() => dispatch({ type: "TICK" }), 1000);
		const off = onControls({
			onNext: () => dispatch({ type: "TAP" }), // NEXT button or BOOT tap
			onSelect: () => dispatch({ type: "HOLD" }), // SELECT button or BOOT hold
		});
		return () => {
			clearInterval(id);
			if (off) off();
		};
	}, []);

	// derived state
	const mmss = useMemo(() => {
		const m = (state.uptime / 60) | 0;
		const ss = state.uptime % 60;
		return (m < 10 ? "0" : "") + m + ":" + (ss < 10 ? "0" : "") + ss;
	}, [state.uptime]);

	switch (state.view) {
		case "status":
			return StatusScreen(state, mmss);
		case "network":
			return NetworkScreen(state);
		case "settings":
			return SettingsScreen(state);
		case "brightness":
			return BrightnessScreen(state);
		default:
			return MenuScreen(state);
	}
}
