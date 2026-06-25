// Mock of Moddable's "pins/i2c" for host-side testing. Emulates an SSD1306 in
// horizontal addressing mode: COLUMN_ADDR/PAGE_ADDR set the active window, and
// each data byte advances an auto-incrementing column pointer (wrapping to the
// next page), exactly like the real controller. This lets a test reconstruct the
// framebuffer even though display.js streams each page in <=40-byte chunks.
export default class I2C {
	constructor(options) {
		this.options = options;
		this.fb = new Uint8Array(1024); // 8 pages * 128 bytes
		this.colStart = 0;
		this.colEnd = 127;
		this.pageStart = 0;
		this.pageEnd = 7;
		this.curCol = 0;
		this.curPage = 0;
		this.writes = 0;
		this.bytes = 0; // total bytes pushed over the bus (for traffic measurement)
	}

	resetCounters() {
		this.writes = 0;
		this.bytes = 0;
	}

	write(...args) {
		this.writes++;
		const bytes = [];
		for (const a of args) {
			if (typeof a === "number") bytes.push(a);
			else for (const b of a) bytes.push(b); // typed array / array
		}
		this.bytes += bytes.length;
		if (bytes.length === 0) return;

		if (bytes[0] === 0x00) {
			// command stream
			let i = 1;
			while (i < bytes.length) {
				const cmd = bytes[i++];
				if (cmd === 0x21) {
					// COLUMN_ADDR: start, end
					this.colStart = bytes[i++];
					this.colEnd = bytes[i++];
					this.curCol = this.colStart;
				} else if (cmd === 0x22) {
					// PAGE_ADDR: start, end
					this.pageStart = bytes[i++];
					this.pageEnd = bytes[i++];
					this.curPage = this.pageStart;
				}
				// other commands (init, single-byte) carry no args here
			}
		} else if (bytes[0] === 0x40) {
			// data stream: advance the column pointer per byte
			for (let i = 1; i < bytes.length; i++) {
				this.fb[this.curPage * 128 + this.curCol] = bytes[i];
				if (++this.curCol > this.colEnd) {
					this.curCol = this.colStart;
					if (++this.curPage > this.pageEnd) this.curPage = this.pageStart;
				}
			}
		}
	}

	getPixel(x, y) {
		const page = y >> 3;
		return (this.fb[page * 128 + x] >> (y & 7)) & 1;
	}
}
