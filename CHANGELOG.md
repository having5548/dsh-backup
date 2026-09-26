# 更新日志(CHANGELOG)

> 本文件是 **AI 接手维护的强制记录簿**:任何 AI(或人)对本仓库做出任何改动,
> 都必须按下方格式在「未发布」区补一条记录,发版时再升版本号。
> 规则细则见仓库根目录的 [AGENTS.md](AGENTS.md)「变更记录规则」。
>
> 格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本遵循语义化版本(SemVer)。

## 条目格式(所有记录必须遵守)

```markdown
## [x.y.z] - YYYY-MM-DD

### 新增
- 功能名:做了什么、从哪里入口使用、默认开还是关

### 变更
- 改了什么、为什么、对既有用户的影响

### 修复
- 现象 → 根因(具体到代码/契约层面)→ 修法

### 兼容
- 宿主版本 / 备份格式 / 平台的适配与破坏性变化

### 移除
- 删了什么、替代方案
```

**硬性要求**
1. 修复类条目必须写清 **现象 → 根因 → 修法**,根因要具体到代码或契约层面,禁止"修复若干问题"这类空话
2. 禁止删除或改写历史条目;只能追加
3. 改动代码而没写条目 = 未完成的工作

---

## [未发布]

_(把下一次改动的条目写在这里,发版时把标题改成版本号与日期)_

## [0.4.0] - 2026-09-26

### 兼容
- **适配 dsh 0.1.6 / 0.1.7**:宿主 0.1.7 客户端已移除 `settingsScope` 服务,依赖它的插件会永久挂起(`pending (waiting for service: settingsScope)`)。客户端 inject 收敛为 `['slots', 'locale']`(与官方 0.1.7 兼容插件一致),`remote` / `sessions` 改为使用时惰性解析——缺席只损失对应功能,不再阻塞整个插件。0.1.5 列车不受影响。
- **设置持久化改为插件自管**(`~/.dsh/dsh-backup-settings.json`,原子写):不再依赖宿主 settings 服务的版本契约;新增 `GET/POST /dsh-backup/settings`。服务端 inject 同步收敛为 `['webServer']`。

## [0.3.1] - 2026-09-26

### 变更
- 自动备份目录默认位置从桌面改为**「文档」文件夹**(`~/Documents/dsh-backups`,Documents 不存在时回落主目录)
- UI 写明各类备份的落点:导出 = 浏览器下载文件夹;立即/自动备份 = 「备份目录」所示路径;「立即备份」完成消息带完整路径

## [0.3.0] - 2026-09-26

### 新增
- **AI 恢复助理**(默认关闭,自主控制 token 消耗):导入报告新增「让 AI 检查恢复结果」,一键经宿主官方 `ctx.remote.session` RPC 开新会话,把结构化恢复摘要与核查任务交给 DeepSeek——只读核查 mnemon 三目录一致性、抽查会话文件、校验 workspace.json;只做「明确安全且可逆」的最小修复,**绝不删除数据**,缺失插件不自行安装
- 设置开关「跨版本导入后自动让 AI 处理」(**默认关闭**):备份与本机 dsh 版本不同(或导入有报错)时,导入完成后自动启动 AI 助理
- 跨版本检测:导出 manifest 记录宿主 dsh 版本(从运行中 bin.js 路径反推),`/status` 同步提供,导入预检比对两侧版本并标注 `crossVersion`
- `POST /dsh-backup/assistant-brief`:服务端统一生成任务书(单一事实源,可测试)

## [0.2.3] - 2026-09-26

### 修复
- **设置页全部接口 404 空响应(浏览器报 `Unexpected end of JSON input`)→ 根因:路由前缀带尾斜杠。** dsh-host-webserver 的 prefix 匹配语义是 `pathname === prefix || pathname.startsWith(prefix + '/')`,此前 `ROUTE_PREFIX = '/dsh-backup/'` 退化为 `startsWith('/dsh-backup//')` 永不命中。现改为 `/dsh-backup`
- **「预检」请求挂死 → 根因:`spoolRequest` 从不调用 `ws.end()`,** 上传 handler 永不响应,网关超时掐断后浏览器拿到空响应体。现于请求体读完后正确收尾,并对客户端中途断开做清理
- **导出下载损坏 → 根因:流式输出开始后调用 `res.setHeader`**(ERR_HTTP_HEADERS_SENT)销毁连接。已移除该调用
- **脱敏备份被带校验导入误拒 → 根因:checksums 记录的是 settings.yaml 磁盘原始大小而非包内脱敏后大小。** 现记录实际条目大小
- 回归防护:新增 HTTP 路由回归测试(mock dsh webserver 全链路:预检→执行→导出→救援包,全部带超时防挂死)

