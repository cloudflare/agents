#!/usr/bin/env bash
# Start headless Chrome for CDP and the Vite dev server.
# Chrome is killed automatically when the dev server exits.

CHROME_PORT=9222

# Find Chrome binary
if [[ -n "$CHROME_BIN" ]]; then
  : # use caller-provided CHROME_BIN
elif [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
  CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif command -v google-chrome &>/dev/null; then
  CHROME_BIN="google-chrome"
elif command -v chromium &>/dev/null; then
  CHROME_BIN="chromium"
else
  echo "Chrome not found. Install Chrome or set CHROME_BIN." >&2
  exit 1
fi

# Kill any existing Chrome on the debugging port
lsof -ti tcp:$CHROME_PORT 2>/dev/null | xargs kill -9 2>/dev/null

"$CHROME_BIN" \
  --headless \
  --remote-debugging-port=$CHROME_PORT \
  --no-first-run \
  --disable-gpu \
  --no-sandbox \
  --disable-extensions \
  --disable-background-networking \
  &>/dev/null &
CHROME_PID=$!

cleanup() {
  kill $CHROME_PID 2>/dev/null
  wait $CHROME_PID 2>/dev/null
}
trap cleanup EXIT INT TERM

# Wait for Chrome to be ready
for i in $(seq 1 20); do
  if curl -s "http://localhost:$CHROME_PORT/json/version" >/dev/null 2>&1; then
    echo "Chrome ready on port $CHROME_PORT (pid $CHROME_PID)"
    break
  fi
  sleep 0.5
done

if ! curl -s "http://localhost:$CHROME_PORT/json/version" >/dev/null 2>&1; then
  echo "Chrome failed to start on port $CHROME_PORT" >&2
  exit 1
fi

# Start the dev server — Chrome is killed when this exits
npx vite dev
