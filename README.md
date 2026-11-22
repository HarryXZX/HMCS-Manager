# HYCX MC Server Manager（HMCS）

> 一个跑在本机的「服务端版启动器」：下载核心、启动服务端、在 WebUI 里改文件与配置、把已有存档直接链接进来、通过 UPnP 把服务端端口开到公网。

仓库：<https://github.com/HarryXZX/HMCS-Manager>

纯 **Node.js + 原生 JavaScript** 实现：后端无框架（原生 `http` 路由），前端原生 JS/CSS，**无构建步骤、无数据库**。
WebUI 只监听 `127.0.0.1`，不对外网开放；对外只暴露你显式映射的那一个游戏端口。

支持 **Windows / macOS / Linux**。

## 目录结构

```
<程序目录>                      ← 只有代码，可以随意移动 / 重新下载
  app.js              入口（HTTP 服务 + 全部 API）
  lib/                sources（核心源）/ instances（实例注册表）/ fsbrowse（目录浏览）
                      proc（进程托管）/ worlds（存档）/ props / eula / upnp
  public/             前端（原生 JS，无构建）
  _dev/               自测脚本（模拟 UPnP 网关、前端冒烟测试），可整个删除
  启动.bat            Windows 中文版（GBK 编码）
  start.bat           Windows 英文版（控制台无中文时用）
  start.sh            Linux / macOS
  start-macos.command macOS 双击启动
```

数据目录（所有可变内容，**不在程序目录**，程序目录被移动也不会丢配置）：

| 平台 | 数据目录 |
| --- | --- |
| Windows | `%APPDATA%\HMCS` |
| macOS | `~/Library/Application Support/HMCS` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/HMCS` |

```
  settings.json     应用设置（实例目录、客户端根目录、Java、内存）
  instances.json    实例注册表（记录每个实例的真实磁盘路径）
  servers/          默认实例存放目录（可在设置里改成任意位置）
