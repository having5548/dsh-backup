<div align="center">

# 💾 dsh-backup

**DeepSeek Harness 备份与恢复插件** — 工作区、完整对话、附件、设置、mnemon 记忆，一个 ZIP 全带走，换机 / 重装 / 升级后原样恢复。

![Version](https://img.shields.io/badge/version-0.2.0-4c7ef3?style=flat-square)
![Format](https://img.shields.io/badge/format-DshBackup%20v1-2b6cb0?style=flat-square)
![CI](https://github.com/having5548/dsh-backup/actions/workflows/ci.yml/badge.svg?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078d6?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)
![Dependencies](https://img.shields.io/badge/dependencies-1%20(schemastery)-9cf?style=flat-square)

</div>

---

## ✨ 特性

| | | |
|---|---|---|
| 🗂 **工作区级备份**<br>类似 VS Code 的 Profile 导出：一个 ZIP 携带工作区注册表 + 全部会话 + 附件 + 设置 + 插件清单 | 🔒 **对话字节级保真**<br>会话文件全程不解包、不改写，恢复后 AI 可完整识别全部历史 | 🔁 **版本双向兼容**<br>旧代际会话由 harness 自带迁移链自动升级；未来新版 harness 的会话也能装进当前备份 |
| 🧠 **mnemon 注入一致**<br>`~/.mnemon` 三目录按字节备份，覆盖导入 = 全量还原，上下文注入与备份时完全一致 | 🔍 **先预检再动手**<br>导入前看清楚将新增 / 覆盖 / 保留多少数据、缺哪些插件；导入后给出逐组件报告 | 🛟 **救援通道**<br>每份磁盘备份都带零依赖的 `rescue.mjs` 与「点我恢复」双击启动器——DSH 起不来也能还原 |
| 🔀 **合并 / 覆盖双模式**<br>合并只补缺不覆盖（日常）；覆盖整批替换（灾难恢复），语义透明、行为可预期 | ⏰ **自动备份 + 轮换**<br>定时写盘到本机备份目录，每份带 `.sha256` 校验文件，按保留份数自动轮换，重启不中断 | 🩺 **会话体检**<br>一键扫描全部会话文件（zstd 魔数 / 文件头 / 空文件），异常早发现 |
| 🤖 **/backup 斜杠命令**<br>在对话里直接 `/backup`、`/backup restore latest --dry-run`、`/backup auto 12` | 🔐 **凭据脱敏**<br>导出时 settings.yaml 中的密钥值替换为占位符，明文不出备份包；恢复时自动保留本机现值 | 🪶 **零重依赖**<br>ZIP 流式读写与全部合并逻辑为内置纯 JS 实现，仅依赖 `schemastery` |

## 📦 安装

```bash
# 打包
npm pack          # 得到 dsh-backup-0.1.0.tgz

# 安装到 DSH web profile
dsh plugin --profile web add dsh-backup-0.1.0.tgz
```

也可以从 GitHub Release 直接装：

```bash
dsh plugin --profile web add https://github.com/having5548/dsh-backup/releases/download/v0.1.0/dsh-backup-0.1.0.tgz
```

安装后**重启服务**（桌面端工具栏「重新连接服务」），打开 **设置 → 备份与恢复**。

## 🚀 快速开始

### 方式一：设置面板（推荐）

1. 打开 **设置 → 备份与恢复**，状态卡会显示数据目录、会话数、工作区数与 mnemon 概况
2. 勾选要包含的组件（每项实时显示文件数与体积）→「导出备份包」
3. 恢复：选择备份包 →「预检」→ 合并 / 覆盖 →「执行导入」

### 方式二：对话里敲 `/backup`

```
/backup                    # 立即备份（默认写到 ~/Desktop/dsh-backups/，输出 sha256）
/backup auto 12            # 每 12 小时自动备份，重启不中断
/backup restore latest --dry-run   # 先预览恢复会做什么
/backup restore latest     # 正式恢复（默认合并模式）
/backup list | verify all | doctor | help
```

每份磁盘备份都附带 `rescue.mjs` 和「点我恢复」双击启动器（Windows `.bat` / macOS `.command` / Linux `.sh`）——DSH 起不来时，装个 Node 就能恢复。

### 导入恢复（面板流程）

1. 选择备份包 → 点「**预检**」：看清楚备份来自哪里、将发生什么、缺哪些插件
2. 选择模式：**合并导入**（推荐）或 **覆盖导入**
3. 勾选要恢复的组件 → 「执行导入」→ 查看报告
4. 报告提示后**重启服务**并刷新页面，会话列表完全刷新

> 换机 / 重装 → 用「覆盖导入」一步回到备份时点；日常把旧机器的数据并进新机器 → 用「合并导入」。

## 🗜 备份包含什么

| 组件 | 内容 | 默认 |
|---|---|:---:|
| 会话记录 | `~/.dsh/sessions/` + `dsh-session-archive/`，全部对话（含归档会话） | ✅ |
| 工作区注册表 | `~/.dsh/storages/workspace.json`（工作区列表、排序、会话归属） | ✅ |
| 会话投影缓存 | `storages/session_projcache/`，可再生，加速恢复后首次打开 | ✅ |
| 附件 | 对话中引用的图片 / 文件（`~/.dsh/attachments/`） | ✅ |
| 设置 | `settings.yaml`，各插件设置（**可能含 API 密钥，请妥善保管备份**） | ✅ |
| Profile 插件清单 | `profiles/web/` 的 package.json 与 patch 文件；导入时仅补缺并生成缺失插件报告 | ✅ |
| dsh-mnemon 记忆数据 | `~/.mnemon/{runtime, documents, data[, state]}`，上下文注入的全部来源 | ✅ |
| 其他插件数据 | task-board / dsh-usage / skins 等第三方插件的数据目录（动态发现） | ⬜ |

## 🔀 两种导入模式

| | 合并导入（推荐） | 覆盖导入 |
|---|---|---|
| 会话 / 附件 / 缓存 | 同名文件保留本机，只补充备份多出的 | 备份内容替换本机同名文件；本机多出的数据**不会**被删除 |
| 工作区注册表 | 按 UUID 合并，`updatedAt` 新者胜，排序保序 | 整体替换为备份版本 |
| mnemon 热记忆 | 按 `target+content` 去重并入；MEMORY.md / USER.md 保留本机投影，下次写入自动重投影 | 按备份原样还原 |
| mnemon 文档 | 同 id 同 contentHash 跳过；同 id 异内容换新 id 导入 | 按备份原样还原 |
| mnemon 记忆体（SQLite） | 仅新增 body，已有 body 一律保留本机 | 全量替换（先清 `-wal`/`-shm`，防旧 WAL 配新库） |
| settings.yaml | 跳过（想覆盖请用覆盖模式） | 整体替换 |
| 被替换的原文件 | — | 保留为 `*.bak-dshbackup-<时间戳>`，可随时手动还原 |

## 🛟 救援通道（DSH 起不来时）

磁盘备份目录里的 `rescue.mjs` 是**零依赖**单文件（只用 Node 内置模块），不依赖 DSH：

```bash
node rescue.mjs list                              # 列出备份
node rescue.mjs verify dsh-backup-xxx.zip         # 逐条目 CRC 校验
node rescue.mjs restore latest --dry-run          # 预览（默认只补缺失文件，绝不覆盖）
node rescue.mjs restore latest --force            # 覆盖恢复（原文件留 *.bak-rescue-*）
```

Windows 双击「点我恢复.bat」、macOS 双击「点我恢复.command」进入交互式菜单。
也可以在设置面板点「下载救援工具包」把它和备份放在一起。

## 🔐 凭据脱敏

- 导出（含自动备份）默认把 `settings.yaml` 中疑似密钥的值（`apiKey` / `token` / `password` / `secret`…，自动识别 camelCase）替换为占位符，**明文不出备份包**；占位符清单写在包内 `redaction.json`
- 覆盖导入时，占位符处自动回填**本机现值**（本机没有的保留占位符并在报告中提示重填）——换机恢复后无需担心密钥互相覆盖
- 需要明文备份（如本机冷存档）可在导出时取消勾选

## ⏰ 自动备份

- `/backup auto 12`：每 12 小时一次（1–720），重启 dsh 后自动续跑，不中断
- 每份备份：`dsh-backup-<时间戳>.zip` + 同名 `.sha256`（sha256sum 格式）+ 救援工具
- 保留策略：默认保留最近 7 份（`/backup --keep N` 或面板设置），超出自动轮换删除

## 🧠 为什么 dsh-mnemon 上下文注入能「跟原本一样」

mnemon 的注入内容全部来自 `~/.mnemon` 三个目录：

- `runtime/memories.json` — 热记忆单一事实源（+ MEMORY.md / USER.md 投影）
- `documents/` — 项目文档与 `index.json` 登记表
- `data/<bodyId>/mnemon.db` — 记忆体证据图（SQLite）

dsh-backup 在导入前校验两组对应关系（index ↔ 文件、bodies ↔ db 目录），
**覆盖导入按字节还原这三处**，因此恢复后 mnemon 的 `system-prompt/assemble` 注入段与
`agent/pre-step` 记忆快照和备份时完全一致，AI 拿到的上下文不变。

> ⚠️ 若 mnemon 使用 `workspaces` 存储范围（按工作区路径哈希分桶），恢复后请保持
> 工作区**目录路径不变**，否则 mnemon 会以新路径建新桶。默认 `global` 范围无此顾虑。

## 🛡 数据安全设计

```
上传备份包 → 暂存区落盘 → 逐文件 CRC32 / sha256 校验 → 原子提交（tmp → rename）
                                    ↓ 校验失败
                              拒绝导入，本机数据零改动
```

- 暂存区放在目标所在磁盘内，rename 同卷原子；不占大块内存，GB 级备份也稳
- manifest.json 有独立 sha256，防清单被篡改；`formatVersion` 更新的备份**明确拒绝**并提示升级插件
- 导入过程被中断：暂存区自动清理，已提交文件前均有 `.bak`，可手动恢复
- 同源防护：浏览器跨站请求被拒绝，其它网页无法触发你的导出 / 导入

## 🧩 备份格式 DshBackup v1

```
manifest.json      { format: "dsh-backup", formatVersion: 1, counts, components, bundles, … }
checksums.json     { manifest: sha256, files: { <路径>: { size } } }
redaction.json     { file, paths }        ← 仅在启用脱敏且命中密钥时出现
payload/
  sessions/<projectKey>/<sessionId>/…      ← ~/.dsh/sessions
  sessions-archive/…                       ← ~/.dsh/dsh-session-archive
  storages/workspace.json                  ← 工作区注册表（unit v2）
  storages/session_projcache/…             ← 投影缓存
  attachments/…                            ← 附件
  settings/settings.yaml                   ← 设置（默认已脱敏）
  profile/…                                ← 插件清单（package.json / cordis.patch.yml / …）
  mnemon/{runtime,documents,data}/…        ← dsh-mnemon 数据
  extensions/<插件数据>/…                   ← 其它插件数据
```

条目完整性由 ZIP CRC32 逐文件保证；导入时未知子目录（来自更新版本插件）忽略并告警，
永远不静默丢弃。

## ❓ FAQ

**Q: 备份文件里有没有敏感信息？**
默认没有。导出与自动备份默认**脱敏** `settings.yaml` 中的密钥值（明文不出包）；会话内容当然在备份里。若手动取消脱敏选项，备份即明文，请像保管密钥一样保管备份文件。

**Q: 老版本 dsh 产生的会话，新版 harness 里能用吗？**
能。会话文件按字节复制，打开时由 harness 自带的 v0→v1→v2→v3 迁移链自动升级——这正是 dsh-backup 不解包会话的原因：无论会话格式怎么演进，备份侧永远兼容。

**Q: 和 dsh-mnemon 自带的「备份与迁移」什么关系？**
互补。mnemon 自带的 Mnemon Pack 只覆盖记忆数据；dsh-backup 连同会话、工作区、附件、设置一起打包，并保证二者恢复后行为一致。若你只关心记忆，用 mnemon 的 Pack 也完全可以。

**Q: 跨机器恢复要注意什么？**
工作区记录里保存的是绝对路径（如 `H:\mycode`）。若新机器路径不同，会话记录仍然完整可读，只是工作区面板里显示的是备份时的路径；按需手动调整即可。mnemon 默认 `global` 范围与路径无关。

**Q: 导入后插件没装全怎么办？**
预检报告会列出备份里有、本机没有的插件名称与版本，在「插件管理」里装回即可；数据导入不受影响。

## 🧪 开发与测试

```bash
npm install            # 安装 schemastery
node --test test/local-test.mjs
```

测试覆盖：ZIP 读写回环（文本 / 二进制 / 空文件 / 嵌套 / 大文件 / 第三方 zip）、zip 路径安全（穿越 / 绝对路径 / 驱动器号）、组件分类与落点、workspace / memories / documents 三类合并语义、两套假 dsh home 之间的端到端导出导入（合并 / 覆盖 / 校验失败拒绝 / 惰性暂存）。

```
lib/
├── index.js    服务端：/dsh-backup/* 路由（status / estimate / export / import）
├── store.js    数据布局、组件模型、合并语义、暂存与原子恢复
├── zip.js      纯 JS 流式 ZIP 读写（deflate / store / zip64 / CRC32）
└── client.js   客户端：设置 → 备份与恢复（settings.section 槽位）
```

## 📄 License

[MIT](LICENSE)
