/*
 * renderer.js — a custom Preact renderer that paints to the OLED framebuffer.
 *
 * THE TALK IN ONE FILE
 * --------------------
 * React/Preact is a reconciler (diffs a component tree) plus a renderer (mutates
 * some target). react-dom's target is the DOM. Swap the renderer and you swap
 * the target. Here the target is a 128x64 OLED.
 *
 * Preact's reconciler talks to its target through a tiny set of host operations —
 * the same shape react-reconciler calls a "host config":
 *
 *     createInstance / createTextInstance   <- make a node
 *     appendChild / insertBefore / removeChild   <- move nodes around
 *     commitUpdate        <- a prop changed
 *     commitTextUpdate    <- text changed
 *
 * Unlike react-dom (which uses react-reconciler) Preact has its diff built in and
 * drives the target through a DOM-shaped object: document.createElement(...),
 * node.appendChild(...), node.setAttribute(...). So our "host config" takes the
 * form of a minimal DOM: a fake `document` plus Element/Text nodes whose
 * mutation methods ARE the host operations. We never build a real DOM — each
 * mutation just edits an in-memory scene graph and marks the screen dirty.
 *
 * WHY NOT preact-reconciler?
 * --------------------------
 * preact-reconciler exposes the exact react-reconciler host-config API and would
 * be the textbook fit — but v0.2.3 is browser-only: it subclasses HTMLElement,
 * calls customElements.define, and relies on super.appendChild / ownerSVGElement.
 * None of that exists under Moddable XS. This minimal-DOM host shim is the
 * on-chip path the POC plan anticipated; the architecture lesson is identical.
 *
 * Supported elements:
 *     <text x y [color="off"]>...</text>   draw a string (5x7 font)
 *     <rect x y w h [fill] [color]/>        outline, or filled when `fill` set
 *     <pixel x y [color]/>                  a single pixel
 * Anything else is treated as a transparent group: its children still render.
 */

import { render } from "preact";
import { FONT_HEIGHT } from "font";
import Timer from "timer";

const XHTML_NS = "http://www.w3.org/1999/xhtml";

// ---------------------------------------------------------------------------
// Scene-graph nodes. Their mutation methods are the host config (see header).
// ---------------------------------------------------------------------------

class TextNode {
	constructor(text) {
		this.nodeType = 3;
		this.parentNode = null;
		this._data = text == null ? "" : "" + text;
	}
	get data() {
		return this._data;
	}
	// Preact assigns `.data` when text changes -> this IS commitTextUpdate.
	set data(value) {
		this._data = value == null ? "" : "" + value;
		markDirty();
	}
}

class Element {
	constructor(type, namespaceURI) {
		this.nodeType = 1;
		this.localName = type;
		this.namespaceURI = namespaceURI || XHTML_NS;
		this.parentNode = null;
		this.childNodes = []; // a real Array so Preact's slice() works
		this.attrs = Object.create(null);
		this.style = {}; // Preact pokes dom.style when a style prop is present
	}

	get firstChild() {
		return this.childNodes.length ? this.childNodes[0] : null;
	}

	get nextSibling() {
		const parent = this.parentNode;
		if (!parent) return null;
		const i = parent.childNodes.indexOf(this);
		return i >= 0 && i + 1 < parent.childNodes.length
			? parent.childNodes[i + 1]
			: null;
	}

	// host config: appendChild
	appendChild(child) {
		if (child.parentNode) child.parentNode.removeChild(child);
		this.childNodes.push(child);
		child.parentNode = this;
		markDirty();
		return child;
	}

	// host config: insertBefore (ref === null means append)
	insertBefore(child, ref) {
		if (ref == null) return this.appendChild(child);
		if (child.parentNode) child.parentNode.removeChild(child);
		const i = this.childNodes.indexOf(ref);
		if (i < 0) this.childNodes.push(child);
		else this.childNodes.splice(i, 0, child);
		child.parentNode = this;
		markDirty();
		return child;
	}

	// host config: removeChild
	removeChild(child) {
		const i = this.childNodes.indexOf(child);
		if (i >= 0) this.childNodes.splice(i, 1);
		child.parentNode = null;
		markDirty();
		return child;
	}

	// host config: commitUpdate (a prop was set)
	setAttribute(name, value) {
		this.attrs[name] = value;
		markDirty();
	}

	// host config: commitUpdate (a prop was removed)
	removeAttribute(name) {
		delete this.attrs[name];
		markDirty();
	}

	// Our elements emit no events; stubs keep Preact's event path happy.
	addEventListener() {}
	removeEventListener() {}
}

