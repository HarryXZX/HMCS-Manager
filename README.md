# HYCX MC Server Manager（HMCS）

> 一个跑在本机的「服务端版启动器」：下载核心、启动服务端、在 WebUI 里改文件与配置、把已有存档直接链接进来、通过 UPnP 把服务端端口开到公网。

仓库：<https://github.com/HarryXZX/HMCS-Manager>

纯 **Node.js + 原生 JavaScript** 实现：后端无框架（原生 `http` 路由），前端原生 JS/CSS，**无构建步骤、无数据库**。

默认只监听 `127.0.0.1`。需要从别的机器管理时，把监听地址改成 `0.0.0.0` 并**先设访问密码**（scrypt 加盐哈希 + 会话 Cookie + 登录限流），
再让 HMCS 用 UPnP 把自己的端口映射出去即可；也可以一键注册成 Windows 计划任务 / systemd / launchd 服务，开机自启、无窗口运行。

支持 **Windows / macOS / Linux**。

## 目录结构

```
<程序目录>                      ← 只有代码，可以随意移动 / 重新下载
  app.js              入口（HTTP 服务 + 全部 API + 认证闸门）
  lib/                sources（核心源）/ instances（实例注册表）/ fsbrowse（目录浏览）
                      proc（进程托管）/ worlds（存档）/ props / eula / upnp
                      auth（密码/会话/限流）/ selfmap（自身端口映射）/ logger（日志落盘）
                      firewall（跨平台防火墙放行 / 收回）
  public/             前端（原生 JS，无构建）；login.html 是独立的登录页
  scripts/            hmcsm.js（命令行入口）/ menu.js（命令行控制台）/ service.js（服务注册与管理）
                      firewall-cli.js（防火墙）/ install-cli.js（写 PATH）/ launch.js（脱离终端启动）
                      prompt.js（终端输入）/ reset-password.js（重置密码）
  _dev/               自测脚本（UPnP 网关、认证、hmcsm、防火墙、公网地址、前端冒烟、重启/换端口生效），可整个删除
  启动.bat            Windows 中文版（GBK 编码）
  start.bat           Windows 英文版（控制台无中文时用）
  安装服务.bat        Windows：注册 / 起停 / 自启 / 卸载（会请求管理员权限）
  start.sh            Linux / macOS
  install-service.sh  Linux / macOS：注册 / 起停 / 自启 / 卸载
  start-macos.command macOS 双击启动
```

数据目录（所有可变内容，**都不在程序目录**，程序目录被移动也不会丢配置）：

| 平台 | 配置（`settings.json` / `instances.json`） | 数据（`servers/`） |
| --- | --- | --- |
| Windows | `%APPDATA%\HMCS` | `%APPDATA%\HMCS` |
| macOS | `~/Library/Application Support/HMCS` | 同左 |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/HMCS` | `${XDG_DATA_HOME:-~/.local/share}/HMCS` |

Linux 按 [XDG Base Directory](https://specifications.freedesktop.org/basedir-spec/) 规范把配置与实例数据分开：配置小、值得备份；`servers/` 常是几十 GB 存档，归到 data 目录才不会被备份 / 同步工具当成配置一起搬。

```
  settings.json     应用设置（实例目录、客户端根目录、Java、内存、监听地址、认证参数）
  instances.json    实例注册表（记录每个实例的真实磁盘路径）
  sessions.json     会话表（只存令牌的 SHA-256，不存可用 Cookie）
  control.token     本机运维凭据（服务脚本用来优雅停止，0600）
  service.json      服务注册时写死的启动参数（端口 / 地址 / 后端类型）
  firewall-state.json  防火墙里由 HMCS 建的放行规则（用于精确删除、避免重复添加）
  servers/          默认实例存放目录（可在设置里改成任意位置）
  logs/             运行日志（仅 Linux 在 data 目录；Windows / macOS 与配置同目录）
