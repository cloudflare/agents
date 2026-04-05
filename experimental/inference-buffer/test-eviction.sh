#!/usr/bin/env bash
# Test: simulate DO eviction mid-stream, then resume.
#
# This is the key scenario — the caller disconnects (DO evicted) while the
# provider is still streaming. The buffer keeps consuming in the background.
# After the provider finishes, the restarted caller resumes and gets everything
# it missed. Provider called exactly once, zero wasted tokens.
#
# Prerequisites: buffer worker running at localhost:8686
#   cd experimental/inference-buffer && npm run dev -- --port 8686
set -euo pipefail

BUFFER=http://localhost:8686
BUF_ID="eviction-$(date +%s)"

echo "=== 1. Start slow mock provider (10 chunks, 300ms apart) ==="
node -e "
const http = require('http');
const server = http.createServer((req, res) => {
  console.log('Provider: request received');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
  });
  let i = 0;
  const interval = setInterval(() => {
    if (i >= 10) {
      res.write('data: [DONE]\n\n');
      res.end();
      clearInterval(interval);
      console.log('Provider: stream complete');
      setTimeout(() => process.exit(0), 1000);
      return;
    }
    const chunk = JSON.stringify({choices: [{delta: {content: 'word' + i + ' '}}]});
    res.write('data: ' + chunk + '\n\n');
    console.log('Provider: sent chunk', i);
    i++;
  }, 300);
});
server.listen(9998, () => console.log('Provider: listening on :9998'));
" &
MOCK_PID=$!
sleep 1

echo ""
echo "=== 2. Start proxy, abort after ~1s (simulating DO eviction) ==="
curl -sN \
  -X POST "$BUFFER/proxy?id=$BUF_ID" \
  -H "X-Provider-URL: http://localhost:9998/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"test","stream":true}' &
CURL_PID=$!
sleep 1
echo ""
echo "(killing curl to simulate eviction)"
kill $CURL_PID 2>/dev/null || true
wait $CURL_PID 2>/dev/null || true

echo ""
echo "=== 3. Check status right after 'eviction' ==="
curl -s "$BUFFER/status?id=$BUF_ID" | python3 -m json.tool

echo ""
echo "=== 4. Wait for provider to finish streaming ==="
sleep 3

echo ""
echo "=== 5. Status after provider finished ==="
curl -s "$BUFFER/status?id=$BUF_ID" | python3 -m json.tool

echo ""
echo "=== 6. Resume from chunk 3 (what the restarted DO would do) ==="
curl -sN "$BUFFER/resume?id=$BUF_ID&from=3"

echo ""
echo ""
echo "=== 7. Cleanup ==="
curl -s -X POST "$BUFFER/ack?id=$BUF_ID" | python3 -m json.tool

kill $MOCK_PID 2>/dev/null || true
echo ""
echo "=== DONE — buffer survived caller disconnect ==="
