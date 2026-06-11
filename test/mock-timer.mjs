// Mock of Moddable's "timer" module. Stores callbacks so a test can fire them
// deterministically instead of waiting on wall-clock time.
const callbacks = new Map();
let nextId = 1;

const Timer = {
	repeat(cb, ms) {
		const id = nextId++;
		callbacks.set(id, cb);
		return id;
	},
	clear(id) {
		callbacks.delete(id);
	},
	// test helper, not part of the real API
	_fireAll() {
		for (const cb of callbacks.values()) cb();
	},
};

export default Timer;
