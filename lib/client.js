// ============================================================================
// dsh-backup —— DSH 备份与恢复插件（浏览器/客户端半部）
//
// 在 DSH Web UI「设置」里新增「备份与恢复」页：
//   1. 状态卡：数据目录、会话/工作区/mnemon 概况
//   2. 导出：勾选组件 → 直接下载 ZIP 备份包（流式，浏览器自带下载进度）
//   3. 导入：选择备份包 → 预检（显示将发生什么）→ 合并/覆盖 → 执行 → 报告
//
// 以预打包 bundle 形式随插件安装，格式与官方 client 插件一致（__ModuleLoader__）。
// ============================================================================
window.__ModuleLoader__.load({
  id: 'dsh-backup',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var ReactDOM = require('react-dom')

    // ------------------------------------------------------------------
    // 样式（DSH 语义化 CSS 变量，自动适配明暗主题）
    // ------------------------------------------------------------------
    var CSS = [
      '.dshb-root{display:flex;flex-direction:column;gap:14px;max-width:640px;font-family:var(--dsw-font-family,ui-sans-serif,system-ui,"Segoe UI",sans-serif)}',
      '.dshb-title{margin:0;font-size:16px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary,#1c1c1e)}',
      '.dshb-desc{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#5b616b)}',
      '.dshb-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.dshb-warn{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary,#d9822b)}',
      '.dshb-err{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#d64545)}',
      '.dshb-ok{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary,#2fa95e)}',
      '.dshb-card{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:12px;padding:14px 16px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02));display:flex;flex-direction:column;gap:10px}',
      '.dshb-card-title{margin:0;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary,#1c1c1e)}',
      '.dshb-kv{display:flex;gap:8px;font-size:12px;line-height:18px}',
      '.dshb-k{flex:none;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.dshb-v{min-width:0;color:var(--dsw-alias-label-primary,#1c1c1e);word-break:break-all}',
      '.dshb-row{display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);cursor:pointer}',
      '.dshb-row-static{cursor:default}',
      '.dshb-check{margin:2px 0 0;accent-color:var(--dsw-alias-state-business-primary,#4c7ef3);width:15px;height:15px;flex:none;cursor:pointer}',
      '.dshb-rowText{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}',
      '.dshb-rowTitle{font-size:13px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-primary,#1c1c1e)}',
      '.dshb-rowDesc{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8a8f98);word-break:break-all}',
      '.dshb-badge{flex:none;font-size:11px;line-height:16px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));color:var(--dsw-alias-label-secondary,#5b616b);align-self:center;white-space:nowrap}',
      '.dshb-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
      '.dshb-btn{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#1c1c1e);border-radius:8px;padding:6px 14px;font-size:13px;line-height:18px;cursor:pointer}',
      '.dshb-btn:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(0,0,0,.1))}',
      '.dshb-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.dshb-btn-primary{background:var(--dsw-alias-state-business-primary,#4c7ef3);border-color:transparent;color:#fff}',
      '.dshb-btn-primary:hover{background:var(--dsw-alias-state-business-primary-hover,#3d6ce0)}',
      '.dshb-btn-danger{background:var(--dsw-alias-state-error-primary,#d64545);border-color:transparent;color:#fff}',
      '.dshb-btn-danger:hover{background:#c13c3c}',
      '.dshb-file{font-size:12px;color:var(--dsw-alias-label-secondary,#5b616b)}',
      '.dshb-radio{display:flex;gap:14px;flex-wrap:wrap}',
      '.dshb-radio label{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--dsw-alias-label-primary,#1c1c1e);cursor:pointer}',
      '.dshb-list{display:flex;flex-direction:column;gap:6px;max-height:260px;overflow-y:auto}',
      '.dshb-item{padding:6px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:8px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#5b616b);word-break:break-all}',
      '.dshb-item .dshb-strong{color:var(--dsw-alias-label-primary,#1c1c1e);font-weight:500}',
      '.dshb-summary{display:flex;flex-direction:column;gap:4px}',
      '.dshb-summary .dshb-kv{gap:10px}',
      '.dshb-section-gap{height:2px}',
      '.dshb-spin{display:inline-block;width:12px;height:12px;border:2px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));border-top-color:var(--dsw-alias-state-business-primary,#4c7ef3);border-radius:50%;animation:dshb-spin 1s linear infinite;vertical-align:-2px}',
      '@keyframes dshb-spin{to{transform:rotate(360deg)}}'
    ].join('\n')
    ;(function () {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-dsh-backup-css]')) return
      var tag = document.createElement('style')
      tag.setAttribute('data-dsh-backup-css', '1')
      tag.textContent = CSS
      document.head.appendChild(tag)
    })()

    // ------------------------------------------------------------------
    // 工具
    // ------------------------------------------------------------------
    function fmtBytes(n) {
      if (typeof n !== 'number' || !isFinite(n) || n < 0) return '—'
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB'
      return (n / 1073741824).toFixed(2) + ' GB'
    }

    function fmtTime(iso) {
      try {
        var d = new Date(iso)
        var pad = function (n) { return n < 10 ? '0' + n : String(n) }
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
      } catch (e) { return String(iso || '—') }
    }

    function clip(text, max) {
      var s = String(text || '')
      return s.length <= max ? s : s.slice(0, max - 1) + '…'
    }

    // 组件元数据（与服务端 COMPONENTS 对应；顺序即 UI 顺序）
    var COMPONENT_META = [
      { id: 'sessions', label: '会话记录', desc: '全部对话（字节级复制，含归档会话）——恢复后 AI 可完整识别历史' },
      { id: 'workspaces', label: '工作区注册表', desc: '工作区列表与排序（workspace.json）' },
      { id: 'projcache', label: '会话投影缓存', desc: '可再生的显示缓存，加速恢复后首次打开' },
      { id: 'attachments', label: '附件', desc: '对话中引用的图片 / 文件' },
      { id: 'settings', label: '设置（settings.yaml）', desc: '各插件设置；注意可能包含 API 密钥，请妥善保管备份' },
      { id: 'profile', label: 'Profile 插件清单', desc: '已装插件列表；导入时仅补缺并生成缺失插件报告' },
      { id: 'mnemon', label: 'dsh-mnemon 记忆数据', desc: '热记忆 / 文档 / 记忆体（上下文注入来源），保证注入与原本一致' },
      { id: 'extensions', label: '其他插件数据', desc: 'task-board / dsh-usage / skins 等第三方插件的数据目录' }
    ]
    var EXPORT_DEFAULT_ON = ['sessions', 'workspaces', 'projcache', 'attachments', 'settings', 'profile', 'mnemon']

    // ------------------------------------------------------------------
    // API 封装
    // ------------------------------------------------------------------
    function api() {
      return {
        status: function () {
          return fetch('/dsh-backup/status').then(function (r) { return r.json() })
        },
        estimate: function (components) {
          return fetch('/dsh-backup/estimate?components=' + encodeURIComponent(components.join(','))).then(function (r) { return r.json() })
        },
        preview: function (file, verify) {
          return fetch('/dsh-backup/import?mode=preview&verify=' + (verify ? '1' : '0'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/zip' },
            body: file,
          }).then(function (r) { return r.json() })
        },
        execute: function (token, mode, components, verify) {
          return fetch('/dsh-backup/import/execute?token=' + encodeURIComponent(token) +
            '&mode=' + encodeURIComponent(mode) +
            '&components=' + encodeURIComponent(components.join(',')) +
            '&verify=' + (verify ? '1' : '0'), { method: 'POST' }).then(function (r) { return r.json() })
        },
        disk: function () {
          return fetch('/dsh-backup/disk').then(function (r) { return r.json() })
        },
        backupNow: function () {
          return fetch('/dsh-backup/backup-now', { method: 'POST' }).then(function (r) { return r.json() })
        },
        setAuto: function (hours) {
          return fetch('/dsh-backup/auto?hours=' + encodeURIComponent(hours), { method: 'POST' }).then(function (r) { return r.json() })
        },
        verifyDisk: function (name) {
          return fetch('/dsh-backup/disk/verify?name=' + encodeURIComponent(name)).then(function (r) { return r.json() })
        },
        doctor: function () {
          return fetch('/dsh-backup/doctor').then(function (r) { return r.json() })
        },
      }
    }

    // ------------------------------------------------------------------
    // 小组件
    // ------------------------------------------------------------------
    function Kv(k, v) {
      return React.createElement('div', { className: 'dshb-kv', key: k },
        React.createElement('span', { className: 'dshb-k' }, k),
        React.createElement('span', { className: 'dshb-v' }, v))
    }

    function Spinner() {
      return React.createElement('span', { className: 'dshb-spin' })
    }

    function ComponentRow(props) {
      var meta = props.meta
      var checked = props.checked
      var present = props.present
      var est = props.est
      var onToggle = props.onToggle
      var disabled = props.disabled
      var desc = meta.desc
      if (est && present) {
        desc = desc + '（' + est.files + ' 个文件 / ' + fmtBytes(est.bytes) + '）'
      }
      return React.createElement('label', { className: 'dshb-row' + (disabled ? ' dshb-row-static' : '') },
        React.createElement('input', {
          type: 'checkbox',
          className: 'dshb-check',
          checked: !!checked,
          disabled: !!disabled,
          onChange: function (e) { onToggle(meta.id, e.target.checked) },
        }),
        React.createElement('span', { className: 'dshb-rowText' },
          React.createElement('span', { className: 'dshb-rowTitle' }, meta.label),
          React.createElement('span', { className: 'dshb-rowDesc' }, desc)),
        !present ? React.createElement('span', { className: 'dshb-badge' }, '本机无数据') : null)
    }

    // ------------------------------------------------------------------
    // 设置面板主组件
    // ------------------------------------------------------------------
    function BackupSettingsSection(props) {
      var defaults = props.defaults || {}
      var apiObj = api()

      var statusState = React.useState(null)
      var status = statusState[0]
      var setStatus = statusState[1]
      var statusErrState = React.useState('')
      var statusErr = statusErrState[0]
      var setStatusErr = statusErrState[1]

      var exportSelState = React.useState(defaults.exportComponents || EXPORT_DEFAULT_ON.slice())
      var exportSel = exportSelState[0]
      var setExportSel = exportSelState[1]
      var estState = React.useState(null)
      var est = estState[0]
      var setEst = estState[1]

      var fileState = React.useState(null)
      var file = fileState[0]
      var setFile = fileState[1]
      var previewState = React.useState(null)
      var preview = previewState[0]
      var setPreview = previewState[1]
      var previewErrState = React.useState('')
      var previewErr = previewErrState[0]
      var setPreviewErr = previewErrState[1]
      var importSelState = React.useState(null)
      var importSel = importSelState[0]
      var setImportSel = importSelState[1]
      var modeState = React.useState(defaults.defaultImportMode || 'merge')
      var mode = modeState[0]
      var setMode = modeState[1]
      var verifyState = React.useState(defaults.verifyChecksums !== false)
      var verify = verifyState[0]
      var setVerify = verifyState[1]
      var redactState = React.useState(defaults.redactSecrets !== false)
      var redact = redactState[0]
      var setRedact = redactState[1]
      var busyState = React.useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]
      var reportState = React.useState(null)
      var report = reportState[0]
      var setReport = reportState[1]

      // ---- 磁盘备份 / 自动备份 / 体检 ----
      var diskState = React.useState(null)
      var disk = diskState[0]
      var setDisk = diskState[1]
      var diskErrState = React.useState('')
      var diskErr = diskErrState[0]
      var setDiskErr = diskErrState[1]
      var autoInputState = React.useState('12')
      var autoInput = autoInputState[0]
      var setAutoInput = autoInputState[1]
      var backupMsgState = React.useState('')
      var backupMsg = backupMsgState[0]
      var setBackupMsg = backupMsgState[1]
      var verifyMsgState = React.useState({})
      var verifyMsg = verifyMsgState[0]
      var setVerifyMsg = verifyMsgState[1]
      var doctorState = React.useState(null)
      var doctor = doctorState[0]
      var setDoctor = doctorState[1]
      var doctorBusyState = React.useState(false)
      var doctorBusy = doctorBusyState[0]
      var setDoctorBusy = doctorBusyState[1]

      function refreshDisk() {
        apiObj.disk().then(function (r) {
          if (r && r.ok) {
            setDisk(r)
            setAutoInput(String(r.auto && r.auto.hours > 0 ? r.auto.hours : 12))
          } else setDiskErr((r && r.error) || '读取失败')
        }).catch(function (e) { setDiskErr(String((e && e.message) || e)) })
      }

      function doBackupNow() {
        setBusy('backupnow')
        setBackupMsg('')
        apiObj.backupNow().then(function (r) {
          setBusy('')
          if (r && r.ok) {
            var x = r.result
            var msg = '✅ ' + x.name + '（' + fmtBytes(x.bytes) + '，' + x.fileCount + ' 个文件）\nsha256: ' + x.sha256.slice(0, 16) + '…'
            if (x.redacted && x.redacted.count > 0) msg += '\n已脱敏 ' + x.redacted.count + ' 处密钥'
            if (x.removed && x.removed.length) msg += '\n轮换删除 ' + x.removed.length + ' 份'
            setBackupMsg(msg)
            refreshDisk()
          } else setBackupMsg('❌ ' + ((r && r.error) || '备份失败'))
        }).catch(function (e) { setBusy(''); setBackupMsg('❌ ' + String((e && e.message) || e)) })
      }

      function doSetAuto(on) {
        setBusy('auto')
        apiObj.setAuto(on ? autoInput : 0).then(function (r) {
          setBusy('')
          if (r && r.ok) refreshDisk()
          else setBackupMsg('❌ ' + ((r && r.error) || '设置失败'))
        }).catch(function (e) { setBusy(''); setBackupMsg('❌ ' + String((e && e.message) || e)) })
      }

      function doVerify(name) {
        setVerifyMsg(function (prev) { var n = Object.assign({}, prev); n[name] = '…'; return n })
        apiObj.verifyDisk(name).then(function (r) {
          setVerifyMsg(function (prev) {
            var n = Object.assign({}, prev)
            n[name] = (r && r.ok !== false && r.ok) ? ('✅ ' + r.entries + ' 条目') : ('❌ ' + ((r && r.error) || ((r && r.bad && r.bad.length) || 0) + ' 个损坏'))
            return n
          })
        }).catch(function (e) {
          setVerifyMsg(function (prev) { var n = Object.assign({}, prev); n[name] = '❌ ' + String((e && e.message) || e); return n })
        })
      }

      function doDoctor() {
        setDoctorBusy(true)
        apiObj.doctor().then(function (r) {
          setDoctorBusy(false)
          setDoctor(r && r.ok ? r : { error: (r && r.error) || '体检失败' })
        }).catch(function (e) { setDoctorBusy(false); setDoctor({ error: String((e && e.message) || e) }) })
      }

      // ---- 初始加载 ----
      React.useEffect(function () {
        var alive = true
        apiObj.status().then(function (s) {
          if (!alive) return
          if (s && s.ok) setStatus(s)
          else setStatusErr((s && s.error) || '状态获取失败')
        }).catch(function (e) { if (alive) setStatusErr(String((e && e.message) || e)) })
        refreshDisk()
        return function () { alive = false }
      }, [])

      // ---- 选择变化 → 估算 ----
      React.useEffect(function () {
        if (!status) return
        var alive = true
        apiObj.estimate(exportSel).then(function (r) { if (alive && r && r.ok) setEst(r.components) }).catch(function () { /* 估算失败不打扰 */ })
        return function () { alive = false }
      }, [status, exportSel.join(',')])

      function toggleExport(id, on) {
        setExportSel(function (prev) {
          var next = prev.filter(function (x) { return x !== id })
          if (on) next.push(id)
          return next
        })
      }

      function doExport() {
        if (exportSel.length === 0) return
        var url = '/dsh-backup/export?components=' + encodeURIComponent(exportSel.join(',')) +
          '&redact=' + (redact ? '1' : '0')
        var a = document.createElement('a')
        a.href = url
        a.download = 'dsh-backup.zip'
        document.body.appendChild(a)
        a.click()
        a.remove()
      }

      function doPreview() {
        if (!file) return
        setBusy('preview')
        setPreviewErr('')
        setPreview(null)
        setReport(null)
        apiObj.preview(file, verify).then(function (r) {
          setBusy('')
          if (r && r.ok) {
            setPreview(r)
            var ids = []
            var comps = (r.manifest && r.manifest.components) || {}
            COMPONENT_META.forEach(function (m) {
              if (comps[m.id] && comps[m.id].included && comps[m.id].files > 0) ids.push(m.id)
            })
            setImportSel(ids)
          } else {
            setPreviewErr(clip((r && r.error) || '预检失败', 400))
          }
        }).catch(function (e) {
          setBusy('')
          setPreviewErr(String((e && e.message) || e))
        })
      }

      function doExecute() {
        if (!preview || !preview.token || !importSel || importSel.length === 0) return
        var confirmText = mode === 'replace'
          ? '覆盖导入会用备份中的文件替换本机同名数据（不删除本机多出的数据），并覆盖工作区注册表与 settings.yaml（原文件保留 .bak）。确定继续？'
          : '合并导入不会删除或覆盖本机已有数据，只补充备份中多出的内容。确定继续？'
        if (!window.confirm(confirmText)) return
        setBusy('execute')
        setReport(null)
        apiObj.execute(preview.token, mode, importSel, verify).then(function (r) {
          setBusy('')
          if (r && r.ok !== false) setReport(r.report || r)
          else setReport({ ok: false, error: (r && r.error) || '导入失败' })
        }).catch(function (e) {
          setBusy('')
          setReport({ ok: false, error: String((e && e.message) || e) })
        })
      }

      // ---- 渲染 ----
      var counts = (status && status.counts) || {}
      var mnemon = counts.mnemon || {}
      var presentMap = {}
      if (est) {
        Object.keys(est).forEach(function (id) { presentMap[id] = est[id].present })
      }

      return React.createElement('section', { className: 'dshb-root', 'aria-labelledby': 'dshb-title' },
        React.createElement('h2', { id: 'dshb-title', className: 'dshb-title' }, '备份与恢复'),
        React.createElement('p', { className: 'dshb-desc' }, '把全部工作区、完整对话、附件、设置与 dsh-mnemon 记忆数据导出为一个 ZIP 备份包；换机或重装后导入即可恢复。会话文件全程字节级复制，不依赖 dsh 版本格式，升级后可正常导入。'),
        statusErr ? React.createElement('p', { className: 'dshb-err' }, clip(statusErr, 300)) : null,

        // ---- 状态 ----
        React.createElement('div', { className: 'dshb-card' },
          React.createElement('h3', { className: 'dshb-card-title' }, '当前状态'),
          !status && !statusErr ? React.createElement('p', { className: 'dshb-note' }, React.createElement(Spinner, null), ' 正在读取…') : null,
          status ? React.createElement('div', { className: 'dshb-summary' },
            Kv('数据目录', status.dshHome),
            Kv('会话', (counts.sessionDirs || 0) + ' 个对话（' + (counts.projectKeys || 0) + ' 个项目目录）'),
            Kv('工作区', (counts.workspaces || 0) + ' 个' + (counts.workspaceVersion ? '（注册表 v' + counts.workspaceVersion + '）' : '')),
            Kv('mnemon', mnemon.present
              ? '已启用' + (mnemon.memoryEntries != null ? '，热记忆 ' + mnemon.memoryEntries + ' 条' : '') + (mnemon.documentsCount != null ? '，文档 ' + mnemon.documentsCount + ' 篇' : '') + (mnemon.bodies && mnemon.bodies.length ? '，记忆体 ' + mnemon.bodies.join('/') : '')
              : '未检测到数据（未启用或不曾产生记忆）'),
            (mnemon.health && mnemon.health.length) ? React.createElement('p', { className: 'dshb-warn' }, 'mnemon 数据健康提示：' + mnemon.health.join('；')) : null,
            Kv('备份格式', 'DshBackup v' + status.formatVersion + '（插件 v' + status.pluginVersion + '，Node ' + status.node + '）')
          ) : null),

        // ---- 导出 ----
        React.createElement('div', { className: 'dshb-card' },
          React.createElement('h3', { className: 'dshb-card-title' }, '导出备份'),
          React.createElement('p', { className: 'dshb-note' }, '勾选要包含的内容。会话记录按字节复制，任何 dsh 版本产生的会话都能装进备份并在更新后的 harness 中正常打开。'),
          React.createElement('div', { className: 'dshb-list' },
            COMPONENT_META.map(function (meta) {
              return React.createElement(ComponentRow, {
                key: meta.id,
                meta: meta,
                checked: exportSel.indexOf(meta.id) >= 0,
                present: est ? !!presentMap[meta.id] : true,
                est: est ? est[meta.id] : null,
                disabled: !status,
                onToggle: toggleExport,
              })
            })),
          React.createElement('div', { className: 'dshb-actions' },
            React.createElement('button', {
              type: 'button',
              className: 'dshb-btn dshb-btn-primary',
              disabled: !status || exportSel.length === 0,
              onClick: doExport,
            }, '导出备份包（.zip）'),
            React.createElement('label', { className: 'dshb-radio' },
              React.createElement('input', {
                type: 'checkbox',
                checked: redact,
                onChange: function (e) { setRedact(e.target.checked) },
              }),
              '脱敏密钥（推荐）'),
            exportSel.length === 0 ? React.createElement('span', { className: 'dshb-warn' }, '至少勾选一项') : null),
          React.createElement('p', { className: 'dshb-note' }, '备份包含全部对话内容与设置。开启脱敏时，settings.yaml 中的密钥值替换为占位符：导入时自动保留本机现值，本机没有的需手动重填。请妥善保管备份。')),

        // ---- 磁盘备份 / 自动备份 / 救援工具 ----
        React.createElement('div', { className: 'dshb-card' },
          React.createElement('h3', { className: 'dshb-card-title' }, '自动备份（存到本机备份目录）'),
          React.createElement('p', { className: 'dshb-note' }, '定时把备份写到本机目录，每份附带 .sha256 校验文件与救援控制台（DSH 起不来时双击「点我恢复」即可还原）。按保留份数自动轮换。'),
          diskErr ? React.createElement('p', { className: 'dshb-err' }, clip(diskErr, 200)) : null,
          !disk && !diskErr ? React.createElement('p', { className: 'dshb-note' }, React.createElement(Spinner, null), ' 正在读取…') : null,
          disk ? React.createElement('div', { className: 'dshb-summary' },
            Kv('备份目录', disk.destination),
            Kv('自动备份', disk.auto && disk.auto.hours > 0
              ? '每 ' + disk.auto.hours + ' 小时' + (disk.auto.nextRunAt ? '，下次 ' + fmtTime(disk.auto.nextRunAt) : '')
              : '关闭'),
            React.createElement('div', { className: 'dshb-actions' },
              React.createElement('input', {
                type: 'number',
                min: '1',
                max: '720',
                value: autoInput,
                onChange: function (e) { setAutoInput(e.target.value) },
                style: { width: '64px' },
                className: 'dshb-file',
              }),
              React.createElement('span', { className: 'dshb-note' }, '小时'),
              React.createElement('button', { type: 'button', className: 'dshb-btn', disabled: busy !== '', onClick: function () { doSetAuto(true) } }, busy === 'auto' ? '设置中…' : '开启自动备份'),
              React.createElement('button', { type: 'button', className: 'dshb-btn', disabled: busy !== '' || !disk.auto || disk.auto.hours === 0, onClick: function () { doSetAuto(false) } }, '关闭'),
              React.createElement('button', { type: 'button', className: 'dshb-btn dshb-btn-primary', disabled: busy !== '', onClick: doBackupNow }, busy === 'backupnow' ? '备份中…' : '立即备份')),
            backupMsg ? React.createElement('p', { className: 'dshb-note', style: { whiteSpace: 'pre-wrap' } }, backupMsg) : null,
            disk.backups && disk.backups.length
              ? React.createElement('div', { className: 'dshb-list' },
                  disk.backups.map(function (b) {
                    return React.createElement('div', { key: b.name, className: 'dshb-row dshb-row-static' },
                      React.createElement('span', { className: 'dshb-rowText' },
                        React.createElement('span', { className: 'dshb-rowTitle' }, b.name),
                        React.createElement('span', { className: 'dshb-rowDesc' }, fmtBytes(b.size) + (b.hasSha256 ? '' : ' · 缺 .sha256') + (verifyMsg[b.name] ? ' · ' + verifyMsg[b.name] : ''))),
                      React.createElement('button', { type: 'button', className: 'dshb-btn', onClick: function () { doVerify(b.name) } }, '校验'))
                  }))
              : React.createElement('p', { className: 'dshb-note' }, '备份目录还没有备份。'),
            React.createElement('div', { className: 'dshb-actions' },
              React.createElement('a', { href: '/dsh-backup/rescue', className: 'dshb-btn', style: { textDecoration: 'none' } }, '下载救援工具包'),
              React.createElement('span', { className: 'dshb-note' }, '放到备份目录，无需 DSH 即可恢复'))
          ) : null),

        // ---- 会话体检 ----
        React.createElement('div', { className: 'dshb-card' },
          React.createElement('h3', { className: 'dshb-card-title' }, '会话体检'),
          React.createElement('p', { className: 'dshb-note' }, '只读扫描全部会话文件（zstd 魔数 / 文件头 / 空文件），报告异常项。异常会话仍会照常备份。'),
          React.createElement('div', { className: 'dshb-actions' },
            React.createElement('button', { type: 'button', className: 'dshb-btn', disabled: doctorBusy, onClick: doDoctor }, doctorBusy ? '体检中…' : '开始体检')),
          doctor && doctor.error ? React.createElement('p', { className: 'dshb-err' }, clip(doctor.error, 200)) : null,
          doctor && doctor.total !== undefined ? React.createElement('div', { className: 'dshb-summary' },
            React.createElement('p', { className: doctor.corrupt.length ? 'dshb-warn' : 'dshb-ok' },
              doctor.corrupt.length === 0
                ? '✅ ' + doctor.total + ' 个会话全部健康'
                : '⚠ ' + doctor.total + ' 个会话中 ' + doctor.corrupt.length + ' 个异常：'),
            doctor.corrupt.slice(0, 8).map(function (c, i) {
              return React.createElement('p', { key: i, className: 'dshb-note' }, '· ' + c.session + '（' + (c.file || '无会话文件') + '）— ' + clip(c.reason, 80))
            }),
            doctor.corrupt.length > 8 ? React.createElement('p', { className: 'dshb-note' }, '… 共 ' + doctor.corrupt.length + ' 个') : null) : null),

        // ---- 导入 ----
        React.createElement('div', { className: 'dshb-card' },
          React.createElement('h3', { className: 'dshb-card-title' }, '导入恢复'),
          React.createElement('p', { className: 'dshb-note' }, '先预检看清楚将发生什么，再执行。合并 = 只补充本机没有的数据（推荐日常用）；覆盖 = 用备份内容替换本机同名数据（原文件保留 .bak 备份）。'),
          React.createElement('div', { className: 'dshb-actions' },
            React.createElement('input', {
              type: 'file',
              accept: '.zip,application/zip',
              className: 'dshb-file',
              onChange: function (e) {
                var f = e.target.files && e.target.files[0]
                setFile(f || null)
                setPreview(null)
                setPreviewErr('')
                setReport(null)
              },
            }),
            React.createElement('button', {
              type: 'button',
              className: 'dshb-btn',
              disabled: !file || busy !== '',
              onClick: doPreview,
            }, busy === 'preview' ? React.createElement('span', null, React.createElement(Spinner, null), ' 预检中…') : '预检')),
          mode === 'replace' && preview
            ? React.createElement('p', { className: 'dshb-warn' }, '覆盖模式：备份中的文件会替换本机同名文件；本机多出的数据不会被删除。工作区注册表与 settings.yaml 将整体替换。')
            : null,
          previewErr ? React.createElement('p', { className: 'dshb-err' }, previewErr) : null,

          preview ? React.createElement(PreviewBlock, {
            preview: preview,
            importSel: importSel,
            setImportSel: setImportSel,
            mode: mode,
            setMode: setMode,
            verify: verify,
            setVerify: setVerify,
            busy: busy,
            onExecute: doExecute,
          }) : null,

          report ? React.createElement(ReportBlock, { report: report }) : null),

        // ---- 说明 ----
        React.createElement('div', { className: 'dshb-card' },
          React.createElement('h3', { className: 'dshb-card-title' }, '兼容性说明'),
          React.createElement('p', { className: 'dshb-note' }, '· 会话文件不解包不改写：旧版 dsh 产生的会话导入后由 harness 自动升级格式；未来新版本 dsh 的会话也能装进当前备份。'),
          React.createElement('p', { className: 'dshb-note' }, '· dsh-mnemon：覆盖导入按字节还原记忆数据，上下文注入与备份时完全一致；合并导入遵循 mnemon 官方合并语义（按 target+content 去重、文档同 id 异内容换新 id）。'),
          React.createElement('p', { className: 'dshb-note' }, '· 更新版本的备份格式（formatVersion 更高）会明确拒绝并提示升级本插件，不会静默损坏数据。'),
          React.createElement('p', { className: 'dshb-note' }, '· 导入后建议重启服务（桌面端工具栏「重新连接服务」）让会话列表完全刷新。'))
      )
    }

    // ------------------------------------------------------------------
    // 预检结果块
    // ------------------------------------------------------------------
    function PreviewBlock(props) {
      var preview = props.preview
      var importSel = props.importSel
      var setImportSel = props.setImportSel
      var mode = props.mode
      var setMode = props.setMode
      var verify = props.verify
      var setVerify = props.setVerify
      var busy = props.busy
      var onExecute = props.onExecute

      var manifest = preview.manifest || {}
      var plan = preview.plan || {}
      var comps = manifest.components || {}

      function toggleImport(id, on) {
        setImportSel(function (prev) {
          var next = prev.filter(function (x) { return x !== id })
          if (on) next.push(id)
          return next
        })
      }

      var lines = []
      var plans = plan.components || {}
      Object.keys(plans).forEach(function (id) {
        var s = plans[id]
        var meta = null
        for (var i = 0; i < COMPONENT_META.length; i++) if (COMPONENT_META[i].id === id) meta = COMPONENT_META[i]
        if (!meta) return
        var bits = []
        if (id === 'workspaces' && s.merge) {
          bits.push('新增 ' + s.merge.added + ' 个工作区、更新 ' + s.merge.updated + ' 个、保留 ' + s.merge.kept + ' 个')
        } else if (id === 'mnemon') {
          if (s.backupPresent === false) { bits.push('备份中无 mnemon 数据') }
          else if (plan.mode === 'replace') bits.push('全量还原（数据库 ' + (s.dbReplaced || 0) + ' 个）')
          else {
            if (s.memoriesAdded) bits.push('并入 ' + s.memoriesAdded + ' 条热记忆')
            if (s.documentsAdded) bits.push('新增文档 ' + s.documentsAdded + ' 篇' + (s.documentsRenamed ? '（其中 ' + s.documentsRenamed + ' 篇因内容不同换新 id）' : ''))
            if (s.documentsSkipped) bits.push('跳过相同文档 ' + s.documentsSkipped + ' 篇')
            if (s.bodiesAdded) bits.push('新增记忆体 ' + s.bodiesAdded + ' 个')
            if (!bits.length) bits.push('与本机记忆一致，无需变更')
          }
        } else if (id === 'settings') {
          bits.push(s.action === 'replaced' ? '将整体替换（原文件保留 .bak）' : s.action === 'notInBackup' ? '备份中无此文件' : '合并模式跳过（可用覆盖模式整体替换）')
          if (s.redactedCount > 0) bits.push('含 ' + s.redactedCount + ' 处脱敏密钥（覆盖导入时保留本机现值）')
        } else if (id === 'profile') {
          if (s.restoreFiles && s.restoreFiles.length) bits.push('补缺 ' + s.restoreFiles.join('、'))
          if (s.keepFiles && s.keepFiles.length) bits.push('保留本机 ' + s.keepFiles.join('、'))
        } else {
          if (s.add) bits.push('新增 ' + s.add + ' 个文件')
          if (s.overwrite) bits.push('覆盖 ' + s.overwrite + ' 个文件')
          if (s.skip) bits.push('保留本机 ' + s.skip + ' 个')
          if (s.conflicts && s.conflicts.length) bits.push('内容不同 ' + s.conflicts.length + ' 个（合并模式保留本机）')
        }
        if (comps[id] && comps[id].included && bits.length) {
          lines.push({ id: id, label: meta.label, text: bits.join('；') })
        } else if (comps[id] && comps[id].included && !bits.length) {
          lines.push({ id: id, label: meta.label, text: '无变更' })
        }
      })

      var warnings = plan.warnings || []
      var missing = plan.missingPlugins || []

      return React.createElement('div', { className: 'dshb-summary' },
        React.createElement('p', { className: 'dshb-note' },
          '备份创建于 ' + fmtTime(manifest.createdAt) + '（格式 v' + manifest.formatVersion + '，来自 ' + clip((manifest.source && manifest.source.dshHome) || '未知位置', 60) + '）'),
        React.createElement('div', { className: 'dshb-radio' },
          React.createElement('label', null,
            React.createElement('input', { type: 'radio', name: 'dshb-mode', checked: mode === 'merge', onChange: function () { setMode('merge') } }),
            '合并导入（推荐）'),
          React.createElement('label', null,
            React.createElement('input', { type: 'radio', name: 'dshb-mode', checked: mode === 'replace', onChange: function () { setMode('replace') } }),
            '覆盖导入')),
        React.createElement('div', { className: 'dshb-list' },
          lines.map(function (l) {
            return React.createElement('label', { key: l.id, className: 'dshb-row' },
              React.createElement('input', {
                type: 'checkbox',
                className: 'dshb-check',
                checked: importSel.indexOf(l.id) >= 0,
                onChange: function (e) { toggleImport(l.id, e.target.checked) },
              }),
              React.createElement('span', { className: 'dshb-rowText' },
                React.createElement('span', { className: 'dshb-rowTitle' }, l.label),
                React.createElement('span', { className: 'dshb-rowDesc' }, l.text)))
          })),
        missing.length ? React.createElement('div', null,
          React.createElement('p', { className: 'dshb-warn' }, '备份中的以下插件本机未安装（不影响数据导入）：'),
          missing.map(function (p, i) {
            return React.createElement('p', { key: i, className: 'dshb-note' }, '· ' + p.name)
          })) : null,
        warnings.length ? React.createElement('div', null,
          warnings.map(function (w, i) {
            return React.createElement('p', { key: i, className: 'dshb-note' }, '· ' + clip(w, 200))
          })) : null,
        React.createElement('label', { className: 'dshb-row dshb-row-static' },
          React.createElement('input', {
            type: 'checkbox',
            className: 'dshb-check',
            checked: !!verify,
            onChange: function (e) { setVerify(e.target.checked) },
          }),
          React.createElement('span', { className: 'dshb-rowText' },
            React.createElement('span', { className: 'dshb-rowTitle' }, '逐文件校验（推荐）'),
            React.createElement('span', { className: 'dshb-rowDesc' }, '导入时校验每个文件的完整性；关闭可加速大备份的导入'))),
        React.createElement('div', { className: 'dshb-actions' },
          React.createElement('button', {
            type: 'button',
            className: (mode === 'replace' ? 'dshb-btn dshb-btn-danger' : 'dshb-btn dshb-btn-primary'),
            disabled: busy !== '' || importSel.length === 0,
            onClick: onExecute,
          }, busy === 'execute' ? React.createElement('span', null, React.createElement(Spinner, null), ' 导入中…') : '执行导入')))
    }

    // ------------------------------------------------------------------
    // 导入报告块
    // ------------------------------------------------------------------
    function ReportBlock(props) {
      var report = props.report
      if (report.error) {
        return React.createElement('div', { className: 'dshb-summary' },
          React.createElement('p', { className: 'dshb-err' }, '导入失败：' + clip(report.error, 400)))
      }
      var comps = report.components || {}
      var rows = []
      Object.keys(comps).forEach(function (id) {
        var s = comps[id]
        var label = id
        for (var i = 0; i < COMPONENT_META.length; i++) if (COMPONENT_META[i].id === id) label = COMPONENT_META[i].label
        var bits = []
        if (s.add) bits.push('新增 ' + s.add)
        if (s.overwrite) bits.push('覆盖 ' + s.overwrite)
        if (s.skip) bits.push('保留本机 ' + s.skip)
        if (s.action === 'merged') bits.push('合并：新增 ' + s.added + ' / 更新 ' + s.updated + ' / 保留 ' + s.kept)
        if (s.action === 'replaced') bits.push('已整体替换' + (s.secretsRestored ? '，回填本机密钥 ' + s.secretsRestored + ' 处' : '') + ((s.secretsMissing && s.secretsMissing.length) ? '，需重填 ' + s.secretsMissing.length + ' 处' : ''))
        if (s.action === 'skippedMergeMode') bits.push('合并模式未改动')
        if (s.action === 'notInBackup') bits.push('备份中无此文件')
        if (s.restored && s.restored.length) bits.push('补缺 ' + s.restored.join('、'))
        if (s.errors) bits.push('失败 ' + s.errors)
        if (bits.length) rows.push(label + '：' + bits.join('，'))
      })
      var m = report.mnemon
      return React.createElement('div', { className: 'dshb-summary' },
        React.createElement('p', { className: report.ok ? 'dshb-ok' : 'dshb-warn' },
          report.ok ? '导入完成（' + Math.round((report.durationMs || 0) / 100) / 10 + ' 秒，共写入 ' + report.applied + ' 项）' : '导入完成但有报错，请查看下方详情'),
        rows.map(function (r, i) { return React.createElement('p', { key: i, className: 'dshb-note' }, '· ' + r) }),
        m ? React.createElement('p', { className: 'dshb-note' },
          'mnemon：' + (m.note || ((m.memoriesAdded ? '并入热记忆 ' + m.memoriesAdded + ' 条；' : '') +
            (m.documentsAdded ? '新增文档 ' + m.documentsAdded + ' 篇；' : '') +
            (m.documentsSkipped ? '相同文档跳过 ' + m.documentsSkipped + ' 篇；' : '') +
            (m.dbReplaced ? '还原数据库 ' + m.dbReplaced + ' 个；' : '') +
            (m.bodiesAdded ? '新增记忆体 ' + m.bodiesAdded + ' 个' : '') +
            (!m.memoriesAdded && !m.documentsAdded && !m.dbReplaced && !m.bodiesAdded ? '与本机一致' : '')))) : null,
        (report.errors && report.errors.length) ? report.errors.map(function (e, i) {
          return React.createElement('p', { key: i, className: 'dshb-err' }, '· ' + clip(e, 260))
        }) : null,
        report.ok && report.needsRestart
          ? React.createElement('p', { className: 'dshb-warn' }, '已写入本机数据。建议重启服务（桌面端工具栏「重新连接服务」）并刷新页面，让会话列表完全刷新。')
          : null,
        (report.warnings && report.warnings.length) ? report.warnings.map(function (w, i) {
          return React.createElement('p', { key: i, className: 'dshb-note' }, '提示：' + clip(w, 200))
        }) : null)
    }

    // ------------------------------------------------------------------
    // 插件主体
    // ------------------------------------------------------------------
    var inject = ['slots', 'settingsScope', 'locale']

    var LOCALE_NS = 'dsh-backup'
    var LOCALE_ZH = { nav: '备份与恢复' }
    var LOCALE_EN = { nav: 'Backup & Restore' }

    function apply(ctx) {
      var translate = null
      try {
        ctx.locale.register(LOCALE_NS, { zh: LOCALE_ZH, en: LOCALE_EN })
        translate = ctx.locale.bind(LOCALE_NS)
      } catch (e) { /* 字典注册失败不影响功能 */ }

      var settingsScopeCached = null
      function getSettingsScope() {
        if (settingsScopeCached) return settingsScopeCached
        try {
          var svc = ctx.get('settingsScope')
          if (svc) settingsScopeCached = svc.bind({ namespace: 'dsh-backup', decode: function (v) { return v } })
        } catch (e) { /* ignore */ }
        return settingsScopeCached
      }

      ctx.effect(function () {
        return function () { /* 无常驻资源 */ }
      }, 'dsh-backup: client')

      // ---- 设置面板：DSH Web UI 设置 → 备份与恢复 ----
      try {
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-backup',
            order: 70,
            label: function () { return translate ? translate('nav') : '备份与恢复' },
            locale: LOCALE_NS,
            inject: function () {
              var defaults = {
                defaultImportMode: 'merge',
                verifyChecksums: true,
              }
              try {
                var scope = getSettingsScope()
                if (scope) {
                  var snap = scope.getSnapshot()
                  var v = snap && snap.value
                  if (v && typeof v === 'object') {
                    if (v.defaultImportMode) defaults.defaultImportMode = v.defaultImportMode
                    if (typeof v.verifyChecksums === 'boolean') defaults.verifyChecksums = v.verifyChecksums
                  }
                }
              } catch (e) { /* ignore */ }
              return { defaults: defaults }
            },
          }, BackupSettingsSection)
        })
        if (typeof console !== 'undefined' && console.info) {
          console.info('[dsh-backup] settings.section registered')
        }
      } catch (e) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[dsh-backup] settings.section registration failed:', e)
        }
      }
    }

    exports.apply = apply
    exports.inject = inject
    void ReactDOM
    return module.exports
  }
})
