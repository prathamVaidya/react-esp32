// Real-timer implementation of Moddable's "timer" module, for the live OLED
// preview (test/preview.mjs). Unlike mock-timer.mjs (which stores callbacks for
// deterministic test firing), this drives them off Node's own timers so a
// <Counter/> actually ticks.
const Timer = {
	set(cb, ms) {
		return setTimeout(cb, ms | 0);
	},
	repeat(cb, ms) {
		return setInterval(cb, ms | 0);
	},
	clear(id) {
		clearTimeout(id);
		clearInterval(id);
	},
};

export default Timer;
