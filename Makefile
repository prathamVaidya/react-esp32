# Makefile — convenience targets for Preact-on-ESP32.
# The real logic lives in scripts/flash.sh and package.json; this is just shortcuts.
#
#   make flash                 build + flash a release firmware
#   make flash PORT=/dev/cu.x  override the serial port
#   make flash-debug           instrumented build (serial console on)
#   make monitor               read the serial console @115200
#   make sim / sim-dash        run the OLED in the terminal
#   make test                  host-side smoke tests
#   make                       (no target) prints this help

PORT    ?= /dev/cu.usbserial-0001
PYSERIAL ?= $(HOME)/.espressif/python_env/idf6.0_py3.13_env/bin/python

.PHONY: help flash flash-debug monitor sim sim-dash test jsx install clean

help:
	@echo "Targets:"
	@echo "  make flash         build + flash a release firmware   (PORT=... to override)"
	@echo "  make flash-debug   build + flash an instrumented firmware (serial console on)"
	@echo "  make monitor       read the serial console @115200 (instrument builds; Ctrl-] quits)"
	@echo "  make sim           run the OLED in the terminal (counter)"
	@echo "  make sim-dash      run the dashboard in the terminal"
	@echo "  make test          run the host-side smoke tests"
	@echo "  make jsx           compile src/*.jsx -> build/"
	@echo "  make install       npm install (also patches preact)"
	@echo "  make clean         remove build/"

flash:
	UPLOAD_PORT=$(PORT) bash scripts/flash.sh

flash-debug:
	UPLOAD_PORT=$(PORT) bash scripts/flash.sh instrument

monitor:
	@echo "Reading $(PORT) @115200 — Ctrl-] to quit"
	@$(PYSERIAL) -m serial.tools.miniterm $(PORT) 115200

sim:
	npm run sim

sim-dash:
	npm run sim dash

test:
	npm test

jsx:
	npm run build:jsx

install:
	npm install

clean:
	npm run clean