```

`settings.json`、`sessions.json`、`control.token` 在 POSIX 上以 `0600` 创建。

环境变量 `HMCS_HOME` 可以把两者统一指到一个自定义目录（旧名 `HYSERV_HOME` 仍然兼容）。

## 启动方式

| 系统 | 怎么做 |
| --- | --- |
| Windows | 双击 **`启动.bat`**（中文提示，GBK 编码）；若控制台乱码改双击 `start.bat` |
| macOS | 双击 **`start-macos.command`**（首次可能需右键 → 打开）；或在终端 `./start.sh` |
| Linux | `./start.sh` |
| 任意系统 | 装一次 **`hmcsm`** 命令（见下），以后 `hmcsm --port 8720` 就能后台起服务 |
| 任意系统 | `npm install && npm start`（从源码直接跑） |
| 装成后台服务（开机自启） | Windows `安装服务.bat`；Linux / macOS `./install-service.sh`（详见下方「注册成系统服务」） |

脚本会检查 Node.js 版本（需要 **18+**）、依赖缺失时自动 `npm install`，启动后自动打开浏览器。
没有 Node.js 时会直接提示安装地址，不会闪退。

### 装一个 `hmcsm` 命令

不想每次翻目录找 `启动.bat` 的话，装一次就好（**不需要管理员权限**）：

```bash
node scripts/install-cli.js install     # 装
node scripts/install-cli.js status      # 看装在哪、PATH 里有没有
node scripts/install-cli.js uninstall   # 卸
```

| 系统 | 装到哪 | PATH 怎么处理 |
| --- | --- | --- |
| Windows | `<配置目录>\bin\hmcsm.cmd` | 追加到**用户** PATH（改注册表 `HKCU:\Environment`，不用 `setx`，`%JAVA_HOME%\bin` 这类变量不会被展开写死，也不会被 1024 字符截断） |
| Linux / macOS | `/usr/local/bin/hmcsm`（可写时）否则 `~/.local/bin/hmcsm` | 追加 `export PATH=...` 到 `~/.zshrc` 或 `~/.bashrc` |

装完**新开一个终端**（旧窗口读的还是旧 PATH），之后：

```bash
hmcsm                        # 打开命令行控制台（启停 / 安装 / 自启 / 密码 / 公网 / 防火墙）
hmcsm passwd                 # 改访问密码（两次输入，不回显；不需要旧密码）
hmcsm firewall sync          # 按配置同步防火墙规则
hmcsm url https://mc.example.com   # 设置公网访问地址（改端口重启后跳到它）
hmcsm --port 8800            # 以服务方式启动，端口存为 8800
hmcsm --host 0.0.0.0         # 允许局域网 / 外网访问（必须先设密码）
hmcsm stop                   # 停止（会先让 Minecraft 存档退出）
hmcsm status                 # 查看状态
```

`hmcsm` 不带参数进的是命令行控制台，一个进程内的菜单把这些都收在一起：

| | |
| --- | --- |
| 服务 | 启动 / 停止 / 重启 |
| 安装 | 安装 / 卸载系统服务（开机自动跑） |
| 自启 | 开启 / 关闭开机自启 |
| 命令 | 安装 / 卸载 `hmcsm` 命令（写 PATH） |
| 其他 | 打开管理界面、公网访问与密码、查看详细状态 |

菜单是**遥控器**：每个动作都是一次独立命令，退出菜单、甚至 Ctrl+C 都不会影响正在运行的面板。公网访问那一项里可以设密码、开关校验、切换免密范围、改监听地址 / 端口，**并一并同步防火墙**。

**两条规则：**

| 调用方式 | 行为 |
| --- | --- |
| **不带任何参数** | 只调起服务管理菜单，不启动任何进程。Windows 会请求管理员权限（安装服务要写计划任务） |
| **带参数** | 以**服务方式**启动：Windows 计划任务 / `systemd` / `launchd`。进程不挂在这个终端下，**关掉窗口不会跟着退出** |

服务方式启动时，`--port` / `--host` 会被写进 `settings.json`（不是写死成启动参数），所以之后在界面里改设置、点「一键重启」依然生效。

没有注册服务、或者当前身份没有安装权限时，`hmcsm --port 8800` 会**退化成独立后台进程**：同样是脱离终端的独立进程，关窗口不影响，但重启电脑后不会自动启动。终端里会明确提示这一点，以及怎么升级成真正的服务（`hmcsm install`）。

启动器优先用 PATH 里的 `node`，找不到才退回安装时记录的绝对路径 —— 以后换 Node 版本、用 nvm 切版本都不会失效。

> 如果已经把 HMCS 注册成开机自启的服务，`hmcsm --port` 走的是「改配置 + 重启服务」，不用手动 stop/start。

> Linux 发行版源里的 `nodejs` 常常太旧（Ubuntu 20.04 是 10.19）。没有 root 的话，把官方二进制解到
> `~/opt` 再软链到 `~/.local/bin` 就行，不必装系统包；JDK 同理（`~/opt/jdk-21`，HMCS 会自动扫到）。

**平台差异**：存档链接在 Windows 上用 NTFS 目录联接（Junction，不需要管理员权限），在 macOS / Linux 上用符号链接，效果一致；Java 探测会自动扫描各平台常见安装位置、`JAVA_HOME` 与 `PATH`。

1. **新建服务器** → 选核心类型与 MC 版本 → 自动下载核心（Paper 26.3 约 55 MB，实测 36 秒）
2. **同意 EULA**：未同意时概览页有红色提示、顶栏显示 `EULA 未同意`，服务端拒绝启动。到 **配置 → eula.txt** 勾选并写入即可（详见下方「EULA」）
3. 顶部 **启动** → 弹窗里可改内存 / Java / JVM 参数，并**手动挑一个本机存档**（默认保持当前世界）
4. 切到 **控制台** 看实时日志、发命令；**文件** 页可上传/下载/改名/在线编辑；**配置** 页可视化改 `server.properties` 与 YAML/JSON
5. **插件** 页搜 Modrinth 直接装；**世界** 页可随时把别的存档链接进来或断开链接
6. **网络** 页检测 UPnP 网关并一键开端口，可设成「随服务端启停自动映射」

## 端口：固定，不漂移

WebUI 端口是**固定**的，默认 `8720`。取值优先级：命令行 `--port` > 环境变量 `HMCS_PORT` > `settings.json` 的 `port`。

启动时生效的那个值会**同步写回 `settings.json`**（只写 `host` / `port` 两个字段）。这样「界面里显示的目标值」永远等于「重启后会用的值」：否则你用 `--port 9000` 起了一个，界面里还显示着 8720 待生效，点一下重启反而跳回 8720，谁也说不清听谁的。

端口被别的程序占用时，HMCS 会直接报错退出，**不会偷偷 +1 换个端口**——因为这个地址可能已经写进了服务配置、书签、端口映射里，静默漂移只会让人找不到界面。

```
端口 8720 已被其他程序占用。HMCS 使用固定端口，不会自动换端口。
  查占用进程：netstat -ano | findstr :8720   然后 taskkill /PID <PID> /F
  或者换个端口启动：node app.js --port 8721（同时要改 settings.json 或服务配置）