```

环境变量 `HMCS_HOME` 可以把数据目录指到别处（旧名 `HYSERV_HOME` 仍然兼容）。

## 启动方式

| 系统 | 怎么做 |
| --- | --- |
| Windows | 双击 **`启动.bat`**（中文提示，GBK 编码）；若控制台乱码改双击 `start.bat` |
| macOS | 双击 **`start-macos.command`**（首次可能需右键 → 打开）；或在终端 `./start.sh` |
| Linux | `./start.sh` |
| 任意系统 | `npm install && npm start` |

脚本会检查 Node.js 版本（需要 **18+**）、依赖缺失时自动 `npm install`，启动后自动打开浏览器。
没有 Node.js 时会直接提示安装地址，不会闪退。

**平台差异**：存档链接在 Windows 上用 NTFS 目录联接（Junction，不需要管理员权限），在 macOS / Linux 上用符号链接，效果一致；Java 探测会自动扫描各平台常见安装位置、`JAVA_HOME` 与 `PATH`。

1. **新建服务器** → 选核心类型与 MC 版本 → 自动下载核心（Paper 26.3 约 55 MB，实测 36 秒）
2. **同意 EULA**：未同意时概览页有红色提示、顶栏显示 `EULA 未同意`，服务端拒绝启动。到 **配置 → eula.txt** 勾选并写入即可（详见下方「EULA」）
3. 顶部 **启动** → 弹窗里可改内存 / Java / JVM 参数，并**手动挑一个本机存档**（默认保持当前世界）
4. 切到 **控制台** 看实时日志、发命令；**文件** 页可上传/下载/改名/在线编辑；**配置** 页可视化改 `server.properties` 与 YAML/JSON
5. **插件** 页搜 Modrinth 直接装；**世界** 页可随时把别的存档链接进来或断开链接
6. **网络** 页检测 UPnP 网关并一键开端口，可设成「随服务端启停自动映射」

## 存储位置：目录都能自己选

**设置 → 存储位置**

| 项目 | 默认值 | 说明 |
| --- | --- | --- |
| 服务端实例存放目录 | 数据目录下的 `servers/` | 新建实例默认放这里，可改成 `D:\MinecraftServers` / `/srv/mc` 这类任意位置 |
| 配置目录 | 见上方「目录结构」 | `settings.json` / `instances.json`，只读展示，可一键打开 |

- 目录选择器是内置的（盘符 / 根目录 + 快捷位置 + 单击进目录 + 新建文件夹），不用手打路径
- 新建实例时还会单独确认一次存放位置，**每个实例可以放在不同磁盘**
- 已有实例保留各自的原始路径，改默认目录不会搬动它们（不动你几十 GB 的存档）
- 从旧版本升级：程序目录里的 `settings.json` 自动迁移到数据目录（旧文件改名 `settings.json.migrated` 留档），`servers/` 下的实例被注册表接管，文件原地不动
- 从 `HYServ` 改名前的老版本升级：整个 `%APPDATA%\HYServ` 会自动搬到 `%APPDATA%\HMCS`，注册表里的绝对路径同步重写，实例无需重新导入

**设置 → 客户端实例**：世界面板的存档来源，可以添加任意多个 `.minecraft` 目录。

- 「自动检测」会扫官方启动器、`%APPDATA%\.minecraft`（macOS 为 `~/Library/Application Support/minecraft`）、用户目录与各磁盘根目录，以及 Prism / MultiMC / Modrinth App / CurseForge 的实例目录
- 每个目录显示识别到的存档数与版本数，路径失效会标红
- 「额外存档目录」用于不在客户端实例里的零散存档

## 实例管理

- **导入已有服务端**：侧栏底部按钮，选一个包含 `paper.jar` / `server.jar` 的目录就地接管（不复制、不下载），自动读 `server.properties` 的端口与世界名，核心类型按 jar 名判断
- **删除实例**：侧栏条目悬停出现 `×`，概览页也有「删除实例」，两种模式：
  - **只从列表移除** —— 磁盘上的核心、插件、世界全部保留，之后可以再导入
  - **同时删除磁盘目录** —— 会二次确认；世界里若是指向客户端存档的链接（Junction / symlink），只删链接、不动存档
  - 安全兜底：只有「看起来像服务端目录」的目录（有核心 jar / `server.properties` / `eula.txt`）才会被真正删除，否则只移除记录并提示
  - 服务端运行中不允许删除，先停止
- **目录失效**：实例目录被手动移走时，侧栏显示「目录失效」，概览页给出提示，可选择移回原路径或移除记录

## EULA

Minecraft 服务端启动前必须读到 `eula.txt` 里的 `eula=true`，否则进程会立刻退出。这一步**必须由你本人确认**，工具不会替你同意。

入口三处，都能看到真实状态（以 `eula.txt` 文件内容为准，不是缓存字段）：

| 位置 | 作用 |
|---|---|
| 顶栏徽标 | 未同意时显示红色 `EULA 未同意` |
| 概览页 | 顶部红色横幅 + 「去同意 EULA」按钮，直达编辑页 |
| 配置 → `eula.txt` | 完整面板：状态、复选框、原文链接、文件内容预览 |

面板能力：

- **同意 / 撤销**：勾选后「同意并写入」写 `eula=true`；「撤销同意」写回 `eula=false`（文件保留，不是删除）。撤销后服务端无法启动，直到重新同意
- **文本模式**：直接编辑 `eula.txt` 原文，保存后以文件内容为准（大小写不敏感，`eula=TRUE` 也算同意）
- **格式对齐原版**：新建或早期版本留下的裸文件会自动补成原版格式

```
#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).
#Sun Nov 22 17:47:16 GMT+8 2026
eula=true
```

- **保护已有的自定义注释**：只替换 `eula=` 那一行；文件里已经有 `#` 注释行时不会强行加原版头

