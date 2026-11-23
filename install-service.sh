#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  HMCS 服务管理入口（Linux / macOS）
#
#  用法与 Windows 的「安装服务.bat」一致：
#     ./install-service.sh                 交互菜单
#     ./install-service.sh install         注册服务并启动
#     ./install-service.sh status          查看状态
#     sudo ./install-service.sh install    装成系统级服务（开机即起，不用登录）
#     ./install-service.sh install --user  装成当前用户服务（不需要 root）
# ---------------------------------------------------------------------------
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || exit 1

# sudo 会重置 PATH，导致 nvm / volta 装的 node 找不到。先试自己，再回头问原用户。
if ! command -v node >/dev/null 2>&1; then
  if [ -n "${SUDO_USER:-}" ]; then
    NODE_PATH_FIX="$(sudo -u "$SUDO_USER" bash -lc 'command -v node' 2>/dev/null || true)"
    if [ -n "$NODE_PATH_FIX" ]; then
      PATH="$(dirname "$NODE_PATH_FIX"):$PATH"
      export PATH
    fi
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node。请先安装 Node.js 18+：https://nodejs.org/zh-cn/download"
  echo "如果用的是 nvm，可以这样运行： sudo env \"PATH=\$PATH\" ./install-service.sh install"
  exit 1
fi

# Node 主版本至少 18
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "当前 Node.js 版本过低（$(node -v)），需要 18 或更高。"
  exit 1
fi

exec node "$ROOT/scripts/service.js" "$@"
