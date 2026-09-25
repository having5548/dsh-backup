# Changelog

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
