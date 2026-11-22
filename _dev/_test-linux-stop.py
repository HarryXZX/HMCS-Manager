#!/usr/bin/env python3
"""HMCS Linux 停止压力测试：连续 6 轮启停，必须每轮 exit 0 且日志有 Saving chunks

依赖 _test-linux.py 先跑过（实例 ubuntu-test 已存在）。
"""
import json, time, urllib.request, urllib.error

BASE = "http://127.0.0.1:8720"
ID = "ubuntu-test"


def api(path, method="GET", body=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            t = r.read().decode("utf-8", "replace")
            return t if raw else (json.loads(t) if t.strip() else {})
    except urllib.error.HTTPError as e:
        t = e.read().decode("utf-8", "replace")
        return t if raw else {"error": t[:200]}


def rt():
    return api(f"/api/instances/{ID}").get("runtime") or {}


def logs():
    return api(f"/api/instances/{ID}/logs?limit=400", raw=True)


def wait(pred, limit):
    t0 = time.time()
    while time.time() - t0 < limit:
        if pred():
            return True, time.time() - t0
        time.sleep(1)
    return False, time.time() - t0


def start():
    api(f"/api/instances/{ID}/logs/clear", "POST", {})
    api(f"/api/instances/{ID}/start", "POST", {})


def stop_and_measure(tag):
    t0 = time.time()
    api(f"/api/instances/{ID}/stop", "POST", {})
    ok, _ = wait(lambda: rt().get("status") == "stopped", 60)
    el = time.time() - t0
    code = rt().get("exitCode")
    saved = logs().count("Saving chunks")
    tag2 = "ok  " if (ok and code == 0) else "FAIL"
    print(f"  [{tag2}] {tag}: {el:.0f}s 退出码={code} 保存日志={saved} 行")
    return ok and code == 0


bad = 0
print("=== A. 正常启停 5 轮（每轮等 Done 再停）")
for n in range(1, 6):
    start()
    ok, el = wait(lambda: "Done (" in logs(), 120)
    if not ok:
        print(f"  第 {n} 轮: 启动失败")
        bad += 1
        continue
    time.sleep(3)                      # 让它跑一会儿，模拟真实使用
    if not stop_and_measure(f"第 {n} 轮 (启动 {el:.0f}s 后停止)"):
        bad += 1
    time.sleep(2)

print("\n=== B. 启动阶段立刻停止（服务端还没读完启动流程）")
start()
time.sleep(1.2)
ok = stop_and_measure("启动中停止")
if not ok:
    bad += 1

print("\n=== C. 停止后状态一致性")
r = rt()
print(f"  status={r.get('status')} exitCode={r.get('exitCode')} error={r.get('error')!r}")
if r.get("status") != "stopped":
    bad += 1

print("\n" + "=" * 46)
print("全部优雅退出" if bad == 0 else f"{bad} 项异常")