```

退出码约定：`1` = 端口被占用（可重试），`2` = 配置错误（对外监听但没设密码、端口非法、端口 <1024 无权限）。服务脚本依赖这个区分，`systemd` 里配了 `RestartPreventExitStatus=2`，避免配置错了还无限重启。

### 改完不用回命令行：页面里直接重启

监听地址和端口都属于「下次启动生效」。设置页会**同时显示两个值**：

- 下拉框里的是**已保存**的值（下次启动会用的）
- 下面一行小字是**当前正在运行**的值

两者不一致时，保存后会出现一条黄色提示 **「重启后生效」**，旁边是 **「立即重启」** 按钮：

- 点了之后后端自己重启（不需要你去命令行重新跑）
- 重启前会**先安全关闭正在运行的 Minecraft 服务端**（等它们写完存档），确认框里会列出来
- 页面会轮询等新进程起来（比对 pid，避免把还没退干净的旧进程当成成功），然后自动刷新
- **重启成功后黄条自动消失**：新进程的 `net.bind` 就等于 `settings.json`，运行值和保存值一致，本来就没有「待生效」这回事了
- 改了端口的话，页面会自己**跳到新地址**（`http://<当前主机>:<新端口>/#settings`），不用手动改书签；改成了「仅本机」且你正从局域网访问时，确认框会先警告「这个地址以后进不来」
- 想反悔就点「撤销改动」，把配置改回当前运行中的值

**如果黄条一直不消失**，说明配置确实没生效，不是界面画错了。常见原因就两种：新进程没起来（去 `<数据目录>/logs/manager.log` 看，最常见是端口被占），或者是 0.3.3 之前的老版本 —— 那时重启会把命令行里的 `--port` / `--host` 原样继承给新进程，命令行优先级更高，界面里改的永远压不过它。

