/*
 * Counter.jsx — button-driven counter (bonus demo). Each press of the BOOT
 * button (GPIO0) bumps the count, proving the reconciler diffs and our host
 * config re-commits on every state change. In the sim, press Space.
 *
 * Two Moddable-XS notes baked into this file's design:
 *   - Uses a host <group> wrapper, NOT <Fragment>: preact instantiates Fragment
 *     as a component (`h.constructor = Fragment`), which throws under XS. A plain
 *     host element costs nothing (our renderer treats unknown tags as transparent
 *     groups that recurse their children).
 *   - Re-renders (setState) rely on the preact assign() patch in
 *     scripts/patch-preact.mjs; without it every increment throws
 *     "set constructor: not writable".
 */

import { h } from "preact";
import { useState, useEffect } from "preact/hooks";
import { onButton } from "button";

export default function Counter() {
	const [n, setN] = useState(0);

	useEffect(() => {
		const off = onButton(() => setN((v) => v + 1));
		return off;
	}, []);

	return (
		<group>
			<text x={0} y={0}>Preact + ESP32</text>
			<text x={0} y={12}>Count: {n}</text>
			<rect x={0} y={22} w={128} h={2} fill />
			<text x={0} y={40}>Press button +1</text>
		</group>
	);
}
