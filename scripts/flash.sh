#!/bin/bash
#
# flash.sh — build the firmware and flash it to the ESP32.
#
#   scripts/flash.sh                 # release build (console off, smallest)
#   scripts/flash.sh instrument      # instrumented build (serial console on @115200)
#   UPLOAD_PORT=/dev/cu.xxx scripts/flash.sh
#
# Why this wrapper instead of plain `mcconfig`:
#   - Sets MODDABLE + ESP-IDF env in one shell (shell state doesn't persist).
#   - Forces ESP-IDF to use python3.13 (Homebrew's 3.14 is too new for IDF v6.0)
#     via a /tmp/pyshim that also shadows pyenv's `python`.
#   - mcconfig's `all` target tries to launch the xsbug GUI (not built) and the
#     idf_monitor (needs a TTY); both fail headlessly, so we run `make build` +
#     flash the bins directly with esptool.
#   - `stty raw` first: rapid open/close cycles can wedge the USB-serial line
#     discipline into EINVAL; resetting it fixes "termios Invalid argument".
set -e

MODE="${1:-release}"            # release | instrument
PORT="${UPLOAD_PORT:-/dev/cu.usbserial-0001}"
export MODDABLE="${MODDABLE:-$HOME/Projects/moddable}"
export IDF_PATH="${IDF_PATH:-$HOME/esp32/esp-idf-v6.0}"

# python3.13 shim for ESP-IDF (see header)
mkdir -p /tmp/pyshim
ln -sf "$(command -v python3.13 || echo /opt/homebrew/bin/python3.13)" /tmp/pyshim/python3
ln -sf "$(command -v python3.13 || echo /opt/homebrew/bin/python3.13)" /tmp/pyshim/python
export PATH="/tmp/pyshim:$MODDABLE/build/bin/mac/release:$PATH"
. "$IDF_PATH/export.sh" >/dev/null 2>&1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm run build:jsx

FLAG=""
[ "$MODE" = "instrument" ] && FLAG="-i"
UPLOAD_PORT="$PORT" mcconfig $FLAG -m -p esp32 >/tmp/mcconfig.log 2>&1 || true

PROJ="$MODDABLE/build/tmp/esp32/$MODE/preact-esp32"
cd "$PROJ"
make build >>/tmp/mcconfig.log 2>&1

BIN="$MODDABLE/build/bin/esp32/$MODE/preact-esp32"
stty -f "$PORT" raw 115200 2>/dev/null || true
python -m esptool --chip esp32 --port "$PORT" -b 460800 \
	--before default-reset --after hard-reset write-flash \
	--flash-mode dio --flash-size 4MB --flash-freq 80m \
	0x1000 "$BIN/bootloader.bin" \
	0x8000 "$BIN/partition-table.bin" \
	0x10000 "$BIN/xs_esp32.bin"

echo "Flashed $MODE build to $PORT"
