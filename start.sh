#!/usr/bin/env sh
# ============================================================
#  HMCS Manager - Linux / macOS launcher
#  Linux:  ./start.sh
#  macOS:  double-click start-macos.command, or ./start.sh
# ============================================================
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  [!] Node.js not found."
  echo "      macOS : brew install node"
  echo "      Ubuntu: sudo apt install nodejs npm"
  echo "      Others: https://nodejs.org/"
  echo ""
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  [!] Node.js 18+ required, current: $(node -v)"
  exit 1
fi

if [ ! -d "node_modules/js-yaml" ]; then
  echo "[1/2] Installing dependencies ..."
  npm install --no-audit --no-fund
fi

echo "[2/2] Starting HMCS Manager ..."
echo "      Press Ctrl+C to stop."

# 后台等两秒再打开浏览器（服务端口可能被自动 +1，所以读 last-url.txt）
(
  sleep 2
  URL=""
  [ -f last-url.txt ] && URL=$(cat last-url.txt | tr -d '\r\n')
  [ -z "$URL" ] && URL="http://127.0.0.1:8720"
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  fi
) >/dev/null 2>&1 &

exec node app.js