启动弹窗里也有一个 EULA 复选框（未同意时勾上即可启动）。未勾选且未同意时，前端会直接拦下并提示，后端也会返回 `409` 而不是让 java 白跑一趟。

## 核心来源

| 类型 | 来源 | 说明 |
|---|---|---|
| 原版 Vanilla | Mojang `piston-meta` 官方清单 | 官方服务端，无插件 |
| Paper | PaperMC `fill.papermc.io/v3` | 支持 Bukkit/Spigot 插件，推荐 |
| Purpur | `api.purpurmc.org/v2` | Paper 分支，可调项更多 |
| Fabric | `meta.fabricmc.net` | 服务端模组（Carpet、Lithium 等） |

下载带校验（Vanilla 用 sha1、Paper 用 sha256、Modrinth 用 sha512），失败会明确报错，不会留下半截文件（`.part` 临时名）。
> 旧版 `api.papermc.io/v2` 已于 2026 年下线（返回 `{"error":"sunset"}`），本项目已改用 v3。

插件来源是 **Modrinth**（有公开 API，覆盖 EssentialsX、WorldEdit、LuckPerms 等主流插件）；SpigotMC 没有公开 API，故未接入。

## 配置编辑

- **server.properties**：按 6 个分组渲染成表单（布尔→开关、枚举→下拉、数字→数字框），每个键有中文说明；
  保存时**只改值、保留注释与顺序**，未知键会归到「其他键」。
- **YAML / JSON**（`bukkit.yml`、`spigot.yml`、`config/paper-global.yml`、`config/paper-world-defaults.yml`、`ops.json`、`whitelist.json`…）：
  用树形表单编辑，支持增删键与数组项；保存前自动备份为 `*.hmcs.bak`。
- 表单模式会重写文件（YAML 注释会丢失），需要保注释时切「文本模式」。

## 存档链接是怎么做的

`<实例目录>/<world>` 是一个**目录链接**，指向你选的存档目录本身。Windows 用 NTFS 目录联接（Junction，无需管理员权限），macOS / Linux 用符号链接：

```
<实例目录>/world  ⟶(link)⟶  <客户端实例>/saves/my-world
```

- 服务端写的就是那份存档，客户端再从启动器打开看到的是同一批文件，**不需要拷贝、不存在「哪份是最新的」**
- 链接时会自动把 `server.properties` 的 `level-name` 改成链接名，避免服务端另建一个世界
- 删除链接只删链接本身（reparse point / symlink），**真实存档不动**
- **复制**模式则把它整份复制进实例，之后互不影响
- 服务端运行中禁止换世界（会拒绝并提示先停止）

## 端口转发（UPnP）

「网络」页会用 **SSDP（239.255.255.250:1900）** 找支持 IGD 的网关，再通过 **SOAP** 调 `AddPortMapping` / `DeletePortMapping` / `GetExternalIPAddress` / `GetGenericPortMappingEntry`。
零依赖实现（`lib/upnp.js`，只用 Node 内置的 `dgram` / `http`），没有引入停更的第三方 UPnP 库。

| 能力 | 说明 |
|---|---|
| 自动发现网关 | **逐网卡**发 `ST`（见下方「多网卡」），取回 device description，递归找到 `WANIPConnection` / `WANPPPConnection` |
| 一键映射 | 外网端口留空即与 `server-port` 相同；协议可选 TCP / UDP / TCP+UDP |
| 随启停自动映射 | 勾选后启动服务端即建立，进程退出即回收 |
| 冲突自愈 | 端口被占（错误 718）先删旧条目再写；只支持永久租期（725）自动回退 `lease=0` |
| 映射表查看 | 读网关现有的转发规则，标出哪些是本工具建的、哪些指向本机，可单条删除 |
| 排障提示 | 失败时列出本机每张网卡、是否发过 M-SEARCH；公网 IP 落在私有段 / CGNAT（100.64/10）时明确告警 |

