'use strict';
const fs = require('fs');
const path = require('path');

/** 解析 server.properties，保留原有顺序与注释 */
function parse(text) {
  const lines = [];
  const map = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || t.startsWith('#') || t.startsWith('!')) { lines.push({ raw, kind: 'comment' }); continue; }
    const i = raw.indexOf('=');
    if (i < 0) { lines.push({ raw, kind: 'raw' }); continue; }
    const key = raw.slice(0, i).trim();
    const value = raw.slice(i + 1);
    lines.push({ raw, kind: 'kv', key, value });
    map[key] = value;
  }
  return { lines, map };
}

/** 写回：已存在的键只替换值，未命中的键追加到末尾 */
function apply(text, patch) {
  const { lines } = parse(text);
  const used = new Set();
  const out = lines.map(line => {
    if (line.kind !== 'kv') return line.raw;
    if (!(line.key in patch)) return line.raw;
    used.add(line.key);
    return `${line.key}=${patch[line.key]}`;
  });
  for (const [k, v] of Object.entries(patch)) {
    if (used.has(k)) continue;
    if (!/^[A-Za-z0-9._-]+$/.test(k)) continue;
    out.push(`${k}=${v === null || v === undefined ? '' : v}`);
  }
  // 去掉末尾多余空行，统一 CRLF
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out.join('\n') + '\n';
}

const DEFAULT_TEXT = `#Minecraft server properties
#由 HMCS 生成，可在 WebUI「配置」里可视化修改
level-name=world
server-port=25565
server-ip=
max-players=20
online-mode=false
white-list=false
enforce-whitelist=false
motd=A Minecraft Server
difficulty=normal
gamemode=survival
force-gamemode=false
hardcore=false
pvp=true
allow-flight=false
allow-nether=true
spawn-monsters=true
spawn-animals=true
spawn-npcs=true
generate-structures=true
level-seed=
level-type=minecraft\\:normal
view-distance=10
simulation-distance=10
spawn-protection=0
enable-command-block=true
enable-status=true
hide-online-players=false
player-idle-timeout=0
op-permission-level=4
function-permission-level=2
max-world-size=29999984
entity-broadcast-range-percentage=100
network-compression-threshold=256
prevent-proxy-connections=false
sync-chunk-writes=true
enable-query=false
query.port=25565
enable-rcon=false
rcon.port=25575
rcon.password=
require-resource-pack=false
resource-pack=
resource-pack-sha1=
resource-pack-prompt=
`;

// ---------------------------------------------------------------- 字段 schema（中文说明）
const F = (key, label, type, desc, extra) => ({ key, label, type, desc, ...(extra || {}) });

