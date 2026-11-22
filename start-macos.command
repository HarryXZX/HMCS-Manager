#!/bin/bash
# macOS 双击启动：Finder 里双击本文件即可。
# 首次使用若提示「无法打开」，右键 → 打开，或在终端执行：
#   chmod +x start.sh start-macos.command
cd "$(dirname "$0")" || exit 1

echo "HYCX MC Server Manager (HMCS)"
echo "----------------------------------------"
./start.sh

echo ""
echo "服务已停止，可以关闭此窗口。"
read -r -p "按回车键退出..." _
