/*
 * App.jsx — the Hello world UI. Plain Preact; the only unusual thing is the
 * element vocabulary (<text>, <rect>, <pixel>) defined by our renderer instead
 * of <div>/<span>. JSX compiles to h() calls via babel (see babel.config.json).
 *
 * The button-driven Counter lives in Counter.jsx so this module has no GPIO /
 * pins dependency — mount <Counter/> from main.js when you want that demo.
 */

import { h } from "preact";

// Milestone target: render "Hello world" to the OLED.
export default function App() {
	return <text x={0} y={0}>Hello world</text>;
}
