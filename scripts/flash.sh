#!/bin/bash
#
# flash.sh — build the firmware and flash it to the ESP32 (with step logging).
#
#   npm run flash            scripts/flash.sh              # release build
#   npm run flash:debug      scripts/flash.sh instrument   # serial console @115200
#   UPLOAD_PORT=/dev/cu.xxx npm run flash                  # override the port
#
# Why this wrapper instead of plain `mcconfig`:
#   - Sets MODDABLE + ESP-IDF env in one shell (shell state doesn't persist).
#   - Forces ESP-IDF to use python3.13 (Homebrew's 3.14 is too new for IDF v6.0)
#     via a /tmp/pyshim that also shadows pyenv's `python`.
#   - We run `mcconfig` WITHOUT `-m` (generate only) + `make build`, then flash
#     the bins ourselves with esptool. This avoids mcconfig's deploy step, which
#     flashes via idf AND launches `idf.py monitor` — and in an interactive
#     terminal that monitor attaches to the TTY and never exits, hanging the run.
#   - `stty raw` first: rapid open/close cycles can wedge the USB-serial line
#     discipline into EINVAL; resetting it fixes "termios Invalid argument".
set -e

START=$(date +%s)
MODE="${1:-release}"                                   # release | instrument
PORT="${UPLOAD_PORT:-/dev/cu.usbserial-0001}"
export MODDABLE="${MODDABLE:-$HOME/Projects/moddable}"
export IDF_PATH="${IDF_PATH:-$HOME/esp32/esp-idf-v6.0}"
BUILD_LOG="/tmp/flash-build.log"

# ---------- logging ----------
if [ -t 1 ]; then C=$'\e[36m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; D=$'\e[2m'; Z=$'\e[0m'; else C=; G=; Y=; R=; D=; Z=; fi
el()   { echo $(( $(date +%s) - START )); }
log()  { echo "${C}▶ [+$(el)s]${Z} $*"; }
ok()   { echo "${G}  ✓${Z} ${D}$*${Z}"; }
warn() { echo "${Y}  ! $*${Z}"; }
on_err() {
	local code=$?
	echo "${R}✗ [+$(el)s] failed (exit $code)${Z}" >&2
	echo "${D}  --- last 25 lines of $BUILD_LOG ---${Z}" >&2
	tail -25 "$BUILD_LOG" 2>/dev/null >&2
	exit "$code"
}
trap on_err ERR

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Which component does main.js currently mount? (informational)
APP="$(grep -E '^[[:space:]]*mount\(h\(' src/main.js 2>/dev/null | head -1 | sed -E 's/.*h\(([A-Za-z]+).*/\1/')"

log "Flashing ${G}${MODE}${Z} build of ${G}${APP:-?}${Z} → ${PORT}"

# ---------- 1. board check ----------
if [ ! -e "$PORT" ]; then
	warn "no board at $PORT"
	echo "    plug the ESP32 in over USB and check: ${D}ls /dev/cu.usbserial-*${Z}"
	exit 1
fi
ok "board present on $PORT"

# ---------- 2. toolchain env ----------
log "Setting up Moddable + ESP-IDF env (python3.13)"
mkdir -p /tmp/pyshim
PY313="$(command -v python3.13 || echo /opt/homebrew/bin/python3.13)"
ln -sf "$PY313" /tmp/pyshim/python3
ln -sf "$PY313" /tmp/pyshim/python
export PATH="/tmp/pyshim:$MODDABLE/build/bin/mac/release:$PATH"
[ -x "$MODDABLE/build/bin/mac/release/mcconfig" ] || { warn "mcconfig not found under \$MODDABLE ($MODDABLE)"; exit 1; }
. "$IDF_PATH/export.sh" >/dev/null 2>&1
ok "MODDABLE=$MODDABLE  IDF=$IDF_PATH"

# ---------- 3. compile JSX ----------
log "Compiling JSX → build/  (npm run build:jsx)"
npm run build:jsx >"$BUILD_LOG" 2>&1
ok "src/*.jsx compiled to build/"

# ---------- 4. build firmware ----------
log "Building $MODE firmware  (mcconfig + idf — first build can take minutes)"
FLAG=""
[ "$MODE" = "instrument" ] && FLAG="-i"
# Generate the project (no -m, so it does NOT deploy/monitor), then build only.
UPLOAD_PORT="$PORT" mcconfig $FLAG -p esp32 </dev/null >>"$BUILD_LOG" 2>&1
PROJ="$MODDABLE/build/tmp/esp32/$MODE/preact-esp32"
( cd "$PROJ" && make build </dev/null >>"$BUILD_LOG" 2>&1 )
BIN="$MODDABLE/build/bin/esp32/$MODE/preact-esp32"
[ -f "$BIN/xs_esp32.bin" ] || { warn "build produced no xs_esp32.bin — see $BUILD_LOG"; exit 1; }
ok "firmware built: $(( $(wc -c <"$BIN/xs_esp32.bin") / 1024 )) KB  (xs_esp32.bin)"

# ---------- 5. free the serial port ----------
# mcconfig's deploy step (and any open `idf.py monitor`) leaves a process holding
# the port, which blocks esptool with "Resource temporarily unavailable".
log "Freeing serial port"
pkill -f "idf_monitor|esp_idf_monitor|idf\.py.*monitor" 2>/dev/null || true
HOLDERS="$(lsof -t "$PORT" 2>/dev/null || true)"
if [ -n "$HOLDERS" ]; then
	warn "killing process(es) holding $PORT: $(echo "$HOLDERS" | tr '\n' ' ')"
	# shellcheck disable=SC2086
	kill $HOLDERS 2>/dev/null || true
	sleep 0.5
fi
ok "port free"

# ---------- 6. flash over USB ----------
log "Flashing over USB ($PORT @460800) — writing 3 partitions"
stty -f "$PORT" raw 115200 2>/dev/null || true # un-wedge a stuck serial line
python -m esptool --chip esp32 --port "$PORT" -b 460800 \
	--before default-reset --after hard-reset write-flash \
	--flash-mode dio --flash-size 4MB --flash-freq 80m \
	0x1000 "$BIN/bootloader.bin" \
	0x8000 "$BIN/partition-table.bin" \
	0x10000 "$BIN/xs_esp32.bin"

# ---------- done ----------
echo
log "${G}Done in $(el)s${Z} — board was reset and is running ${G}${APP:-the app}${Z}."
if [ "$MODE" = "instrument" ]; then
	echo "    read traces: ${D}idf.py -p $PORT monitor${Z}  (serial console is on @115200)"
fi
