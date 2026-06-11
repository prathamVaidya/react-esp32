/*
 * display.js — 1bpp framebuffer + I2C flush for a 0.96" SSD1306 OLED.
 *
 * The SSD1306 stores its 128x64 monochrome image as 8 "pages". A page is a
 * 128-byte row; each byte holds 8 vertically-stacked pixels (bit 0 = top pixel
 * of that page). So pixel (x, y) lives in:
 *
 *     page  = y >> 3              // which of the 8 pages
 *     byte  = page * 128 + x      // index into the framebuffer
 *     bit   = y & 7               // which pixel within the byte
 *
 * We keep a local Uint8Array framebuffer in that exact layout, so flushing a
 * page is a straight copy with no bit shuffling. flush() only pushes pages that
 * changed since the last flush — that is the "dirty-rect" win the renderer
 * relies on to keep I2C traffic (and screen stutter) down.
 *
 * I2C is driven through Moddable's "pins/i2c" module. Every transfer is either
 * a command stream (control byte 0x00) or a data stream (control byte 0x40).
 */

import I2C from "pins/i2c";
import { glyphFor, FONT_WIDTH, FONT_HEIGHT } from "font";

const WIDTH = 128;
const HEIGHT = 64;
const PAGES = HEIGHT >> 3; // 8
const PAGE_BYTES = WIDTH; // 128 bytes per page
const DATA_CHUNK = 32; // I2C data bytes per write (+1 control <= Moddable's 40-byte limit)

// SSD1306 command bytes (only the ones we use).
const SET_CONTRAST = 0x81;
const DISPLAY_ALL_ON_RESUME = 0xa4;
const NORMAL_DISPLAY = 0xa6;
const DISPLAY_OFF = 0xae;
const DISPLAY_ON = 0xaf;
const SET_DISPLAY_OFFSET = 0xd3;
const SET_COM_PINS = 0xda;
const SET_VCOM_DETECT = 0xdb;
const SET_DISPLAY_CLOCK_DIV = 0xd5;
const SET_PRECHARGE = 0xd9;
const SET_MULTIPLEX = 0xa8;
const SET_LOW_COLUMN = 0x00;
const SET_HIGH_COLUMN = 0x10;
const SET_START_LINE = 0x40;
const MEMORY_MODE = 0x20;
const COLUMN_ADDR = 0x21;
const PAGE_ADDR = 0x22;
const COM_SCAN_DEC = 0xc8;
const SEG_REMAP = 0xa1;
const CHARGE_PUMP = 0x8d;

const INIT_SEQUENCE = [
	DISPLAY_OFF,
	SET_DISPLAY_CLOCK_DIV, 0x80,
	SET_MULTIPLEX, HEIGHT - 1,
	SET_DISPLAY_OFFSET, 0x00,
	SET_START_LINE | 0x00,
	CHARGE_PUMP, 0x14, // internal charge pump (most modules are not externally powered)
	MEMORY_MODE, 0x00, // horizontal addressing
	SEG_REMAP,
	COM_SCAN_DEC,
	SET_COM_PINS, 0x12,
	SET_CONTRAST, 0xcf,
	SET_PRECHARGE, 0xf1,
	SET_VCOM_DETECT, 0x40,
	DISPLAY_ALL_ON_RESUME,
	NORMAL_DISPLAY,
	DISPLAY_ON,
];

export default class Display {
	constructor(options = {}) {
		this.width = WIDTH;
		this.height = HEIGHT;
		this.buffer = new Uint8Array(PAGES * PAGE_BYTES);

		// dirty[p] !== 0 means page p changed and must be flushed.
		this.dirty = new Uint8Array(PAGES);

		// Reusable transfer buffer: 1 control byte + one page of data.
		this._tx = new Uint8Array(1 + PAGE_BYTES);

		this.i2c = new I2C({
			sda: options.sda === undefined ? 21 : options.sda,
			scl: options.scl === undefined ? 22 : options.scl,
			address: options.address === undefined ? 0x3c : options.address,
			hz: options.hz === undefined ? 400000 : options.hz,
		});

		this._initPanel();
		this.clear();
		this.flush();
	}