// The fake `document` Preact's diff reaches for. createElement* are the
// "createInstance"/"createTextInstance" host operations.
const documentShim = {
	createElement(type) {
		return new Element(type, XHTML_NS);
	},
	createElementNS(ns, type) {
		return new Element(type, ns);
	},
	createTextNode(text) {
		return new TextNode(text);
	},
};

// Named host-config view of the same operations, for reference / the talk.
export const hostConfig = {
	createInstance: (type) => new Element(type, XHTML_NS),
	createTextInstance: (text) => new TextNode(text),
	appendChild: (parent, child) => parent.appendChild(child),
	insertBefore: (parent, child, ref) => parent.insertBefore(child, ref),
	removeChild: (parent, child) => parent.removeChild(child),
	commitUpdate: (inst, name, value) => inst.setAttribute(name, value),
	commitTextUpdate: (inst, text) => {
		inst.data = text;
	},
};

// Install the shim globally so Preact's `document.*` calls resolve to it.
// Preact only touches `document` inside diffing functions (not at import), so
// installing it before the first render() is sufficient.
export function installDOM() {
	if (typeof globalThis === "undefined") return;

	if (!globalThis.document) globalThis.document = documentShim;

	// preact/hooks flushes effects through global setTimeout / requestAnimationFrame.
	// Moddable XS ships neither as a global (it has the "timer" module instead),
	// so without these shims useEffect would never run on the chip. Back them
	// with Moddable's Timer. Guarded so we never clobber a host that has them
	// (e.g. Node during tests).
	if (!globalThis.setTimeout) {
		globalThis.setTimeout = (cb, ms) => Timer.set(cb, ms | 0);
		globalThis.clearTimeout = (id) => id != null && Timer.clear(id);
		globalThis.setInterval = (cb, ms) => Timer.repeat(cb, ms | 0);
		globalThis.clearInterval = (id) => id != null && Timer.clear(id);
	}
}
installDOM();

// ---------------------------------------------------------------------------
// Commit -> paint. Every node mutation marks the tree dirty; we coalesce the
// repaints into one microtask so a burst of commits paints the screen once.
// ---------------------------------------------------------------------------

let activeDisplay = null;
let activeRoot = null;
let paintScheduled = false;

function markDirty() {
	if (paintScheduled || !activeDisplay) return;
	paintScheduled = true;
	Promise.resolve().then(paint);
}

function collectText(element, out) {
	const kids = element.childNodes;
	for (let i = 0; i < kids.length; i++) {
		const k = kids[i];
		if (k.nodeType === 3) out.push(k.data);
		else collectText(k, out);
	}
}

function toInt(v, fallback) {
	if (v == null) return fallback;
	const n = v | 0;
	return Number.isNaN(n) ? fallback : n;
}

function drawNode(node, display) {
	if (node.nodeType !== 1) return; // text nodes are drawn by their parent

	const a = node.attrs;
	const on = a.color !== "off" && a.color !== 0 && a.color !== false;

	switch (node.localName) {
		case "text":
		case "label": {
			const parts = [];
			collectText(node, parts);
			display.drawText(toInt(a.x, 0), toInt(a.y, 0), parts.join(""), on);
			return; // text content already consumed
		}
		case "rect":
		case "box": {
			const x = toInt(a.x, 0);
			const y = toInt(a.y, 0);
			const w = toInt(a.w, toInt(a.width, 0));
			const h = toInt(a.h, toInt(a.height, 0));
			const filled = a.fill !== undefined && a.fill !== false && a.fill !== "false";
			if (filled) display.fillRect(x, y, w, h, on);
			else display.drawRect(x, y, w, h, on);
			break;
		}
		case "pixel": {
			display.setPixel(toInt(a.x, 0), toInt(a.y, 0), on);
			break;
		}
		default:
			break; // unknown element = transparent group; just recurse
	}

	const kids = node.childNodes;
	for (let i = 0; i < kids.length; i++) drawNode(kids[i], display);
}

function paint() {
	paintScheduled = false;
	if (!activeDisplay || !activeRoot) return;
	activeDisplay.clear();
	const kids = activeRoot.childNodes;
	for (let i = 0; i < kids.length; i++) drawNode(kids[i], activeDisplay);
	activeDisplay.flush();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Mount a Preact element tree onto an OLED Display.
 *   mount(<App />, new Display())
 * Re-renders (setState/hooks) flow through the same host operations and repaint
 * automatically.
 */
export function mount(vnode, display) {
	installDOM();
	activeDisplay = display;
	activeRoot = new Element("root", XHTML_NS);
	render(vnode, activeRoot);
	paint(); // paint once up front; later commits schedule their own repaint
	return activeRoot;
}
