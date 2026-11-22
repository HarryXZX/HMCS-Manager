#!/usr/bin/env python3
"""HMCS Linux 启动自测：非 ASCII 世界名 / 干净启动 / 控制台命令 / 停止

依赖 _test-linux.py 先跑过（实例 ubuntu-test 已存在）。
"""
import json, os, time, urllib.request, urllib.error

BASE = "http://127.0.0.1:8720"
ID = "ubuntu-test"
WORLD = "Ubuntu测试世界"


def api(path, method="GET", body=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
            txt = r.read().decode("utf-8", "replace")
            return txt if raw else (json.loads(txt) if txt.strip() else {})
    except urllib.error.HTTPError as e:
        txt = e.read().decode("utf-8", "replace")
        if raw:
            return txt
        try:
            return json.loads(txt)
        except Exception:
            return {"error": txt[:300]}


def logs(n=400):
    return api(f"/api/instances/{ID}/logs?limit={n}", raw=True)


def status():
    return (api(f"/api/instances/{ID}").get("runtime") or {}).get("status")


def wait_for(pred, limit=200):
    t0 = time.time()
    while time.time() - t0 < limit:
        time.sleep(3)
        tx = logs()
        if pred(tx):
            return True, tx, int(time.time() - t0)
        if status() == "stopped" and "Done (" not in tx:
            return False, tx, int(time.time() - t0)
    return False, logs(), limit


FAIL = []


def check(name, cond, detail=""):
    print(f"  [{'ok  ' if cond else 'FAIL'}] {name}" + (f"  -> {detail}" if detail else ""))
    if not cond:
        FAIL.append(name)


# 保证从干净状态开始：残留运行中的进程会让 attach/start 全部失真
if status() != "stopped":
    print("== 先停掉上一次残留的运行实例")
    api(f"/api/instances/{ID}/stop", "POST", {})
    for _ in range(30):
        if status() == "stopped":
            break
        time.sleep(2)

print("=== A. 中文世界名（非 ASCII 路径编码）")
api("/api/instances/ubuntu-test/world/detach", "POST", {})
r = api(f"/api/instances/ubuntu-test/world/attach", "POST",
        {"source": os.path.expanduser("~/hmcs-mc/.minecraft/saves/" + WORLD), "mode": "link"})
check("世界链接建立", r.get("ok") is True, str(r)[:100])
api(f"/api/instances/{ID}/logs/clear", "POST", {})
api(f"/api/instances/{ID}/start", "POST", {})
ok, tx, el = wait_for(lambda t: "Done (" in t and "For help" in t)
enc_bad = "InvalidPathException" in tx or "unmappable characters" in tx
check("非 ASCII 路径不再抛 InvalidPathException", not enc_bad, f"{el}s")
if enc_bad:
    print("   ", "\n    ".join([l for l in tx.splitlines() if "Exception" in l or "unmappable" in l][:3]))
else:
    ver_msg = [l for l in tx.splitlines() if "newer" in l.lower() or "version" in l.lower() and "world" in l.lower()]
    print("     （存档是 26.3 / DataVersion 5023，1.21.4 服务端拒绝加载属预期）")
    print("     首条世界相关日志:", (ver_msg[0][:120] if ver_msg else "无"))
    if status() != "stopped":
        api(f"/api/instances/{ID}/stop", "POST", {})
        time.sleep(6)

print("\n=== B. 干净世界完整启动")
api("/api/instances/ubuntu-test/world/detach", "POST", {})
api(f"/api/instances/{ID}/config/properties", "PUT", {"values": {"level-name": "world"}})
api(f"/api/instances/{ID}/logs/clear", "POST", {})
api(f"/api/instances/{ID}/start", "POST", {})
ok, tx, el = wait_for(lambda t: "Done (" in t and "For help" in t)
check("服务端启动到 Done", ok, f"{el}s")
check("状态变为 running", status() == "running", str(status()))
check("日志按行可读（无乱码/无 \\r 残留）",
      "\r" not in tx and "Starting minecraft server version" in tx,
      next((l for l in tx.splitlines() if "Starting minecraft server version" in l), "")[:80])
check("端口已就绪", "Done (" in tx, next((l for l in tx.splitlines() if "Done (" in l), "")[:110])

if ok:
    print("\n=== C. 控制台命令")
    api(f"/api/instances/{ID}/command", "POST", {"line": "list"})
    time.sleep(4)
    tx2 = logs(80)
    check("命令有回显", "players online" in tx2.lower() or "There are" in tx2,
          next((l for l in tx2.splitlines() if "players online" in l.lower()), "")[:90])
    api(f"/api/instances/{ID}/command", "POST", {"line": "say HMCS on linux"})
    time.sleep(3)
    check("say 命令写入日志", "HMCS on linux" in logs(80))

    print("\n=== D. 停止")
    t0 = time.time()
    api(f"/api/instances/{ID}/stop", "POST", {})
    while time.time() - t0 < 90 and status() != "stopped":
        time.sleep(2)
    check("已停止", status() == "stopped", f"{int(time.time()-t0)}s")
    check("停止时保存了世界（日志含 Saving）", "Saving the game" in logs(400) or "saved" in logs(400).lower())

print("\n" + "=" * 46)
print(("失败: " + "; ".join(FAIL)) if FAIL else "全部通过")