	_command(...bytes) {
		// Control byte 0x00 => the rest of the transfer is commands.
		this.i2c.write(0x00, ...bytes);
	}

	_initPanel() {
		// Send the init sequence one byte at a time to stay well within any
		// per-transfer length limits and to keep the path obvious.
		for (let i = 0; i < INIT_SEQUENCE.length; i++)
			this._command(INIT_SEQUENCE[i]);
	}

	// --- drawing primitives (all mark affected pages dirty) -----------------

	clear() {
		this.buffer.fill(0);
		this.dirty.fill(1);
	}

	setPixel(x, y, on = true) {
		if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
		const page = y >> 3;
		const idx = page * PAGE_BYTES + x;
		const bit = 1 << (y & 7);
		if (on) this.buffer[idx] |= bit;
		else this.buffer[idx] &= ~bit;
		this.dirty[page] = 1;
	}

	// Draw one character; returns the x advance (glyph width + 1px gap).
	drawChar(x, y, ch, on = true) {
		const glyph = glyphFor(ch);
		for (let row = 0; row < FONT_HEIGHT; row++) {
			const bits = glyph[row];
			for (let col = 0; col < FONT_WIDTH; col++) {
				// bit (FONT_WIDTH-1-col) is the leftmost column.
				if (bits & (1 << (FONT_WIDTH - 1 - col)))
					this.setPixel(x + col, y + row, on);
			}
		}
		return FONT_WIDTH + 1;
	}

	drawText(x, y, str, on = true) {
		let cx = x;
		for (let i = 0; i < str.length; i++) {
			if (str[i] === "\n") {
				cx = x;
				y += FONT_HEIGHT + 1;
				continue;
			}
			cx += this.drawChar(cx, y, str[i], on);
		}
		return cx;
	}

	fillRect(x, y, w, h, on = true) {
		for (let yy = y; yy < y + h; yy++)
			for (let xx = x; xx < x + w; xx++) this.setPixel(xx, yy, on);
	}

	drawRect(x, y, w, h, on = true) {
		for (let xx = x; xx < x + w; xx++) {
			this.setPixel(xx, y, on);
			this.setPixel(xx, y + h - 1, on);
		}
		for (let yy = y; yy < y + h; yy++) {
			this.setPixel(x, yy, on);
			this.setPixel(x + w - 1, yy, on);
		}
	}

	// --- flush: push only the dirty pages over I2C --------------------------

	flush() {
		// Moddable's pins/i2c caps a single write() at 40 bytes total (see
		// i2c.c: `unsigned char buffer[40]`). So we stream each 128-byte page in
		// chunks of 32 data bytes (+1 control byte = 33 <= 40). In horizontal
		// addressing mode the SSD1306 auto-advances its column pointer across the
		// chunks, so the page reassembles correctly on the panel.
		const tx = this._tx;
		tx[0] = 0x40; // control byte: the rest of this transfer is pixel data
		for (let page = 0; page < PAGES; page++) {
			if (!this.dirty[page]) continue;

			// Aim the SSD1306 at (page, columns 0..127) in horizontal mode.
			this._command(COLUMN_ADDR, 0, WIDTH - 1);
			this._command(PAGE_ADDR, page, page);

			const start = page * PAGE_BYTES;
			for (let off = 0; off < PAGE_BYTES; off += DATA_CHUNK) {
				const n = Math.min(DATA_CHUNK, PAGE_BYTES - off);
				tx.set(this.buffer.subarray(start + off, start + off + n), 1);
				this.i2c.write(tx.subarray(0, n + 1));
			}

			this.dirty[page] = 0;
		}
	}
}
