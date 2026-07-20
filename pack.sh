#!/usr/bin/env bash
# 打包扩展为可上传 Chrome Web Store 的 zip（排除仓库文档等非运行文件）
set -e
cd "$(dirname "$0")"

VER=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
OUT="moyu-video-${VER}.zip"
rm -f "$OUT"

zip -r "$OUT" . \
  -x "*.DS_Store" \
  -x "README.md" \
  -x "STORE.md" \
  -x "pack.sh" \
  -x "*.zip" \
  -x ".gitignore" \
  -x ".git/*" >/dev/null

echo "打包完成: $OUT"
unzip -Z1 "$OUT" | sed 's/^/  /'