## [0.2.1] - 2026-09-26

### 修复
- **服务启动即崩(`cannot get property "webServer" without inject`)→ 根因:cordis-plugin-loader 优先取 `exports.default` 作为插件对象**,此前把 `apply` 单独导出为 default,loader 拿到裸函数丢失 `inject` 声明。现改为纯命名导出(`export { apply, inject, name }`),与 dsh-notify / 官方插件契约一致
- **`/backup` 命令风险 → 根因:直接访问未声明的 `ctx.commands` getter 会抛错。** 改为经 `ctx.inject(['commands'], …)` 延迟接线,命令服务缺席不影响其余功能

## [0.2.0] - 2026-09-26

参考 [xiaoyuyu6420/dsh-backup](https://github.com/xiaoyuyu6420/dsh-backup) 的设计吸收五项能力(按本插件的组件化 ZIP 架构重写):

### 新增
- **救援通道**:零依赖 `rescue.mjs`(list / verify / restore,默认只补缺失文件、`--force` 覆盖并留 `.bak-rescue-*`)+ 三平台「点我恢复」双击启动器;磁盘备份目录自动附带,面板可下载救援工具包
- **自动备份**:`/backup auto 12` 每 12 小时(1–720)写盘一次,重启自动续跑;每份带 `.sha256` sidecar,按保留份数(默认 7)自动轮换
- **`/backup` 斜杠命令**:`backup / list / verify / restore [--dry-run] [--mode] / auto / doctor / --keep N / help`(命令名冲突自动退回 `/dsh-backup`)
- **凭据脱敏**:导出默认把 settings.yaml 中疑似密钥值(自动识别 camelCase)替换为占位符并写 `redaction.json`;覆盖导入时占位符处自动回填本机现值
- **会话体检 doctor**:只读扫描全部会话(zstd 魔数 / 空文件 / JSONL 首字节)

### 变更
- 仓库:新增 CI(node 22/24 × ubuntu/windows 矩阵)、Issue 模板、`engines.dsh` 兼容声明、英文 README

## [0.1.0] - 2026-09-26

### 新增
- 首个版本
- **导出**:设置 → 备份与恢复,勾选组件后流式导出 DshBackup v1 ZIP 备份包(会话 / 工作区注册表 / 投影缓存 / 附件 / 设置 / 插件清单 / dsh-mnemon 记忆数据 / 其他插件数据)
- **导入**:预检(增量计划 + 缺失插件报告 + 警告)→ 合并 / 覆盖双模式执行 → 逐组件报告
- **会话保真**:会话文件字节级复制,不解包不改写;旧代际(v0–v2)由 harness 迁移链自动升级
- **mnemon 保真**:覆盖 = `~/.mnemon` 全量按字节还原(SQLite 换库先清 `-wal`/`-shm`);合并 = 官方 Pack 语义(热记忆去重并入、文档同 id 异内容换新 id、记忆体仅新增 body)
- **安全**:暂存区 + 逐文件 CRC32 校验 + manifest sha256 + 原子提交 + 失败回滚,被替换文件保留 `.bak-dshbackup-<时间戳>`;formatVersion 更新的备份明确拒绝
- **兼容**:payload 未知子目录忽略并告警;跨 Windows / macOS / Linux;仅依赖 schemastery

[未发布]: https://github.com/having5548/dsh-backup/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/having5548/dsh-backup/releases/tag/v0.4.0
[0.3.1]: https://github.com/having5548/dsh-backup/releases/tag/v0.3.1
[0.3.0]: https://github.com/having5548/dsh-backup/releases/tag/v0.3.0
[0.2.3]: https://github.com/having5548/dsh-backup/releases/tag/v0.2.3
[0.2.1]: https://github.com/having5548/dsh-backup/releases/tag/v0.2.1
[0.2.0]: https://github.com/having5548/dsh-backup/releases/tag/v0.2.0
[0.1.0]: https://github.com/having5548/dsh-backup/releases/tag/v0.1.0