### 多网卡：为什么早期版本探测不到路由器

Windows 上 `dgram` 的组播出口是**由系统挑的**，不是发到所有网卡。装了 Radmin VPN / VMware / VirtualBox / WSL / 各种 VPN 的机器，系统经常把 `239.255.255.250` 的包从虚拟网卡发出去，路由器一个包都收不到，表现为「明明开了 UPnP 却探测不到」。

现在 `lib/upnp.js` 的做法是：

1. `os.networkInterfaces()` 枚举所有 IPv4 网卡，用名字识别虚拟网卡（`radmin|vmware|virtualbox|hyper-v|wsl|docker|vpn|zerotier|tailscale|wireguard…`）；
2. 优先只走**非虚拟网卡**，每张卡各自 `setMulticastInterface()` 后独立发 M-SEARCH；同时从默认路由出口（UDP connect 到公网 DNS 得到的本机地址）推断主网卡，结果里优先选它发现的设备；
3. 每个 `ST` 发**两轮**（间隔 1.3 s），避免无线网络丢 UDP 组播包；单轮监听 2.6 s；
4. 定向 `ST` 没找到网关时自动升级为 `ST: ssdp:all` 再扫一遍（部分路由器只认这个）；
5. 非虚拟网卡全失败时，把虚拟网卡也纳入重试。

所以即使网卡顺序里 VPN 排在第一位，也能正确定位到真实网关；页面的「网关设备」卡片会显示**是通过哪张网卡发现的**。

### NewInternalClient 必须是「到网关的那张网卡」的地址

另一个更隐蔽的坑：不少家用网关（实测华为 EchoLife）在 `AddPortMapping` 时会校验
`NewInternalClient` **必须等于控制连接的真实源 IP**，否则返回 `402 Invalid Args` —— 报错文字是「参数无效」，看着像参数写错了，其实是地址不对。

多网卡机器上「连公网 DNS 的出口」和「连路由器的出口」可能不是同一张网卡：

```
连 223.5.5.5 的出口 → 192.168.1.165（WLAN）
连 192.168.1.1 的出口 → 192.168.1.140（以太网）
```

用前者去填 `NewInternalClient` 就会被 402 拒掉，而且**只在接了 WiFi 的机器上才复现**，很难查。现在 `localIpFor(target)` 用 UDP connect 到**网关地址**取出口 IP；万一仍被 402 拒，会自动换本机其它 IPv4 再试一轮。

错误码已翻译成中文（714 条目不存在、718 端口占用、725 仅支持永久租期、606 未授权…），失败原因同时写进控制台日志。
设置 `HMCS_UPNP_DEBUG=1` 环境变量后，后端会把每次 SOAP 的请求头、请求体、响应原文打到 stderr，排查网关怪癖很方便。

**限制**（都是 UPnP 本身的，不是实现问题）：

- 路由器必须开启 UPnP。很多运营商光猫默认关闭，或只在内层设备上开启；**双 NAT** 要两层都开。
- 运营商级 NAT（CGNAT）下没有公网 IPv4，端口映射对外不可达，需要申请公网 IP 或改用 IPv6 / 内网穿透。
- Windows 防火墙仍可能拦截 `java.exe` 入站，映射成功后连不上先查这一项。
- 部分路由器不支持读取映射表（`GetGenericPortMappingEntry` 返回 401/501），页面会提示但不影响添加。
- 出于安全考虑，**不提供把 WebUI 端口映射出去的功能**；WebUI 始终只监听 `127.0.0.1`。

没有 UPnP 路由器也想看效果，可以起一个模拟网关：`node _dev\_mock-igd.js`（只在本机响应 SSDP，不碰真实设备）。
只想单独看 SSDP 发现过程，跑 `node _dev\_diag-ssdp.js`：它会对比「不指定网卡 / 逐网卡指定」两种方式的响应数量，多网卡问题一眼可见。

