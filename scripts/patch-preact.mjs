/*
 * patch-preact.mjs — make Preact survive Moddable XS's frozen built-ins.
 *
 * Moddable XS puts the built-in prototypes in ROM, so `Object.prototype.constructor`
 * is non-writable. Preact's `assign` helper (`function m(n,l){for(var u in l)n[u]=l[u]}`)
 * copies a vnode's own `constructor: void 0` property on every UPDATE via
 * `assign({}, vnode)`. On XS that assignment goes through the frozen prototype and
 * throws `TypeError: set constructor: not writable` — so the first render works but
 * every re-render (setState/hooks) crashes.
 *
 * Fix: rewrite `assign` to define `constructor` as an own property with
 * Object.defineProperty (which bypasses the frozen prototype) and copy everything
 * else normally. Idempotent; run from npm "postinstall".
 */
import { readFileSync, writeFileSync } from "node:fs";

const FILE = new URL("../node_modules/preact/dist/preact.module.js", import.meta.url);
const FROM = "function m(n,l){for(var u in l)n[u]=l[u];return n}";
const TO =
	'function m(n,l){for(var u in l)"constructor"==u?Object.defineProperty(n,u,{value:l[u],writable:!0,configurable:!0,enumerable:!0}):n[u]=l[u];return n}';

let src;
try {
	src = readFileSync(FILE, "utf8");
} catch {
	console.log("[patch-preact] preact not installed yet; skipping");
	process.exit(0);
}

if (src.includes(TO)) {
	console.log("[patch-preact] already patched");
} else if (src.includes(FROM)) {
	writeFileSync(FILE, src.replace(FROM, TO));
	console.log("[patch-preact] patched assign() for Moddable XS frozen built-ins");
} else {
	console.error(
		"[patch-preact] WARNING: preact's assign() signature changed — patch not applied. " +
			"Re-check the XS frozen-constructor workaround against the new preact version.",
	);
	process.exit(1);
}
