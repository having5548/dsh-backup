# Changelog

## 0.2.2 (2026-09-26)

**关键修复**：修复「预检」请求挂死（浏览器报 Unexpected end of JSON input / 空响应）与导出下载损坏。

- `spoolRequest` 从不调用 `ws.end()`，上传预检的 handler 永不响应——dsh 网关超时掐断后浏览器拿到空响应体。现于请求体读完后正确收尾，并对客户端中途断开做清理。
- 导出下载曾在流式输出过程中调用 `res.setHeader`（ERR_HTTP_HEADERS_SENT）导致连接被销毁、下载损坏，已移除该调用。
- 修复脱敏备份的 checksums 大小错误：包内 settings.yaml 现记录脱敏后内容的大小（此前记录磁盘原始大小，导致带校验的导入被误拒）。
- 新增 HTTP 路由回归测试（mock dsh webserver 全链路：预检→执行→导出→救援包，全部带超时防挂死）。


## 0.2.1 (2026-09-26)

**关键修复**：修复服务启动即崩（`cannot get property "webServer" without inject`）。

- 根因：cordis-plugin-loader 会优先取 `exports.default` 作为插件对象；此前把 `apply`
  单独导出成了 default，loader 拿到裸函数、丢失 `inject` 声明，插件启动即崩并被
  桌面端自动屏蔽卸载。现改为纯命名导出（`export { apply, inject, name }`），
  与 dsh-notify / 官方插件契约一致。
- `/backup` 斜杠命令改为经 `ctx.inject(['commands'], …)` 延迟接线：不再直接访问
  未声明的 `ctx.commands`（未注入服务的 getter 会抛错），且命令服务缺席时其余
  功能不受影响。

## 0.2.0 (2026-09-26)

参考 [xiaoyuyu6420/dsh-backup](https://github.com/xiaoyuyu6420/dsh-backup) 的设计吸收了五项能力（实现按本插件的组件化 ZIP 架构重写）：

- **救援通道**：新增零依赖 `rescue.mjs`（list / verify / restore，默认只补缺失文件、`--force` 覆盖并留 `.bak-rescue-*`）+ 三平台「点我恢复」双击启动器；磁盘备份目录自动附带，设置面板可下载救援工具包
- **自动备份**：`/backup auto 12` 每 12 小时（1–720）写盘一次，重启自动续跑；每份带 `.sha256` sidecar，按保留份数（默认 7）自动轮换；状态存备份目录随目录走
- **`/backup` 斜杠命令**：`backup / list / verify / restore [--dry-run] [--mode] / auto / doctor / --keep N / help`（命令名冲突时自动退回 `/dsh-backup`）
- **凭据脱敏**：导出默认把 settings.yaml 中疑似密钥值（自动识别 camelCase）替换为占位符并在包内写 `redaction.json`；覆盖导入时占位符处自动回填本机现值，本机缺失的保留占位并提示重填
- **会话体检 doctor**：只读扫描全部会话（zstd 魔数 / 空文件 / JSONL 首字节），面板与 `/backup doctor` 均可触发

仓库：新增 CI（node 22/24 × ubuntu/windows 矩阵）、Issue 模板、`engines.dsh` 兼容声明、英文 README。

## 0.1.0 (2026-09-26)

首个版本。

- **导出**：设置 → 备份与恢复，勾选组件后流式导出 DshBackup v1 ZIP 备份包
  （会话 / 工作区注册表 / 投影缓存 / 附件 / 设置 / 插件清单 / dsh-mnemon 记忆数据 / 其他插件数据）
- **导入**：预检（增量计划 + 缺失插件报告 + 警告）→ 合并 / 覆盖双模式执行 → 逐组件报告
- **会话保真**：会话文件字节级复制，不解包不改写；旧代际（v0–v2）由 harness 迁移链自动升级
- **mnemon 保真**：覆盖 = `~/.mnemon` 全量按字节还原（SQLite 换库先清 `-wal`/`-shm`）；
  合并 = 官方 Pack 语义（热记忆去重并入、文档同 id 异内容换新 id、记忆体仅新增 body）
- **安全**：暂存区 + 逐文件 CRC32 校验 + manifest sha256 + 原子提交 + 失败回滚，
  被替换文件保留 `.bak-dshbackup-<时间戳>`；formatVersion 更新的备份明确拒绝
- **兼容**：payload 未知子目录忽略并告警；跨 Windows / macOS / Linux；仅依赖 schemastery
