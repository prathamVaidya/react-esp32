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
import { FONT_HEIGHT, FONT_WIDTH } from "font";
import Timer from "timer";

const GLYPH_ADVANCE = FONT_WIDTH + 1; // px a character advances (matches display.drawChar)

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
		markDirty(this.parentNode); // the drawable <text> element owns this content
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
		markDirty(child.nodeType === 3 ? this : child);
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
		markDirty(child.nodeType === 3 ? this : child);
		return child;
	}

	// host config: removeChild
	removeChild(child) {
		const i = this.childNodes.indexOf(child);
		if (i >= 0) this.childNodes.splice(i, 1);
		const wasText = child.nodeType === 3;
		child.parentNode = null;
		if (wasText) markDirty(this); // this <text> lost some content
		else markRemoved(child); // erase wherever the removed element drew
		return child;
	}

	// host config: commitUpdate (a prop was set)
	setAttribute(name, value) {
		this.attrs[name] = value;
		markDirty(this);
	}

	// host config: commitUpdate (a prop was removed)
	removeAttribute(name) {
		delete this.attrs[name];
		markDirty(this);
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
let hasBaseline = false; // false until the first full paint establishes the image
let fullDirty = false; // structural/ambiguous change -> repaint everything

// Incremental state: which drawable nodes changed since the last paint, and the
// regions vacated by removed nodes (which must be erased).
const dirtyNodes = new Set();
const removedBoxes = [];

const DRAWABLE = { text: 1, label: 1, rect: 1, box: 1, pixel: 1 };

function schedulePaint() {
	if (paintScheduled || !activeDisplay) return;
	paintScheduled = true;
	Promise.resolve().then(paint);
}

// Record a changed node. Drawables get tracked precisely (dirty-rectangle);
// anything else (groups, structural changes, detached text) falls back to a
// full repaint, which is always correct — just not minimal.
function markDirty(node) {
	if (node && node.nodeType === 1 && DRAWABLE[node.localName]) dirtyNodes.add(node);
	else fullDirty = true;
	schedulePaint();
}

function markRemoved(node) {
	const b = node && node.nodeType === 1 ? node._bbox || bboxOf(node) : null;
	if (b) removedBoxes.push(b);
	else fullDirty = true;
	schedulePaint();
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

// The framebuffer region a drawable node occupies (null = nothing to draw).
function bboxOf(node) {
	if (!node || node.nodeType !== 1) return null;
	const a = node.attrs;
	switch (node.localName) {
		case "text":
		case "label": {
			const parts = [];
			collectText(node, parts);
			const len = parts.join("").length;
			if (len === 0) return null;
			return { x: toInt(a.x, 0), y: toInt(a.y, 0), w: len * GLYPH_ADVANCE, h: FONT_HEIGHT };
		}
		case "rect":
		case "box": {
			const w = toInt(a.w, toInt(a.width, 0));
			const h = toInt(a.h, toInt(a.height, 0));
			if (w <= 0 || h <= 0) return null;
			return { x: toInt(a.x, 0), y: toInt(a.y, 0), w, h };
		}
		case "pixel":
			return { x: toInt(a.x, 0), y: toInt(a.y, 0), w: 1, h: 1 };
		default:
			return null; // groups don't draw anything themselves
	}
}

function unionRect(a, b) {
	if (!a) return b;
	if (!b) return a;
	const x1 = Math.min(a.x, b.x);
	const y1 = Math.min(a.y, b.y);
	const x2 = Math.max(a.x + a.w, b.x + b.w);
	const y2 = Math.max(a.y + a.h, b.y + b.h);
	return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function intersects(a, b) {
	if (!a || !b) return false;
	return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function clampRect(r) {
	const x = Math.max(0, r.x);
	const y = Math.max(0, r.y);
	const x2 = Math.min(activeDisplay.width, r.x + r.w);
	const y2 = Math.min(activeDisplay.height, r.y + r.h);
	return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

// Draw a single node's primitive (no recursion); groups draw nothing.
function drawPrimitive(node, display) {
	const a = node.attrs;
	const on = a.color !== "off" && a.color !== 0 && a.color !== false;
	switch (node.localName) {
		case "text":
		case "label": {
			const parts = [];
			collectText(node, parts);
			display.drawText(toInt(a.x, 0), toInt(a.y, 0), parts.join(""), on);
			break;
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
		case "pixel":
			display.setPixel(toInt(a.x, 0), toInt(a.y, 0), on);
			break;
	}
}

// Walk the tree, refreshing each node's stored bbox. rect === null draws every
// node (full paint); otherwise only nodes intersecting rect are drawn.
function walk(node, display, rect) {
	if (node.nodeType !== 1) return;
	const bb = bboxOf(node);
	if (bb) {
		node._bbox = bb;
		if (rect === null || intersects(bb, rect)) drawPrimitive(node, display);
	}
	const kids = node.childNodes;
	for (let i = 0; i < kids.length; i++) walk(kids[i], display, rect);
}

function fullPaint() {
	activeDisplay.clear();
	const kids = activeRoot.childNodes;
	for (let i = 0; i < kids.length; i++) walk(kids[i], activeDisplay, null);
	activeDisplay.flush();
	hasBaseline = true;
	dirtyNodes.clear();
	removedBoxes.length = 0;
	fullDirty = false;
}

function incrementalPaint() {
	// The region that may have changed = union of each dirty node's old + new
	// bbox, plus the regions vacated by removed nodes.
	let rect = null;
	for (const node of dirtyNodes) {
		rect = unionRect(rect, node._bbox || null);
		rect = unionRect(rect, bboxOf(node));
	}
	for (let i = 0; i < removedBoxes.length; i++) rect = unionRect(rect, removedBoxes[i]);
	dirtyNodes.clear();
	removedBoxes.length = 0;
	if (!rect) return;

	rect = clampRect(rect);
	if (rect.w <= 0 || rect.h <= 0) return;

	// Erase the dirty rectangle, then redraw every node that overlaps it (in
	// tree/paint order, which handles overlap). Only the pages this region spans
	// get marked dirty, so flush() ships just those — not the whole screen.
	activeDisplay.fillRect(rect.x, rect.y, rect.w, rect.h, false);
	const kids = activeRoot.childNodes;
	for (let i = 0; i < kids.length; i++) walk(kids[i], activeDisplay, rect);
	activeDisplay.flush();
}

function paint() {
	paintScheduled = false;
	if (!activeDisplay || !activeRoot) return;
	if (!hasBaseline || fullDirty) fullPaint();
	else incrementalPaint();
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
	hasBaseline = false;
	fullDirty = false;
	dirtyNodes.clear();
	removedBoxes.length = 0;
	render(vnode, activeRoot);
	paint(); // first paint is full: establishes the baseline image + node bboxes
	return activeRoot;
}

/**
 * Force a full repaint of the current tree (clear + redraw everything). Used by
 * tests to assert the incrementally-rendered framebuffer matches a from-scratch
 * render (i.e. no ghosting).
 */
export function forceRepaint() {
	if (activeDisplay && activeRoot) fullPaint();
}