**重启失败的兜底**：新进程启动后如果 1.8 秒内就退出了（配置非法、Node 被删、端口被别人抢了），老进程会**放弃重启继续服务**，日志里记一条「重启中止」——不会出现「重启失败 = 面板彻底打不开」。此时页面会提示重启超时，去 `<数据目录>/logs/manager.log` 看原因。

在服务模式下（systemd / 计划任务）：systemd 走 `Restart=always`，程序 exit(0) 后由 systemd 拉起；Windows 计划任务和 launchd 由程序自己拉起副本，参数继承时**只保留 `--home` / `--log-file` 这类路径参数，主动摘掉 `--port` / `--host` 和 `HMCS_PORT` / `HMCS_HOST`** —— 重启的目的就是让新保存的监听配置生效，把旧的监听参数带过去等于白重启。

## 远程访问与密码

默认只听 `127.0.0.1`，只有本机能打开。要让它从别的机器访问：

1. **先设密码**：设置 → 远程访问 → 设置密码（至少 8 位）
2. **再改监听地址**：改成「所有网络（0.0.0.0）」
3. 点保存，页面出现黄条后点 **「立即重启」**（或自己重启 HMCS）

顺序不能反。**监听非回环地址却没有密码时，程序拒绝启动**（退出码 2），因为管理面板能执行任意服务器指令、读写实例文件、删世界存档，裸奔到网络上等于把机器交出去。确实不需要密码的场景（受控内网）可以加 `--allow-insecure`。

### 防火墙：开关公网访问时一并处理

只把监听地址从 `127.0.0.1` 改成 `0.0.0.0` 还不够 —— Windows Defender 防火墙、`ufw`、`firewalld` 默认会拦掉外部发起的入站连接，表现就是「界面显示已开放，但局域网连不上」。所以切换监听地址 / 端口时会顺带把防火墙改好：

| 平台 | 做法 | 需要权限 |
| --- | --- | --- |
| Windows | `netsh advfirewall` 加入站放行规则，规则名固定 `HMCS-WebUI` | 管理员 |
| Linux | `ufw allow <端口>/tcp`（优先）或 `firewall-cmd --add-port`；防火墙没启用就跳过 | root |
| macOS | 默认允许访问已监听端口，跳过 | — |

- **开公网** → 放行当前端口；**改端口** → 删旧端口、加新端口；**改回仅本机** → 收回规则
- 规则只按 `HMCS-WebUI` 这个名字或自己记过的端口删除，不动你自己配的其它规则
- 状态记在 `<配置目录>/firewall-state.json`，重复启动不会反复执行命令；规则被安全软件清掉后会自动补回
- **权限不够时不会假装成功**：日志和界面都会提示「需要管理员 / root」，并给出一条可直接复制的手动命令。服务模式下进程本身是 SYSTEM / root，通常自动就成；普通终端里改的话，Windows 会单独弹一次 UAC，Linux 用 `sudo hmcsm firewall sync`
- 设置页「远程访问」卡片里会实时显示：已放行 / 尚未放行 / 待收回

命令行也能单独处理：

```bash
hmcsm firewall            # 看现在放行了没有
hmcsm firewall sync       # 按当前配置同步（Linux 加 sudo）
hmcsm firewall on | off   # 强制放行 / 收回
```