## 进程托管

- 自动挑选 Java：优先 Mojang 官方运行时（`%APPDATA%\.minecraft\runtime`），26.x 要求 Java 25、1.21.x 要求 21，版本不足会拒绝启动
- 强制 UTF-8：注入 `-Dstdout/stderr/stdin.encoding=UTF-8`，避免中文 Windows 下控制台与命令乱码
- 日志：环形缓冲 4000 行 + SSE 实时推送；`stop` 指令优雅关闭，30 秒未退出才强杀
- 状态判定：捕获 `Done (x.xxxs)!` 进入 `running`

## API 摘要

```
GET  /api/bootstrap                     实例、Java、提供方、设置、配置路径、客户端探测
POST /api/instances                     新建（同步下载核心，可传 dir 指定存放位置）
POST /api/instances/import              导入已有服务端目录（{dir, name?}）
DELETE /api/instances/:id?files=1       删除实例（files=1 连同磁盘目录；默认只移除记录）
POST /api/instances/:id/start|stop      启动 / 停止
POST /api/instances/:id/command         发送控制台命令
GET  /api/instances/:id/console         SSE 日志流
GET  /api/instances/:id/files           列目录
GET  /api/instances/:id/config/properties   读 server.properties + 字段 schema
GET  /api/instances/:id/eula            读 eula.txt 状态与原文
PUT  /api/instances/:id/eula            写同意状态（{accepted:bool} 或 {text:string} 原样覆盖）
GET  /api/worlds                        扫描本机存档（含 DataVersion→版本名映射）
POST /api/instances/:id/world/attach    链接 / 复制存档
GET  /api/plugins/search?instId=&q=     Modrinth 插件搜索
GET  /api/upnp/status?instId=&probe=1   网关信息 / 公网 IP / 映射表
POST /api/upnp/map                      建立映射（instId, externalPort, protocol, lease）
POST /api/upnp/unmap                    移除映射（可只删指定端口）
POST /api/upnp/auto                     保存「随启停自动映射」配置
GET  /api/fs/roots                      盘符 + 常用位置
GET  /api/fs/browse?path=               列子目录（目录选择器用）
POST /api/fs/mkdir                      新建目录
POST /api/reveal                        在资源管理器里打开路径
GET  /api/clients                       探测本机客户端实例（只读建议）
PUT  /api/settings                      保存设置（serversDir / clientRoots / extraWorldDirs / memory / javaPath）
```

## 已知限制

- **版本必须对齐**：世界 DataVersion 高于服务端版本时无法加载；客户端想进服也必须同版本（26.1 协议 775 ≠ 26.3 的 777）
- 原版 Vanilla 没有插件生态，插件页会提示改用 Paper/Purpur
- YAML 树形编辑会丢注释（已有 `.hmcs.bak` 备份，也可切文本模式）
- Modrinth 上部分插件未及时标注 26.3 兼容，搜索会自动放宽版本限制并列出可用版本，装前请核对
- 端口映射依赖路由器 UPnP：网关关闭、双 NAT、CGNAT 时映射不生效（页面会给出对应提示）
- WebUI 端口在数据目录的 `settings.json`（默认 8720），改后需重启；端口被占用会自动 +1 并在窗口打印实际地址
- Fabric 服务端 jar 由 meta.fabricmc.net 现场打包，首次请求可能要等 1-2 分钟（下载器会重试），不是卡死
- 旧版本把实例放在程序目录里的，注册表仍按原绝对路径工作；想整理可在设置里换目录后重新导入

## 许可

MIT License，详见 [LICENSE](LICENSE)。

本项目不含任何 Minecraft 官方资源：核心 jar、插件均从官方 / 第三方公开源按需下载，使用前请自行阅读并同意 [Minecraft EULA](https://aka.ms/MinecraftEULA)。
