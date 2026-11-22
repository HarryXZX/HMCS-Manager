#!/bin/sh
# 在 guest 里造一个「假客户端实例」，用来验证存档探测 / 扫描 / 链接
set -e
MC="$HOME/hmcs-mc/.minecraft"
rm -rf "$HOME/hmcs-mc"
mkdir -p "$MC/saves/Ubuntu测试世界" "$MC/versions/HY Craft 26.3"
python3 - "$MC" <<'PY'
import gzip, struct, sys, os
mc = sys.argv[1]
# 最小 NBT：TAG_Compound{ DataVersion: TAG_Int }，HMCS 用字节搜索读 DataVersion
nbt = (b'\x0a\x00\x00' + b'\x03' + b'\x00\x0b' + b'DataVersion'
       + struct.pack('>i', 5023) + b'\x00')
w = os.path.join(mc, 'saves', 'Ubuntu测试世界')
open(os.path.join(w, 'level.dat'), 'wb').write(gzip.compress(nbt))
open(os.path.join(w, 'session.lock'), 'wb').write(b'\x00' * 16)
os.makedirs(os.path.join(w, 'region'), exist_ok=True)
open(os.path.join(w, 'region', 'r.0.0.mca'), 'wb').write(b'\x00' * 8192)
open(os.path.join(mc, 'launcher_profiles.json'), 'w').write('{"profiles":{}}')
open(os.path.join(mc, 'options.txt'), 'w').write('version:26.3\n')
# versions 目录里放个带 version.json 的假 jar，让版本映射索引有东西可读
vd = os.path.join(mc, 'versions', 'HY Craft 26.3')
open(os.path.join(vd, 'version.json'), 'w').write('{"id":"26.3","javaVersion":{"majorVersion":21}}')
open(os.path.join(vd, 'HY Craft 26.3.jar'), 'wb').write(b'PK\x05\x06' + b'\x00' * 18)
print("fake client ready:", mc)
PY
ls -R "$HOME/hmcs-mc" | head -20