| 机制 | 实现 |
| --- | --- |
| 密码存储 | `scrypt(N=16384, r=8, p=1)` + 16 字节随机盐，存 `scrypt$N$r$p$salt$hash`；比对走 `timingSafeEqual` |
| 会话 | 32 字节随机令牌进 Cookie（`HttpOnly; SameSite=Lax`，HTTPS 下自动加 `Secure`）；`sessions.json` 只存 SHA-256 |
| 改密码 | 旧会话立即全部失效，同时给当前浏览器换发新会话，不会把自己踢出去 |
| 登录限流 | 同一 IP 连续 5 次失败后指数退避：60 秒起，翻倍，上限 30 分钟；返回 `Retry-After` |
| 跨站防护 | 写操作校验 `Origin` 与 `Host` 是否一致 + `SameSite=Lax` |
| 响应头 | `X-Frame-Options: DENY`（防点击劫持）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` |
| 本机免密 | 「仅非本机访问需要密码」默认开启；本机 `127.0.0.1` 直连不用登录，方便你在服务器本机操作 |

**忘了密码**：本机执行

```bash
node scripts/reset-password.js              # 交互式设置新密码
node scripts/reset-password.js --clear      # 关掉密码访问
```

**关于 HTTPS**：内置服务是明文 HTTP，经公网直接访问时密码在链路上可见。正经做法是套一层 Nginx / Caddy 做 TLS 反代（或用内网穿透自带的加密隧道），反代后把「信任反向代理头」打开，并把监听地址改回 `127.0.0.1` —— 反代和 HMCS 在同一台机器时这是最安全的组合。

### 公网地址：域名由你自己填

「监听地址」管的是 HMCS 听哪个网卡，「对外用哪个地址访问」是另一件事。套了 Nginx / Caddy / CDN 之后，面板内部端口怎么改，外部地址通常一直是 `https://mc.example.com`。所以设置页「远程访问」里留了一个可选项：

```
公网访问地址（可选，域名 / 反向代理）
```

- 填了以后，**关于页 / 命令行 `hmcsm status` 的访问地址**都优先显示它
- **改端口重启后，页面跳到它**，不再拼「当前 IP : 新端口」—— 反代 / CDN 后面这是唯一正确的落点
- 留空就按当前访问地址走，和以前一样
- 只接受 `http://` / `https://`，可带端口和路径前缀（`https://mc.example.com:8720`、`https://example.com/hmcs`），不带协议自动补 `http://`
- 拒绝 `javascript:` / `data:` / 带账号密码 / 带查询串 —— 这个值会直接用于页面跳转，不能让它变成 XSS 入口
- 纯展示 + 跳转，**不参与监听**，保存即生效，不用重启

从本机（`127.0.0.1`）操作时仍然跳本机地址，避免「改个端口被扔去走公网」；从局域网 IP 访问时会跳到域名，若内网回不到公网（NAT 回流没开），重启确认框里会同时给出直连地址兜底。反向代理场景下监听地址应保持「仅本机」，只让反代能连到面板；**面板内部端口改了，反代里的 `proxy_pass` 要同步改**（域名不用动，所以对外地址始终是同一个）。

```bash
hmcsm url                          # 看当前填了什么
hmcsm url https://mc.example.com   # 设置
hmcsm url off                      # 清除，改回按当前 IP + 端口
```


### 自动端口映射（UPnP）

设置里可以打开「启动时自动映射」：HMCS 启动后用 UPnP 把自己的 WebUI 端口登记到路由器，退出时回收。外网端口可以填别的（比如外网 8721 → 内网 8720）。

- 只有在监听地址不是「仅本机」时才允许开启，否则映射建好了也没人应答
- 和「网络」页给游戏端口做映射用的是同一套 `lib/upnp.js`，同样受 CGNAT 限制
- 映射成功会在日志里打印 `外部访问地址 http://<公网IP>:<端口>`

## 手机 / 平板访问

手机连同一个 Wi-Fi，浏览器打开 `http://<电脑局域网 IP>:8720`（或你填的公网域名）就行。界面做了窄屏适配：

- **侧栏变抽屉**：点左上角的 ☰ 打开服务器实例列表，选完自动收起；点遮罩、关闭按钮或按 Esc 也能关。以前窄屏上侧栏直接被挪出屏幕、又没有任何入口，等于打不开其它实例
- **弹窗变底部抽屉**：启动服务端这类弹窗固定在屏幕底部，内容再长，「启动服务端」按钮也一直贴在拇指够得到的地方 —— 之前用 `90vh` 算高度，iOS Safari 的地址栏 / 底部工具栏会把它盖住，看起来就是「按钮点不到」。现在改用 `dvh` 并按 `env(safe-area-inset-bottom)` 留白
- 顶栏重排成「菜单 + 标题 + 启停」，状态标签单独一行横向滚动；页签、宽表格、状态标签都能横向滑
- 表单单列、路径输入与按钮分行、卡片两列；按钮至少 40px 高，弹窗底部主按钮 46px
- 没有 hover 的触屏上，删除 / 行内操作按钮常显（不用「悬停才出现」）
- 输入框统一 16px，避免 iOS 聚焦时自动放大页面；登录页同样处理
- 如果点「启动服务端」只是弹一句「需要先勾选同意 Minecraft EULA」，弹窗会自动滚到上面的勾选框，不用自己找

