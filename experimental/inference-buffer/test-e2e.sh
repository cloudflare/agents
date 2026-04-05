#!/usr/bin/env bash
# End-to-end test: proxy a full SSE stream through the buffer, then resume
# from a midpoint to verify replay works.
#
# Prerequisites: buffer worker running at localhost:8686
#   cd experimental/inference-buffer && npm run dev -- --port 8686
set -euo pipefail

BUFFER=http://localhost:8686
BUF_ID="test-$(date +%s)"

echo "=== 1. Start mock SSE provider ==="
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
      setTimeout(() => process.exit(0), 500);
      return;
    }
    const chunk = JSON.stringify({
      choices: [{delta: {content: 'chunk-' + i + ' '}}]
    });
    res.write('data: ' + chunk + '\n\n');
    console.log('Provider: sent chunk', i);
    i++;
  }, 100);
});
server.listen(9999, () => console.log('Provider: listening on :9999'));
" &
MOCK_PID=$!
sleep 1

echo ""
echo "=== 2. Full proxy (let it complete) ==="
curl -sN \
  -X POST "$BUFFER/proxy?id=$BUF_ID" \
  -H "X-Provider-URL: http://localhost:9999/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"test","stream":true}'

echo ""
echo "=== 3. Buffer status after completion ==="
curl -s "$BUFFER/status?id=$BUF_ID" | python3 -m json.tool

echo ""
echo "=== 4. Resume from chunk 5 (replay latter half) ==="
curl -sN "$BUFFER/resume?id=$BUF_ID&from=5"

echo ""
echo "=== 5. Cleanup ==="
curl -s -X POST "$BUFFER/ack?id=$BUF_ID" | python3 -m json.tool

kill $MOCK_PID 2>/dev/null || true
echo ""
echo "=== DONE ==="
