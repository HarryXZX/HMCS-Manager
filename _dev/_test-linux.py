#!/usr/bin/env python3
"""HMCS Linux 集成自测（在目标机上跑，需 HMCS 已启动）

用法: python3 _dev/_test-linux.py   # 可选 MC_VER / MC_TYPE / HMCS_URL
会创建一个名为 ubuntu-test 的实例，重复执行会复用。
"""
import json, os, sys, time, urllib.request, urllib.error

BASE = os.environ.get("HMCS_URL", "http://127.0.0.1:8720")
FAIL = []


def api(path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return json.loads(raw)
        except Exception:
            return {"error": raw[:400]}


def check(name, cond, detail=""):
    tag = "ok  " if cond else "FAIL"
    print(f"  [{tag}] {name}" + (f"  -> {detail}" if detail else ""))
    if not cond:
        FAIL.append(name)
    return cond


def section(title):
    print(f"\n=== {title} ===")


section("1. 目录规范（XDG 拆分）")
r = api("/api/fs/roots")
home = r["home"]
check("配置文件在 XDG_CONFIG_HOME", r["configDir"] == home + "/.config/HMCS", r["configDir"])
check("数据在 XDG_DATA_HOME", r["dataDir"] == home + "/.local/share/HMCS", r["dataDir"])
check("实例默认目录在数据目录下", r["serversDir"] == r["dataDir"] + "/servers", r["serversDir"])
check("盘符列表为 POSIX 根", r["drives"] and r["drives"][0]["path"] == "/", str(r["drives"]))
check("快捷位置不含 Windows 专用项", all("AppData" not in q["name"] for q in r["quick"]),
      ", ".join(q["name"] for q in r["quick"]))

section("2. Java 探测（Linux 分支）")
b = api("/api/bootstrap")
jv = b["java"]
check("探测到 JVM", len(jv) > 0, ", ".join(f"Java {x['major']} {x['path']}" for x in jv))
check("路径来自 /usr/lib/jvm 或 JAVA_HOME",
      any("/usr/lib/jvm" in x["path"] or "JAVA_HOME" == x["source"] or "PATH" == x["source"] for x in jv),
      str([x.get("source") for x in jv]))

section("3. 核心源可达性")
provs = [p["id"] for p in b["providers"]]
check("核心源列表", "vanilla" in provs and "paper" in provs, ", ".join(provs))
def ids(lst):
    return [x if isinstance(x, str) else (x.get("id") or x.get("version") or str(x)) for x in lst]


v = api("/api/sources/versions?type=vanilla")
vers = ids(v.get("versions") or [])
check("Mojang 版本清单可拉取", len(vers) > 10, ", ".join(vers[:5]))
p = api("/api/sources/versions?type=paper")
pvers = ids(p.get("versions") or [])
check("PaperMC 版本清单可拉取", len(pvers) > 3, ", ".join(pvers[:5]))

section("4. 客户端实例探测")
# 先把测试客户端登记进设置，后续存档扫描才会覆盖它
s = api("/api/settings", "PUT", {"clientRoots": [home + "/hmcs-mc/.minecraft"]})
check("设置里保存客户端目录", (s.get("settings") or {}).get("clientRoots") == [home + "/hmcs-mc/.minecraft"],
      str((s.get("settings") or {}).get("clientRoots")))
c = api("/api/clients")
found = c.get("clients") or []
check("探测到刚造的 .minecraft 测试实例",
      any("hmcs-mc" in x["path"] for x in found),
      "; ".join(f'{x["path"]} ({x.get("saves")} 存档)' for x in found) or "无")

section("5. 存档链接（Linux 用 symlink 而非 junction）")
saves = os.path.expanduser("~/hmcs-mc/.minecraft/saves")
w = api("/api/worlds?force=1")
wl = [x for x in (w.get("worlds") or []) if x["path"].startswith(saves)]
check("存档扫描到测试世界", len(wl) > 0, str([x["name"] for x in wl]))
world_name = wl[0]["name"] if wl else None
print("  （实例创建与链接见下一步）")

section("6. 新建实例（真实下载核心）")
mc = os.environ.get("MC_VER", "1.21.4")
typ = os.environ.get("MC_TYPE", "vanilla")
print(f"  目标: {typ} {mc}")
t0 = time.time()
b2 = api("/api/bootstrap")
exist = next((x for x in b2["instances"] if x["id"] == "ubuntu-test"), None)
if exist:
    print("  已存在，复用（脚本可重复执行）")
    inst = exist
else:
    r = api("/api/instances", "POST", {"name": "ubuntu-test", "type": typ, "mcVersion": mc,
                                       "memory": "1G", "onlineMode": False, "eula": False})
    inst = r.get("instance") or {}
if inst:
    check("实例已创建", inst.get("id") == "ubuntu-test", f"{inst.get('id')} -> {inst.get('dir')}")
    check("落在自定义数据目录", (inst.get("dir") or "").startswith(home + "/.local/share/HMCS"),
          inst.get("dir"))
    core = os.path.join(inst["dir"], inst.get("coreFile") or "")
    check("核心 jar 已下载", os.path.exists(core),
          f"{os.path.basename(core)} {os.path.getsize(core)//1024//1024 if os.path.exists(core) else 0} MB"
          f"  用时 {int(time.time()-t0)}s")
else:
    check("实例已创建", False, str(r)[:300])

if inst:
    section("7. 存档链接到实例")
    api("/api/instances/ubuntu-test/world/detach", "POST", {})
    r = api(f"/api/instances/ubuntu-test/world/attach",
            "POST", {"source": wl[0]["path"] if wl else "", "mode": "link"})
    check("链接成功", r.get("ok") is True, str(r)[:160])
    target = os.path.join(inst["dir"], world_name or "world")
    check("链接类型是符号链接", os.path.islink(target),
          os.readlink(target) if os.path.islink(target) else "不是链接")
    check("链接指向真实存档", os.path.realpath(target).startswith(os.path.realpath(saves)),
          os.path.realpath(target))
    # level-name 是否同步
    props = os.path.join(inst["dir"], "server.properties")
    if os.path.exists(props):
        txt = open(props, encoding="utf-8", errors="replace").read()
        lvl = [l for l in txt.splitlines() if l.startswith("level-name=")]
        check("server.properties 的 level-name 已同步", lvl and world_name in lvl[0], lvl[0] if lvl else "无")

    section("8. EULA 流程（未同意必须拦住启动）")
    api("/api/instances/ubuntu-test/eula", "PUT", {"accepted": False})  # 复位，保证每次都真测门禁
    st = api("/api/instances/ubuntu-test/start", "POST", {})
    err = str(st.get("error") or "")
    check("未同意 EULA 时被拒绝", "EULA" in err, err[:120] or str(st)[:160])
    e = api("/api/instances/ubuntu-test/eula")
    check("读到 eula.txt 状态", "accepted" in json.dumps(e, ensure_ascii=False), json.dumps(e, ensure_ascii=False)[:120])
    api("/api/instances/ubuntu-test/eula", "PUT", {"accepted": True})
    e2 = api("/api/instances/ubuntu-test/eula")
    d = e2.get("eula") or e2
    check("写入后状态为已同意", d.get("accepted") is True, str(d)[:120])
    ef = os.path.join(inst["dir"], "eula.txt")
    check("eula.txt 磁盘内容正确",
          os.path.exists(ef) and "eula=true" in open(ef, encoding="utf-8", errors="replace").read().lower(),
          open(ef, encoding="utf-8", errors="replace").read().replace("\n", " | ")[:100] if os.path.exists(ef) else "文件不存在")

print("\n" + "=" * 46)
if FAIL:
    print(f"失败 {len(FAIL)} 项: " + "; ".join(FAIL))
    sys.exit(1)
print("全部通过")