## 注册成系统服务

三个平台都有一键脚本，交互菜单与命令行两种用法：

| 系统 | 入口 | 实现 |
| --- | --- | --- |
| Windows | `安装服务.bat` | 计划任务 `HMCS`：`/SC ONSTART` + `/RU SYSTEM` + `/RL HIGHEST`，开机即起、无窗口、不依赖登录 |
| Linux | `./install-service.sh` | systemd：root 装系统级（`User=<你>`），非 root 自动装用户级 + `enable-linger` |
| macOS | `./install-service.sh` | launchd `~/Library/LaunchAgents/com.hycx.hmcs.plist`，`RunAtLoad` 控制自启 |

```
1) 安装 / 重装服务
2) 启动服务
3) 停止服务
4) 开机自启  开 / 关
5) 查看状态
6) 卸载服务
7) 打开管理界面
8) 安装 hmcsm 命令到 PATH
```

命令行等价写法：

```bash
node scripts/service.js install            # 注册并启动（默认开启自启）
node scripts/service.js install --port 8720 --host 0.0.0.0 --no-autostart
node scripts/service.js start | stop | restart
node scripts/service.js enable | disable   # 只切开机自启
node scripts/service.js status             # 状态 + 版本 + 已运行时长 + 访问地址
node scripts/service.js uninstall          # 卸载（保留数据与实例）
node scripts/service.js install --dry-run  # 只打印将要写入的 unit / 计划任务参数
```

`sudo ./install-service.sh install` 会把服务装成系统级，但 **以调用 sudo 的那个用户身份运行**（脚本读 `SUDO_USER`），配置目录仍然落在你自己的家目录，不会凭空多出 `/root/.config/HMCS`。

**端口和监听地址不在启动参数里**：安装时会把 `--port` / `--host` 写进 `settings.json`，`ExecStart` / 计划任务参数只留 `--log-file`。原因很实际 —— 命令行参数优先级高于配置文件，一旦写死，你在界面里改完设置、点了重启，还是会被老参数压回去，表现就是「设置保存了但永远不生效」。

`--home` 只在两种情况出现：Windows（SYSTEM 账户的 `%APPDATA%` 与安装者不同）和设置了 `HMCS_HOME`（配置+数据合并到一个自定义目录）时。Linux / macOS 正常安装**不会**带它 —— 带上反而会把 `~/.local/share/HMCS` 并到 `~/.config/HMCS`，看着像「装完服务，实例和存档全不见了」。

> **从 0.3.0 及更早版本升级上来**：旧的服务配置里写着 `--port` / `--host`，请**重新运行一次安装**（`安装服务.bat` 或 `./install-service.sh install`）让 unit / 计划任务换成新参数。重装会自动停掉旧实例、保留所有数据与实例。

**停止是优雅的**：Linux / macOS 走服务管理器自己的 `stop`（发 `SIGTERM`），HMCS 收到后逐个给运行中的 Minecraft 发 `stop`、等存档写完再退出，systemd 的 `TimeoutStopSec=80` 就是这个余量；Windows 的 `schtasks /End` 是强杀，所以先 `POST /api/system/shutdown`（用本机 `control.token` 鉴权）请它自己退，超时才 End。

这里有个容易踩的坑：systemd 配的是 `Restart=always`（界面上的「一键重启」靠它拉起新进程），所以**不能让进程自己 `exit(0)` 来「停止」** —— 几秒后 systemd 又会把它拉回来，表现就是「点了停止，过一会儿又活了」。停止必须走 `systemctl stop`，让它被标记为「人为停止」。

**Windows 的取舍**：Windows 没有免依赖的真·服务宿主（写 SCM 需要原生模块，NSSM / WinSW 要额外下载二进制）。这里用「计划任务 + SYSTEM」达到等价效果。因为 SYSTEM 的 `%APPDATA%` 和你的不同，脚本会用 `--home` 把数据目录钉死成安装者的配置目录，所以实例列表不会跑到 `C:\Windows\system32\config\systemprofile` 下面去。注意「关闭开机自启」在 Windows 上等于禁用该任务，此时手工 `start` 会临时启用、启动后自动恢复禁用。

