# AGENTS.md —— AI 接手维护必读

> 本仓库由 AI 辅助维护。**任何接手的 AI(或人)在改代码前必须读完本文件,
> 改完代码后必须按「变更记录规则」更新 CHANGELOG.md。** 这不是建议,是验收条件。

## 项目是什么

**dsh-backup**:DeepSeek Harness(dsh,npm 包 `@deepseek-ai/dsh`)的备份/恢复插件。
在 dsh Web UI 设置里提供「备份与恢复」页,把工作区、完整对话(字节级)、附件、设置、
插件清单与 dsh-mnemon 记忆数据导出为 DshBackup v1 ZIP,并可预检后合并/覆盖导入。
发布为 npm 包 `@having5548/dsh-backup`(注意:unscoped `dsh-backup` 被 npm 他人占用,**不要改回**)。

## 代码地图

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 服务端入口;`/dsh-backup/*` 路由(status/estimate/export/import/settings/assistant-brief…)+ `/backup` 斜杠命令 + 自动备份调度 |
| `lib/store.js` | 数据布局、组件模型、workspace/mnemon 合并语义、脱敏、doctor、共享打包、磁盘轮换 |
| `lib/zip.js` | 纯 JS 流式 ZIP 读写(deflate/store/zip64/CRC32),零第三方依赖 |
| `lib/backupdir.js` | 磁盘备份引擎(写盘 + sha256 sidecar + 救援工具落盘 + 轮换) |
| `lib/client.js` | 浏览器半部:设置页(`settings.section` 槽位),`__ModuleLoader__` 预打包格式 |
| `rescue/rescue.mjs` | 零依赖救援控制台(DSH 起不来时的恢复通道),**必须保持零依赖** |
| `test/*.mjs` | node:test 套件:zip 回环/合并语义/端到端/HTTP 路由台架 |

## 硬性禁忌(历史踩坑,违反任意一条 = 线上炸)

1. **插件入口只能命名导出** `export { apply, inject, name }`。cordis-plugin-loader 优先取
   `exports.default` 作为插件对象——把 `apply` 单独导出为 default 会丢 `inject` 声明,
   启动即崩(`cannot get property ... without inject`)并被桌面端自动屏蔽卸载。
2. **webServer prefix 路由的 path 绝不能带尾斜杠。** 匹配语义是
   `pathname === prefix || pathname.startsWith(prefix + '/')`;
   `/dsh-backup/` 会退化为 `startsWith('/dsh-backup//')` 永不命中 → 全部接口 404 空响应。
3. **inject 只声明确定存在的服务。** 不确定是否存在的服务(`commands` / `remote` /
   `sessions` / `uiSession` 等)一律用 `ctx.get(name)` + try/catch 惰性解析,或
   `ctx.inject([name], cb)` 延迟接线——缺席只允许损失单个功能,绝不能让插件 pending。
   (宿主 0.1.7 已移除客户端 `settingsScope`,教训在 CHANGELOG 0.4.0。)
4. **读 HTTP 请求体必须在读完时 `ws.end()` 收尾**,否则 handler 永不响应;
   **流式响应开始后禁止 `res.setHeader`**(ERR_HTTP_HEADERS_SENT → 连接被销毁)。
5. **会话文件永远字节级复制**,不解包、不改写——这是"对话完整、跨版本兼容"的根基。
6. **`rescue/rescue.mjs` 保持零第三方依赖**(只用 node 内置模块),它是 DSH 起不来时的最后通道。
7. 宿主 services 契约随版本漂移(0.1.5 → 0.1.7 变化很大):升级宿主后先跑
   `test/route-harness.mjs` 与真实环境冒烟,别凭旧记忆写代码。

## 版本与发布清单(每次发版逐条打勾)

1. 三处版本号同步:`package.json` `version`、`lib/index.js` `PLUGIN_VERSION`、`lib/store.js` `PLUGIN_VERSION_TAG`
2. 测试全绿:
   ```bash
   node --test test/local-test.mjs && node --test test/v02-test.mjs && node --test test/route-harness.mjs
   ```
3. 按「变更记录规则」更新 `CHANGELOG.md`
4. `npm pack` → 把 tgz 装进本地 profile 验证加载(需把 `H:\DeepSeek Harness\resources\runtime` 加入 PATH 供 pnpm 使用):
   ```bash
   node "H:/DeepSeek Harness/node_modules/@deepseek-ai/dsh/lib/bin.js" plugin --profile web add <tgz>
   ```
5. `git tag vX.Y.Z` + GitHub Release(资产命名 `having5548-dsh-backup-X.Y.Z.tgz`)
6. `npm publish`(账号开了 2FA:必须真实终端运行,浏览器配置已指向 Edge;非交互 shell 里 EOTP 会打印打码 URL 后退出,无法自动化)

## 变更记录规则(必须执行)

- **任何改动**(功能/修复/重构/文档/CI)都必须在 `CHANGELOG.md` 的 `## [未发布]` 区追加条目;
  发版时把 `[未发布]` 改成 `[x.y.z] - 日期`,并新建空白的 `[未发布]` 区
- 分类只用这五种:`新增` / `变更` / `修复` / `兼容` / `移除`
- 修复必须写 **现象 → 根因(具体到代码/契约)→ 修法**;禁止"优化了体验"这类空话
- 禁止删除或改写历史条目
- 版本号遵循 SemVer:不兼容的宿主适配/格式变化升次版本,纯修复升修订号

## 本地环境备忘

- 桌面端捆绑运行时(含 pnpm):`H:\DeepSeek Harness\resources\runtime\`
- dsh 本体安装根:`H:\DeepSeek Harness\`(宿主升级会整体替换)
- dsh 数据目录:`~/.dsh`(会话/工作区/设置);mnemon 数据:`~/.mnemon`
- 本地安装调试:profile 以 `file:` tgz 依赖方式安装;profile 的 `package.json` 里若引用了
  本地 tgz 路径,记得 `npm pack` 后保持文件名一致
- npm 网页验证自动开在 Edge(`npm config get browser` 已配置)