const SCHEMA = [
  {
    group: '基础',
    fields: [
      F('motd', '服务器标语', 'text', '多人游戏列表里显示的名字，支持 § 颜色代码'),
      F('server-port', '端口', 'int', '客户端连接用的端口，默认 25565；同机多开必须不同'),
      F('server-ip', '监听地址', 'text', '留空表示监听全部网卡'),
      F('max-players', '最大玩家数', 'int', '同时在线人数上限'),
      F('online-mode', '正版验证', 'bool', 'true 要求正版账号；与离线/外置登录共用存档时需注意 UUID 不同'),
      F('player-idle-timeout', '挂机踢出（分钟）', 'int', '0 表示不踢'),
      F('enable-status', '响应服务器列表', 'bool', '关闭后列表里显示为离线'),
      F('hide-online-players', '隐藏在线玩家', 'bool', '列表里不返回玩家名单'),
    ],
  },
  {
    group: '玩家与规则',
    fields: [
      F('white-list', '启用白名单', 'bool', '只允许 whitelist.json 里的玩家进入'),
      F('enforce-whitelist', '强制白名单', 'bool', '已在线但不在名单里的玩家会被踢出'),
      F('difficulty', '难度', 'enum', 'peaceful / easy / normal / hard', { options: ['peaceful', 'easy', 'normal', 'hard'] }),
      F('gamemode', '默认模式', 'enum', '新玩家进入时的游戏模式', { options: ['survival', 'creative', 'adventure', 'spectator'] }),
      F('force-gamemode', '强制模式', 'bool', '每次登录都重置为该模式'),
      F('hardcore', '极限模式', 'bool', '死亡即旁观，不可复活'),
      F('pvp', '允许 PVP', 'bool', '玩家之间能否互相伤害'),
      F('allow-flight', '允许飞行', 'bool', '生存模式下允许飞行（防作弊会因此放宽）'),
      F('enable-command-block', '启用命令方块', 'bool', '关闭后已有命令方块也不执行'),
      F('op-permission-level', 'OP 权限等级', 'enum', '4 为最高（可管理其他 OP）', { options: ['1', '2', '3', '4'] }),
      F('function-permission-level', '函数权限等级', 'enum', '数据包函数可用的权限等级', { options: ['1', '2', '3', '4'] }),
    ],
  },
  {
    group: '世界生成',
    fields: [
      F('level-name', '世界目录名', 'text', '对应服务器目录下的文件夹，也是存档链接指向的位置'),
      F('level-seed', '种子', 'text', '留空随机'),
      F('level-type', '世界类型', 'text', '原版为 minecraft\\:normal；插件/数据包可自定义'),
      F('allow-nether', '生成下界', 'bool', '关闭后无法进入下界'),
      F('generate-structures', '生成结构', 'bool', '村庄、要塞等'),
      F('spawn-monsters', '生成怪物', 'bool', ''),
      F('spawn-animals', '生成动物', 'bool', ''),
      F('spawn-npcs', '生成村民', 'bool', ''),
      F('spawn-protection', '出生点保护半径', 'int', '单位为方块，0 表示不保护'),
      F('max-world-size', '世界边界半径', 'int', '单位方块，最大 29999984'),
    ],
  },
  {
    group: '性能与网络',
    fields: [
      F('view-distance', '视距', 'int', '以区块计，越大越吃带宽与内存'),
      F('simulation-distance', '模拟距离', 'int', '实体/作物/红石的模拟范围'),
      F('entity-broadcast-range-percentage', '实体广播范围（%）', 'int', '降低可减少带宽占用'),
      F('network-compression-threshold', '压缩阈值', 'int', '数据包超过该字节数时压缩，-1 关闭'),
      F('prevent-proxy-connections', '阻止代理连接', 'bool', '开启后通过代理/VPN 的玩家可能被拒'),
      F('sync-chunk-writes', '同步写区块', 'bool', 'true 更安全，false 在机械盘上更快'),
      F('rate-limit', '包速率限制', 'int', '每秒允许的数据包数，0 为不限'),
    ],
  },
  {
    group: '资源包',
    fields: [
      F('resource-pack', '资源包地址', 'text', '直链 URL'),
      F('resource-pack-sha1', '资源包 SHA1', 'text', '用于校验完整性'),
      F('resource-pack-prompt', '资源包提示文字', 'text', ''),
      F('require-resource-pack', '强制资源包', 'bool', '拒绝加载会被踢出'),
    ],
  },
  {
    group: '查询与 RCON',
    fields: [
      F('enable-query', '启用 Query', 'bool', 'GameSpy4 协议查询，供监控面板使用'),
      F('query.port', 'Query 端口', 'int', ''),
      F('enable-rcon', '启用 RCON', 'bool', '远程控制台，注意只在内网开放'),
      F('rcon.port', 'RCON 端口', 'int', ''),
      F('rcon.password', 'RCON 密码', 'text', '务必设置强密码'),
      F('broadcast-rcon-to-ops', 'RCON 命令回显给 OP', 'bool', ''),
    ],
  },
];

function readProps(dir) {
  const p = path.join(dir, 'server.properties');
  if (!fs.existsSync(p)) return { text: DEFAULT_TEXT, exists: false };
  return { text: fs.readFileSync(p, 'utf8'), exists: true };
}

function ensureProps(dir, patch) {
  const p = path.join(dir, 'server.properties');
  let text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : DEFAULT_TEXT;
  if (patch) text = apply(text, patch);
  fs.writeFileSync(p, text, 'utf8');
  return text;
}

module.exports = { parse, apply, SCHEMA, DEFAULT_TEXT, readProps, ensureProps };