**日志**：服务模式没有控制台，`console` 输出会自动写进 `<数据目录>/logs/manager.log`（5 MB 滚动、留 3 份，权限 0600）。Linux 上同时能用 `journalctl --user -u hmcs -f`（系统级则去掉 `--user`）看。

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

- 自动挑选 Java：Windows 扫 Mojang 官方运行时（`%APPDATA%\.minecraft\runtime`）与 `Program Files`；Linux/macOS 扫
  `/usr/lib/jvm`、`/Library/Java/JavaVirtualMachines`、Homebrew，以及**用户自己装的 JDK**（`~/opt`、`~/.jdks`（IntelliJ）、
  SDKMAN、mise、jabba、Android Studio / JetBrains Toolbox 自带的 JBR）。26.x 要求 Java 25、1.21.x 要求 21，版本不足会拒绝启动
- 强制 UTF-8：注入 `-Dstdout/stderr/stdin.encoding=UTF-8`，避免中文 Windows 下控制台与命令乱码；
  Linux/macOS 另外注入 `-Dsun.jnu.encoding=UTF-8` 并把子进程 locale 兜底成 `C.UTF-8`——**否则从 SSH / systemd 这类
  没有 locale 的环境启动时，中文世界名会直接 `InvalidPathException` 起不来**
- 日志：环形缓冲 4000 行 + SSE 实时推送；`stop` 指令优雅关闭，启动阶段会每 3 秒补发一次，30 秒未退出才强杀
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
PUT  /api/settings                      保存设置（serversDir / clientRoots / extraWorldDirs / memory / javaPath / host / port / publicUrl）
POST /api/system/restart                重启自己（改完端口 / 监听地址不用回命令行）
POST /api/system/firewall               同步 / 收回防火墙规则（control token，仅本机）
POST /api/auth/local                    本机运维改密码 / 开关校验 / 免密范围（control token，不要旧密码）
POST /api/system/shutdown               优雅停止（服务脚本用）
GET  /api/auth/state                    认证状态（免登录可读，用于登录页判断）
POST /api/auth/login|logout             登录 / 退出（登录成功下发 HttpOnly 会话 Cookie）
PUT  /api/auth/password                 设置 / 修改密码（已设置时必须带 current）
PUT  /api/auth/options                  开关、免密范围、信任反代、会话天数
GET  /api/net/self?probe=1              自身端口的映射状态 / 网关 / 外网地址
PUT  /api/net/self                      保存自动映射配置（auto / externalPort / protocol / lease）
POST /api/net/selfmap|unmap             立即映射 / 取消映射
GET  /api/system/ping|info|log          探活 / 运行信息 / 最近日志（ping 支持跨源读，供换端口后探活）
```

除 `/api/auth/*`、`/api/system/ping` 之外，所有接口在开启密码访问后都需要会话 Cookie，
或本机 `X-HMCS-Control: <control.token>` 头（供服务脚本使用）。


## Linux 实测（Ubuntu 20.04 无桌面机）

不是"理论上支持"，是实际跑过一遍：

| 项目 | 结果 |
| --- | --- |
| `./start.sh` 首次启动 | 自动 `npm install` → 起服务 → 只监听 `127.0.0.1:8720` |
| 数据位置 | 配置 `~/.config/HMCS`、数据 `~/.local/share/HMCS`（XDG 规范），实例落在数据目录 |
| Java 探测 | 只有系统 JDK 8 时能正确拒绝启动并提示"需要 Java 21+"；装到 `~/opt/jdk-21` 后自动识别 |
| 核心下载 | Mojang 清单 + Vanilla 1.21.4 核心（54 MB）4 秒下完 |
| 存档链接 | 建立的是**符号链接**（非 junction），`readlink` 指向真实存档，`level-name` 同步 |
| 中文世界名 | 修复前 JVM 报 `InvalidPathException: unmappable characters`，修复后正常 |
| 服务端启动 | `Done (1.03s)!`，状态切到 `running`，日志无 `\r` 残留、无乱码 |
| 控制台 | `list` / `say` 有回显 |
| 停止 | 连续 6 轮（含启动阶段中断）全部 `exit 0`，日志有 "Saving chunks"；修复前会卡 30 秒被强杀 |
| UPnP | VM 在 NAT 后，探测优雅失败并给出中文提示，不阻塞、不报错 |
| 前端 | 用 DOM 桩跑全部 8 个标签页（含真实实例），无运行时错误 |
| systemd 注册 | `./install-service.sh install --port 8791` → 写 unit、`enable`、`linger` 全成功，`curl` 有应答 |
| 服务起停 | `stop` 走优雅关闭（`ExecMainStatus=0`），`SIGTERM` 直接 `systemctl stop` 也是 0；`restart` / `--no-autostart` / `uninstall` 全部符合预期 |
| 自启开关 | `disable` → `is-enabled=disabled` 且服务仍在跑；`enable` → `enabled` |
| 远程访问 | 监听 `0.0.0.0`：本机 `127.0.0.1` 免密 200，局域网 IP 401 并跳 `/login`；登录后 Cookie 访问 200 |
| 配置权限 | `settings.json` / `sessions.json` / `control.token` / `service.json` 均为 `0600` |
| 日志落盘 | 服务模式无控制台时自动写 `~/.local/share/HMCS/logs/manager.log`，含局域网地址与登录记录 |

## 已知限制

- **版本必须对齐**：世界 DataVersion 高于服务端版本时无法加载；客户端想进服也必须同版本（26.1 协议 775 ≠ 26.3 的 777）
- 原版 Vanilla 没有插件生态，插件页会提示改用 Paper/Purpur
- YAML 树形编辑会丢注释（已有 `.hmcs.bak` 备份，也可切文本模式）
- Modrinth 上部分插件未及时标注 26.3 兼容，搜索会自动放宽版本限制并列出可用版本，装前请核对
- 端口映射依赖路由器 UPnP：网关关闭、双 NAT、CGNAT 时映射不生效（页面会给出对应提示）
- 防火墙只自动处理 `netsh` / `ufw` / `firewalld`；自定义 `iptables` / `nftables` 规则需要自己维护（CLI 会给出提示）
- WebUI 端口固定（默认 8720），被占用时直接报错退出、不会自动换端口；改端口/监听地址在设置页里改，保存后点「立即重启」即可生效（服务模式同样适用，因为这两个值不在服务启动参数里）。换了端口页面会自动跳到新地址，但跳过去是**另一个 origin**，新 origin 下的实例选择（`localStorage`）不会跟着过去，会自动落到第一个实例
- 改成「仅本机」后又想从局域网访问，只能回本机改成 `0.0.0.0`——远程已经进不来了，这是设计如此
- 「一键重启」在 systemd 下依赖 unit 里的 `Restart=always`；如果你是手工写的 unit，需要自己保证这一点，否则程序退出后就真停了
- 防火墙放行需要管理员 / root：Windows 计划任务（SYSTEM）、systemd 系统级服务通常自动成功；用户级服务或普通终端里改配置时可能失败，会提示手动执行 `hmcsm firewall sync`（Windows 会单独弹一次 UAC）。macOS 不做处理（默认不拦已监听端口）
- 内置服务是 **HTTP**，没有自带 TLS。经公网明文访问时密码在链路上可见，请套 HTTPS 反代或加密隧道
- 「仅非本机免密」依赖连接的真实来源 IP；只有挂了反向代理时才该打开「信任反向代理头」，否则别人可以伪造来源绕过
- Windows 的服务化用计划任务实现（SYSTEM 账户 + 开机启动），不是 SCM 注册的 `services.msc` 条目；关闭自启等于禁用该任务
- Fabric 服务端 jar 由 meta.fabricmc.net 现场打包，首次请求可能要等 1-2 分钟（下载器会重试），不是卡死
- 旧版本把实例放在程序目录里的，注册表仍按原绝对路径工作；想整理可在设置里换目录后重新导入

## 许可

MIT License，详见 [LICENSE](LICENSE)。

本项目不含任何 Minecraft 官方资源：核心 jar、插件均从官方 / 第三方公开源按需下载，使用前请自行阅读并同意 [Minecraft EULA](https://aka.ms/MinecraftEULA)。
