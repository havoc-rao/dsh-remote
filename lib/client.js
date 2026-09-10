// dsh-remote — client half.
// Settings → 远程工作区: a multi-machine SSH registry (add/edit/select current;
// passphrase / host-key mode / proxy jump / agent / keychain password; password
// stored host-side and kept private). Plus a port-forward panel, the command
// audit log view, quick workspace switching, and an ~/.ssh/config importer.
//
// A unified workspace directory picker fills ui-workspace's two directory-flow
// holes (sidebar + conversation hero):
//   • 本机 tab → opens the NATIVE OS folder chooser (/dsh-remote/local-pick)
//     and returns the picked local path (works with local workspaces).
//   • 远程 tab → pick a machine (dropdown), list its directories over
//     /dsh-remote/ls, choose or type a remote path → /dsh-remote/mirror builds a
//     real LOCAL mirror → onPicked(localMirror) so host adopts it as a workspace.
//
// better-sidebar integration (optional): a live remote file explorer tab and a
// read-only-by-default remote file tab with an explicit「编辑 → 保存到远程」flow
// (mtime optimistic lock via POST /dsh-remote/write).
//
// Client entries must be classic scripts registered via window.__ModuleLoader__.load
// ({ id, factory }); the factory receives a synchronous `require`.
window.__ModuleLoader__.load({
  id: 'dsh-remote',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const name = 'dsh-remote'

    // ── The @-reference protocol (shared with the host-half prompt) ──────────
    // A file can live on the REMOTE host or on THIS machine; a bare path is
    // ambiguous. Every reference the plugin inserts into the composer is
    // therefore explicitly tagged:
    //   REF_REMOTE + '/data/...'  → file exists ONLY on this session's remote
    //                               host — read via rw_read_file / rw_stat /
    //                               rw_search / rw_exec, never local tools.
    //   REF_LOCAL + '/Users/...'  → file on THIS machine — native local tools.
    // The host-half system-prompt section documents these tokens verbatim
    // (lib/index.js section text); keep the spellings in sync.
    const REF_REMOTE = '@remote:'
    const REF_LOCAL = '@local:'

    // ── i18n (issue #14) ────────────────────────────────────────────────────
    // Dictionaries are keyed by stable ids, zh + en share the same key set.
    // Lookup order: active locale → en fallback → the key itself (so a missing
    // translation stays visible instead of blanking the UI).
    const NS = 'dsh-remote'
    const L = {
      zh: {
        'settings.title': '远程工作区（dsh-remote）',
        'settings.intro': '维护多台 SSH 机器（密码/私钥/agent/跳板机/钥匙串）。路径在新建/选择工作区时选：「本机」走系统文件夹对话框；「远程」选一台机器在远程目录中选择。',
        'settings.machines': '已配置的机器',
        'settings.noMachines': '还没有机器。在下方添加。',
        'settings.current': '当前',
        'settings.edit': '编辑',
        'settings.delete': '删除',
        'settings.setCurrent': '设为当前',
        'settings.currentMachine': '当前远程机：{name}',
        'settings.clearCurrent': '取消设为当前（active remote = none）',
        'settings.noActive': '当前没有活动远程机：保存的机器只是备用连接，不会自动进入会话上下文（本地会话不受影响）。',
        'settings.addMachine': '添加机器',
        'settings.editMachine': '编辑机器',
        'settings.badgeSshConfig': 'ssh cfg',
        'settings.sshImport': '从 ~/.ssh/config 导入',
        'settings.sshCollapse': '收起',
        'settings.sshNoEntries': '~/.ssh/config 里没有可导入的 Host 条目',
        'settings.sshUseAlias': '用别名（不复制）',
        'settings.sshCopyFields': '复制字段',
        'settings.sshAliasHint': '别名模式：机器只记住「{alias}」这个名字，主机/用户/端口/私钥/跳板每次连接都从 ~/.ssh/config 实时解析（改配置立刻生效）。',
        'settings.useSshConfig': '使用 ~/.ssh/config 别名（只存别名，不存副本）',
        'settings.useSshConfigHint': '留空或保持默认的字段（用户 root、端口 22、私钥、跳板）将从 ~/.ssh/config 实时解析；填了非默认值则覆盖。',
        'settings.sshResolvedTo': '→ {user}@{host}:{port}',
        'settings.sshResolvedNone': '~/.ssh/config 中没有匹配「{alias}」的 Host 条目',
        'settings.sshResolvedWarn': '注意：{msg}',
        'settings.sshAliasSaved': '已按别名保存（连接时解析）',
        'settings.name': '名称',
        'settings.host': '主机',
        'settings.port': '端口',
        'settings.user': '用户',
        'settings.password': '密码',
        'settings.advCollapse': '▲ 收起高级配置',
        'settings.advExpand': '▼ 高级配置（私钥 / 跳板机 / agent 等）',
        'settings.privateKey': '私钥路径',
        'settings.passphrase': 'Passphrase',
        'settings.workspace': '默认工作区',
        'settings.hostKeyMode': 'HostKey 模式',
        'settings.hkDefault': '（默认 accept-new）',
        'settings.hkAccept': 'accept-new（信任首次，之后校验）',
        'settings.hkVerify': 'verify（严格：拒绝陌生主机）',
        'settings.hkOff': 'off（不校验，不推荐）',
        'settings.agent': 'SSH agent（SSH_AUTH_SOCK）',
        'settings.keyboardInteractive': 'keyboard-interactive（OTP/动态码）',
        'settings.encryptPassword': '加密保存密码（系统钥匙串）',
        'settings.proxyHost': '跳板机',
        'settings.proxyPortUser': '端口/用户',
        'settings.proxyKey': '跳板私钥',
        'settings.cancelEdit': '取消编辑',
        'settings.clear': '清空',
        'settings.testing': '连接中…',
        'settings.testOk': '✓ 连接成功',
        'settings.testConn': '测试连接',
        'settings.saving': '保存中…',
        'settings.save': '保存',
        'settings.recentWorkspaces': '当前机器最近工作区（一键切换）',
        'settings.switch': '切换',
        'settings.forwards': '端口转发（SSH 隧道）',
        'settings.fwdStop': '停止',
        'settings.fwdStart': '启动',
        'settings.fwdRemove': '删除',
        'settings.fwdDirLocal': '本地→远端',
        'settings.fwdDirReverse': '远端→本地',
        'settings.fwdListen': '监听端口',
        'settings.fwdTargetHost': '目标主机',
        'settings.fwdTargetPort': '目标端口',
        'settings.fwdAuto': '自动重连',
        'settings.fwdAdd': '添加转发',
        'settings.audit': '最近执行的远程命令（审计日志）',
        'settings.auditEmpty': '暂无记录（在远端执行的命令会记录到 $DSH_HOME/remote-workspaces/audit.log）',
        'settings.auditRefresh': '刷新日志',
        'settings.badgePwd': '密码',
        'settings.badgeKeychain': '钥匙串',
        'settings.badgeProxy': '跳板',
        'settings.sectionHide': '收起此栏',
        'settings.sectionShow': '展开此栏',
        'settings.update': '更新',
        'settings.updateChecking': '版本信息加载中…',
        'settings.checking': '检查中…',
        'settings.checkUpdate': '检查更新',
        'settings.updateNow': '立即更新',
        'settings.updateMode': '更新模式：',
        'settings.updateManual': '手动',
        'settings.updateAuto': '自动',
        'settings.updateOff': '关闭',
        'settings.like': '觉得好用？',
        'settings.star': '⭐ 去 GitHub 点个 Star',
        'settings.feedback': '💬 反馈建议 / 提 issue',
        'settings.deleted': '已删除',
        'settings.saved': '已保存更新',
        'settings.added': '已添加 — 可设为当前',
        'settings.secretStoreFailed': '密码未能写入系统密钥库（{msg}），已回退为明文保存在 machines.json，连接仍可用。',
        'settings.switched': '已切换为当前远程机',
        'settings.cleared': '已取消当前远程机 — 本地会话不再自动使用远程上下文',
        'settings.noScope': '无法确定作用工作区（当前没有活动会话）— 请在有会话的窗口打开本页',
        'settings.switchedScope': '已将该机器设为工作区 {dir} 的当前远程机（其它工作区不受影响）',
        'settings.clearedScope': '已清除工作区 {dir} 的远程绑定（其它工作区不受影响）',
        'settings.scopeBar': '作用工作区：{dir}',
        'settings.remotePath': '远程：{path}',
        'settings.filledSsh': '已从 ~/.ssh/config 填入（仅引用私钥路径，不读取内容）',
        'settings.workspaceSwitched': '已切换到工作区 {path}',
        'settings.connOk': '连接成功',
        'settings.connOkWith': '连接成功（{user}@{host}，{latency}ms）{shell}',
        'settings.connFail': '连接失败',
        'settings.shellWin': '（Windows · Git Bash）',
        'settings.shellWinNoGit': '（Windows · 未找到 Git Bash）',
        'settings.shellPosix': '（POSIX）',
        'settings.updateFail': '检查更新失败',
        'settings.updateAvailable': '发现新版本 v{version}',
        'settings.updateLatest': '已是最新版本（v{version}）',
        'settings.updateConfirm': '将更新 dsh-remote 到 v{version}，替换本机插件文件。更新后需重启 Harness 生效。继续？',
        'settings.updateApplied': '✅ 已更新到 v{to}（{from} → {to}）。重启 Harness 生效。',
        'settings.updateFailed': '更新失败',
        'settings.updateFailedMsg': '更新失败: {msg}',
        'settings.registryUnreachable': '无法连接 npm registry',
        'settings.updateModeSet': '更新模式已设为「{mode}」',
        'settings.updateModeSaveFail': '模式保存失败: {msg}',
        'settings.deleteConfirm': '确定删除这台机器？',
        'settings.sshReadFail': '读取 ~/.ssh/config 失败: {msg}',
        'settings.delFail': '删除失败: {msg}',
        'settings.addFail': '保存失败: {msg}',
        'settings.modeAuto': '自动',
        'settings.modeOff': '关闭',
        'settings.modeManual': '手动',
        'picker.title': '选择工作目录',
        'picker.close': '关闭 ✕',
        'picker.tabLocal': '本机',
        'picker.tabRemote': '远程',
        'picker.localIntro': '弹出系统文件夹对话框选择；不可用时用内置目录浏览，也可直接输入本机目录。',
        'picker.localPlaceholder': '本机目录，如 C:\\Users\\you\\project',
        'picker.useLocalPath': '选用此本地路径',
        'picker.openSysPicker': '打开系统文件夹选择器',
        'picker.opening': '打开中…',
        'picker.remoteMachine': '远程机器:',
        'picker.chooseMachine': '— 选择机器 —',
        'picker.noMachines': '还没有机器，请先在设置里添加',
        'picker.recent': '最近:',
        'picker.pathPlaceholder': '输入远程路径（自动补全）',
        'picker.pathPlaceholderWin': '输入远程路径，如 C:\\Users\\…（自动补全）',
        'picker.chooseMachineFirst': '先选远程机器',
        'picker.browse': '浏览…',
        'picker.home': '~ 主目录',
        'picker.setRemoteWs': '设为远程工作区',
        'picker.mirroring': '镜像中…',
        'picker.cancel': '取消',
        'picker.selectDir': '选择工作目录',
        'picker.selected': '所选: {path}',
        'picker.driveRoot': '（驱动器根）',
        'picker.emptyDir': '（空目录）',
        'picker.loading': '加载中…',
        'picker.readingRoot': '正在读取根目录…',
        'picker.back': '回上一级 ▴',
        'picker.closeBtn': '关闭 ✕',
        'picker.newDir': '新建目录',
        'picker.newFolder': '新建文件夹',
        'picker.create': '新建',
        'picker.chooseThis': '选用此路径',
        'picker.enterDir': '进入 {name}',
        'picker.enterDrive': '进入驱动器 {name}',
        'picker.fileAt': '文件: {name}',
        'picker.cancelled': '已取消选择',
        'picker.noSysPicker': '无法打开系统文件夹选择器，可直接在输入框填本地路径',
        'picker.timeout': '目录选择已超时，请重试或直接在输入框填本地路径',
        'picker.pickerBinNotFound': '未找到目录选择器程序',
        'picker.noSysPickerHost': '当前系统不支持自动打开目录选择器，请在输入框直接填本地路径',
        'picker.noHomeWin': 'Windows 远程暂不支持 ~ 解析，请直接输入绝对路径',
        'picker.typePath': ' — 可直接在输入框填本地路径',
        'picker.noHome': '无法解析主目录',
        'picker.newDirName': '新建目录名（在 {path} 下）',
        'picker.noSubdir': '（没有子目录 — 可直接选用当前目录）',
        'picker.truncated': '（条目过多已截断）',
        'picker.thisPc': '此电脑',
        'picker.chooseDrive': ' 选择驱动器',
        'picker.homeBtn': '🏠',
        'picker.goHome': '回家目录',
        'picker.hintKeys': 'Enter 确认 · Esc 关闭 · Ctrl/⌘+Enter 设为工作区',
        'picker.closeLabel': '关闭',
        'picker.browseLocal': '浏览本机目录',
        'picker.star': '⭐ Star dsh-remote',
        'picker.feedback': '反馈 / 提 issue',
        'explorer.refresh': '刷新',
        'explorer.reconnect': '重新连接',
        'explorer.reconnecting': '正在重新连接…',
        'explorer.reconnectOk': '已重新连接，正在刷新…',
        'explorer.reconnectCredential': '无法自动重连：该机器未保存密码 / 私钥。\n请在「设置 → 远程工作区」编辑该机器，填写密码（或私钥路径 / SSH agent）后重新连接。',
        'explorer.credentialHint': '（无法自动重连：机器未保存密码 / 私钥，请到「设置 → 远程工作区」补充凭据后刷新）',
        'explorer.newDir': '新建目录',
        'explorer.more': '…',
        'explorer.pickWorkspace': '切换远程工作区',
        'explorer.remoteWs': '远程工作区: {path}{host}',
        'explorer.hostTag': '  ({user}@{host})',
        'explorer.noRemoteWs': '未设置远程工作区',
        'explorer.sessionLocal': '当前会话未使用远程工作区',
        'explorer.localSession': '当前会话是本地工作区，未使用远程文件。\n\n如需访问远程，可在设置页将某台机器「设为当前」，再用上方「…」选择远程工作区。',
        'explorer.loading': '加载中…',
        'explorer.dirMissing': '目录不存在或已被删除',
        'explorer.notConnected': '未连接远程主机（重启后需在设置中将机器「设为当前」，或刷新右侧列）',
        'explorer.resolveFail': '解析远程工作区失败：{msg}',
        'explorer.softError': '⚠ {msg}（显示缓存，可点 ↻ 刷新）',
        'explorer.busy': '处理中… ',
        'explorer.menuExpand': '📂 展开/收起',
        'explorer.menuOpen': '📄 打开文件',
        'explorer.menuDownload': '⬇ 下载到本地镜像',
        'explorer.menuCopyRel': '📋 复制相对地址',
        'explorer.menuCopyAbs': '📋 复制绝对地址',
        'explorer.menuRename': '✏ 重命名',
        'explorer.menuDelete': '🗑 删除',
        'explorer.menuDeleteDir': '🗑 删除（含子目录）',
        'explorer.renamePrompt': '重命名为（新名字）',
        'explorer.renameTitle': '重命名',
        'explorer.mkdirTitle': '新建目录',
        'explorer.namePlaceholder': '名称',
        'explorer.deleteConfirm': '确认删除 {path}？',
        'explorer.copied': '已复制',
        'explorer.reference': '@remote',
        'explorer.tabTitle': '远程文件',
        'terminal.tabTitle': '远程终端',
        'terminal.noMachine': '没有活动的远程机。请先在 dsh-remote 设置页「设为当前」一台机器，再打开远程终端。',
        'terminal.loading': '正在打开远程终端…',
        'terminal.loadFail': '无法加载终端组件：{msg}',
        'terminal.connFail': '远程终端连接失败',
        'terminal.connecting': '正在连接远程终端…',
        'settings.terminal': '远程终端（交互式 SSH）',
        'settings.terminalHint': '远程会话里侧栏「+」菜单的「终端」默认就是远程 SSH 终端（需要 dsh-better-sidebar 的 terminal-source 槽位，旧版自动保持本地）；也可显式打开「🖥 远程终端」。每个标签页是一条独立 SSH 连接，关闭标签页即断开。',
        'settings.terminalSessions': '活动会话：{n} / {max}',
        'settings.terminalNeedsSidebar': '终端通道不可用：宿主不支持 WS 升级，或侧边栏版本过低。',
        'settings.terminalLoading': '读取中…',
        'file.readonly': '只读',
        'file.editing': '编辑中',
        'file.saveToRemote': '保存到远程',
        'file.saving': '保存中…',
        'file.cancel': '取消',
        'file.edit': '编辑',
        'file.download': '下载',
        'file.loading': '加载中…',
        'file.binary': '二进制文件 ({size}) — 请用「下载」或 rw_download / 本地镜像查看。',
        'file.unknownSize': '未知大小',
        'file.empty': '（空文件）',
        'file.truncated': '… 内容已截断（只读远程查看，完整文件请用 rw_read_file / 下载）',
        'file.conflict': '远端文件已变化，请重新读取',
        'file.dirty': '未保存',
        'file.saveHint': 'Ctrl/⌘+S 保存',
        'file.downloaded': '已下载到本地镜像{local}',
        'file.downloadedAt': ': {path}',
        'file.readFail': '远程读取失败: {msg}',
        'file.listFail': '远程目录读取失败: {msg}',
        'common.refresh': '刷新',
        'common.reconnect': '重新连接',
        'common.close': '关闭',
        'common.confirm': '确认',
      },
      en: {
        'settings.title': 'Remote workspace (dsh-remote)',
        'settings.intro': 'Manage multiple SSH machines (password / private key / agent / proxy jump / keychain). Pick a path when creating/selecting a workspace: "Local" opens the system folder dialog; "Remote" picks a machine and a directory on it.',
        'settings.machines': 'Configured machines',
        'settings.noMachines': 'No machines yet. Add one below.',
        'settings.current': 'current',
        'settings.edit': 'Edit',
        'settings.delete': 'Delete',
        'settings.setCurrent': 'Set as current',
        'settings.currentMachine': 'Current remote: {name}',
        'settings.clearCurrent': 'Clear current (active remote = none)',
        'settings.noActive': 'No active remote machine: saved machines are standby connections and never enter a session context automatically (local sessions are unaffected).',
        'settings.addMachine': 'Add machine',
        'settings.editMachine': 'Edit machine',
        'settings.badgeSshConfig': 'ssh cfg',
        'settings.sshImport': 'Import from ~/.ssh/config',
        'settings.sshCollapse': 'Collapse',
        'settings.sshNoEntries': 'No importable Host entries in ~/.ssh/config',
        'settings.sshUseAlias': 'Use alias (no copy)',
        'settings.sshCopyFields': 'Copy fields',
        'settings.sshAliasHint': 'Alias mode: the machine remembers only the name "{alias}"; host/user/port/key/jump host are resolved from ~/.ssh/config at every connect, so editing that file takes effect immediately.',
        'settings.useSshConfig': 'Use a ~/.ssh/config alias (keep the alias, not a copy)',
        'settings.useSshConfigHint': 'Fields left empty or at their default (user root, port 22, key, jump host) come from ~/.ssh/config at connect time; a non-default value overrides it.',
        'settings.sshResolvedTo': '→ {user}@{host}:{port}',
        'settings.sshResolvedNone': 'no ~/.ssh/config block matches "{alias}"',
        'settings.sshResolvedWarn': 'Heads-up: {msg}',
        'settings.sshAliasSaved': 'Saved as an alias (resolved on connect)',
        'settings.name': 'Name',
        'settings.host': 'Host',
        'settings.port': 'Port',
        'settings.user': 'User',
        'settings.password': 'Password',
        'settings.advCollapse': '▲ Collapse advanced config',
        'settings.advExpand': '▼ Advanced (private key / proxy jump / agent, etc.)',
        'settings.privateKey': 'Private key path',
        'settings.passphrase': 'Passphrase',
        'settings.workspace': 'Default workspace',
        'settings.hostKeyMode': 'HostKey mode',
        'settings.hkDefault': '（default accept-new）',
        'settings.hkAccept': 'accept-new (trust first, verify later)',
        'settings.hkVerify': 'verify (strict: reject unknown hosts)',
        'settings.hkOff': 'off (no verification, not recommended)',
        'settings.agent': 'SSH agent (SSH_AUTH_SOCK)',
        'settings.keyboardInteractive': 'keyboard-interactive (OTP / dynamic code)',
        'settings.encryptPassword': 'Encrypt saved password (system keychain)',
        'settings.proxyHost': 'Proxy jump host',
        'settings.proxyPortUser': 'Port / user',
        'settings.proxyKey': 'Proxy jump private key',
        'settings.cancelEdit': 'Cancel edit',
        'settings.clear': 'Clear',
        'settings.testing': 'Connecting…',
        'settings.testOk': '✓ Connected',
        'settings.testConn': 'Test connection',
        'settings.saving': 'Saving…',
        'settings.save': 'Save',
        'settings.recentWorkspaces': 'Recent workspaces of the current machine (one-click switch)',
        'settings.switch': 'Switch',
        'settings.forwards': 'Port forwarding (SSH tunnels)',
        'settings.fwdStop': 'Stop',
        'settings.fwdStart': 'Start',
        'settings.fwdRemove': 'Remove',
        'settings.fwdDirLocal': 'Local → remote',
        'settings.fwdDirReverse': 'Remote → local',
        'settings.fwdListen': 'Listen port',
        'settings.fwdTargetHost': 'Target host',
        'settings.fwdTargetPort': 'Target port',
        'settings.fwdAuto': 'Auto reconnect',
        'settings.fwdAdd': 'Add forward',
        'settings.audit': 'Recent remote commands (audit log)',
        'settings.auditEmpty': 'No records yet (commands run remotely are logged to $DSH_HOME/remote-workspaces/audit.log)',
        'settings.auditRefresh': 'Refresh log',
        'settings.badgePwd': 'password',
        'settings.badgeKeychain': 'keychain',
        'settings.badgeProxy': 'jump',
        'settings.sectionHide': 'Collapse section',
        'settings.sectionShow': 'Expand section',
        'settings.update': 'Update',
        'settings.updateChecking': 'Loading version info…',
        'settings.checking': 'Checking…',
        'settings.checkUpdate': 'Check for updates',
        'settings.updateNow': 'Update now',
        'settings.updateMode': 'Update mode:',
        'settings.updateManual': 'Manual',
        'settings.updateAuto': 'Auto',
        'settings.updateOff': 'Off',
        'settings.like': 'Like it?',
        'settings.star': '⭐ Star on GitHub',
        'settings.feedback': '💬 Feedback / report issue',
        'settings.deleted': 'Deleted',
        'settings.saved': 'Saved',
        'settings.added': 'Added — you can set it as current',
        'settings.secretStoreFailed': 'The OS keychain refused the password ({msg}); it was saved as plaintext in machines.json and the machine still connects.',
        'settings.switched': 'Switched to current remote machine',
        'settings.cleared': 'Cleared current remote — local sessions no longer use remote context automatically',
        'settings.noScope': 'Cannot determine the scope workspace (no active session) — open this page from a session window',
        'settings.switchedScope': 'Machine set as current for workspace {dir} (other workspaces unaffected)',
        'settings.clearedScope': 'Cleared the remote binding of workspace {dir} (other workspaces unaffected)',
        'settings.scopeBar': 'Scope workspace: {dir}',
        'settings.remotePath': 'Remote path: {path}',
        'settings.filledSsh': 'Filled from ~/.ssh/config (only references the private key path, never reads its content)',
        'settings.workspaceSwitched': 'Switched to workspace {path}',
        'settings.connOk': 'Connection successful',
        'settings.connOkWith': 'Connection successful ({user}@{host}, {latency}ms){shell}',
        'settings.connFail': 'Connection failed',
        'settings.shellWin': ' (Windows · Git Bash)',
        'settings.shellWinNoGit': ' (Windows · no Git Bash found)',
        'settings.shellPosix': ' (POSIX)',
        'settings.updateFail': 'Failed to check for updates',
        'settings.updateAvailable': 'New version found: v{version}',
        'settings.updateLatest': 'Already up to date (v{version})',
        'settings.updateConfirm': 'Update dsh-remote to v{version}? This replaces the local plugin files and requires a Harness restart to take effect. Continue?',
        'settings.updateApplied': '✅ Updated to v{to} ({from} → {to}). Restart Harness to apply.',
        'settings.updateFailed': 'Update failed',
        'settings.updateFailedMsg': 'Update failed: {msg}',
        'settings.registryUnreachable': 'Cannot reach the npm registry',
        'settings.updateModeSet': 'Update mode set to "{mode}"',
        'settings.updateModeSaveFail': 'Failed to save mode: {msg}',
        'settings.deleteConfirm': 'Delete this machine?',
        'settings.sshReadFail': 'Failed to read ~/.ssh/config: {msg}',
        'settings.delFail': 'Delete failed: {msg}',
        'settings.addFail': 'Save failed: {msg}',
        'settings.modeAuto': 'Auto',
        'settings.modeOff': 'Off',
        'settings.modeManual': 'Manual',
        'picker.title': 'Select working directory',
        'picker.close': 'Close ✕',
        'picker.tabLocal': 'Local',
        'picker.tabRemote': 'Remote',
        'picker.localIntro': 'Opens the system folder dialog; when unavailable, uses the built-in directory browser. You can also type a local path directly.',
        'picker.localPlaceholder': 'Local directory, e.g. C:\\Users\\you\\project',
        'picker.useLocalPath': 'Use this local path',
        'picker.openSysPicker': 'Open system folder picker',
        'picker.opening': 'Opening…',
        'picker.remoteMachine': 'Remote machine:',
        'picker.chooseMachine': '— choose a machine —',
        'picker.noMachines': 'No machines yet — add one in Settings first',
        'picker.recent': 'Recent:',
        'picker.pathPlaceholder': 'Enter remote path (auto-complete)',
        'picker.pathPlaceholderWin': 'Enter remote path, e.g. C:\\Users\\… (auto-complete)',
        'picker.chooseMachineFirst': 'Choose a remote machine first',
        'picker.browse': 'Browse…',
        'picker.home': '~ Home',
        'picker.setRemoteWs': 'Set as remote workspace',
        'picker.mirroring': 'Mirroring…',
        'picker.cancel': 'Cancel',
        'picker.selectDir': 'Select working directory',
        'picker.selected': 'Selected: {path}',
        'picker.driveRoot': ' (drive root)',
        'picker.emptyDir': ' (empty directory)',
        'picker.loading': 'Loading…',
        'picker.readingRoot': 'Reading root directory…',
        'picker.back': 'Back ▴',
        'picker.closeBtn': 'Close ✕',
        'picker.newDir': 'New directory',
        'picker.newFolder': 'New folder',
        'picker.create': 'Create',
        'picker.chooseThis': 'Use this path',
        'picker.enterDir': 'Enter {name}',
        'picker.enterDrive': 'Enter drive {name}',
        'picker.fileAt': 'File: {name}',
        'picker.cancelled': 'Selection cancelled',
        'picker.noSysPicker': 'Cannot open the system folder picker — you can type a local path in the input box',
        'picker.timeout': 'Directory selection timed out — retry or type a local path directly',
        'picker.pickerBinNotFound': 'Directory picker program not found',
        'picker.noSysPickerHost': 'This system cannot auto-open a directory picker — type a local path in the input box',
        'picker.noHomeWin': 'Windows remotes do not support ~ resolution — enter an absolute path',
        'picker.typePath': ' — type a local path in the input box instead',
        'picker.noHome': 'Cannot resolve home directory',
        'picker.newDirName': 'New directory name (under {path})',
        'picker.noSubdir': ' (no subdirectories — you can use the current directory)',
        'picker.truncated': ' (too many entries, truncated)',
        'picker.thisPc': 'This PC',
        'picker.chooseDrive': ' choose a drive',
        'picker.homeBtn': '🏠',
        'picker.goHome': 'Go to home',
        'picker.hintKeys': 'Enter confirms · Esc closes · Ctrl/⌘+Enter sets workspace',
        'picker.closeLabel': 'Close',
        'picker.browseLocal': 'Browse local folder',
        'picker.star': '⭐ Star dsh-remote',
        'picker.feedback': 'Feedback / report issue',
        'explorer.refresh': 'Refresh',
        'explorer.reconnect': 'Reconnect',
        'explorer.reconnecting': 'Reconnecting…',
        'explorer.reconnectOk': 'Reconnected, refreshing…',
        'explorer.reconnectCredential': 'Cannot reconnect automatically: this machine has no saved password / private key.\nEdit the machine in Settings → Remote workspace (enter a password, a private key path, or enable the SSH agent), then reconnect.',
        'explorer.credentialHint': ' (cannot reconnect automatically: no saved password / private key for this machine — add credentials in Settings → Remote workspace, then refresh)',
        'explorer.newDir': 'New directory',
        'explorer.more': '…',
        'explorer.pickWorkspace': 'Switch remote workspace',
        'explorer.remoteWs': 'Remote workspace: {path}{host}',
        'explorer.hostTag': '  ({user}@{host})',
        'explorer.noRemoteWs': 'No remote workspace set',
        'explorer.sessionLocal': 'This session does not use a remote workspace',
        'explorer.localSession': 'This session is a local workspace and does not use remote files.\n\nTo access remote, set a machine as "current" in Settings, then pick a remote workspace with the "…" button above.',
        'explorer.loading': 'Loading…',
        'explorer.dirMissing': 'Directory does not exist or was deleted',
        'explorer.notConnected': 'Not connected to the remote host (after a restart, set a machine as "current" in Settings, or refresh the right column)',
        'explorer.resolveFail': 'Failed to resolve the remote workspace: {msg}',
        'explorer.softError': '⚠ {msg} (showing cache, click ↻ to refresh)',
        'explorer.busy': 'Processing… ',
        'explorer.menuExpand': '📂 Expand/collapse',
        'explorer.menuOpen': '📄 Open file',
        'explorer.menuDownload': '⬇ Download to local mirror',
        'explorer.menuCopyRel': '📋 Copy relative path',
        'explorer.menuCopyAbs': '📋 Copy absolute path',
        'explorer.menuRename': '✏ Rename',
        'explorer.menuDelete': '🗑 Delete',
        'explorer.menuDeleteDir': '🗑 Delete (with contents)',
        'explorer.renamePrompt': 'Rename to (new name)',
        'explorer.renameTitle': 'Rename',
        'explorer.mkdirTitle': 'New directory',
        'explorer.namePlaceholder': 'Name',
        'explorer.deleteConfirm': 'Delete {path}?',
        'explorer.copied': 'Copied',
        'explorer.reference': '@remote',
        'explorer.tabTitle': 'Remote Files',
        'terminal.tabTitle': 'Remote Terminal',
        'terminal.noMachine': 'No active remote machine. Mark one as current in the dsh-remote settings page first, then open the remote terminal.',
        'terminal.loading': 'Opening the remote terminal…',
        'terminal.loadFail': 'Cannot load the terminal component: {msg}',
        'terminal.connFail': 'Remote terminal connection failed',
        'terminal.connecting': 'Connecting to the remote terminal…',
        'settings.terminal': 'Remote terminal (interactive SSH)',
        'settings.terminalHint': 'In remote sessions, the sidebar "+" menu "Terminal" is a remote SSH shell by default (needs dsh-better-sidebar with the terminal-source slot; older hosts stay local). You can also open "🖥 远程终端" explicitly. Each tab is a dedicated SSH connection; closing the tab disconnects.',
        'settings.terminalSessions': 'Active sessions: {n} / {max}',
        'settings.terminalNeedsSidebar': 'Terminal channel unavailable: no WS upgrade support on the host, or the sidebar version is too old.',
        'settings.terminalLoading': 'Loading…',
        'file.readonly': 'read-only',
        'file.editing': 'editing',
        'file.saveToRemote': 'Save to remote',
        'file.saving': 'Saving…',
        'file.cancel': 'Cancel',
        'file.edit': 'Edit',
        'file.download': 'Download',
        'file.loading': 'Loading…',
        'file.binary': 'Binary file ({size}) — use "Download", rw_download or the local mirror to view.',
        'file.unknownSize': 'unknown size',
        'file.empty': ' (empty file)',
        'file.truncated': '… content truncated (read-only remote view; use rw_read_file / Download for the full file)',
        'file.conflict': 'The remote file changed, please re-read it',
        'file.dirty': 'unsaved',
        'file.saveHint': 'Ctrl/⌘+S to save',
        'file.downloaded': 'Downloaded to local mirror{local}',
        'file.downloadedAt': ': {path}',
        'file.readFail': 'Failed to read remote: {msg}',
        'file.listFail': 'Failed to list remote directory: {msg}',
        'common.refresh': 'Refresh',
        'common.reconnect': 'Reconnect',
        'common.close': 'Close',
        'common.confirm': 'Confirm',
      },
    }

    // Active dictionary: resolved from the DSH locale service when available
    // (its active locale + en fallback), else from the browser language, else en.
    let ACTIVE_LANG = 'en'
    try {
      const nav = (typeof navigator !== 'undefined' && navigator.languages) ? navigator.languages : (typeof navigator !== 'undefined' ? [navigator.language] : [])
      for (const tag of nav) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh') { ACTIVE_LANG = 'zh'; break }
        if (primary === 'en') { ACTIVE_LANG = 'en'; break }
      }
    } catch { /* keep en */ }

    // The DSH locale service binds a translate thunk; we call it first and fall
    // back to our own dictionary so missing keys never blank the UI.
    function makeTr() {
      const dict = L[ACTIVE_LANG] || L.en
      return (key, params) => {
        let text = dict[key]
        if (text === undefined && ACTIVE_LANG !== 'en') text = L.en[key]
        if (text === undefined) text = key
        if (params) text = String(text).replace(/\{(\w+)\}/g, (m, p) => (p in params ? String(params[p]) : m))
        return text
      }
    }
    let tr = makeTr()
    // Called from apply() once the real locale service is reachable; registers
    // both dictionaries and rebinds tr so live locale switches take effect.
    function wireLocale(ctx) {
      try {
        const locale = ctx && ctx.get && ctx.get('locale')
        if (!locale || typeof locale.register !== 'function') return
        const dispose = locale.register(NS, { zh: L.zh, en: L.en })
        const bound = locale.bind(NS)
        tr = (key, params) => {
          let text = bound(key, params)
          if (text === key) {
            const d = L[ACTIVE_LANG] || L.en
            text = d[key] !== undefined ? d[key] : L.en[key]
            if (text === undefined) text = key
            if (params) text = String(text).replace(/\{(\w+)\}/g, (m, p) => (p in params ? String(params[p]) : m))
          }
          return text
        }
        if (ctx.effect) ctx.effect(() => dispose, 'dsh-remote.locale')
      } catch (e) { /* keep local dict fallback */ }
    }

    // Known host-side error messages (lib/index.js) are Chinese. Map them to
    // dictionary keys so non-zh locales see localized errors instead of raw
    // zh text. Unknown / server-generated messages pass through untouched.
    const HOST_ERROR_KEYS = {
      '目录选择已超时，请重试或直接在输入框填本地路径': 'picker.timeout',
      '无法打开系统文件夹选择器': 'picker.noSysPicker',
      '当前系统不支持自动打开目录选择器，请在输入框直接填本地路径': 'picker.noSysPickerHost',
      'Windows 远程暂不支持 ~ 解析，请直接输入绝对路径': 'picker.noHomeWin',
      '无法连接 npm registry': 'settings.registryUnreachable',
    }
    const HOST_ERROR_PREFIX = [
      ['未找到目录选择器程序', 'picker.pickerBinNotFound'],
    ]
    const HOST_ERROR_SUFFIX = [
      [' — 可直接在输入框填本地路径', 'picker.typePath'],
    ]
    function trHostError(msg) {
      if (!msg || ACTIVE_LANG === 'zh') return msg
      if (HOST_ERROR_KEYS[msg]) return tr(HOST_ERROR_KEYS[msg])
      for (const [prefix, key] of HOST_ERROR_PREFIX) {
        if (msg.startsWith(prefix)) {
          const en = L.en[key]
          if (en !== undefined) return en + msg.slice(prefix.length)
        }
      }
      for (const [suffix, key] of HOST_ERROR_SUFFIX) {
        if (msg.endsWith(suffix)) {
          const en = L.en[key]
          if (en !== undefined) return msg.slice(0, -suffix.length) + en
        }
      }
      return msg
    }

    // The official Electron shell serves the shared API over its private
    // dsh-app carrier. Legacy browser hosts keep their existing route prefix.
    // Choose before sending: never retry a mutating request on another route.
    function apiPath(path) {
      return window.location && window.location.protocol === 'dsh-app:'
        ? '/api' + path : path
    }

    function sessionQuery(sessionId) {
      return sessionId ? 'sessionId=' + encodeURIComponent(sessionId) : ''
    }
    function withSessionQuery(path, sessionId) {
      const q = sessionQuery(sessionId)
      if (!q) return path
      return path + (path.includes('?') ? '&' : '?') + q
    }
    function withSessionBody(body, sessionId) {
      if (!sessionId) return body
      return Object.assign({}, body || {}, { sessionId })
    }

    async function api(method, path, body) {
      const opts = { method, headers: {} }
      if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
      const res = await fetch(apiPath(path), opts)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(trHostError((data && (data.error || data.message))) || 'HTTP ' + res.status)
      return data
    }

    // Like api() but returns {status, data} so callers can handle 409 etc.
    async function apiRaw(method, path, body) {
      const opts = { method, headers: {} }
      if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
      const res = await fetch(apiPath(path), opts)
      const data = await res.json().catch(() => ({}))
      if (data && typeof data.error === 'string') data.error = trHostError(data.error)
      if (data && typeof data.message === 'string') data.message = trHostError(data.message)
      return { status: res.status, data }
    }

    // The remote git data-plane call behind every GitDataSource method (the
    // better-sidebar 'gitSource' slot, v0.23.0): one POST per op, the host
    // half runs the git command on the owning machine and porcelain-parses
    // it (lib/git-parse.js). Host-provided result shapes pass through
    // verbatim (they mirror the host sidebar's git.* routes). `signal` is
    // the consumer's optional AbortSignal; credential-classified failures
    // carry `err.credential` like every other remote browse/read error.
    async function apiGit(op, payload, signal) {
      const res = await fetch('/dsh-remote/git', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, ...payload }),
        signal,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const msg = trHostError((data && (data.error || data.message))) || 'HTTP ' + res.status
        const err = new Error(msg)
        err.credential = !!(data && data.credential)
        throw err
      }
      return data
    }

    // Theme via DSH design tokens so this follows the harness light/dark theme.
    const v = (name, fb) => `var(${name}, ${fb})`
    const T = {
      bg: v('--dsw-alias-bg-layer-1', 'rgba(128,128,128,0.07)'),
      bg2: v('--dsw-alias-interactive-bg-hover', 'rgba(128,128,128,0.10)'),
      border: v('--dsw-alias-border-l2', 'rgba(128,128,128,0.35)'),
      borderStrong: v('--dsw-alias-border-l3', 'rgba(128,128,128,0.5)'),
      danger: v('--dsw-static-red-500', '#e06c75'),
      dangerText: v('--dsw-static-red-400', '#e06c75'),
      ok: v('--dsw-static-green-500', '#4caf7d'),
      warn: v('--dsw-static-yellow-500', '#e6c07b'),
      radius: 8,
      muted: v('--dsw-alias-label-tertiary', 'rgba(128,128,128,0.7)'),
      label: v('--dsw-alias-label-primary', '#e4e4e7'),
      primary: v('--dsw-alias-button-primary-fill', '#2563eb'),
      // Text ON a --dsw-alias-button-primary-fill surface must use the *label*
      // token, which is the pairing the harness's own primary button uses
      // (._primary{background:button-primary-fill;color:label-primary-foreground}).
      // --dsw-alias-button-contrast-fill is a FILL token (the harness uses it as a
      // `background`), so it is NOT the light-on-dark colour: in the light theme it
      // is #61666b (gray on #0f1115 = 3.3:1, and 1.6:1 once :disabled fades it),
      // and in the dark theme it collapses to #f9fafb on a #f9fafb fill (invisible).
      onPrimary: v('--dsw-alias-label-primary-foreground', '#fff'),
      // Hover tints are a neutral translucent gray rather than a theme token:
      // the harness's own interactive-bg-hover is a 6% tint that disappears on
      // the settings surface, while a gray overlay darkens light themes and
      // lightens dark ones.
      hoverBg: 'rgba(128,128,128,0.14)',
      bg: v('--dsw-alias-bg-layer-1', 'rgba(128,128,128,0.07)'),
      bg2: v('--dsw-alias-interactive-bg-hover', 'rgba(128,128,128,0.10)'),
      border: v('--dsw-alias-border-l2', 'rgba(128,128,128,0.35)'),
      borderStrong: v('--dsw-alias-border-l3', 'rgba(128,128,128,0.5)'),
      danger: v('--dsw-static-red-500', '#e06c75'),
      dangerText: v('--dsw-static-red-400', '#e06c75'),
      ok: v('--dsw-static-green-500', '#4caf7d'),
      warn: v('--dsw-static-yellow-500', '#e6c07b'),
      radius: 8,
      muted: v('--dsw-alias-label-tertiary', 'rgba(128,128,128,0.7)'),
      label: v('--dsw-alias-label-primary', '#e4e4e7'),
      primary: v('--dsw-alias-button-primary-fill', '#2563eb'),
      // DSH dialog vocabulary (ui-theme design-platform.css / gradient-shadow-
      // text.css tokens, with dark-ish fallbacks): mask, card, borders, menu,
      // labels and the business-accent blue used by tabs/focus rings.
      mask: v('--dsw-alias-bg-mask-1', 'rgba(0,0,0,0.5)'),
      maskBlur: v('--dsw-mask-blur', 'blur(2px)'),
      layer1: v('--dsw-alias-bg-layer-1', '#1c1c1f'),
      layer2: v('--dsw-alias-bg-layer-2', '#1e1e1e'),
      layer3: v('--dsw-specific-menu', v('--dsw-alias-bg-layer-3', '#242428')),
      borderL1: v('--dsw-alias-border-l1', 'rgba(128,128,128,0.15)'),
      borderL2: v('--dsw-alias-border-l2', 'rgba(128,128,128,0.25)'),
      borderL3: v('--dsw-alias-border-l3', 'rgba(128,128,128,0.35)'),
      borderInv: v('--dsw-alias-border-inverted', 'rgba(255,255,255,0.06)'),
      shadowL3: v('--dsw-shadow-lv3', '0 12px 32px rgba(0,0,0,0.08)'),
      hover: v('--dsw-alias-interactive-bg-hover', 'rgba(128,128,128,0.08)'),
      active: v('--dsw-alias-interactive-bg-active', 'rgba(128,128,128,0.14)'),
      label2: v('--dsw-alias-label-secondary', 'rgba(255,255,255,0.72)'),
      label3: v('--dsw-alias-label-tertiary', 'rgba(128,128,128,0.7)'),
      caption: v('--dsw-alias-label-caption', 'rgba(128,128,128,0.6)'),
      dimmed: v('--dsw-alias-label-dimmed', 'rgba(128,128,128,0.4)'),
      primaryFg: v('--dsw-alias-label-primary-foreground', '#ffffff'),
      primaryHover: v('--dsw-alias-button-primary-hover', '#1d4ed8'),
      business: v('--dsw-alias-state-business-primary', '#4176e6'),
      errorState: v('--dsw-alias-state-error-primary', '#dc2626'),
    }
    const inputS = { flex: 1, padding: '6px 10px', borderRadius: T.radius, border: '1px solid ' + T.border, background: T.bg, color: T.label, outline: 'none' }
    const buttonS = { padding: '6px 12px', borderRadius: T.radius, border: '1px solid ' + T.border, background: T.bg, color: T.label, cursor: 'pointer' }
    const primaryBtnS = { padding: '6px 12px', borderRadius: T.radius, border: 'none', background: T.primary, color: T.onPrimary, cursor: 'pointer', fontWeight: 600 }
    const box = { border: '1px solid ' + T.border, borderRadius: 10, background: T.bg, padding: 12 }
    const boxS = box
    const LABEL_W = 108
    const CHROME_CSS_ID = 'dsh-remote-chrome'
    function ensureChromeCss() {
      try {
        if (typeof document === 'undefined' || !document.head || typeof document.getElementById !== 'function') return
        if (document.getElementById(CHROME_CSS_ID)) return
        const el = document.createElement('style')
        el.id = CHROME_CSS_ID
        el.textContent = [
          '.dsh-rw-btn{transition:background .12s ease,opacity .12s ease,border-color .12s ease}',
          '.dsh-rw-btn:hover:not(:disabled){background:rgba(128,128,128,.18)}',
          '.dsh-rw-btn:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#2563eb);outline-offset:1px}',
          // A disabled FILLED primary keeps its solid fill. Fading the whole
          // button (opacity) turned the near-black primary fill into a muddy
          // gray and dragged the white label down to ~1.5:1 — the fill is the
          // affordance here, so keep it pure; the cursor carries "disabled".
          '.dsh-rw-btn:disabled{cursor:not-allowed}',
          '.dsh-rw-btn:disabled:not(.dsh-rw-primary){opacity:.45}',
          // A filled primary keeps its own fill on hover; opacity is the only
          // cue that stays visible whether that fill is near-black or near-white.
          '.dsh-rw-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-fill,#2563eb);opacity:.85}',
          '.dsh-rw-input{transition:border-color .12s ease,box-shadow .12s ease}',
          '.dsh-rw-input:focus{border-color:var(--dsw-alias-button-primary-fill,#2563eb)!important;box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-button-primary-fill,#2563eb) 28%,transparent)}',
          '.dsh-rw-row{border-radius:8px;margin:0 -6px;padding-left:8px;padding-right:8px;transition:background .12s ease}',
          '.dsh-rw-row:hover{background:rgba(128,128,128,.14)}',
          '.dsh-rw-list-item{transition:background .1s ease}',
          '.dsh-rw-list-item:hover{background:rgba(128,128,128,.18)}',
          '.dsh-rw-tabs{display:inline-flex;padding:3px;gap:2px;border-radius:10px;background:rgba(128,128,128,.14);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35))}',
          '.dsh-rw-tab{border:none!important;background:transparent!important}',
          '.dsh-rw-tab.is-active{background:var(--dsw-alias-button-primary-fill,#2563eb)!important;color:var(--dsw-alias-label-primary-foreground,#fff)!important;font-weight:600}',
          '.dsh-rw-pill{display:inline-flex;align-items:center;font-size:11px;line-height:1.3;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));opacity:.9;white-space:nowrap}',
          '.dsh-rw-pill.is-ok{color:var(--dsw-static-green-500,#4caf7d);border-color:currentColor}',
          '.dsh-rw-section-btn{width:100%;text-align:left;display:flex;align-items:center;gap:8px;background:transparent;border:none;cursor:pointer;padding:0;color:inherit}',
          '@keyframes dsh-rw-in{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}',
          '.dsh-rw-modal-panel{animation:dsh-rw-in .14s ease-out}',
        ].join('')
        document.head.appendChild(el)
      } catch { /* vm tests / no DOM */ }
    }
    function PromptDialog(props) {
      const { title, initial, placeholder, onSubmit, onCancel } = props
      const [val, setVal] = React.useState(initial || '')
      React.useEffect(() => {
        try {
          if (typeof document === 'undefined') return
          const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); onCancel() }
            if (e.key === 'Enter') { e.preventDefault(); const t = val.trim(); if (t) onSubmit(t) }
          }
          document.addEventListener('keydown', onKey)
          return () => document.removeEventListener('keydown', onKey)
        } catch { return undefined }
      }, [val, onSubmit, onCancel])
      return React.createElement('div', {
        style: { position: 'fixed', inset: 0, zIndex: 1000000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
        onClick: onCancel,
      },
        React.createElement('div', {
          className: 'dsh-rw-modal-panel',
          style: { background: v('--dsw-alias-bg-overlay', '#1e1e1e'), border: '1px solid ' + T.borderStrong, borderRadius: 10, padding: 14, width: 'min(420px, 92vw)', display: 'flex', flexDirection: 'column', gap: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.4)' },
          onClick: (e) => e.stopPropagation(),
        },
          React.createElement('div', { style: { fontSize: 13, fontWeight: 600, color: T.label } }, title),
          React.createElement('input', { autoFocus: true, value: val, onChange: (e) => setVal(e.target.value), placeholder: placeholder || '', className: 'dsh-rw-input', style: inputS }),
          React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, onClick: onCancel }, tr('file.cancel')),
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: primaryBtnS, onClick: () => { const t = val.trim(); if (t) onSubmit(t) }, disabled: !val.trim() }, tr('common.confirm')),
          ),
        ),
      )
    }

    function humanSize(n) {
      if (n == null) return ''
      if (n < 1024) return n + ' B'
      const units = ['KB', 'MB', 'GB', 'TB']
      let i = -1
      let v = n
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
      return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i]
    }
    function fmtTime(ts) {
      if (!ts) return ''
      const d = new Date(ts * 1000)
      const pad = (x) => String(x).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    // Write text to the clipboard. Prefers the async Clipboard API (works on
    // http://127.0.0.1 secure contexts) and falls back to the legacy
    // execCommand('copy') path, mirroring primitives' writeClipboard semantics.
    function copyToClipboard(text) {
      if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text).then(() => true).catch(() => false)
      }
      try {
        const ta = document.createElement('textarea')
        ta.value = String(text)
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        const ok = document.execCommand('copy')
        ta.remove()
        return Promise.resolve(ok)
      } catch (e) {
        return Promise.resolve(false)
      }
    }

    let SESSIONS = null // optional sessions service, tracked by ctx.inject in apply()

    /** Best-effort current workspace dir (the isolation unit for the "current
     *  machine"): the selected session's cwd. Empty when unknown — the
     *  settings page then refuses workspace-scoped actions. */
    function scopeCwdGuess() {
      try {
        const list = SESSIONS && SESSIONS.list && typeof SESSIONS.list.getSnapshot === 'function'
          ? SESSIONS.list.getSnapshot()
          : null
        const entry = list && list.current ? (list.byId && list.byId[list.current]) : null
        if (entry && entry.cwd) return String(entry.cwd)
      } catch { /* sessions store shape differs */ }
      return ''
    }

    // ── Settings → 远程工作区 (machine registry + forwards + audit) ──────────
    function RemoteWorkspacePage() {
      const [machines, setMachines] = React.useState([])
      const [currentId, setCurrentId] = React.useState('')
      const [form, setForm] = React.useState({
        name: '', host: '', port: '22', username: 'root', password: '', privateKeyPath: '',
        passphrase: '', workspace: '', hostKeyMode: '', useAgent: false, keyboardInteractive: false,
        encryptPassword: false, proxyHost: '', proxyPort: '22', proxyUser: '', proxyPassword: '', proxyKey: '', id: '',
        // Issue #38: alias mode — `host` is a ~/.ssh/config Host name and the
        // resolved values are never copied into the registry.
        useSshConfig: false,
      })
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const [err, setErr] = React.useState('')
      const [tst, setTst] = React.useState('') // idle | testing | ok | failing
      const [forwards, setForwards] = React.useState([])
      const [fwdForm, setFwdForm] = React.useState({ listenPort: '', targetHost: '127.0.0.1', targetPort: '', direction: 'local', autoStart: false })
      const [auditLines, setAuditLines] = React.useState([])
      const [terminalStatus, setTerminalStatus] = React.useState(null)
      const [sshEntries, setSshEntries] = React.useState(null)
      const [workspaces, setWorkspaces] = React.useState([])
      const [advOpen, setAdvOpen] = React.useState(false) // 高级配置折叠
const [fwdOpen, setFwdOpen] = React.useState(true)
      const [auditOpen, setAuditOpen] = React.useState(false)
      React.useEffect(() => { ensureChromeCss() }, [])
      // Per-workspace isolation: "设为当前/清除/切远程目录" act on ONE local
      // workspace (scopeDir). No app-wide current exists anymore.
      const [scopeDir, setScopeDir] = React.useState('')
      const [scopeStatus, setScopeStatus] = React.useState(null) // /status?cwd= of the scope

      const testConn = () => {
        if (!form.host.trim() || tst === 'testing') return
        setTst('testing'); setErr(''); setMsg('')
        api('POST', '/dsh-remote/test-connect', {
          host: form.host, port: Number(form.port) || 22, username: form.username || 'root',
          password: form.password, privateKeyPath: form.privateKeyPath, passphrase: form.passphrase,
          useSshConfig: !!form.useSshConfig,
          proxy: form.proxyHost ? { host: form.proxyHost, port: Number(form.proxyPort) || 22, username: form.proxyUser || '', password: form.proxyPassword || '', privateKeyPath: form.proxyKey || '' } : undefined,
        })
          .then((r) => {
            if (r && r.ok) {
              const shellTag = r.platform === 'windows' ? (r.gitBash ? tr('settings.shellWin') : tr('settings.shellWinNoGit')) : (r.platform === 'posix' ? tr('settings.shellPosix') : '')
              setTst('ok'); setMsg(r.latencyMs != null ? tr('settings.connOkWith', { user: r.user, host: r.host, latency: r.latencyMs, shell: shellTag }) : tr('settings.connOk'))
              // Issue #38: show where an alias resolved to (and what could not
              // be honoured), instead of leaving the user guessing.
              if (r.alias) {
                setMsg((m) => m + ' ' + tr('settings.sshResolvedTo', { user: r.alias.user || '?', host: r.alias.host, port: r.alias.port }))
                if (r.alias.warnings && r.alias.warnings.length) setErr(tr('settings.sshResolvedWarn', { msg: r.alias.warnings.join(' ') }))
              }
              refresh()
            }
            else { setTst('failing'); setErr((r && r.error) || tr('settings.connFail')) }
          })
          .catch((e) => { setTst('failing'); setErr(String((e && e.message) || e)) })
      }

      const refresh = (dirArg) => {
        const dir = dirArg !== undefined && dirArg !== null ? dirArg : scopeDir
        if (!dir) { setScopeStatus(null); setCurrentId(''); setWorkspaces([]); return Promise.resolve() }
        return Promise.all([
          api('GET', '/dsh-remote/machines'),
          api('GET', '/dsh-remote/status?cwd=' + encodeURIComponent(dir)).catch(() => null),
        ]).then(([r, s]) => {
          if (scopeCwdGuess() !== dir) return
          setMachines(r.machines || [])
          setScopeStatus(s)
          const curId = (s && s.currentId) || ''
          setCurrentId(curId)
          const cur = (r.machines || []).find((m) => m.id === curId)
          setWorkspaces((cur && cur.recentWorkspaces) || [])
        })
      }
      React.useEffect(() => {
        const s = scopeCwdGuess()
        setScopeDir(s)
        // eslint-disable-next-line react-hooks/exhaustive-deps
        refresh(s || '')
        const feed = SESSIONS && SESSIONS.list
        return feed && typeof feed.subscribe === 'function' ? feed.subscribe(() => setScopeDir(scopeCwdGuess())) : undefined
      }, [scopeDir])

      // ── update state ────────────────────────────────────────────────────────
      const [upd, setUpd] = React.useState(null) // { current, latest, updateAvailable, updateMode, updatedMarker }
      const [updBusy, setUpdBusy] = React.useState(false)
      const [updMsg, setUpdMsg] = React.useState('')
      const [updMode, setUpdMode] = React.useState('manual')
      const checkUpdate = (quiet) => {
        if (updBusy) return
        setUpdBusy(true); setUpdMsg('')
        api('GET', '/dsh-remote/update-check')
          .then((r) => {
            if (!r || !r.ok) { setUpdMsg((r && r.error) || tr('settings.updateFail')); return }
            setUpd(r)
            if (r.updateMode) setUpdMode(r.updateMode)
            if (!quiet) setUpdMsg(r.updateAvailable ? tr('settings.updateAvailable', { version: r.latest }) : tr('settings.updateLatest', { version: r.current }))
          })
          .catch((e) => setUpdMsg(String((e && e.message) || e)))
          .finally(() => setUpdBusy(false))
      }
      const applyUpdateNow = () => {
        if (!upd || !upd.latest) return
        if (!window.confirm(tr('settings.updateConfirm', { version: upd.latest }))) return
        setUpdBusy(true); setUpdMsg('')
        api('POST', '/dsh-remote/update-apply', { version: upd.latest })
          .then((r) => {
            if (r && r.ok) setUpdMsg(tr('settings.updateApplied', { to: r.to, from: (r.from || '') }))
            else setUpdMsg((r && r.error) || tr('settings.updateFailed'))
            checkUpdate(true)
          })
          .catch((e) => setUpdMsg(tr('settings.updateFailedMsg', { msg: String((e && e.message) || e) })))
          .finally(() => setUpdBusy(false))
      }
      const saveUpdateMode = (mode) => {
        setUpdMode(mode); setUpdMsg(tr('settings.updateModeSet', { mode: mode === 'auto' ? tr('settings.modeAuto') : mode === 'off' ? tr('settings.modeOff') : tr('settings.modeManual') }))
        api('POST', '/dsh-remote/update-mode', { mode }).catch((e) => setUpdMsg(tr('settings.updateModeSaveFail', { msg: String((e && e.message) || e) })))
      }
      React.useEffect(() => { checkUpdate(true) }, [])

      const refreshForwards = () => api('GET', '/dsh-remote/forwards').then((r) => setForwards(r.forwards || [])).catch(() => {})
      React.useEffect(() => { refreshForwards(); api('GET', '/dsh-remote/audit?limit=30').then((r) => setAuditLines(r.lines || [])).catch(() => {}) }, [])
      React.useEffect(() => { api('GET', '/dsh-remote/terminal/status').then((r) => setTerminalStatus(r || { enabled: false, sessions: [] })).catch(() => setTerminalStatus({ enabled: false, sessions: [] })) }, [])

      const setF = (k) => (ev) => setForm({ ...form, [k]: ev.target.value })
      const setFb = (k) => (ev) => setForm({ ...form, [k]: ev.target.checked })
      const startEdit = (m) => {
        setForm({
          name: m.name, host: m.host, port: String(m.port || 22), username: m.username || 'root',
          password: '', privateKeyPath: m.privateKeyPath || '', passphrase: '', workspace: m.workspace || '',
          hostKeyMode: m.hostKeyMode || '', useAgent: !!m.useAgent, keyboardInteractive: !!m.keyboardInteractive,
          encryptPassword: !!(m.credentialBackend && m.credentialBackend !== 'plain'),
          proxyHost: (m.proxy && m.proxy.host) || '', proxyPort: String((m.proxy && m.proxy.port) || 22),
          proxyUser: (m.proxy && m.proxy.username) || '', proxyPassword: '', proxyKey: (m.proxy && m.proxy.privateKeyPath) || '',
          id: m.id,
          useSshConfig: !!m.useSshConfig,
        })
        // 编辑时若该机器用了高级配置(私钥/agent/跳板/钥匙串等),自动展开折叠区
        if (m.privateKeyPath || m.useAgent || m.keyboardInteractive || m.workspace || (m.proxy && m.proxy.host) || (m.credentialBackend && m.credentialBackend !== 'plain')) {
          setAdvOpen(true)
        }
      }
      const clearForm = () => setForm({ name: '', host: '', port: '22', username: 'root', password: '', privateKeyPath: '', passphrase: '', workspace: '', hostKeyMode: '', useAgent: false, keyboardInteractive: false, encryptPassword: false, proxyHost: '', proxyPort: '22', proxyUser: '', proxyPassword: '', proxyKey: '', id: '', useSshConfig: false })
      const save = (action) => {
        setBusy(true); setErr(''); setMsg('')
        if (action === 'delete') {
          api('POST', '/dsh-remote/machines', { action: 'delete', id: form.id }).then(refresh).then(() => { clearForm(); setMsg(tr('settings.deleted')) }).catch((e) => setErr(String((e && e.message) || e))).finally(() => setBusy(false))
          return
        }
        api('POST', '/dsh-remote/machines', {
          action: form.id ? 'update' : 'add', id: form.id || undefined, name: form.name, host: form.host, port: Number(form.port) || 22,
          username: form.username, password: form.password, privateKeyPath: form.privateKeyPath, passphrase: form.passphrase,
          workspace: form.workspace, hostKeyMode: form.hostKeyMode, useAgent: form.useAgent, keyboardInteractive: form.keyboardInteractive,
          encryptPassword: form.encryptPassword, useSshConfig: !!form.useSshConfig,
          proxy: form.proxyHost ? { host: form.proxyHost, port: Number(form.proxyPort) || 22, username: form.proxyUser || '', password: form.proxyPassword || '', privateKeyPath: form.proxyKey || '' } : undefined,
        }).then((r) => {
          refresh(); clearForm()
          // Issue #30: "加密保存密码"失败时服务端回退明文并带警告 —— 不能再静默
          // 保存一台没有凭据的机器（那会让之后每次连接都失败且没有原因）。
          if (r && r.warning === 'secret-store-failed') setErr(tr('settings.secretStoreFailed', { msg: r.warningDetail || 'unknown' }))
          else setMsg(form.id ? tr('settings.saved') : tr('settings.added'))
        }).catch((e) => setErr(String((e && e.message) || e))).finally(() => setBusy(false))
      }
      const useNow = (id) => {
        if (!scopeDir) { setErr(tr('settings.noScope')); return }
        setBusy(true)
        api('POST', '/dsh-remote/current', { id, workspace: scopeDir }).then((r) => { setCurrentId(r.currentId); setMsg(tr('settings.switchedScope', { dir: scopeDir })) }).catch((e) => setErr(String((e && e.message) || e))).finally(() => setBusy(false))
      }
      // Per-workspace isolation: "active remote = none" applies to ONE
      // workspace — saved machines stay, but no machine is current THERE, so
      // that workspace's sessions are never dragged into a remote context.
      const clearCurrent = () => {
        if (!scopeDir) { setErr(tr('settings.noScope')); return }
        setBusy(true)
        api('POST', '/dsh-remote/current', { id: '', workspace: scopeDir }).then((r) => { setCurrentId(''); setMsg(tr('settings.clearedScope', { dir: scopeDir })) }).catch((e) => setErr(String((e && e.message) || e))).finally(() => setBusy(false))
      }
      const del = (id) => { if (window.confirm(tr('settings.deleteConfirm'))) { api('POST', '/dsh-remote/machines', { action: 'delete', id }).then(refresh).then(() => setMsg(tr('settings.deleted'))).catch((e) => setErr(String((e && e.message) || e))) } }

      const importSsh = () => {
        api('GET', '/dsh-remote/ssh-config').then((r) => setSshEntries(r && r.present ? (r.entries || []) : []))
          .catch((e) => setErr(tr('settings.sshReadFail', { msg: String((e && e.message) || e) })))
      }
      // Issue #38, primary action: save the machine as an ALIAS. Nothing from
      // ~/.ssh/config is copied into the registry — the host/user/port/key/jump
      // host are re-read at every connect, so editing that file is enough.
      const useSshAlias = (e) => {
        setForm({
          ...form,
          name: e.host, host: e.host, port: '22', username: 'root',
          privateKeyPath: '', passphrase: '', useSshConfig: true,
        })
        setSshEntries(null)
        setMsg(tr('settings.sshAliasHint', { alias: e.host }))
      }
      // Legacy/escape hatch: materialise the current values as a normal machine
      // (for users who want to override them individually).
      const applySshEntry = (e) => {
        setForm({
          ...form,
          name: e.host, host: e.hostName || e.host, port: String(e.port || 22),
          username: e.user || 'root', privateKeyPath: e.identityFile || '', useSshConfig: false,
        })
        setSshEntries(null)
        setMsg(tr('settings.filledSsh'))
      }

      const setWorkspaceNow = (p) => {
        api('POST', '/dsh-remote/workspace', { path: p, workspace: scopeDir })
          .then(() => { setMsg(tr('settings.workspaceSwitched', { path: p })); refresh() })
          .catch((e) => setErr(String((e && e.message) || e)))
      }

      // ── forwards panel ────────────────────────────────────────────────────
      const fwdAction = (action, id) => {
        api('POST', '/dsh-remote/forwards', { action, id })
          .then((r) => { setForwards(r.forwards || []); setErr(''); setMsg('') })
          .catch((e) => setErr(String((e && e.message) || e)))
      }
      const fwdDefine = () => {
        if (!fwdForm.listenPort) return
        api('POST', '/dsh-remote/forwards', { action: 'define', listenPort: Number(fwdForm.listenPort), targetHost: fwdForm.targetHost || '127.0.0.1', targetPort: Number(fwdForm.targetPort) || Number(fwdForm.listenPort), direction: fwdForm.direction, autoStart: fwdForm.autoStart })
          .then((r) => { setForwards(r.forwards || []); setFwdForm({ listenPort: '', targetHost: '127.0.0.1', targetPort: '', direction: 'local', autoStart: false }) })
          .catch((e) => setErr(String((e && e.message) || e)))
      }

      const row = (label, ctrl, k) => React.createElement('div', { key: k, style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 } },
        React.createElement('label', { style: { width: LABEL_W, fontSize: 12, opacity: 0.8, flexShrink: 0 } }, label), ctrl)
      const pill = (cls, text) => React.createElement('span', { className: 'dsh-rw-pill' + (cls ? ' ' + cls : ''), style: { marginLeft: 4 } }, text)
      const sectionToggle = (open, setOpen, title, extra) => React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: open ? 8 : 0 } },
        React.createElement('button', {
          type: 'button', className: 'dsh-rw-section-btn',
          title: open ? tr('settings.sectionHide') : tr('settings.sectionShow'),
          onClick: () => setOpen(!open),
          style: { fontSize: 13, fontWeight: 600 },
        }, React.createElement('span', { style: { opacity: 0.7, width: 12 } }, open ? '▾' : '▸'), title),
        extra || null,
      )

      return React.createElement('div', { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 860 } },
        React.createElement('div', { style: { fontSize: 16, fontWeight: 650, letterSpacing: '-0.01em' } }, tr('settings.title')),
        React.createElement('div', { style: { fontSize: 12, opacity: 0.8, lineHeight: 1.55 } },
          tr('settings.intro')),
        React.createElement('div', { style: boxS },
          React.createElement('div', { style: { marginBottom: 8, fontSize: 13, fontWeight: 600 } }, tr('settings.machines')),
          machines.length
? machines.map((m) => React.createElement('div', { key: m.id, className: 'dsh-rw-row', style: { display: 'flex', gap: 8, alignItems: 'center', paddingTop: 8, paddingBottom: 8, borderBottom: '1px solid ' + T.border, flexWrap: 'wrap' } },
                React.createElement('div', { style: { flex: 1, fontSize: 13, minWidth: 180 } },
                  React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                    React.createElement('span', { style: { fontWeight: 600 } }, m.name),
                    React.createElement('code', { style: { fontSize: 12, opacity: 0.8 } },
                      m.useSshConfig ? (m.host + (m.sshConfigResolved && m.sshConfigResolved.matched ? '  ' + tr('settings.sshResolvedTo', { user: m.sshConfigResolved.username || '?', host: m.sshConfigResolved.host, port: m.sshConfigResolved.port }) : ''))
                        : (m.username + '@' + m.host + ':' + m.port)),
                    m.useSshConfig ? pill('', tr('settings.badgeSshConfig')) : null,
                    m.id === currentId ? pill('is-ok', tr('settings.current')) : null,
                    m.passwordSet ? pill('', tr('settings.badgePwd')) : null,
                    (m.credentialBackend && m.credentialBackend !== 'plain') ? pill('', tr('settings.badgeKeychain')) : null,
                    m.proxy && m.proxy.host ? pill('', tr('settings.badgeProxy')) : null,
                    m.latencyMs != null ? React.createElement('span', { style: { fontSize: 11, opacity: 0.6 } }, m.latencyMs + 'ms') : null,
                  ),
                  // Issue #38: an alias that no longer resolves (or a ProxyJump
                  // the plugin had to trim) must be visible, not silent.
                  (m.sshConfigResolved && m.sshConfigResolved.warnings && m.sshConfigResolved.warnings.length)
                    ? React.createElement('div', { style: { fontSize: 11, color: T.warn, marginTop: 2 } }, tr('settings.sshResolvedWarn', { msg: m.sshConfigResolved.warnings.join(' ') }))
                    : null),
                React.createElement('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
                  React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, onClick: () => startEdit(m) }, tr('settings.edit')),
                  React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, onClick: () => del(m.id) }, tr('settings.delete')),
                  React.createElement('button', { type: 'button', className: 'dsh-rw-btn' + (m.id === currentId ? '' : ' dsh-rw-primary'), style: { ...(m.id === currentId ? buttonS : primaryBtnS), padding: '6px 10px', whiteSpace: 'nowrap' }, onClick: () => useNow(m.id), disabled: !scopeDir || m.id === currentId }, tr('settings.setCurrent')))))
            : React.createElement('div', { style: { opacity: 0.6, fontSize: 12 } }, tr('settings.noMachines')),
          React.createElement('div', { style: { paddingTop: 6, fontSize: 12, opacity: 0.7, wordBreak: 'break-all' } },
            scopeDir
              ? React.createElement('span', null,
                  tr('settings.scopeBar', { dir: scopeDir }) +
                  (scopeStatus && scopeStatus.sessionRemotePath ? ' · ' + tr('settings.remotePath', { path: scopeStatus.sessionRemotePath }) : ''))
              : tr('settings.noScope')),
          currentId
            ? React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', paddingTop: 10, fontSize: 12, color: T.ok } },
                tr('settings.currentMachine', { name: ((machines.find((m) => m.id === currentId) || {}).name || currentId) }),
                React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 8px', fontSize: 12, marginLeft: 'auto' }, onClick: clearCurrent }, tr('settings.clearCurrent')))
            : React.createElement('div', { style: { paddingTop: 10, fontSize: 12, opacity: 0.6 } }, tr('settings.noActive')),
          ),
        React.createElement('div', { style: boxS },
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
            React.createElement('div', { style: { fontSize: 13, fontWeight: 600 } }, form.id ? tr('settings.editMachine') : tr('settings.addMachine')),
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, fontSize: 12, padding: '3px 8px' }, onClick: () => (sshEntries ? setSshEntries(null) : importSsh()) }, sshEntries ? tr('settings.sshCollapse') : tr('settings.sshImport'))),
          sshEntries ? React.createElement('div', { style: { marginBottom: 8, maxHeight: 200, overflowY: 'auto', border: '1px solid ' + T.border, borderRadius: T.radius } },
            sshEntries.length ? sshEntries.map((e) => React.createElement('div', { key: e.host, className: 'dsh-rw-list-item', style: { padding: '6px 10px', fontSize: 12, borderBottom: '1px solid ' + T.border, display: 'flex', gap: 8, alignItems: 'center' } },
              React.createElement('div', { onClick: () => useSshAlias(e), style: { flex: 1, cursor: 'pointer' }, title: tr('settings.sshUseAlias') },
                e.host + '  →  ' + (e.hostName || '?') + (e.user ? '  (' + e.user + ')' : '') + (e.identityFile ? '  [key]' : '') + (e.proxyJump ? '  ⛳' : '')),
              React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, fontSize: 11, padding: '2px 8px', whiteSpace: 'nowrap' }, onClick: () => useSshAlias(e) }, tr('settings.sshUseAlias')),
              React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, fontSize: 11, padding: '2px 8px', whiteSpace: 'nowrap', opacity: 0.8 }, onClick: () => applySshEntry(e) }, tr('settings.sshCopyFields'))))
              : React.createElement('div', { style: { padding: 8, fontSize: 12, opacity: 0.6 } }, tr('settings.sshNoEntries')))
          : null,
          row(tr('settings.name'), React.createElement('input', { className: 'dsh-rw-input', value: form.name, onChange: setF('name'), placeholder: tr('settings.name') + ' (e.g. build-server)', style: inputS }), 'n'),
          row(tr('settings.host'), React.createElement('input', { className: 'dsh-rw-input', value: form.host, onChange: setF('host'), placeholder: form.useSshConfig ? tr('settings.sshImport') + ' Host 别名' : 'IP or hostname', style: inputS }), 'h'),
          row(tr('settings.useSshConfig'), React.createElement('input', { type: 'checkbox', checked: !!form.useSshConfig, onChange: setFb('useSshConfig') }), 'sshc'),
          form.useSshConfig ? React.createElement('div', { style: { fontSize: 11, opacity: 0.8, marginBottom: 8, lineHeight: 1.5 } }, tr('settings.useSshConfigHint')) : null,
          form.useSshConfig ? (() => {
            // Preview where the alias points, from the same resolution the
            // connect path uses (the host list carries it — issue #38).
            const preview = machines.find((m) => m.host === form.host && m.useSshConfig)
            const res = preview && preview.sshConfigResolved
            if (!res) return null
            return React.createElement('div', { style: { fontSize: 11, marginBottom: 8, color: res.matched ? T.ok : T.warn, lineHeight: 1.5 } },
              res.matched
                ? form.host + ' ' + tr('settings.sshResolvedTo', { user: res.username || '?', host: res.host, port: res.port })
                : tr('settings.sshResolvedNone', { alias: form.host }),
              (res.warnings && res.warnings.length) ? React.createElement('div', { style: { opacity: 0.85 } }, tr('settings.sshResolvedWarn', { msg: res.warnings.join(' ') })) : null)
          })() : null,
          row(tr('settings.port'), React.createElement('input', { className: 'dsh-rw-input', value: form.port, onChange: setF('port'), placeholder: '22', style: { ...inputS, width: 70 } }), 'p'),
          row(tr('settings.user'), React.createElement('input', { className: 'dsh-rw-input', value: form.username, onChange: setF('username'), placeholder: 'root', style: inputS }), 'u'),
          row(tr('settings.password'), React.createElement('input', { className: 'dsh-rw-input', type: 'password', value: form.password, onChange: setF('password'), placeholder: 'SSH password (hidden)', style: inputS }), 'w'),
          // 高级配置折叠开关
          React.createElement('button', {
            type: 'button',
            className: 'dsh-rw-btn',
            onClick: () => setAdvOpen(!advOpen),
            style: { ...buttonS, width: '100%', marginBottom: advOpen ? 10 : 0, color: advOpen ? T.primary : 'inherit', fontWeight: advOpen ? 600 : 400, borderStyle: 'dashed' },
          }, advOpen ? tr('settings.advCollapse') : tr('settings.advExpand')),
          advOpen ? React.createElement('div', { key: 'adv', style: { paddingTop: 2 } },
            row(tr('settings.privateKey'), React.createElement('input', { value: form.privateKeyPath, onChange: setF('privateKeyPath'), placeholder: 'Empty = password or agent', style: inputS }), 'k'),
            row(tr('settings.passphrase'), React.createElement('input', { type: 'password', value: form.passphrase, onChange: setF('passphrase'), placeholder: 'Encrypted private key passphrase', style: inputS }), 'pp'),
            row(tr('settings.workspace'), React.createElement('input', { value: form.workspace, onChange: setF('workspace'), placeholder: 'Optional: default remote dir for this machine', style: inputS }), 'ws'),
            row(tr('settings.hostKeyMode'), React.createElement('select', { value: form.hostKeyMode, onChange: setF('hostKeyMode'), style: { ...inputS, maxWidth: 220 } },
              React.createElement('option', { value: '' }, tr('settings.hkDefault')),
              React.createElement('option', { value: 'accept-new' }, tr('settings.hkAccept')),
              React.createElement('option', { value: 'verify' }, tr('settings.hkVerify')),
              React.createElement('option', { value: 'off' }, tr('settings.hkOff'))), 'hkm'),
            React.createElement('div', { style: { display: 'flex', gap: 16, paddingLeft: LABEL_W + 8, flexWrap: 'wrap', marginBottom: 8 } },
              React.createElement('label', { style: { fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' } },
                React.createElement('input', { type: 'checkbox', checked: form.useAgent, onChange: setFb('useAgent') }), tr('settings.agent')),
              React.createElement('label', { style: { fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' } },
                React.createElement('input', { type: 'checkbox', checked: form.keyboardInteractive, onChange: setFb('keyboardInteractive') }), tr('settings.keyboardInteractive')),
              React.createElement('label', { style: { fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' } },
                React.createElement('input', { type: 'checkbox', checked: form.encryptPassword, onChange: setFb('encryptPassword') }), tr('settings.encryptPassword'))),
            row(tr('settings.proxyHost'), React.createElement('input', { value: form.proxyHost, onChange: setF('proxyHost'), placeholder: 'Route through this host (optional)', style: inputS }), 'ph'),
            row(tr('settings.proxyPortUser'), React.createElement('div', { style: { display: 'flex', gap: 6, flex: 1, flexWrap: 'wrap' } },
              React.createElement('input', { value: form.proxyPort, onChange: setF('proxyPort'), placeholder: 'Port (22)', style: { ...inputS, minWidth: 90, maxWidth: 120 } }),
              React.createElement('input', { value: form.proxyUser, onChange: setF('proxyUser'), placeholder: 'Jump user', style: { ...inputS, minWidth: 140 } }),
              React.createElement('input', { type: 'password', value: form.proxyPassword, onChange: setF('proxyPassword'), placeholder: 'Jump password', style: { ...inputS, minWidth: 140 } })), 'pu'),
            row(tr('settings.proxyKey'), React.createElement('input', { value: form.proxyKey, onChange: setF('proxyKey'), placeholder: 'Jump private key path (optional)', style: inputS }), 'pk'),
          ) : null,
          React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap', marginTop: 8 } },
            msg ? React.createElement('span', { style: { color: T.ok, fontSize: 12, marginRight: 'auto' } }, msg) : null,
            form.id ? React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, onClick: () => save('delete') }, tr('settings.delete')) : null,
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, onClick: () => { clearForm(); setErr(''); setTst('idle'); setAdvOpen(false) } }, form.id ? tr('settings.cancelEdit') : tr('settings.clear')),
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, fontFamily: 'monospace', whiteSpace: 'nowrap' }, onClick: testConn, disabled: busy || !form.host.trim() || tst === 'testing' },
              tst === 'testing' ? tr('settings.testing') : tst === 'ok' ? tr('settings.testOk') : tr('settings.testConn')),
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: primaryBtnS, onClick: () => save(form.id ? 'update' : 'add'), disabled: busy || !form.host.trim() }, busy ? tr('settings.saving') : tr('settings.save')),
          ),
        ),
        // 快捷切换工作区（该机器的最近工作区）
        workspaces.length ? React.createElement('div', { style: boxS },
          React.createElement('div', { style: { marginBottom: 6, fontSize: 13, fontWeight: 600 } }, tr('settings.recentWorkspaces')),
          workspaces.map((w, i) => React.createElement('div', { key: w + i, style: { display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' } },
            React.createElement('code', { style: { flex: 1, fontSize: 12, fontFamily: 'monospace' } }, w),
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 10px' }, onClick: () => setWorkspaceNow(w) }, tr('settings.switch'))))) : null,
        // 端口转发面板
        React.createElement('div', { style: boxS },
          sectionToggle(fwdOpen, setFwdOpen, tr('settings.forwards')),
          fwdOpen ? React.createElement(React.Fragment, null,
            forwards.length ? forwards.map((f) => React.createElement('div', { key: f.id, className: 'dsh-rw-row', style: { display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', fontSize: 12, fontFamily: 'monospace' } },
              React.createElement('span', { style: { color: f.active ? T.ok : T.muted } }, f.active ? '●' : '○'),
              React.createElement('span', { style: { flex: 1 } }, `${f.direction} 127.0.0.1:${f.listenPort} → ${f.targetHost}:${f.targetPort}${f.autoStart ? ' [auto]' : ''}`),
              f.active
                ? React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 8px' }, onClick: () => fwdAction('stop', f.id) }, tr('settings.fwdStop'))
                : React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 8px' }, onClick: () => fwdAction('start', f.id) }, tr('settings.fwdStart')),
              React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 8px' }, onClick: () => fwdAction('remove', f.id) }, tr('settings.fwdRemove')))) : null,
            React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' } },
              React.createElement('select', { className: 'dsh-rw-input', value: fwdForm.direction, onChange: (e) => setFwdForm({ ...fwdForm, direction: e.target.value }), style: { ...inputS, maxWidth: 110 } },
                React.createElement('option', { value: 'local' }, tr('settings.fwdDirLocal')),
                React.createElement('option', { value: 'reverse' }, tr('settings.fwdDirReverse'))),
              React.createElement('input', { className: 'dsh-rw-input', value: fwdForm.listenPort, onChange: (e) => setFwdForm({ ...fwdForm, listenPort: e.target.value }), placeholder: tr('settings.fwdListen'), style: { ...inputS, maxWidth: 90 } }),
              React.createElement('input', { className: 'dsh-rw-input', value: fwdForm.targetHost, onChange: (e) => setFwdForm({ ...fwdForm, targetHost: e.target.value }), placeholder: tr('settings.fwdTargetHost'), style: { ...inputS, maxWidth: 120 } }),
              React.createElement('input', { className: 'dsh-rw-input', value: fwdForm.targetPort, onChange: (e) => setFwdForm({ ...fwdForm, targetPort: e.target.value }), placeholder: tr('settings.fwdTargetPort'), style: { ...inputS, maxWidth: 90 } }),
              React.createElement('label', { style: { fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' } },
                React.createElement('input', { type: 'checkbox', checked: fwdForm.autoStart, onChange: (e) => setFwdForm({ ...fwdForm, autoStart: e.target.checked }) }), tr('settings.fwdAuto')),
              React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: primaryBtnS, onClick: fwdDefine, disabled: !fwdForm.listenPort }, tr('settings.fwdAdd'))),
          ) : null,
        ),
        // 远程终端（交互式 SSH shell）
        React.createElement('div', { style: boxS },
          React.createElement('div', { style: { marginBottom: 6, fontSize: 13, fontWeight: 600 } }, '🖥 ' + tr('settings.terminal')),
          React.createElement('div', { style: { fontSize: 12, lineHeight: 1.7, opacity: 0.85 } },
            tr('settings.terminalHint'),
            React.createElement('div', { style: { marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 } },
              terminalStatus === null
                ? React.createElement('span', { style: { opacity: 0.6 } }, tr('settings.terminalLoading'))
                : React.createElement('span', null,
                    terminalStatus.enabled
                      ? tr('settings.terminalSessions', { n: (terminalStatus.sessions || []).length, max: terminalStatus.maxSessions })
                      : tr('settings.terminalNeedsSidebar')),
            ),
            (terminalStatus && terminalStatus.sessions && terminalStatus.sessions.length)
              ? React.createElement('div', { style: { marginTop: 6, fontSize: 11, fontFamily: 'monospace', lineHeight: 1.6 } },
                  terminalStatus.sessions.map((s, i) => React.createElement('div', { key: i, style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                    `${s.alive ? '●' : '○'} ${s.machine} ${s.cwd ? '· ' + s.cwd : ''}${s.parked ? ' [parked]' : ''}`)))
              : null,
          ),
        ),
        // 审计日志
        React.createElement('div', { style: boxS },
          sectionToggle(auditOpen, setAuditOpen, tr('settings.audit'),
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 8px', fontSize: 12, marginLeft: 'auto' }, onClick: (e) => { e.stopPropagation(); api('GET', '/dsh-remote/audit?limit=30').then((r) => setAuditLines(r.lines || [])).catch(() => {}) } }, tr('settings.auditRefresh'))),
          auditOpen
            ? (auditLines.length
              ? React.createElement('div', { style: { maxHeight: 180, overflowY: 'auto', fontSize: 11, fontFamily: 'monospace', lineHeight: 1.6 } },
                  auditLines.map((l, i) => React.createElement('div', { key: i, style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, l)))
              : React.createElement('div', { style: { opacity: 0.6, fontSize: 12 } }, tr('settings.auditEmpty')))
            : React.createElement('div', { style: { fontSize: 11, opacity: 0.55 } }, String(auditLines.length)),
        ),
        err ? React.createElement('div', { style: { color: T.danger, fontSize: 13 } }, err) : null,
        React.createElement('div', { style: boxS },
          React.createElement('div', { style: { marginBottom: 6, fontSize: 13, fontWeight: 600 } }, tr('settings.update')),
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 } },
            upd
              ? React.createElement('span', { style: { opacity: 0.85 } },
                  'v' + upd.current,
                  upd.updateAvailable ? React.createElement('b', { style: { color: T.ok, marginLeft: 6 } }, '→ v' + upd.latest) : null)
              : React.createElement('span', { style: { opacity: 0.6 } }, tr('settings.updateChecking')),
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 10px' }, onClick: () => checkUpdate(false), disabled: updBusy }, updBusy ? tr('settings.checking') : tr('settings.checkUpdate')),
            upd && upd.updateAvailable
              ? React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: { ...primaryBtnS, padding: '2px 10px' }, onClick: applyUpdateNow, disabled: updBusy }, tr('settings.updateNow'))
              : null,
          ),
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, fontSize: 12 } },
            React.createElement('span', { style: { opacity: 0.8 } }, tr('settings.updateMode')),
            ['manual', 'auto', 'off'].map((m) =>
              React.createElement('button', {
                key: m, style: { ...buttonS, padding: '2px 10px', fontWeight: updMode === m ? 700 : 400, color: updMode === m ? T.ok : 'inherit' },
                onClick: () => saveUpdateMode(m), disabled: updBusy,
              }, m === 'manual' ? tr('settings.modeManual') : m === 'auto' ? tr('settings.modeAuto') : tr('settings.modeOff')),
            ),
          ),
          updMsg ? React.createElement('div', { style: { marginTop: 6, fontSize: 12, color: updMsg.startsWith('✅') ? T.ok : 'inherit', opacity: 0.9 } }, updMsg) : null,
        ),
        React.createElement('div', { style: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 11, opacity: 0.65, borderTop: '1px solid ' + T.border, paddingTop: 10, marginTop: 4 } },
          React.createElement('span', {}, tr('settings.like')),
          React.createElement('a', { href: 'https://github.com/flymysql/dsh-remote', target: '_blank', rel: 'noopener noreferrer', style: { color: 'inherit' } }, tr('settings.star')),
          React.createElement('span', {}, '·'),
          React.createElement('a', { href: 'https://github.com/flymysql/dsh-remote/issues/new', target: '_blank', rel: 'noopener noreferrer', style: { color: 'inherit' } }, tr('settings.feedback')),
          React.createElement('span', { style: { marginLeft: 'auto', opacity: 0.5 } }, 'dsh-remote v' + (upd && upd.current ? upd.current : '?.?.?')),
        ),
      )
    }

    // ── Unified picker (fill the directory-flow holes) ───────────────────
    function parseLs(text) {
      const out = []
      for (const ln of String(text || '').split('\n')) {
        const t = ln.trim()
        if (!t || !t.length || /^total\b/i.test(t)) continue
        const parts = t.split(/\s+/).filter(Boolean)
        if (parts.length < 8) continue
        const mode = parts[0]
        const name = parts.slice(8).join(' ')
        if (!name || name === '.' || name === '..') continue
        const isDir = mode.charAt(0) === 'd'
        out.push({ name, dir: isDir })
      }
      return out
    }

    // Clickable breadcrumb of the current remote path. Windows remotes show a
    // "This PC" root and `\` separators (此电脑 / C:\ / Users / dev); POSIX `/`.
    function breadcrumb(active, cur, win, jumpTo) {
      const raw = String(cur || '')
      const isWinPath = win && (raw === '' || /^[a-zA-Z]:/.test(raw))
      const rootLabel = isWinPath ? tr('picker.thisPc') : '/'
      const crumbs = []
      const crumbStyle = (isLast, clickable) => ({
        color: !clickable ? T.dimmed : (isLast ? T.label : T.label3),
        fontWeight: isLast ? 600 : 400,
        whiteSpace: 'nowrap',
        cursor: clickable ? 'pointer' : 'default',
      })
      crumbs.push(React.createElement('button', { key: 'root', type: 'button', className: 'drp-crumb', style: crumbStyle(raw === '', active), onClick: active ? () => jumpTo('') : undefined, disabled: !active }, rootLabel))
      if (isWinPath && raw !== '') {
        const driveM = raw.match(/^([a-zA-Z]):(.*)$/)
        const drive = driveM[1].toUpperCase() + ':\\'
        crumbs.push(React.createElement('span', { key: 'sep0', style: { color: T.label3, flex: 'none' } }, '\\'))
        crumbs.push(React.createElement('button', { key: 'drive', type: 'button', className: 'drp-crumb', style: crumbStyle(raw === drive, active), onClick: active ? () => jumpTo(drive) : undefined, disabled: !active }, drive))
        let acc = drive
        for (const s of (driveM[2] || '').split('\\')) {
          if (!s) continue
          acc += s + '\\'
          const target = acc.slice(0, -1)
          crumbs.push(React.createElement('span', { key: 's|' + target, style: { color: T.label3, flex: 'none' } }, '\\'))
          crumbs.push(React.createElement('button', { key: target, type: 'button', className: 'drp-crumb', style: crumbStyle(target === raw, active), onClick: active ? () => jumpTo(target) : undefined, disabled: !active }, s))
        }
      } else if (!isWinPath && raw !== '' && raw !== '/') {
        const segs = raw.replace(/\/+$/, '').split('/')
        let acc = ''
        for (const s of segs) {
          if (!s) continue
          acc += '/' + s
          crumbs.push(React.createElement('span', { key: s + '|' + acc, style: { color: T.label3, flex: 'none' } }, '/'))
          crumbs.push(React.createElement('button', { key: acc, type: 'button', className: 'drp-crumb', style: crumbStyle(acc === raw, active), onClick: active ? () => jumpTo(acc) : undefined, disabled: !active }, s))
        }
      }
      if (crumbs.length === 1) crumbs.push(React.createElement('span', { key: 'empty', style: { color: T.label3 } }, isWinPath ? tr('picker.chooseDrive') : ''))
      return React.createElement('span', { key: 'crumb', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 2, maxWidth: '100%' } }, crumbs)
    }

    // ── DSH-style directory picker (mirrors ui-directory-picker-browse) ───────
    // The dialog follows the harness dialog frame (figma 813-23126 family):
    // 680×500 r24 card over a blurred mask, capsule buttons, 28px rows, text
    // tabs with the business-blue underline, ink-line icons. All colors ride
    // the DSH design tokens (ui-theme design-platform.css) so light/dark
    // follow the app. Scoped `.drp-*` classes carry the interaction states
    // inline styles cannot express (hover / focus-visible / placeholder).
    const PICKER_CSS = [
      '.drp-ovl{background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.5));backdrop-filter:var(--dsw-mask-blur,blur(2px))}',
      '.drp-card{box-sizing:border-box;background:var(--dsw-alias-bg-layer-2,#1e1e1e);border:1px solid var(--dsw-alias-border-inverted,rgba(255,255,255,.06));border-radius:24px;box-shadow:var(--dsw-shadow-lv3,0 12px 32px rgba(0,0,0,.08))}',
      '.drp-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;border:none;border-radius:18px;height:36px;padding:0 16px;background:transparent;cursor:pointer;font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary,#e4e4e7);transition:background-color .12s ease,color .12s ease}',
      '.drp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}',
      '.drp-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.14))}',
      '.drp-btn:disabled{opacity:.4;cursor:not-allowed}',
      '.drp-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:2px}',
      '.drp-sm{height:28px;border-radius:14px;padding:0 10px;font-size:12px;line-height:18px}',
      '.drp-outline{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25))}',
      '.drp-primary{background:var(--dsw-alias-button-primary-fill,#2563eb);color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '.drp-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#1d4ed8);color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '.drp-input{box-sizing:border-box;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.07));outline:none;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#e4e4e7);transition:border-color .12s ease}',
      '.drp-input:focus{border-color:var(--dsw-alias-state-business-primary,#4176e6)}',
      '.drp-input::placeholder{color:var(--dsw-alias-label-caption,rgba(128,128,128,.6))}',
      '.drp-input:disabled{opacity:.4;cursor:not-allowed}',
      '.drp-row{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;height:28px;padding:0 8px;border:none;border-radius:6px;background:transparent;text-align:left;cursor:pointer;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary,#e4e4e7);transition:background-color .12s ease}',
      '.drp-row:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}',
      '.drp-row:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.14))}',
      '.drp-row:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:-2px}',
      '.drp-row:disabled{opacity:.4;cursor:not-allowed}',
      '.drp-menu{box-sizing:border-box;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-3,#242428));border:1px solid var(--dsw-alias-border-inverted,rgba(255,255,255,.06));border-radius:12px;box-shadow:var(--dsw-shadow-lv3,0 12px 32px rgba(0,0,0,.08))}',
      '.drp-menurow{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:8px 10px;border:none;border-radius:10px;background:transparent;text-align:left;cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#e4e4e7);transition:background-color .12s ease}',
      '.drp-menurow:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}',
      '.drp-menurow:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:-2px}',
      '.drp-menurow:disabled{opacity:.4;cursor:not-allowed}',
      '.drp-menusm{min-height:30px;padding:3px 8px;border-radius:6px;font-size:12px;line-height:18px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.drp-close{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:8px;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.72));transition:background-color .12s ease,color .12s ease}',
      '.drp-close:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));color:var(--dsw-alias-label-primary,#e4e4e7)}',
      '.drp-close:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:2px}',
      '.drp-close:disabled{opacity:.4;cursor:not-allowed}',
      '.drp-tab{position:relative;border:none;background:transparent;padding:4px 2px 10px;cursor:pointer;font-size:13px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.7));transition:color .12s ease}',
      '.drp-tab::after{content:\'\';position:absolute;right:0;bottom:-1px;left:0;height:2px;border-radius:2px;background:transparent}',
      '.drp-tab:hover{color:var(--dsw-alias-label-primary,#e4e4e7)}',
      '.drp-tabActive{color:var(--dsw-alias-state-business-primary,#4176e6)}',
      '.drp-tabActive::after{background:var(--dsw-alias-state-business-primary,#4176e6)}',
      '.drp-tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:2px;border-radius:2px}',
      '.drp-lnk{color:inherit;text-decoration:none;transition:color .12s ease}',
      '.drp-lnk:hover{color:var(--dsw-alias-label-primary,#e4e4e7)}',
      '.drp-crumb{display:inline-flex;align-items:center;max-width:160px;padding:2px 4px;border:none;border-radius:4px;background:transparent;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.7));transition:color .12s ease,background-color .12s ease}',
      '.drp-crumb:hover:not(:disabled){color:var(--dsw-alias-label-primary,#e4e4e7);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}',
      '.drp-crumb:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:1px}',
      '.drp-crumb:disabled{opacity:.45;cursor:default}',
    ].join('\n')

    // Inline ink-line icons (16px grid), same glyphs as the harness icon set:
    // ic_ds_close_outline_16 / ic_ds_check_outline_16 / chevron_right_outline_14.
    const IconCloseX = () => React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'currentColor' },
      React.createElement('path', { d: 'M14.1168 13.197L13.197 14.1167L1.8833 2.80303L2.80309 1.88324L14.1168 13.197Z' }),
      React.createElement('path', { d: 'M13.197 1.88326L14.1168 2.80305L2.80309 14.1168L1.8833 13.197L13.197 1.88326Z' }),
    )
    const IconCheck = () => React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'currentColor' },
      React.createElement('path', { d: 'M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.59802 12.3336 6.59961 12.334 6.59961 12.334C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.7002 12.3252 6.70211 12.3251 6.7041 12.3242C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z' }),
    )
    const IconChevronRight = () => React.createElement('svg', { width: 12, height: 12, viewBox: '0 0 14 14', fill: 'currentColor' },
      React.createElement('path', { d: 'M5.5 2.15137L5.92383 2.57617L8.65137 5.30273C8.90706 5.55843 9.13382 5.78438 9.29785 5.98828C9.46883 6.20088 9.61756 6.44405 9.66602 6.75C9.69222 6.91565 9.69222 7.08435 9.66602 7.25C9.61756 7.55595 9.46883 7.79912 9.29785 8.01172C9.13382 8.21561 8.90706 8.44157 8.65137 8.69727L5.92383 11.4238L5.5 11.8486L4.65137 11L5.07617 10.5762L7.80273 7.84863C8.07732 7.57405 8.24849 7.40124 8.3623 7.25977C8.46904 7.12709 8.47813 7.07728 8.48047 7.0625C8.48703 7.02105 8.48703 6.97895 8.48047 6.9375C8.47813 6.92272 8.46904 6.87291 8.3623 6.74023C8.24848 6.59876 8.07732 6.42595 7.80273 6.15137L5.07617 3.42383L4.65137 3L5.5 2.15137Z' }),
    )
    const IconHome = () => React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'currentColor' },
      React.createElement('path', { d: 'M8 1.9 2.4 6.83V13.2c0 .44.36.8.8.8h3.3v-3.7h3v3.7h3.3c.44 0 .8-.36.8-.8V6.83L8 1.9Z' }),
    )

    function DirPicker(props) {
      const { open, busy, onPicked, onCancel } = props
      const [tab, setTab] = React.useState('local')
      const [machines, setMachines] = React.useState([])
      const [machineId, setMachineId] = React.useState('')
      const [path, setPath] = React.useState('')
      const [items, setItems] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const [reconnecting, setReconnecting] = React.useState(false)
      const [levels, setLevels] = React.useState(null)
      const [popOpen, setPopOpen] = React.useState(false)
      const [suggest, setSuggest] = React.useState([])
      const [suggestOpen, setSuggestOpen] = React.useState(false)
      const [recent, setRecent] = React.useState([])
      const [win, setWin] = React.useState(false) // remote platform: windows = Git-Bash host
      // 本机浏览浮层（browse 后端）：{ path, home, crumbs, entries, truncated }。
      const [localPop, setLocalPop] = React.useState(null)
      const [newDirName, setNewDirName] = React.useState('')
      // 远程浏览浮层的内联「新建目录」编辑器（替代 window.prompt，DSH 嵌套式）。
      const [mkdirOpen, setMkdirOpen] = React.useState(false)
      const [mkdirName, setMkdirName] = React.useState('')
      const suggestTimer = React.useRef(null)
      const suggestRef = React.useRef(null)
      const suggestMenuRef = React.useRef(null)
      const localPathRef = React.useRef(null)
      const remotePathRef = React.useRef(null)
      const menuRef = React.useRef(null)
      const dirPopRef = React.useRef(null)
      const localPopRef = React.useRef(null)
      React.useEffect(() => {
        if (!suggestOpen) return
        const onDown = (ev) => { if (suggestRef.current && !suggestRef.current.contains(ev.target)) setSuggestOpen(false) }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [suggestOpen])
      const [mOpen, setMOpen] = React.useState(false)
      const ddRef = React.useRef(null)
      React.useEffect(() => {
        if (!mOpen) return
        const onDown = (ev) => { if (ddRef.current && !ddRef.current.contains(ev.target)) setMOpen(false) }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [mOpen])

      // 注入 DSH 风格作用域样式（幂等：多个实例 / 热重载共享一份）。
      React.useEffect(() => {
        if (document.getElementById('dsh-remote-picker-css')) return
        const el = document.createElement('style')
        el.id = 'dsh-remote-picker-css'
        el.textContent = PICKER_CSS
        document.head.appendChild(el)
      }, [])

      // DSH 弹层语义：Esc 逐层收起（本机浮层 → 远程浮层 → 机器菜单 → 补全 → 对话框）。
      React.useEffect(() => {
        if (!open) return
        const onKey = (e) => {
          if (e.key !== 'Escape') return
          if (localPop) { setLocalPop(null); return }
          if (popOpen) { setPopOpen(false); setMkdirOpen(false); return }
          if (mOpen) { setMOpen(false); return }
          if (suggestOpen) { setSuggestOpen(false); return }
          if (!busy) onCancel()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open, busy, localPop, popOpen, mOpen, suggestOpen, onCancel])

      // 列表键盘漫游：行都是真实 button（Tab/Enter/Space 原生可用），
      // ↑/↓/Home/End 在容器内移动焦点（DSH Menu / 浏览器行的键盘行为）。
      const roveList = (e, ref) => {
        const host = ref && ref.current
        if (!host || !(e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End')) return
        const btns = Array.prototype.slice.call(host.querySelectorAll('button')).filter((b) => !b.disabled)
        if (!btns.length) return
        e.preventDefault()
        const idx = btns.indexOf(document.activeElement)
        if (e.key === 'Home') btns[0].focus()
        else if (e.key === 'End') btns[btns.length - 1].focus()
        else if (e.key === 'ArrowDown') btns[(idx + 1) % btns.length].focus()
        else btns[(idx - 1 + btns.length) % btns.length].focus()
      }

      const sortItems = (list) => {
        const dirs = list.filter((it) => it.dir)
        const files = list.filter((it) => !it.dir)
        dirs.sort((a, b) => a.name.localeCompare(b.name))
        files.sort((a, b) => a.name.localeCompare(b.name))
        return dirs.concat(files)
      }

      // Client-side full-path fallback: when the server did not attach a `path`
      // (older host half), join base + name with the base's own separator.
      const joinDisplay = (base, name) => {
        const b = String(base || '')
        const n = String(name || '')
        if (!b || b === '/') return '/' + n
        const sep = /^[a-zA-Z]:/.test(b) || b.includes('\\') ? '\\' : '/'
        return b.replace(/[\\/]+$/, '') + sep + n
      }

      const loadLevels = (id, p, toIndex) => {
        if (!id) return
        setLoading(true); setErr('')
        api('POST', '/dsh-remote/current', { id }).catch(() => {})
        .then(() => api('GET', '/dsh-remote/ls?machine=' + encodeURIComponent(id) + '&path=' + encodeURIComponent(p || '')))
        .then((res) => {
          setWin(res && res.platform === 'windows')
          const real = res && res.path ? res.path : (p || '')
          // Server returns [{ type, name, size, mtime, path }] where `path` is
          // the FULL display-form path (C:\Users\dev on Windows) — the client
          // never joins paths itself, so drives and Windows paths just work.
          const list = Array.isArray(res && res.items)
            ? res.items.map((it) => ({ name: it.name, dir: it.type === 'dir', size: it.size, mtime: it.mtime, path: it.path || joinDisplay(real, it.name), drive: !!it.drive }))
            : parseLs(res && res.text)
          const node = { path: real, dirs: sortItems(list.filter((it) => it.dir)), all: sortItems(list) }
          setLevels((prev) => {
            const base = prev && prev.length ? prev.slice() : []
            let idx = typeof toIndex === 'number' && toIndex >= 0 ? toIndex : base.length
            if (idx >= base.length) return base.concat([node])
            base[idx] = node
            return base.slice(0, idx + 1)
          })
        })
        .catch((e) => setErr(String((e && e.message) || e)))
        .finally(() => setLoading(false))
      }

      // 重新建立该机器的 SSH 连接（连接掉线 / 池内凭据失效后一键恢复），
      // 成功后重新列出当前浏览路径。
      const reconnectRemote = () => {
        if (!machineId || reconnecting) return
        setReconnecting(true); setErr('')
        apiRaw('POST', '/dsh-remote/reconnect', { machineId })
          .then((r) => {
            if (r.status >= 400) {
              const msg = (r.data && (r.data.error || r.data.message)) ? String(r.data.error || r.data.message) : 'HTTP ' + r.status
              const err = new Error(msg)
              err.credential = !!(r.data && r.data.credential)
              throw err
            }
            return r.data
          })
          .then(() => {
            const p = path.trim()
            setLevels(null)
            if (p || popOpen) { loadLevels(machineId, p, 0); setPopOpen(true) }
          })
          .catch((e) => {
            setErr((e && e.credential) || /no credentials/i.test(String((e && e.message) || e))
              ? tr('explorer.reconnectCredential')
              : String((e && e.message) || e))
          })
          .finally(() => setReconnecting(false))
      }

      React.useEffect(() => { if (open) {
        // Bug fix: the picker must NOT reopen with the previous selection's
        // path — reset the path bar (and the browse state) on every open.
        setPath(''); setLevels(null); setWin(false)
        setLocalPop(null); setNewDirName('')
        setMkdirOpen(false); setMkdirName('')
        setSuggestOpen(false); setMOpen(false); setPopOpen(false)
        api('GET', '/dsh-remote/machines').then((r) => {
          setMachines(r.machines || [])
          const scope = scopeCwdGuess()
          // Per-workspace isolation: the picker defaults to the machine of the
          // CURRENT workspace (mirror owner / selection), not a global current.
          const pickScopeMachine = () => {
            if (!scope) return Promise.resolve(null)
            return api('GET', '/dsh-remote/status?cwd=' + encodeURIComponent(scope)).catch(() => null)
          }
          pickScopeMachine().then((s) => {
            const curId = (s && s.currentId) || (r && r.currentId) || ''
            const list = r.machines || []
            const cur = list.find((m) => m.id === curId)
            setRecent((cur && cur.recentWorkspaces) || [])
            setMachineId(curId || (list[0] && list[0].id) || '')
          })
        })
      } }, [open])

      // 本机目录浏览（browse 后端兜底）：列出 path 的子目录；path 为空 → 宿主家目录。
      const loadLocal = (p) => {
        setLoading(true); setErr('')
        api('GET', '/dsh-remote/local-list' + (p ? '?path=' + encodeURIComponent(p) : ''))
          .then((r) => setLocalPop({ path: (r && r.path) || p || '', home: (r && r.home) || '', crumbs: (r && r.crumbs) || [], entries: (r && r.entries) || [], truncated: !!(r && r.truncated), drives: (r && r.drives) || [] }))
          .catch((e) => setErr(String((e && e.message) || e)))
          .finally(() => setLoading(false))
      }

      const chooseLocal = () => {
        setLoading(true); setErr('')
        api('POST', '/dsh-remote/local-pick')
          .then((r) => {
            if (r && r.path) { setLoading(false); onPicked(String(r.path)) }
            // browse 后端（DSH Desktop / 无显示的远程宿主）：没有 OS 对话框可开
            // → 打开内置本机目录浏览器。
            else if (r && r.kind === 'browse') loadLocal('')
            else if (r && r.cancelled) { setLoading(false); setErr(tr('picker.cancelled')) }
            else { setLoading(false); setErr((r && r.error) || tr('picker.noSysPicker')) }
          })
          .catch((e) => { setLoading(false); setErr(String((e && e.message) || e) + tr('picker.typePath')) })
      }

      // 在浮层当前目录下新建文件夹（browse 后端 createDirectory），成功后刷新列表。
      const mkdirLocal = () => {
        const cur = localPop
        const name = newDirName.trim()
        if (!cur || !cur.path || !name || loading) return
        setLoading(true); setErr('')
        api('POST', '/dsh-remote/local-mkdir', { path: cur.path, name })
          .then(() => { setNewDirName(''); loadLocal(cur.path) })
          .catch((e) => { setErr(String((e && e.message) || e)); setLoading(false) })
      }

      // 选用浮层中的本机目录：回填输入框（不直接提交），复核后再点「选用此本地路径」。
      const acceptLocalPick = (p) => {
        setPath(String(p || ''))
        setErr('')
        setLocalPop(null)
      }

      const switchTab = (t) => {
        setTab(t); setErr('')
        setSuggestOpen(false); setMOpen(false); setPopOpen(false); setMkdirOpen(false)
        // each tab keeps its own path — never leak the other tab's selection
        setPath('')
        if (t === 'remote') {
          // Windows remotes show a "This PC" drive view at the root; POSIX shows
          // the filesystem root. Either way loadLevels('') lists that root.
          if (machineId) loadLevels(machineId, '', 0)
        }
      }

      // Parent path of a display-form remote path (client-side, both separators).
      const parentOf = (p) => {
        const t = String(p || '')
        if (!t || t === '/') return null
        const win = /^[a-zA-Z]:/.test(t)
        if (win && /^[a-zA-Z]:\\?$/.test(t)) return null // drive root: no parent
        const sep = win ? '\\' : '/'
        const idx = t.lastIndexOf(sep)
        if (idx <= 0) return null
        const par = t.slice(0, idx)
        if (win && /^[a-zA-Z]:$/.test(par)) return par + '\\'
        return par || '/'
      }

      // enterDir(it): drive into the given entry — `it.path` is the FULL
      // display-form path from the server (drives C:\, Windows and POSIX alike).
      const enterDir = (it) => {
        if (busy || loading || !it || !it.dir) return
        loadLevels(machineId, it.path, (levels ? levels.length : 0))
      }

      // Navigate one level up in the browse popup. When the current level was
      // opened directly at a deep path (levels.length === 1 — e.g. the popup
      // was opened at the path bar's value) the parent is loaded as the new top
      // level instead of being disabled.
      const goUp = () => {
        if (loading) return
        const last = levels && levels.length ? levels[levels.length - 1] : null
        if (!last) return
        if (levels.length > 1) { setLevels((p) => p.slice(0, p.length - 1)); return }
        const par = parentOf(last.path)
        if (par) loadLevels(machineId, par, 1)
      }

      const loadSuggestions = (raw, mid) => {
        const id = mid || machineId
        if (!id || !raw) { setSuggest([]); setSuggestOpen(false); return }
        const t = String(raw || '').trim()
        if (!t) { setSuggest([]); setSuggestOpen(false); return }
        // Separator-aware split: `\` when the input looks like a Windows path.
        const backslash = t.includes('\\') || /^[a-zA-Z]:/.test(t)
        const sep = backslash ? '\\' : '/'
        const idx = t.lastIndexOf(sep)
        let parent, lastSeg
        if (idx < 0) { parent = backslash ? t + '\\' : '/'; lastSeg = backslash ? '' : t }
        else if (idx === t.length - 1) { parent = t.slice(0, idx) || '/'; lastSeg = '' }
        else { parent = t.slice(0, idx) || '/'; lastSeg = t.slice(idx + 1) }
        api('POST', '/dsh-remote/current', { id }).catch(() => {})
        .then(() => api('GET', '/dsh-remote/ls?machine=' + encodeURIComponent(id || '') + '&path=' + encodeURIComponent(parent || '/')))
        .then((res) => {
          const list = Array.isArray(res && res.items)
            ? res.items.map((it) => ({ name: it.name, dir: it.type === 'dir', path: it.path || joinDisplay(parent, it.name) }))
            : []
          const matches = list
            .filter((it) => it.dir && (!lastSeg || it.name.toLowerCase().startsWith(String(lastSeg).toLowerCase())))
            .slice(0, 40).map((it) => it.path)
          setSuggest(matches)
          setSuggestOpen(!!matches.length)
        }).catch(() => { setSuggest([]); setSuggestOpen(false) })
      }

      const onPathChange = (raw) => {
        setPath(raw); setErr('')
        if (suggestTimer.current) clearTimeout(suggestTimer.current)
        suggestTimer.current = setTimeout(() => loadSuggestions(raw), 220)
      }

      const continueSuggest = (dir) => {
        if (!machineId || !dir) { setSuggest([]); setSuggestOpen(false); return }
        setSuggestOpen(false)
        api('POST', '/dsh-remote/current', { id: machineId }).catch(() => {})
        .then(() => api('GET', '/dsh-remote/ls?machine=' + encodeURIComponent(machineId || '') + '&path=' + encodeURIComponent(String(dir).replace(/[\\/]+$/, '') || '/')))
        .then((res) => {
          const list = Array.isArray(res && res.items)
            ? res.items.map((it) => ({ name: it.name, dir: it.type === 'dir', path: it.path || joinDisplay(dir, it.name) }))
            : []
          const kids = list.slice(0, 40).map((it) => it.path)
          setSuggest(kids)
          setSuggestOpen(!!kids.length)
        }).catch(() => { setSuggest([]); setSuggestOpen(false) })
      }

      const selectSuggestion = (s) => {
        if (!s) { setSuggestOpen(false); return }
        // Auto-append the trailing separator so the path reads as a directory
        // and the user can keep typing the next segment right away.
        const sep = String(s).includes('\\') ? '\\' : '/'
        const withSep = String(s).replace(/[\\/]+$/, '') + sep
        setPath(withSep); setErr(''); setSuggestOpen(false)
        continueSuggest(withSep)
      }

      const commitPath = (p) => {
        const target = String(p || '').trim()
        if (!target || !machineId || busy) return
        setPopOpen(false); setSuggestOpen(false)
        api('POST', '/dsh-remote/mirror', { path: target, machine: machineId })
          .then(async (res) => {
            if (res && res.localMirror) { await fetchMirrorRoot(); onPicked(res.localMirror) }
            else setErr((res && res.error) || '')
          })
          .catch((e) => setErr(String((e && e.message) || e)))
      }

      const acceptBrowserPick = (p) => {
        setPath(String(p || ''))
        setSuggestOpen(false)
        setPopOpen(false)
      }

      const pickHome = () => {
        api('POST', '/dsh-remote/home', { machine: machineId }).then((r) => {
          if (r && r.home) { setPath(r.home); setErr(''); loadSuggestions(r.home) }
          else setErr((r && (r.hint || r.error)) || tr('picker.noHome'))
        }).catch((e) => setErr(String((e && e.message) || e)))
      }

      const mkdirHere = () => {
        const last = levels && levels.length ? levels[levels.length - 1] : null
        const base = (last && last.path) || '/'
        const nm = mkdirName.trim()
        if (!nm || loading) return
        const sep = base.includes('\\') ? '\\' : '/'
        const full = base === '/' ? '/' + nm : base + sep + nm
        setLoading(true); setErr('')
        api('POST', '/dsh-remote/fs', { op: 'mkdir', path: full })
          .then(() => { setErr(''); setMkdirOpen(false); setMkdirName(''); loadLevels(machineId, base, (levels ? levels.length - 1 : 0)) })
          .catch((e) => { setErr(String((e && e.message) || e)); setLoading(false) })
      }

      // 本机浏览浮层的面包屑：browse 后端给出完整祖先链（含盘符根），可点击跳转。
      const localCrumbs = (cur) => {
        const crumbs = (cur && cur.crumbs) || []
        if (!crumbs.length) return React.createElement('span', null, '/')
        const out = []
        crumbs.forEach((c, i) => {
          if (i > 0) out.push(React.createElement('span', { key: 'sep' + i, style: { color: T.label3, flex: 'none' } }, '›'))
          out.push(React.createElement('button', {
            key: c.path || i, type: 'button', className: 'drp-crumb',
            title: c.path, onClick: () => loadLocal(c.path),
            style: { color: i === crumbs.length - 1 ? T.label : T.label3, fontWeight: i === crumbs.length - 1 ? 600 : 400 },
          }, c.name))
        })
        return React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 } }, out)
      }

      // 本机目录浏览浮层（browse 后端）：进入子目录 / 面包屑跳转 / 回家目录 /
      // 新建文件夹 / 选用回填。与远程浏览弹层同一套交互，DSH 弹层外观。
      function renderLocalPopup() {
        const cur = localPop
        if (!cur) return null
        const crumbs = cur.crumbs || []
        const parent = crumbs.length >= 2 ? crumbs[crumbs.length - 2].path : null
        return React.createElement('div', {
          className: 'drp-ovl',
          style: { position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 },
          onClick: () => setLocalPop(null),
        },
          React.createElement('div', {
            className: 'drp-card',
            ref: localPopRef,
            style: { display: 'flex', flexDirection: 'column', width: 'min(680px, 100%)', height: 'min(500px, calc(100dvh - 32px))', overflow: 'hidden' },
            onClick: (e) => e.stopPropagation(),
            onKeyDown: (e) => roveList(e, localPopRef),
          },
            // header：标题 + 关闭；次级行：上级 / 首页 / 面包屑。
            React.createElement('div', { style: { flex: 'none', padding: '14px 14px 0 24px', borderBottom: '1px solid ' + T.borderL3 } },
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 } },
                React.createElement('h2', { style: { margin: 0, fontSize: 16, lineHeight: '24px', fontWeight: 500, color: T.label } }, tr('picker.browseLocal')),
                React.createElement('button', { type: 'button', className: 'drp-close', title: tr('picker.closeLabel'), 'aria-label': tr('picker.closeLabel'), onClick: () => setLocalPop(null) },
                  React.createElement(IconCloseX, null),
                ),
              ),
              React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', padding: '0 0 8px' } },
                React.createElement('button', { type: 'button', className: 'drp-btn drp-outline drp-sm', onClick: () => parent && loadLocal(parent), disabled: !parent || loading, title: parent || '' }, tr('picker.back')),
                React.createElement('button', { type: 'button', className: 'drp-btn drp-outline drp-sm', onClick: () => loadLocal(cur.home), disabled: loading, title: tr('picker.goHome') },
                  React.createElement('span', { style: { display: 'inline-flex' } }, React.createElement(IconHome, null)),
                ),
                React.createElement('div', { style: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 2, overflowX: 'auto', scrollbarWidth: 'none' } }, localCrumbs(cur)),
              ),
            ),
            // 盘符切换行（Windows 无统一根目录，browse 面包屑到不了其他盘）。
            (cur.drives && cur.drives.length > 1) ? React.createElement('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', padding: '8px 24px 0' } },
              cur.drives.map((d) => {
                const active = String(cur.path).toUpperCase().startsWith(String(d.name).toUpperCase())
                return React.createElement('button', {
                  key: d.path, type: 'button', className: 'drp-btn drp-outline drp-sm',
                  onClick: () => loadLocal(d.path), disabled: loading, title: d.path,
                  style: { fontFamily: 'monospace', color: active ? T.business : T.label2, fontWeight: active ? 600 : 400 },
                }, d.name)
              }),
            ) : null,
            // 目录行（28px 行 + 文件夹图标 + 行内 chevron，DSH Miller 行语言）。
            React.createElement('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: 6, display: 'flex', flexDirection: 'column', gap: 2 } },
              loading ? React.createElement('div', { style: { fontSize: 12, lineHeight: '18px', color: T.label3, padding: '4px 8px' } }, tr('picker.loading'))
                : (cur.entries.length ? cur.entries.slice(0, 400).map((it, i) => React.createElement('button', {
                    key: it.path || i, type: 'button', className: 'drp-row', disabled: loading,
                    title: tr('picker.enterDir', { name: it.name }), onClick: () => loadLocal(it.path),
                  },
                    React.createElement('span', { style: { flex: 'none', display: 'inline-flex', color: T.label2 } }, IconFolder(false)),
                    React.createElement('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' } }, it.name),
                    React.createElement('span', { style: { flex: 'none', display: 'inline-flex', color: T.label3 } }, React.createElement(IconChevronRight, null)),
                  )) : React.createElement('div', { style: { fontSize: 12, lineHeight: '18px', color: T.label3, padding: '4px 8px' } }, tr('picker.noSubdir'))),
              cur.truncated ? React.createElement('div', { style: { fontSize: 12, lineHeight: '18px', color: T.label3, padding: '4px 8px' } }, tr('picker.truncated')) : null,
            ),
            err ? React.createElement('div', { style: { flex: 'none', fontSize: 12, lineHeight: '18px', color: T.errorState, padding: '4px 24px 0' } }, err) : null,
            // footer：新建文件夹 + 选用此路径。
            React.createElement('div', { style: { flex: 'none', display: 'flex', gap: 8, alignItems: 'center', padding: '10px 24px 14px', borderTop: '1px solid ' + T.borderL3 } },
              React.createElement('input', {
                className: 'drp-input',
                style: { flex: '0 0 auto', width: 130, height: 28, padding: '0 8px', fontSize: 12 },
                value: newDirName, onChange: (e) => setNewDirName(e.target.value), placeholder: tr('picker.newFolder'),
                onKeyDown: (e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); mkdirLocal() }
                  else if (e.key === 'Escape') { e.stopPropagation(); setLocalPop(null) }
                },
              }),
              React.createElement('button', { type: 'button', className: 'drp-btn drp-outline drp-sm', onClick: mkdirLocal, disabled: loading || !newDirName.trim() || !cur.path }, tr('picker.create')),
              React.createElement('span', { style: { flex: 1, minWidth: 0, fontSize: 11, lineHeight: '16px', color: T.label3, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, tr('picker.selected', { path: cur.path })),
              React.createElement('button', { type: 'button', className: 'drp-btn drp-primary', onClick: () => acceptLocalPick(cur.path) }, tr('picker.chooseThis')),
            ),
          ),
        )
      }

      function renderDirPopup() {
        if (!levels || !levels.length) {
          return React.createElement('div', { style: { opacity: 0.6, fontSize: 12 } }, (loading ? tr('picker.loading') : tr('picker.readingRoot')))
        }
        const last = levels[levels.length - 1]
        const entries = last.all || []
        const icon = (it) => React.createElement('span', { style: { flex: 'none', display: 'inline-flex', color: T.label2, opacity: it.dir || it.drive ? 1 : 0.85 } },
          it.dir || it.drive ? IconFolder(false) : IconFile(),
        )
        return React.createElement('div', {
          ref: dirPopRef,
          style: { border: '1px solid ' + T.borderL3, borderRadius: 12, background: T.layer1, display: 'flex', flexDirection: 'column', maxHeight: 'min(340px, 44vh)', overflow: 'hidden' },
          onKeyDown: (e) => roveList(e, dirPopRef),
        },
          // 表头：上级 / 面包屑 / 新建目录 / 关闭。
          React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', padding: '8px 10px', borderBottom: '1px solid ' + T.borderL3 } },
            React.createElement('button', { type: 'button', className: 'drp-btn drp-outline drp-sm', onClick: goUp, disabled: loading || (levels.length <= 1 && !parentOf(last.path)), title: tr('picker.back') }, tr('picker.back')),
            React.createElement('div', { style: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 2, overflowX: 'auto', scrollbarWidth: 'none', fontSize: 13, lineHeight: '20px' } },
              breadcrumb(!!machineId, last.path, win, (p) => setLevels((prev) => { const cut = (prev || []).findIndex((lv) => lv.path === p); return cut >= 0 ? prev.slice(0, cut + 1) : prev })),
            ),
            React.createElement('button', { type: 'button', className: 'drp-btn drp-outline drp-sm', onClick: () => { setMkdirName(''); setMkdirOpen(true) }, disabled: loading || !last.path }, tr('picker.newDir')),
            React.createElement('button', { type: 'button', className: 'drp-close', title: tr('picker.closeLabel'), 'aria-label': tr('picker.closeLabel'), onClick: () => { setPopOpen(false); setMkdirOpen(false) } },
              React.createElement(IconCloseX, null),
            ),
          ),
          // 目录 / 文件行（28px 行；目录带 chevron，文件带大小 / 时间）。
          React.createElement('div', { style: { overflowY: 'auto', overflowX: 'hidden', padding: 6, display: 'flex', flexDirection: 'column', gap: 2 } },
            loading ? React.createElement('div', { style: { fontSize: 12, lineHeight: '18px', color: T.label3, padding: '4px 8px' } }, tr('picker.loading'))
              : (entries.length ? entries.slice(0, 400).map((it, i) => (it.dir || it.drive)
                  ? React.createElement('button', {
                      key: i, type: 'button', className: 'drp-row', disabled: loading,
                      title: it.drive ? tr('picker.enterDrive', { name: it.name }) : tr('picker.enterDir', { name: it.name }),
                      onClick: it.dir ? () => enterDir(it) : undefined,
                    },
                      icon(it),
                      React.createElement('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' } }, it.name),
                      React.createElement('span', { style: { flex: 'none', display: 'inline-flex', color: T.label3 } }, React.createElement(IconChevronRight, null)),
                    )
                  : React.createElement('div', {
                      key: i, className: 'drp-row', title: tr('picker.fileAt', { name: it.name }),
                      style: { cursor: 'default' },
                    },
                      icon(it),
                      React.createElement('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' } }, it.name),
                      React.createElement('span', { style: { flex: 'none', fontSize: 11, lineHeight: '16px', color: T.label3, fontFamily: 'monospace' } }, humanSize(it.size) + (it.mtime ? '  ' + fmtTime(it.mtime) : '')),
                    )
                ) : React.createElement('div', { style: { fontSize: 12, lineHeight: '18px', color: T.label3, padding: '4px 8px' } }, tr('picker.emptyDir'))),
              entries.length > 400 ? React.createElement('div', { style: { fontSize: 12, lineHeight: '18px', color: T.label3, padding: '4px 8px' } }, tr('picker.truncated')) : null,
          ),
          // footer：内联「新建目录」编辑器或「选用此路径」。
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px 10px', borderTop: '1px solid ' + T.borderL3 } },
            mkdirOpen
              ? React.createElement(React.Fragment, null,
                  React.createElement('input', {
                    className: 'drp-input', autoFocus: true, value: mkdirName,
                    style: { flex: 1, minWidth: 0, height: 28, padding: '0 8px', fontSize: 12 },
                    placeholder: tr('picker.newFolder'),
                    onChange: (e) => setMkdirName(e.target.value),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); mkdirHere() }
                      else if (e.key === 'Escape') { e.stopPropagation(); if (!loading) { setMkdirOpen(false); setMkdirName('') } }
                    },
                  }),
                  React.createElement('button', { type: 'button', className: 'drp-btn drp-outline drp-sm', onClick: () => { setMkdirOpen(false); setMkdirName('') } }, tr('picker.cancel')),
                  React.createElement('button', { type: 'button', className: 'drp-btn drp-primary drp-sm', onClick: mkdirHere, disabled: loading || !mkdirName.trim() }, tr('picker.create')),
                )
              : React.createElement(React.Fragment, null,
                  React.createElement('span', { style: { flex: 1, minWidth: 0, fontSize: 11, lineHeight: '16px', color: T.label3, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, tr('picker.selected', { path: (last.path || (win ? tr('picker.driveRoot') : '/')) })),
                  React.createElement('button', { type: 'button', className: 'drp-btn drp-primary', onClick: () => { acceptBrowserPick(last.path); setPopOpen(false); setMkdirOpen(false) } }, tr('picker.chooseThis')),
                ),
          ),
        )
      }

      if (!open) return null
      const tabBtn = (t, lbl) => React.createElement('button', {
        type: 'button', role: 'tab', 'aria-selected': tab === t,
        className: 'drp-tab' + (tab === t ? ' drp-tabActive' : ''),
        onClick: () => switchTab(t),
      }, lbl)
      // DSH Dialog 头部的 28×28 图标关闭按钮。
      const closeIconBtn = (onClose, disabled) => React.createElement('button', {
        type: 'button', className: 'drp-close', title: tr('picker.closeLabel'), 'aria-label': tr('picker.closeLabel'),
        onClick: onClose, disabled: !!disabled,
      }, React.createElement(IconCloseX, null))
      // figma Dialog 813-23126 family：680×500 卡片（视口内收缩）、r24、
      // inverted 细边框、lv3 阴影、layer-2 表面，头部标题 + 文本标签页，
      // 底部 Cancel + primary 胶囊按钮。
      return React.createElement('div', {
        className: 'drp-ovl',
        style: { position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 },
        onClick: () => { if (!busy) onCancel() },
      },
        React.createElement('div', {
          className: 'drp-card',
          role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('picker.title'),
          style: { display: 'flex', flexDirection: 'column', width: 'min(680px, 100%)', height: 'min(500px, calc(100dvh - 32px))', overflow: 'hidden' },
          onClick: (e) => e.stopPropagation(),
        },
          // 标题行 + 标签行（figma Dialog header / Tab_Group 34:11441）。
          React.createElement('div', { style: { flex: 'none', padding: '14px 24px 0', borderBottom: '1px solid ' + T.borderL3 } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
              React.createElement('h2', { style: { margin: 0, fontSize: 16, lineHeight: '24px', fontWeight: 500, color: T.label } }, tr('picker.title')),
              closeIconBtn(() => { if (!busy) onCancel() }, busy),
            ),
            React.createElement('div', { role: 'tablist', style: { display: 'flex', gap: 28, marginTop: 6 } },
              tabBtn('local', tr('picker.tabLocal')),
              tabBtn('remote', tr('picker.tabRemote')),
            ),
          ),
          // 内容区：各页内容、错误行、加载浮标都在此滚动（段落间距 10，DSH Modal body 节奏）。
          React.createElement('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '14px 24px 6px', overflowY: 'auto', position: 'relative' } },
            tab === 'local'
              ? React.createElement('div', { key: 'local', style: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10, width: '100%', maxWidth: 440, alignSelf: 'center' } },
                  React.createElement('div', { style: { fontSize: 12, lineHeight: '18px', color: T.label2 } }, tr('picker.localIntro')),
                  React.createElement('input', {
                    className: 'drp-input', ref: localPathRef, autoFocus: true,
                    style: { width: '100%' },
                    value: path, onChange: (e) => setPath(e.target.value), placeholder: tr('picker.localPlaceholder'),
                    onKeyDown: (e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); if (path.trim() && !loading) onPicked(path.trim()) } },
                  }),
                  React.createElement('div', { style: { display: 'flex', gap: 8 } },
                    React.createElement('button', { type: 'button', className: 'drp-btn drp-outline', onClick: chooseLocal, disabled: loading, style: { alignSelf: 'flex-start' } }, loading ? tr('picker.opening') : tr('picker.openSysPicker')),
                  ),
                  localPop ? renderLocalPopup() : null,
                )
              : React.createElement('div', { key: 'remote', style: { display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 } },
                  // 机器选择（DSH Menu 卡片：r12、lv3 阴影、当前项尾部打勾）。
                  React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                    React.createElement('label', { style: { fontSize: 12, lineHeight: '18px', color: T.label2, whiteSpace: 'nowrap' } }, tr('picker.remoteMachine')),
                    React.createElement('div', { ref: ddRef, style: { position: 'relative', flex: 1, minWidth: 0 } },
                      React.createElement('button', {
                        type: 'button', className: 'drp-btn drp-input',
                        style: { width: '100%', justifyContent: 'space-between', textAlign: 'left', padding: '0 10px', cursor: 'pointer' },
                        onClick: () => setMOpen((x) => !x),
                        'aria-haspopup': 'listbox', 'aria-expanded': mOpen,
                      },
                        React.createElement('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                          (machines.find((m) => m.id === machineId) || {}).name || (machineId ? '…' : tr('picker.chooseMachine'))),
                        React.createElement('span', { style: { flex: 'none', display: 'inline-flex', color: T.label3, transform: 'rotate(90deg)' } }, React.createElement(IconChevronRight, null)),
                      ),
                      mOpen
                        ? React.createElement('div', {
                            className: 'drp-menu', role: 'listbox', ref: menuRef,
                            style: { position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 1200, maxHeight: 260, overflow: 'auto', padding: 4 },
                            onKeyDown: (e) => roveList(e, menuRef),
                          },
                            machines.length
                              ? machines.map((m) => React.createElement('button', {
                                  key: m.id, type: 'button', role: 'option', className: 'drp-menurow', 'aria-selected': m.id === machineId,
                                  onClick: () => { setMachineId(m.id); setRecent(m.recentWorkspaces || []); setLevels(null); setPath(''); setMOpen(false); if (m.id) loadLevels(m.id, '', 0) },
                                },
                                  React.createElement('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                                    React.createElement('span', { style: { fontWeight: 500 } }, m.name),
                                    React.createElement('span', { style: { fontSize: 12, lineHeight: '18px', color: T.label3, fontFamily: 'monospace' } }, '  ' + m.username + '@' + m.host + ':' + m.port),
                                  ),
                                  m.id === machineId ? React.createElement('span', { style: { flex: 'none', display: 'inline-flex', color: T.business } }, React.createElement(IconCheck, null)) : null,
                                ))
                              : React.createElement('div', { style: { padding: '8px 10px', fontSize: 12, lineHeight: '18px', color: T.label3 } }, tr('picker.noMachines')),
                          )
                        : null,
                    ),
                  ),
                  // 最近工作区快捷入口
                  recent.length ? React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                    React.createElement('span', { style: { fontSize: 12, lineHeight: '18px', color: T.label3, whiteSpace: 'nowrap' } }, tr('picker.recent')),
                    recent.map((w, i) => React.createElement('button', {
                      key: w + i, type: 'button', className: 'drp-btn drp-outline drp-sm',
                      onClick: () => { setPath(w); setErr(''); continueSuggest(w) }, title: w,
                    }, React.createElement('span', { style: { fontFamily: 'monospace', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, w))),
                  ) : null,
                  // 远程路径输入 + 浏览 / 主目录
                  React.createElement('div', { ref: suggestRef, style: { position: 'relative' } },
                    React.createElement('div', { style: { display: 'flex', gap: 8 } },
                      React.createElement('input', {
                        className: 'drp-input', ref: remotePathRef, autoFocus: true,
                        style: { flex: 1, minWidth: 0 },
                        value: path, onChange: (e) => onPathChange(e.target.value), onFocus: () => loadSuggestions(path),
                        placeholder: (machineId ? (win ? tr('picker.pathPlaceholderWin') : tr('picker.pathPlaceholder')) : tr('picker.chooseMachineFirst')),
                        disabled: !machineId,
                        onKeyDown: (e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); commitPath(path) } },
                      }),
                      React.createElement('button', { type: 'button', className: 'drp-btn drp-outline', onClick: () => { if (!machineId) return; const p = path.trim(); loadLevels(machineId, p || '', 0); setMkdirOpen(false); setPopOpen(true) }, disabled: !machineId }, tr('picker.browse')),
                      React.createElement('button', { type: 'button', className: 'drp-btn drp-outline', onClick: pickHome, disabled: !machineId }, tr('picker.home')),
                    ),
                    (suggestOpen && suggest.length)
                      ? React.createElement('div', {
                          className: 'drp-menu', ref: suggestMenuRef,
                          style: { position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 1200, maxHeight: 200, overflowY: 'auto', padding: 4 },
                          onKeyDown: (e) => roveList(e, suggestMenuRef),
                        },
                          suggest.map((s, i) => React.createElement('button', {
                            key: s + i, type: 'button', className: 'drp-menurow drp-menusm', title: s,
                            onMouseDown: (e) => { e.preventDefault(); selectSuggestion(s) },
                          },
                            React.createElement('span', { style: { flex: 'none', display: 'inline-flex', color: T.label3 } }, IconFolder(false)),
                            React.createElement('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' } }, s),
                          )),
                        )
                      : null,
                  ),
                  popOpen ? renderDirPopup() : null,
                ),
            err ? React.createElement('div', { style: { flex: 'none', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, lineHeight: '18px', color: T.errorState, padding: '4px 120px 2px 0' } },
              React.createElement('span', { style: { flex: 1, minWidth: 0, whiteSpace: 'normal' } }, err),
              (tab === 'remote' && machineId)
                ? React.createElement('button', {
                    type: 'button', className: 'drp-btn drp-outline drp-sm',
                    onClick: reconnectRemote, disabled: reconnecting,
                    title: reconnecting ? tr('picker.loading') : tr('common.reconnect'),
                  }, reconnecting ? tr('picker.loading') : tr('common.reconnect'))
                : null,
            ) : null,
            (loading && tab === 'remote') ? React.createElement('div', { style: { position: 'absolute', right: 16, bottom: 8, padding: '2px 8px', background: T.layer2, fontSize: 12, lineHeight: '18px', color: T.label3 } }, tr('picker.loading')) : null,
          ),
          // 底部操作行（figma Dialog footer：Cancel + primary，右侧对齐）。
          React.createElement('div', { style: { flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 24px 0' } },
            React.createElement('span', { style: { flex: 1, minWidth: 0, fontSize: 11, lineHeight: '16px', color: T.label3, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              (tab === 'remote' && path) ? tr('picker.selected', { path }) : ''),
            React.createElement('button', { type: 'button', className: 'drp-btn drp-outline', onClick: onCancel, disabled: busy }, tr('picker.cancel')),
            tab === 'local'
              ? React.createElement('button', { type: 'button', className: 'drp-btn drp-primary', onClick: () => (path.trim() ? onPicked(path.trim()) : undefined), disabled: !path.trim() || loading }, tr('picker.useLocalPath'))
              : React.createElement('button', { type: 'button', className: 'drp-btn drp-primary', onClick: () => commitPath(path), disabled: busy || !machineId || !path.trim() }, busy ? tr('picker.mirroring') : tr('picker.setRemoteWs')),
          ),
          // 底部宣传行：caption 级弱化文字。
          React.createElement('div', { style: { flex: 'none', display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center', padding: '10px 24px 14px', fontSize: 11, lineHeight: '16px', color: T.label3 } },
            React.createElement('a', { className: 'drp-lnk', href: 'https://github.com/flymysql/dsh-remote', target: '_blank', rel: 'noopener noreferrer' }, tr('picker.star')),
            React.createElement('span', null, '·'),
            React.createElement('a', { className: 'drp-lnk', href: 'https://github.com/flymysql/dsh-remote/issues/new', target: '_blank', rel: 'noopener noreferrer' }, tr('picker.feedback')),
          ),
        ),
      )
    }

    // ── better-sidebar integration (optional) ────────────────────────────────
    const SIDEBAR_EXPLORER_ID = 'dsh-remote:explorer'
    const SIDEBAR_FILE_ID = 'dsh-remote:file'

    // Host-validated mirror directories drive synchronous UI gates.
    let MIRROR_ROOT = ''
    let MIRROR_DIRS = []

    function fetchMirrorRoot() {
      return api('GET', '/dsh-remote/status')
        .then((s) => { MIRROR_DIRS = s && Array.isArray(s.mirrorDirs) ? s.mirrorDirs : []; MIRROR_ROOT = (s && typeof s.mirrorRoot === 'string') ? s.mirrorRoot : ''; return MIRROR_ROOT })
        .catch(() => { MIRROR_DIRS = []; MIRROR_ROOT = ''; return MIRROR_ROOT })
    }

    /** Match a validated mirror, never the registry/container directory itself. */
    function sessionIsRemote(cwd) {
      if (!cwd) return false
      const normalize = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '')
      const dir = normalize(cwd)
      return MIRROR_DIRS.some((p) => { const root = normalize(p); return dir === root || dir.startsWith(root + '/') })
    }

    function fetchRemoteStatus(sessionId, cwd) {
      const params = new URLSearchParams()
      if (sessionId) params.set('sessionId', sessionId)
      if (cwd) params.set('cwd', cwd)
      const q = params.size ? '?' + params.toString() : ''
      return api('GET', '/dsh-remote/status' + q).catch(() => null)
    }

    // Resolve the remote path this session shows. Issue #13: the ONLY source
    // of truth is the session's own cwd mapped through /dsh-remote/resolve-
    // mirror — a cwd outside any mirror dir means "this session is NOT a
    // remote session", and the sidebar must NOT fall back to the machine
    // workspace (that made an unrelated saved machine leak into local
    // sessions).
    function resolveSessionRemote(sessionId) {
      if (!sessionId) return Promise.resolve('')
      // 1) Prefer the client-side session list cwd (mirror dir under
      //    $DSH_HOME/remote-workspaces/...) passed as ?local=.
      let local = ''
      try {
        const list = SESSIONS && SESSIONS.list && typeof SESSIONS.list.getSnapshot === 'function'
          ? SESSIONS.list.getSnapshot()
          : null
        const entry = list && list.byId && list.byId[sessionId]
        if (entry && entry.cwd) local = String(entry.cwd)
      } catch { /* sessions store shape differs */ }
      if (local) {
        return api('GET', '/dsh-remote/resolve-mirror?local=' + encodeURIComponent(local))
          .then((r) => (r && r.remotePath) || '')
          .catch(() => '')
      }
      // 2) Fall back to host-side session header cwd.
      return api('GET', '/dsh-remote/resolve-mirror?sessionId=' + encodeURIComponent(sessionId))
        .then((r) => (r && r.remotePath) || '')
        .catch(() => '')
    }

    function readRemoteFile(path, maxBytes, sessionId) {
      return api('POST', '/dsh-remote/read', withSessionBody({ path, maxBytes }, sessionId)).catch((e) => {
        throw new Error(tr('file.readFail', { msg: ((e && e.message) || e) }))
      })
    }

function listRemoteDir(path, sessionId) {
      // apiRaw keeps the host's `credential` marker so callers can tell
      // "connection just dropped, retry" from "no saved credentials — user
      // must re-enter them" and offer the right refresh / reconnect UX.
      const url = withSessionQuery('/dsh-remote/ls?path=' + encodeURIComponent(path || ''), sessionId)
      return apiRaw('GET', url)
        .then(({ status, data }) => {
          if (status >= 400) {
            const msg = (data && data.error) ? String(data.error) : 'HTTP ' + status
            const err = new Error(tr('file.listFail', { msg }))
            err.credential = !!(data && data.credential)
            throw err
          }
          return data
        })
    }

    function joinRemote(base, name) {
      if (!base) return name
      return base.replace(/[\\/]+$/, '') + (base.includes('\\') ? '\\' : '/') + name
    }

    // Deterministic remote-listing sort — the ONE fixed rule for every
    // remote tree surface (the host FileTree renders provider entries in
    // the order `list()` returns, so ordering is a data-layer duty).
    // Priority (lexicographic key):
    //   1) folders before files;
    //   2) "."-prefixed names (dotfiles) before plain names — within the
    //      SAME folder/file group (.git/ sorts as a folder, ahead of src/,
    //      while .env sorts ahead of A.txt but after every folder);
    //   3) then plain ASCII order — code-unit compare, case-sensitive
    //      (uppercase before lowercase), NOT locale-aware.
    // Example: .git/  src/  .env  A.txt  B.txt  Z.txt  a.txt
    function sortRemoteEntries(items) {
      return items.slice().sort((a, b) => {
        const aName = String(a.name || '')
        const bName = String(b.name || '')
        const aDir = a.type === 'dir' ? 0 : 1
        const bDir = b.type === 'dir' ? 0 : 1
        if (aDir !== bDir) return aDir - bDir
        const aDot = aName.startsWith('.') ? 0 : 1
        const bDot = bName.startsWith('.') ? 0 : 1
        if (aDot !== bDot) return aDot - bDot
        return aName < bName ? -1 : aName > bName ? 1 : 0
      })
    }

    // ── Remote explorer + file tabs ───────────────────────────────────────
    // The two tab views are restyled on the better-sidebar file side (the
    // built-in local file tree): same 34px/8px rows, 22px indent step, DSH
    // font + alias tokens, VSCode-style indent guides, hover-revealed
    // @-reference pill, and a DSH-styled context menu. All colors ride the
    // design tokens so light/dark follow the app; hover/focus states live in
    // the scoped `.drx-*` sheet (injected once, like PICKER_CSS).
    //
    // Icons are the harness glyph set (path data lifted verbatim from
    // @deepseek-ai/dsh-client-ui-primitives) so rows match the built-in tree
    // icon-for-icon; fill: currentColor → follows the row text color.
    const ICON = {
      'folder-open': [
        { d: 'M5.19629 1.57104C5.81144 1.5711 6.38623 1.8786 6.72754 2.39038L7.19922 3.09839C7.28454 3.22635 7.42824 3.30344 7.58203 3.30347H12.1699C13.5039 3.30348 14.5859 4.38548 14.5859 5.71948V6.62671C15.2694 7.02689 15.6605 7.85012 15.4385 8.68726L14.3848 12.658C14.1037 13.7164 13.1449 14.4527 12.0498 14.4529H2.91699C1.51651 14.4529 0.451662 13.2814 0.501954 11.9519V3.98706C0.501954 2.65305 1.58396 1.57104 2.91797 1.57104H5.19629ZM3.7793 7.75562C3.30994 7.75562 2.89883 8.07153 2.77832 8.52515L1.91602 11.7722C1.74167 12.4291 2.23734 13.073 2.91699 13.073H12.0498C12.5191 13.0728 12.9304 12.757 13.0508 12.3035L14.1045 8.33374C14.1819 8.04202 13.9619 7.756 13.6602 7.75562H3.7793ZM2.91797 2.9519C2.34625 2.9519 1.88281 3.41534 1.88281 3.98706V7.2937C2.33068 6.7269 3.02249 6.37476 3.7793 6.37476H13.2051V5.71948C13.2051 5.14777 12.7416 4.68434 12.1699 4.68433H7.58203C6.96675 4.6843 6.39209 4.37595 6.05078 3.86401L5.5791 3.15601C5.49379 3.02821 5.34995 2.95196 5.19629 2.9519H2.91797Z' },
        { d: 'M13.6602 7.75525C13.9618 7.7556 14.1815 8.04179 14.1045 8.33337L13.0508 12.3031C12.9304 12.7567 12.5191 13.0725 12.0498 13.0726H2.91701C2.23744 13.0725 1.7417 12.4287 1.91603 11.7719L2.77834 8.52478C2.89898 8.07146 3.31018 7.75532 3.77931 7.75525H13.6602ZM5.1963 2.95154C5.34985 2.95159 5.49377 3.02803 5.57912 3.15564L6.0508 3.86365C6.39205 4.37553 6.96685 4.68385 7.58205 4.68396H12.1699C12.7416 4.68396 13.2049 5.14754 13.2051 5.71912V6.37439H3.77931C3.02267 6.37444 2.33067 6.72671 1.88283 7.29333V3.98669C1.88299 3.4152 2.34649 2.95168 2.91798 2.95154H5.1963Z', opacity: 0.2 },
      ],
      folder: [
        { d: 'M5.05582 0.518756L4.50669 0.86654L5.05582 0.518756ZM13 9.4837L13.65 9.4837L13.65 3.53962L13 3.53962L12.35 3.53962L12.35 9.4837L13 9.4837ZM11.3264 1.86603L11.3264 1.21603L6.52313 1.21603L6.52313 1.86603L6.52313 2.51603L11.3264 2.51603L11.3264 1.86603ZM5.58054 1.34727L6.12968 0.999489L5.60495 0.170972L5.05582 0.518756L4.50669 0.86654L5.03141 1.69506L5.58054 1.34727ZM4.11323 1.23058e-13L4.11323 -0.65L1.67359 -0.65L1.67359 5.00699e-14L1.67359 0.65L4.11323 0.65L4.11323 1.23058e-13ZM0 1.67359L-0.65 1.67359L-0.65 9.4837L0 9.4837L0.65 9.4837L0.65 1.67359L0 1.67359ZM11.3264 11.1573L11.3264 10.5073L1.67359 10.5073L1.67359 11.1573L1.67359 11.8073L11.3264 11.8073L11.3264 11.1573ZM0 9.4837L-0.65 9.4837C-0.65 10.767 0.390308 11.8073 1.67359 11.8073L1.67359 11.1573L1.67359 10.5073C1.10828 10.5073 0.65 10.049 0.65 9.4837L0 9.4837ZM1.67359 5.00699e-14L1.67359 -0.65C0.390307 -0.65 -0.65 0.390309 -0.65 1.67359L0 1.67359L0.65 1.67359C0.65 1.10828 1.10828 0.65 1.67359 0.65L1.67359 5.00699e-14ZM5.05582 0.518756L5.60495 0.170972C5.28121 -0.340193 4.71829 -0.65 4.11323 -0.65L4.11323 1.23058e-13L4.11323 0.65C4.27282 0.65 4.4213 0.731715 4.50669 0.86654L5.05582 0.518756ZM6.52313 1.86603L6.52313 1.21603C6.36354 1.21603 6.21507 1.13431 6.12968 0.999489L5.58054 1.34727L5.03141 1.69506C5.35515 2.20622 5.91808 2.51603 6.52313 2.51603L6.52313 1.86603ZM13 3.53962L13.65 3.53962C13.65 2.25634 12.6097 1.21603 11.3264 1.21603L11.3264 1.86603L11.3264 2.51603C11.8917 2.51603 12.35 2.97431 12.35 3.53962L13 3.53962ZM13 9.4837L12.35 9.4837C12.35 10.049 11.8917 10.5073 11.3264 10.5073L11.3264 11.1573L11.3264 11.8073C12.6097 11.8073 13.65 10.767 13.65 9.4837L13 9.4837Z', transform: 'translate(1.5 2.429)' },
      ],
      // ic_ds_code_outline_16 — the built-in tree's default FILE glyph.
      code: [
        { d: 'M12.3368 1.53569L11.931 4.43172H14.8086V5.79673H11.7404L11.1962 9.67859H14.2839V11.0436H11.0056L10.4994 14.6529L9.14873 14.4643L9.62731 11.0436H5.75876L5.25252 14.6529L3.90186 14.4643L4.38043 11.0436H1.69141V9.67859H4.57104L5.11417 5.79673H2.21609V4.43172H5.30581L5.73724 1.34713L7.08995 1.53569L6.68414 4.43172H10.5527L10.9841 1.34713L12.3368 1.53569ZM5.94937 9.67859H9.81791L10.361 5.79673H6.49353L5.94937 9.67859Z', fillRule: 'evenodd', clipRule: 'evenodd' },
      ],
      refresh: [
        { d: 'M7.92136 0.349152C10.3744 0.349234 12.5564 1.5052 13.9557 3.29894L15.1281 2.12759C15.3303 1.92546 15.6767 2.06943 15.6767 2.35538V5.53923C15.6766 5.71626 15.5329 5.85976 15.3559 5.86002H12.171C11.8854 5.8597 11.7426 5.51465 11.9443 5.31249L12.9641 4.29056C11.8237 2.74305 9.98908 1.74106 7.92136 1.74097C4.46436 1.74097 1.66233 4.543 1.66233 8C1.66233 11.457 4.46436 14.259 7.92136 14.259C11.3782 14.2589 14.1804 11.4569 14.1804 8H15.5722C15.5722 12.2251 12.1465 15.6507 7.92136 15.6508C3.69614 15.6508 0.270508 12.2252 0.270508 8C0.270508 3.77478 3.69614 0.349152 7.92136 0.349152Z' },
      ],
      link: [
        { d: 'M9.94133 6.50173C11.3218 7.99603 11.3218 10.3011 9.94128 11.7954C9.88691 11.8542 9.82125 11.9196 9.72099 12.0198L7.75707 13.9838C7.65709 14.0838 7.592 14.1491 7.53334 14.2034C6.03906 15.5843 3.7327 15.5854 2.23827 14.2048C2.17933 14.1503 2.11374 14.0844 2.01315 13.9838C1.91318 13.8839 1.84922 13.8188 1.79495 13.7601C0.413857 12.2657 0.413909 9.95948 1.795 8.46503C1.84923 8.4064 1.91335 8.34115 2.01321 8.24129L3.79275 6.46313C3.71814 7.08101 3.75236 7.71445 3.90115 8.33518L3.00344 9.23151C2.89398 9.34097 2.8535 9.38307 2.82251 9.41658C1.93771 10.3744 1.93704 11.8514 2.82179 12.8092C2.85279 12.8427 2.89383 12.884 3.0034 12.9936C3.11272 13.1029 3.15429 13.1442 3.18777 13.1752C4.14561 14.0603 5.62381 14.0608 6.58178 13.1758C6.61532 13.1448 6.65722 13.1032 6.76685 12.9935L8.73077 11.0296C8.83999 10.9204 8.88142 10.8787 8.91238 10.8452C9.79744 9.88728 9.7969 8.40911 8.91173 7.45124C8.88074 7.41775 8.83944 7.3762 8.73011 7.26687C8.62082 7.15757 8.58061 7.11623 8.54712 7.08526C8.37347 6.92477 8.18243 6.79361 7.98088 6.69165L9.00289 5.66964C9.17506 5.78373 9.34035 5.91265 9.49663 6.05703C9.55538 6.11135 9.62026 6.17652 9.72036 6.27662C9.82094 6.3772 9.88686 6.4428 9.94133 6.50173Z' },
        { d: 'M6.06816 9.49196C4.68626 7.99724 4.68667 5.68942 6.06885 4.19487C6.12268 4.13671 6.18789 4.07306 6.28706 3.9739L8.24541 2.01416C8.34478 1.91479 8.41018 1.85055 8.46845 1.79665C9.96301 0.414902 12.2689 0.414922 13.7635 1.79665C13.8217 1.85051 13.8866 1.91559 13.9858 2.01486C14.0849 2.11394 14.1502 2.17769 14.204 2.23583C15.5861 3.7304 15.5866 6.03823 14.2047 7.53291C14.1508 7.59125 14.0854 7.65638 13.9858 7.75595L12.1994 9.54098C12.2614 8.92982 12.2185 8.30587 12.0634 7.69657L12.9956 6.76573C13.1044 6.65692 13.1458 6.61529 13.1765 6.58205C14.0621 5.62404 14.0621 4.1454 13.1765 3.18738C13.1458 3.15419 13.104 3.1135 12.9956 3.00508C12.8877 2.89716 12.8471 2.85551 12.814 2.82485C11.8559 1.9389 10.376 1.93886 9.41794 2.82485C9.38479 2.85554 9.34381 2.89622 9.23564 3.00439L7.27728 4.96413C7.16875 5.07265 7.12708 5.11322 7.09636 5.14643C6.21074 6.10441 6.21153 7.58236 7.09705 8.5404C7.12775 8.57357 7.16826 8.61575 7.27659 8.72408C7.38456 8.83205 7.42647 8.87227 7.45958 8.90293C7.62849 9.0591 7.81309 9.1881 8.00856 9.28894L6.98795 10.3095C6.82111 10.1978 6.66052 10.0715 6.50872 9.93114C6.45057 9.87733 6.38547 9.81341 6.28637 9.71431C6.1871 9.61504 6.12202 9.55018 6.06816 9.49196Z' },
      ],
      copy: [
        { d: 'M6.14929 4.02032C7.11197 4.02032 7.87983 4.02016 8.49597 4.07598C9.12128 4.13269 9.65792 4.25188 10.1415 4.53106C10.7202 4.8653 11.2008 5.3459 11.535 5.92462C11.8142 6.40818 11.9334 6.94481 11.9901 7.57012C12.0459 8.18625 12.0458 8.95419 12.0458 9.9168C12.0458 10.8795 12.0459 11.6473 11.9901 12.2635C11.9334 12.8888 11.8142 13.4254 11.535 13.909C11.2008 14.4877 10.7202 14.9683 10.1415 15.3025C9.65792 15.5817 9.12128 15.7009 8.49597 15.7576C7.87984 15.8134 7.11196 15.8133 6.14929 15.8133C5.18667 15.8133 4.41874 15.8134 3.80261 15.7576C3.1773 15.7009 2.64067 15.5817 2.1571 15.3025C1.5784 14.9683 1.09778 14.4877 0.76355 13.909C0.484366 13.4254 0.365184 12.8888 0.308472 12.2635C0.252649 11.6473 0.252808 10.8795 0.252808 9.9168C0.252808 8.95418 0.252664 8.18625 0.308472 7.57012C0.365184 6.94481 0.484366 6.40818 0.76355 5.92462C1.09777 5.34589 1.57839 4.86529 2.1571 4.53106C2.64067 4.25188 3.1773 4.13269 3.80261 4.07598C4.41874 4.02017 5.18666 4.02032 6.14929 4.02032ZM6.14929 5.37774C5.16181 5.37774 4.46634 5.37761 3.92566 5.42657C3.39434 5.47472 3.07859 5.56574 2.83582 5.70587C2.4632 5.92106 2.15354 6.2307 1.93835 6.60333C1.79823 6.8461 1.70721 7.16185 1.65906 7.69317C1.6101 8.23385 1.61023 8.92933 1.61023 9.9168C1.61023 10.9043 1.61009 11.5998 1.65906 12.1404C1.70721 12.6717 1.79823 12.9875 1.93835 13.2303C2.15356 13.6029 2.46321 13.9126 2.83582 14.1277C3.07859 14.2679 3.39434 14.3589 3.92566 14.407C4.46634 14.456 5.16182 14.4559 6.14929 14.4559C7.13682 14.4559 7.83224 14.456 8.37292 14.407C8.90425 14.3589 9.21999 14.2679 9.46277 14.1277C9.83535 13.9126 10.145 13.6029 10.3602 13.2303C10.5004 12.9875 10.5914 12.6717 10.6395 12.1404C10.6885 11.5998 10.6884 10.9043 10.6884 9.9168C10.6884 8.92934 10.6885 8.23384 10.6395 7.69317C10.5914 7.16185 10.5004 6.8461 10.3602 6.60333C10.1451 6.23071 9.83536 5.92107 9.46277 5.70587C9.21999 5.56574 8.90424 5.47472 8.37292 5.42657C7.83224 5.3776 7.13682 5.37774 6.14929 5.37774ZM9.80164 0.367975C10.7638 0.367975 11.5314 0.36788 12.1473 0.423639C12.7726 0.480307 13.3093 0.598759 13.7928 0.877741C14.3717 1.21192 14.8521 1.69355 15.1864 2.27227C15.4655 2.75574 15.5857 3.29164 15.6425 3.9168C15.6983 4.53301 15.6971 5.3016 15.6971 6.26446V7.82989C15.6971 8.29264 15.6989 8.58993 15.6649 8.84844C15.4668 10.3525 14.401 11.5738 12.9833 11.9988V10.5467C13.6973 10.1903 14.2105 9.49662 14.3192 8.67169C14.3387 8.52347 14.3407 8.3358 14.3407 7.82989V6.26446C14.3407 5.27706 14.3398 4.58149 14.2909 4.04083C14.2428 3.50968 14.1526 3.19372 14.0126 2.95098C13.7974 2.57849 13.4876 2.26869 13.1151 2.05352C12.8724 1.91347 12.5564 1.82237 12.0253 1.77423C11.4847 1.72528 10.7888 1.7254 9.80164 1.7254H7.71472C6.7562 1.72558 5.92665 2.27697 5.52332 3.07891H4.07019C4.54221 1.51132 5.9932 0.368186 7.71472 0.367975H9.80164Z' },
      ],
      download: [
        { d: 'M15.3695 11.411L15.1234 12.8866C14.8869 14.3042 13.6603 15.3436 12.223 15.3436H3.77673C2.33958 15.3434 1.1128 14.3042 0.876343 12.8866L0.630249 11.411L2.05408 11.1747L2.29919 12.6493C2.41973 13.3713 3.04475 13.9001 3.77673 13.9003H12.223C12.9551 13.9002 13.58 13.3713 13.7006 12.6493L13.9457 11.1747L15.3695 11.411ZM8.72205 8.994C8.77717 8.93934 8.83792 8.88106 8.90271 8.81627L12.4828 5.23424L13.5043 6.25572L9.92224 9.8358C9.6395 10.1185 9.38763 10.3732 9.15857 10.5575C8.91892 10.7503 8.63953 10.9224 8.2865 10.9784C8.09711 11.0083 7.90363 11.0083 7.71423 10.9784C7.36106 10.9224 7.0809 10.7503 6.84119 10.5575C6.61215 10.3732 6.36022 10.1185 6.07751 9.8358L2.49646 6.25572L3.51697 5.23424L7.09705 8.81627C7.16219 8.88142 7.22331 8.94006 7.27869 8.99498V1.3065H8.72205V8.994Z' },
      ],
      trash: [
        { d: 'M14.4782 4.84067L14.2138 10.1152C14.1102 12.1872 14.067 13.0115 13.3866 13.9607C13.1044 14.3546 12.7498 14.6912 12.3424 14.9535C11.8239 15.2872 11.2415 15.4316 10.5585 15.4998C9.88727 15.5668 9.04946 15.5656 7.99998 15.5656C6.95051 15.5656 6.1127 15.5668 5.44142 15.4998C4.75851 15.4316 4.17602 15.2872 3.65753 14.9535C3.25012 14.6912 2.89559 14.3546 2.61332 13.9607C1.93296 13.0115 1.88979 12.1872 1.78619 10.1152L1.52179 4.84067L2.89006 4.77277L3.15343 10.0463C3.26221 12.2218 3.32452 12.6015 3.72646 13.1624C3.90825 13.4161 4.13686 13.6334 4.39927 13.8023C4.66204 13.9714 5.00263 14.0792 5.57825 14.1367C6.16562 14.1953 6.92298 14.1963 7.99998 14.1963C9.07699 14.1963 9.83434 14.1953 10.4217 14.1367C10.9973 14.0792 11.3379 13.9714 11.6007 13.8023C11.8631 13.6334 12.0917 13.4161 12.2735 13.1624C12.6755 12.6015 12.7378 12.2218 12.8465 10.0463L13.1099 4.77277L14.4782 4.84067ZM5.43011 6.22849H6.7994V11.3909H5.43011V6.22849ZM9.20056 6.22849H10.5699V11.3909H9.20056V6.22849ZM8.53597 0.434431C9.17976 0.434431 9.6522 0.426926 10.0966 0.571258C10.2357 0.616451 10.3717 0.672554 10.502 0.738948C10.9182 0.951107 11.2464 1.29099 11.7015 1.74612L12.4978 2.54136H15.3742V3.91169H0.625732V2.54136H3.50218L4.29845 1.74612C4.75358 1.29099 5.08174 0.951107 5.49801 0.738948C5.62831 0.672554 5.76425 0.616451 5.90334 0.571258C6.34776 0.426926 6.82021 0.434431 7.46399 0.434431H8.53597ZM7.46399 1.80476C6.73208 1.80476 6.51641 1.81187 6.32617 1.87369C6.25545 1.89667 6.18668 1.92533 6.12041 1.95907C5.96398 2.03878 5.82348 2.16253 5.44142 2.54136H10.5585C10.1765 2.16253 10.036 2.03878 9.87955 1.95907C9.81329 1.92533 9.74452 1.89667 9.6738 1.87369C9.48356 1.81187 9.26789 1.80476 8.53597 1.80476H7.46399Z' },
      ],
      pen: [
        { d: 'M10.8239 3.54733V4.78443H4.63437V3.54733H10.8239Z' },
        { d: 'M10.8239 6.12629V7.36338H4.63437V6.12629H10.8239Z' },
        { d: 'M9.073 8.70524V9.94234H4.63437V8.70524H9.073Z' },
        { d: 'M9.13321 0.573526C10.0076 0.573525 10.7179 0.572522 11.285 0.63397C11.8645 0.696791 12.3743 0.831648 12.8193 1.1548C13.0776 1.34246 13.3056 1.57047 13.4933 1.82875C13.8164 2.2737 13.9513 2.7836 14.0141 3.36303C14.0755 3.93015 14.0745 4.64049 14.0745 5.51485V6.1757L12.7327 7.5629V5.51485C12.7327 4.61092 12.732 3.9862 12.6803 3.5081C12.6298 3.0427 12.5379 2.79497 12.4083 2.61654C12.3033 2.47211 12.176 2.34472 12.0315 2.23977C11.8531 2.11016 11.6054 2.01823 11.14 1.96777C10.6618 1.91601 10.0372 1.91539 9.13321 1.91539H6.32658C5.42262 1.91539 4.79796 1.91604 4.31983 1.96777C3.85451 2.01819 3.60672 2.11029 3.42827 2.23977C3.28392 2.34465 3.15643 2.47223 3.0515 2.61654C2.9219 2.79496 2.82997 3.04274 2.7795 3.5081C2.72774 3.9862 2.72712 4.61092 2.72712 5.51485V10.023C2.72712 10.9273 2.72773 11.5525 2.7795 12.0307C2.82992 12.4959 2.92205 12.7429 3.0515 12.9213C3.15645 13.0657 3.28384 13.1931 3.42827 13.2981C3.60676 13.4277 3.85408 13.5206 4.31983 13.5711C4.79797 13.6228 5.42259 13.6234 6.32658 13.6234H6.87057L5.57707 14.9593C5.03527 14.9556 4.57031 14.9467 4.17476 14.9039C3.59508 14.841 3.08558 14.7063 2.64048 14.383C2.38215 14.1953 2.15422 13.9684 1.96653 13.7101C1.64319 13.2649 1.50851 12.7546 1.4457 12.1748C1.38432 11.6076 1.38525 10.8974 1.38525 10.023V5.51485C1.38525 4.64049 1.38426 3.93015 1.4457 3.36303C1.50853 2.78363 1.64341 2.27368 1.96653 1.82875C2.15417 1.57059 2.38228 1.34239 2.64048 1.1548C3.08544 0.831805 3.59533 0.696762 4.17476 0.63397C4.74193 0.572552 5.45218 0.573525 6.32658 0.573526H9.13321Z' },
        { d: 'M14.2193 14.9553H10.0124L11.3744 13.6134H14.2193V14.9553Z' },
        { d: 'M8.24493 13.3711L7.49015 14.8806C7.40148 15.058 7.58961 15.2461 7.76695 15.1574L9.27651 14.4027L14.6147 9.09934L13.5832 8.06775L8.24493 13.3711Z' },
      ],
      plus: [
        { d: 'M8.64453 1.5V7.34961H14.5V8.65039H8.64453V14.5H7.34473V8.65039H1.5V7.34961H7.34473V1.5H8.64453Z' },
      ],
      ellipsis: [
        { d: 'M4.55146 8.00001C4.55146 8.63513 4.03659 9.15001 3.40146 9.15001C2.76634 9.15001 2.25146 8.63513 2.25146 8.00001C2.25146 7.36488 2.76634 6.85001 3.40146 6.85001C4.03659 6.85001 4.55146 7.36488 4.55146 8.00001Z' },
        { d: 'M9.1476 8.00001C9.1476 8.63513 8.63273 9.15001 7.9976 9.15001C7.36248 9.15001 6.8476 8.63513 6.8476 8.00001C6.8476 7.36488 7.36248 6.85001 7.9976 6.85001C8.63273 6.85001 9.1476 7.36488 9.1476 8.00001Z' },
        { d: 'M13.7486 8.00001C13.7486 8.63513 13.2338 9.15001 12.5986 9.15001C11.9635 9.15001 11.4486 8.63513 11.4486 8.00001C11.4486 7.36488 11.9635 6.85001 12.5986 6.85001C13.2338 6.85001 13.7486 7.36488 13.7486 8.00001Z' },
      ],
      check: [
        { d: 'M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C5.97266 11.8467 6.12256 11.9853 6.24023 12.0908C6.28475 12.1321 6.32075 12.1665 6.34814 12.1946C6.64779 12.5296 6.90918 12.7046 7.16455 12.5686C7.44446 12.4209 7.71518 12.1386 8.04053 11.7513L14.1113 4.92578L15.0498 3.92579Z' },
      ],
    }
    const Icon = (name, size) => React.createElement('svg', {
      // size must be a NUMBER: React 18 invokes function components as
      // (props, ref), so a positional `size` that ever lands in the ref slot
      // becomes {} — width="[object Object]" falls back to the 300×150 svg
      // default (the "huge icon" regression in the picker rows).
      width: typeof size === 'number' ? size : 14, height: typeof size === 'number' ? size : 14, viewBox: '0 0 16 16', fill: 'none',
      style: { flexShrink: 0, display: 'block' }, 'aria-hidden': true,
    },
      (ICON[name] || []).map((spec, i) => {
        const attrs = { key: i, d: spec.d, fill: 'currentColor' }
        if (spec.opacity != null) attrs.opacity = spec.opacity
        if (spec.transform) attrs.transform = spec.transform
        if (spec.fillRule) { attrs.fillRule = spec.fillRule; attrs.clipRule = spec.clipRule }
        return React.createElement('path', attrs)
      }),
    )
    // Wrappers kept for the picker's listing rows (same glyphs as before).
    // These are PLAIN FACTORIES — call them directly (IconFolder(false)),
    // never via React.createElement: React would call them as (props, ref),
    // making the positional `size` the ref object → 300×150 default svg.
    const IconFolder = (open, size) => Icon(open ? 'folder-open' : 'folder', size || 14)
    const IconFile = (size) => Icon('code', size || 14)

    // Pure-DOM variant of Icon() for the context-menu portal (a React node
    // cannot be appended to the document.body-hosted menu).
    function makeIconSvg(name, size) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('width', String(size))
      svg.setAttribute('height', String(size))
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('fill', 'none')
      for (const spec of ICON[name] || []) {
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        p.setAttribute('d', spec.d)
        p.setAttribute('fill', 'currentColor')
        if (spec.opacity != null) p.setAttribute('opacity', String(spec.opacity))
        if (spec.transform) p.setAttribute('transform', spec.transform)
        if (spec.fillRule) { p.setAttribute('fill-rule', spec.fillRule); p.setAttribute('clip-rule', spec.clipRule) }
        svg.appendChild(p)
      }
      return svg
    }

    // Scoped styles for the explorer + file tabs (injected once, idempotent).
    // Mirrors the better-sidebar file side (sidebar.module.css explorer /
    // editor vocabulary) riding the same DSH tokens.
    const DRX_CSS = [
      // Tree rows: 34px VSCode-style rows, 8px radius, mount fade, hover fill.
      '.drx-row{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;max-width:100%;height:34px;padding:0 8px;border:none;background-color:transparent;font:var(--dsw-font-s-14,14px/22px var(--dsw-font-family,system-ui,sans-serif));color:var(--dsw-alias-label-primary,#e4e4e7);text-align:left;cursor:pointer;white-space:nowrap;border-radius:8px;animation:drx-row-in 150ms var(--ds-ease-in-out,ease)}',
      '.drx-row:hover{background-color:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}',
      '.drx-row:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-hover-accent,#4176e6);outline-offset:-1px}',
      '@keyframes drx-row-in{from{opacity:0}}',
      '.drx-dir{font:var(--dsw-font-s-strong-14,500 14px/22px var(--dsw-font-family,system-ui,sans-serif))}',
      '.drx-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.drx-hidden{opacity:.45}',
      '.drx-link{flex:none;display:inline-flex;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.7))}',
      '.drx-meta{flex:none;font:var(--dsw-font-xxxs-11,11px/14px var(--dsw-font-family,system-ui,sans-serif));color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.7))}',
      '.drx-copied{flex:none;font:var(--dsw-font-xxxs-strong-11,500 11px/14px var(--dsw-font-family,system-ui,sans-serif));color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.7))}',
      // The hover-revealed @-reference pill (same as the local tree's).
      '.drx-ref{flex:none;display:none;align-items:center;height:20px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.15));border-radius:999px;background:var(--dsw-alias-bg-layer-2,#1e1e1e);color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.7));font:var(--dsw-font-xxxs-strong-11,500 11px/14px var(--dsw-font-family,system-ui,sans-serif));cursor:pointer;transition:background-color .12s ease,color .12s ease}',
      '.drx-row:hover .drx-ref,.drx-row:focus-within .drx-ref{display:inline-flex}',
      '.drx-ref:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));color:var(--dsw-alias-label-primary,#e4e4e7)}',
      '.drx-ref:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-hover-accent,#4176e6);outline-offset:-1px}',
      // Toolbar / header icon buttons + compact action buttons.
      '.drx-iconbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.72));cursor:pointer;transition:background-color .12s ease,color .12s ease}',
      '.drx-iconbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));color:var(--dsw-alias-label-primary,#e4e4e7)}',
      '.drx-iconbtn:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-hover-accent,#4176e6);outline-offset:-1px}',
      '.drx-iconbtn:disabled{opacity:.4;cursor:not-allowed}',
      '.drx-btn{flex:none;display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.15));border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.72));font:var(--dsw-font-xxs-strong-12,500 12px/18px var(--dsw-font-family,system-ui,sans-serif));cursor:pointer;transition:background-color .12s ease,color .12s ease}',
      '.drx-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));color:var(--dsw-alias-label-primary,#e4e4e7)}',
      '.drx-btn:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-hover-accent,#4176e6);outline-offset:-1px}',
      '.drx-btn:disabled{opacity:.4;cursor:not-allowed}',
      '.drx-btn-primary{background:var(--dsw-alias-button-primary-fill,#2563eb);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '.drx-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#1d4ed8);color:var(--dsw-alias-label-primary-foreground,#fff)}',
      // Context menu (portal): DSH menu card + compact menu rows.
      '.drx-menu{box-sizing:border-box;min-width:190px;padding:4px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-3,#242428));border:1px solid var(--dsw-alias-border-inverted,rgba(255,255,255,.06));border-radius:12px;box-shadow:var(--dsw-shadow-lv3,0 12px 32px rgba(0,0,0,.08))}',
      '.drx-menurow{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:5px 10px;border:none;border-radius:10px;background:transparent;text-align:left;cursor:pointer;font:var(--dsw-font-xxs-12,12px/18px var(--dsw-font-family,system-ui,sans-serif));color:var(--dsw-alias-label-primary,#e4e4e7);transition:background-color .12s ease}',
      '.drx-menurow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}',
      '.drx-menurow:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-hover-accent,#4176e6);outline-offset:-2px}',
      '.drx-danger{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.drx-danger:hover{background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#dc2626) 12%, transparent);color:var(--dsw-alias-state-error-primary,#dc2626)}',
      // Caption / footer / error / empty rows.
      '.drx-caption{flex:none;padding:4px 12px;font:var(--dsw-font-xxxs-11,11px/14px var(--dsw-font-family,system-ui,sans-serif));color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.7))}',
      '.drx-footer{flex:none;display:flex;align-items:center;gap:6px;min-width:0;padding:4px 10px 6px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.15));font:var(--dsw-font-xxxs-11,11px/14px var(--dsw-font-family,system-ui,sans-serif));color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.7));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.drx-error{flex:none;padding:4px 12px;font:var(--dsw-font-xxs-12,12px/18px var(--dsw-font-family,system-ui,sans-serif));color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.drx-empty{padding:16px;font:var(--dsw-font-xxs-12,12px/18px var(--dsw-font-family,system-ui,sans-serif));color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.7));text-align:center}',
      '.drx-banner{flex:none;padding:4px 8px;font:var(--dsw-font-xxxs-11,11px/14px var(--dsw-font-family,system-ui,sans-serif));color:var(--dsw-alias-state-warn-label,#e6c07b);background:var(--dsw-alias-state-warn-tertiary,rgba(230,192,123,.12))}',
    ].join('\n')

    const ensureDshCss = (id, css) => {
      if (typeof document === 'undefined' || document.getElementById(id)) return
      const el = document.createElement('style')
      el.id = id
      el.textContent = css
      document.head.appendChild(el)
    }

    // VSCode-style indent guides: a 1px vertical stroke under every expanded
    // ancestor at that ancestor's icon column (22px step + 6px base inset),
    // plus a horizontal corner on expanded DIRECTORY rows — painted as inline
    // background longhands so the stylesheet's hover fill (background-color)
    // keeps working underneath. Mirrors the built-in tree's guide painter.
    const GUIDE_STROKE = 'color-mix(in srgb, var(--dsw-alias-border-l1, rgba(128,128,128,.15)) 70%, transparent)'
    const INDENT_STEP = 22
    const INDENT_BASE = 6
    function treeGuides(depth, isOpenDir) {
      if (depth <= 0) return {}
      const image = []
      const size = []
      const position = []
      const repeat = []
      if (isOpenDir) {
        const from = (depth - 1) * INDENT_STEP + INDENT_BASE
        image.push(`linear-gradient(0deg, transparent 16.5px, ${GUIDE_STROKE} 16.5px, ${GUIDE_STROKE} 17.5px, transparent 17.5px)`)
        size.push(`${INDENT_STEP}px 100%`)
        position.push(`${from}px 0`)
        repeat.push('no-repeat')
      }
      for (let k = 0; k < depth; k++) {
        const x = k * INDENT_STEP + INDENT_BASE
        image.push(`linear-gradient(90deg, transparent ${x}px, ${GUIDE_STROKE} ${x}px, ${GUIDE_STROKE} ${x + 1}px, transparent ${x + 1}px)`)
        size.push('100% 100%')
        position.push('0px 0px')
        repeat.push('no-repeat')
      }
      return {
        backgroundImage: image.join(', '),
        backgroundSize: size.join(', '),
        backgroundPosition: position.join(', '),
        backgroundRepeat: repeat.join(', '),
      }
    }

    // Issue #32: the remote tree's expansion list travels on the TAB (`meta`),
    // never on better-sidebar's session-shared `expanded` array. Best-effort:
    // an older sidebar without tab meta simply forgets the expansion on reload.
    const TAB_EXPANDED_META = 'remoteExpanded'
    /** The tab's persisted expansion list, or null when the tab records none
     *  (so a caller can tell "never expanded" from "expanded then collapsed
     *  everything"). */
    function readTabExpanded(tab) {
      try {
        const meta = tab && tab.meta
        if (!meta || typeof meta !== 'object' || !(TAB_EXPANDED_META in meta)) return null
        const list = meta[TAB_EXPANDED_META]
        return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : []
      } catch { return null }
    }
    /** Fallback store when the sidebar predates tab meta (no persistence then,
     *  but the tree still opens and closes within the page's lifetime). */
    const tabExpandedFallback = new Map()
    function tabExpandedOf(tab) {
      const fromMeta = readTabExpanded(tab)
      if (fromMeta !== null) return fromMeta
      const id = tab && tab.id
      return (id && tabExpandedFallback.get(id)) || []
    }
    function toggleTabExpanded(ctx, tab, path) {
      const cur = tabExpandedOf(tab)
      const next = cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path]
      const id = tab && tab.id
      if (id) tabExpandedFallback.set(id, next)
      try {
        if (!ctx || !tab || !id || typeof ctx.get !== 'function') return next
        const bs = ctx.get('betterSidebar')
        if (!bs || typeof bs.updateTab !== 'function') return next
        const meta = tab.meta && typeof tab.meta === 'object' ? tab.meta : {}
        bs.updateTab(id, { meta: { ...meta, [TAB_EXPANDED_META]: next } })
      } catch { /* expansion memory is best-effort */ }
      return next
    }

    // Issue #32 healing, kept pure so it is directly testable: an older
    // dsh-remote pushed REMOTE paths into better-sidebar's session-shared
    // `expanded` set through onToggleDir. That set is PERSISTED (localStorage
    // `dsh-sidebar:v1:<sessionId>`) and the built-in local Files tree loads
    // every entry through a LOCAL fs.realpath, so those remote paths kept
    // failing with ENOENT until the set was cleaned.
    //
    // Return exactly the entries this tree owns: the current remote root and
    // anything under it. That range is remote-only by construction (the root
    // comes from resolve-mirror), so a legitimate local directory cannot
    // match. A LOCAL MIRROR path is never evicted — on a host whose own home is
    // an ancestor of the remote root (a macOS host driving a macOS remote) the
    // mirror under $DSH_HOME/remote-workspaces would otherwise fall inside it.
    //
    // On a WINDOWS host the sweep is broader and complete: a POSIX-absolute
    // entry (`/home/...`) can never be a valid local path there (Windows paths
    // are drive- or UNC-rooted), which is exactly why the bug only bit Windows.
    // That also cleans pollution left by an earlier remote root, which no
    // per-root rule could find.
    function isPosixAbsolutePath(p) {
      return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//')
    }
    function windowsHost() {
      try {
        const nav = typeof navigator !== 'undefined' ? navigator : null
        if (!nav) return false
        if (nav.userAgentData && typeof nav.userAgentData.platform === 'string') {
          return /win/i.test(nav.userAgentData.platform)
        }
        if (typeof nav.platform === 'string' && nav.platform) return /win/i.test(nav.platform)
        return typeof nav.userAgent === 'string' && /windows/i.test(nav.userAgent)
      } catch { return false }
    }
    function strayRemoteSharedPaths(root, shared, hostIsWindows = windowsHost()) {
      if (!Array.isArray(shared) || !shared.length) return []
      let prefix = ''
      if (typeof root === 'string' && root !== '' && root !== '/') prefix = root.replace(/[\\/]+$/, '')
      const isMirror = (p) => p.includes('/remote-workspaces/') || p.includes('\\remote-workspaces\\')
      return shared.filter((p) => {
        if (typeof p !== 'string' || p === '' || isMirror(p)) return false
        if (prefix !== '' && (p === prefix || p === root ||
          p.startsWith(prefix + '/') || p.startsWith(prefix + '\\'))) return true
        return hostIsWindows && isPosixAbsolutePath(p)
      })
    }

    // Issue #32: the remote tree must NOT use better-sidebar's `expanded` /
    // `onToggleDir` props. That pair is the SESSION-shared expansion set, which
    // the built-in local Files tree also reads and loads as local directories
    // through /sidebar/api fs.tree. Feeding it remote paths (/home/...) made the
    // core tree run a LOCAL fs.realpath on them; on win32 a POSIX path counts as
    // absolute (drive-rooted), so it resolved to `D:\home\...` and failed with
    // ENOENT. Own the expansion here and persist it on the tab instead.
    //
    // Because that shared set is PERSISTED, an already-affected user stays
    // broken across reloads, so the stray entries are also migrated eagerly (see
    // migratePollutedSidebarState) and healed again from the tab (below).
    const SIDEBAR_STATE_PREFIX = 'dsh-sidebar:v1:'
    /**
     * Strip remote paths a pre-fix dsh-remote left in PERSISTED sidebar state,
     * before the built-in Files tree loads them. Only entries that cannot be a
     * valid local path on this host are removed (see strayRemoteSharedPaths).
     * Best-effort: any storage failure just leaves the tab-level healing to do
     * the job on the next load.
     *
     * @param storage - a Storage-like object (window.localStorage).
     * @param hostIsWindows - overrides host detection (tests).
     * @returns how many stray entries were removed.
     */
    function migratePollutedSidebarState(storage, hostIsWindows = windowsHost()) {
      if (!storage || typeof storage.length !== 'number') return 0
      let cleaned = 0
      try {
        const keys = []
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i)
          if (key && key.startsWith(SIDEBAR_STATE_PREFIX)) keys.push(key)
        }
        for (const key of keys) {
          const raw = storage.getItem(key)
          if (typeof raw !== 'string' || raw === '') continue
          let parsed
          try { parsed = JSON.parse(raw) } catch { continue }
          if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.expanded)) continue
          const stray = strayRemoteSharedPaths('', parsed.expanded, hostIsWindows)
          if (!stray.length) continue
          const drop = new Set(stray)
          parsed.expanded = parsed.expanded.filter((p) => !drop.has(p))
          storage.setItem(key, JSON.stringify(parsed))
          cleaned += stray.length
        }
      } catch { /* storage unavailable: the tab-level healing still runs */ }
      return cleaned
    }

    // `evictStray` heals state an older dsh-remote already polluted: the tree
    // calls it once it knows its remote root, and it drops exactly those paths
    // from the shared set. It is a plain function (not an effect) so the rule is
    // directly testable.
    function RemoteExplorerTabOwned(props) {
      const [expanded, setExpanded] = React.useState(tabExpandedOf(props.tab))
      const sharedExpanded = Array.isArray(props.expanded) ? props.expanded : []
      const evictShared = typeof props.onToggleDir === 'function' ? props.onToggleDir : null
      // Heal without needing the remote root: on a Windows host a POSIX-absolute
      // entry can never be a valid local path, so the sweep is complete there.
      // (The root-scoped sweep for the session's own remote tree runs inside the
      // tab, which is where the resolved root becomes known.)
      const sharedKey = sharedExpanded.join('\u0000')
      React.useEffect(() => {
        if (!evictShared) return
        const stray = strayRemoteSharedPaths('', sharedKey ? sharedKey.split('\u0000') : [])
        for (const p of stray) evictShared(p)
      }, [sharedKey, evictShared])
      // Explicitly drop the framework's session-shared pair from the child.
      const owned = { ...props }
      delete owned.expanded
      delete owned.onToggleDir
      return React.createElement(RemoteExplorerTab, {
        ...owned,
        evictStray: (root) => {
          if (!evictShared || !sharedExpanded.length) return []
          const stray = strayRemoteSharedPaths(root, sharedExpanded)
          for (const p of stray) evictShared(p)
          return stray
        },
        expanded,
        onToggleDir: (path) => setExpanded(toggleTabExpanded(props.ctx, props.tab, path)),
      })
    }

    // Tree-style remote file explorer. Data is listed live from the remote host
    // over /dsh-remote/ls, rooted at this session's remote workspace dir.
    // Tree-style remote file explorer, restyled on the built-in local file
    // tree (the better-sidebar "file side"): 34px rows with the 22px indent
    // step and VSCode-style guide lines, DSH font/alias tokens, a
    // hover-revealed @-reference pill, dotfiles dimmed, and a DSH-styled
    // context menu. Expansion is DUAL-TRACK: in tab mode the framework's
    // own `expanded` / `onToggleDir` contract applies (it manages + persists
    // the expanded set, matching the local files tab); in fileTreeSection
    // top-module mode NO framework callbacks are wired, so the component
    // maintains its own expansion state and syncs it to the remote by
    // loading each opened dir through /dsh-remote/ls. Data is always listed
    // live from the remote host, rooted at this session's remote workspace
    // dir.
    function RemoteExplorerTab(props) {
      const [status, setStatus] = React.useState(null)
      const [root, setRoot] = React.useState('') // remote root path for this session
      const [data, setData] = React.useState({}) // dir -> { entries | error | loading }
      const dataRef = React.useRef(data)
      const [err, setErr] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [reconnecting, setReconnecting] = React.useState(false)
      const [picker, setPicker] = React.useState(false)
      const [menu, setMenu] = React.useState(null) // { x, y, path, isDir, name }
      const [rootOpen, setRootOpen] = React.useState(true) // first level expanded by default
      /** Row whose path was just copied — shows a brief「已复制」label. */
      const [copiedPath, setCopiedPath] = React.useState('')
      const [namePrompt, setNamePrompt] = React.useState(null) // { kind, path, name }
      React.useEffect(() => { ensureChromeCss() }, [])
      const expanded = Array.isArray(props.expanded) ? props.expanded : []
const scopeCwd = props.scope && props.scope.cwd
      const sessionId = props.scope && props.scope.sessionId
      // Tab mode: the better-sidebar framework owns the expansion state
      // (props.expanded + props.onToggleDir, persisted in tab meta). Section
      // mode (fileTreeSection top module): the framework wires NO toggle
      // callbacks — the expansion state is OURS, maintained here and synced
      // to the remote by loading each opened dir through /dsh-remote/ls.
      const frameworkExpanded = typeof props.onToggleDir === 'function'
      const [localOpen, setLocalOpen] = React.useState([])
      // The dirs currently expanded: framework-driven in tab mode, internal
      // in section mode.
      const openDirs = () => (frameworkExpanded ? expanded : localOpen)
      const isExpanded = (p) => openDirs().includes(p)
      const toggleDir = (p) => {
        if (frameworkExpanded) {
          // Tab mode: hand the toggle to the framework (it owns expanded +
          // persistence); loading follows the expanded effect below.
          props.onToggleDir(p)
          return
        }
        // Section mode: our own state; the effect below loads the content
        // (remote listing) whenever the open set changes.
        setLocalOpen((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]))
      }

      // Scoped styles (idempotent across tabs / hot reloads).
      React.useEffect(() => { ensureDshCss('dsh-remote-drx-css', DRX_CSS) }, [])

      const storeLevel = (path, level) => {
        dataRef.current = { ...dataRef.current, [path]: level }
        setData(dataRef.current)
      }

      const loadDir = React.useCallback((dir, opts) => {
        const cur = dataRef.current
        // A level that is already present — LOADED or IN-FLIGHT — is never
        // re-entered. Re-entering a pending level would write { loading }
        // back into state and start ANOTHER fetch on every effect re-run
        // (host re-renders that hand the tab a fresh `expanded` identity
        // while the listing is still pending) — a loading→loading write-
        // back loop that never converges until the fetch lands. Explicit
        // refreshes always wipe the cache (dataRef.current = {} + setData)
        // FIRST, so a wipe is the ONLY way a level reloads.
        if (cur[dir] !== undefined) return
        storeLevel(dir, { loading: true })
        listRemoteDir(dir, sessionId)
          .then((res) => {
            // A missing dir / malformed listing must NEVER render as an
            // empty success — the host FileTree shows nothing for
            // `{entries: []}` (the "loading flash then blank" symptom), so
            // every real failure becomes an explicit error row instead.
            if (res && res.missing) {
              const msg = 'cannot list ' + dir + ': directory missing'
              console.error('[dsh-remote] ' + msg)
              storeLevel(dir, { error: msg })
              return
            }
            if (!res || !Array.isArray(res.items)) {
              const msg = 'cannot list ' + dir + ': ' + ((res && res.error) ? String(res.error) : 'empty listing response')
              console.error('[dsh-remote] ' + msg)
              storeLevel(dir, { error: msg })
              return
            }
            const sorted = sortRemoteEntries(res.items)
            storeLevel(dir, { entries: sorted })
          })
          .catch((e) => {
            // Keep any previously-loaded entries under this dir (so a transient
            // SFTP failure doesn't collapse the whole subtree); surface a
            // message only when there was nothing to show before. Credential
            // failures get the actionable guidance row (reconnect button).
            console.error('[dsh-remote] cannot list ' + dir + ':', (e && e.message) || e)
            const msg = (e && e.credential) ? tr('explorer.reconnectCredential') : String((e && e.message) || e)
            const prev = dataRef.current[dir]
            if (prev && prev.entries) {
              storeLevel(dir, { ...prev, softError: msg })
            } else {
              storeLevel(dir, { error: msg })
            }
          })
      }, [sessionId])

      // Resolve this session's remote root, then load it and every expanded dir.
      // Re-runs whenever the session scope changes (switching conversations, or
      // the async sessionCwd fetch landing), so the sidebar follows the session's
      // own workspace dir.
      const rootRef = React.useRef('')
      const refreshStatus = React.useCallback((opts) => {
        const applyRoot = (r, connected) => {
          const prevRoot = rootRef.current
          rootRef.current = r
          setRoot(r)
          // Full reset ONLY when the session's remote root actually changed
          // (different workspace / different conversation). When we just come
          // back to this tab with the same workspace, keep the loaded tree so
          // expanded dirs and their contents stay put.
          const sameRoot = prevRoot && r && prevRoot === r
          if (!sameRoot) {
            setData({})
            dataRef.current = {}
          }
          if (r) {
            // Not connected (e.g. freshly restarted, machine no longer active):
            // show a clear disconnected state instead of firing ls requests
            // that all fail with AggregateError / 500 in a loop.
            // A bound remote session lists on demand even if this process has
            // not yet opened the SSH socket; only an unbound/disconnected
            // machine-scoped view should show the empty "未连接" state.
            if (!connected && !sessionId) {
              storeLevel(r, { error: tr('explorer.notConnected') })
              return
            }
            if (!sameRoot) {
              storeLevel(r, { loading: true })
            }
            listRemoteDir(r, sessionId)
              .then((res) => {
                // Same rule as loadDir: a missing/malformed root listing is
                // an ERROR row, never a silent empty tree.
                if (res && res.missing) {
                  const msg = 'cannot list ' + r + ': directory missing'
                  console.error('[dsh-remote] ' + msg)
                  storeLevel(r, { error: msg })
                  return
                }
                if (!res || !Array.isArray(res.items)) {
                  const msg = 'cannot list ' + r + ': ' + ((res && res.error) ? String(res.error) : 'empty listing response')
                  console.error('[dsh-remote] ' + msg)
                  storeLevel(r, { error: msg })
                  return
                }
                const sorted = res.items.slice().sort((a, b) => {
                  if (a.type === 'dir' && b.type !== 'dir') return -1
                  if (a.type !== 'dir' && b.type === 'dir') return 1
                  return String(a.name).localeCompare(String(b.name))
                })
                storeLevel(r, { entries: sorted })
                for (const dir of openDirsRef.current()) loadDir(dir, { keep: true })
              })
              .catch((e) => {
                // Transient connection failure: keep the previously visible
                // root level so the tree doesn't collapse to an error.
                console.error('[dsh-remote] cannot list ' + r + ':', (e && e.message) || e)
                const msg = (e && e.credential) ? tr('explorer.reconnectCredential') : String((e && e.message) || e)
                const prev = dataRef.current[r]
                if (prev && prev.entries) {
                  storeLevel(r, { ...prev, softError: msg })
                } else {
                  storeLevel(r, { error: msg })
                }
              })
          }
        }
        const resolveRoot = () => {
          if (scopeCwd) {
            // A resolve-mirror REQUEST failure must not be conflated with
            // the legitimate "this session is local" answer (remotePath ''
            // → the quiet local-session state): surface the request error
            // so the tree never just stays empty for an unknown reason.
            return api('GET', '/dsh-remote/resolve-mirror?local=' + encodeURIComponent(scopeCwd))
              .then((r) => (r && r.remotePath) || '')
              .catch((e) => {
                const msg = String((e && e.message) || e)
                console.error('[dsh-remote] resolve-mirror failed:', msg)
                setErr(tr('explorer.resolveFail', { msg }))
                return ''
              })
          }
          if (sessionId) return resolveSessionRemote(sessionId)
          return Promise.resolve('')
        }
        resolveRoot().then((r) => {
// Session-scoped status so the explorer shows the workspace's OWN
          // machine (mirror owner) — never another project's.
          fetchRemoteStatus(sessionId || undefined).then((s) => {
            setStatus(s)
            // Issue #13: NEVER fall back to the machine-level workspace here —
            // a session whose cwd is not a mirror is a LOCAL session and shows
            // the "no remote workspace" empty state instead.
            applyRoot(r || '', !!(s && (s.connected || (s.host && s.host.length))))
          })
        })
      }, [scopeCwd, sessionId])

      // Force the HOST to re-establish the SSH connection, then re-list
      // everything. This is the cure for the stale/credential-less pool
      // symptom ("远程目录读取失败: browse failed: no credentials…"): the
      // route pool is torn down and rebuilt, re-resolving keychain
      // credentials, so a dropped connection recovers with one click.
      const reconnect = React.useCallback(() => {
        if (reconnecting) return
        const scopeCwd = props.scope && props.scope.cwd
        if (!root && !scopeCwd && !(status && (status.host || status.currentId))) {
          refreshStatus()
          return
        }
        setReconnecting(true)
        apiRaw('POST', '/dsh-remote/reconnect', {
          path: root || undefined,
          workspace: scopeCwd || undefined,
          sessionId: sessionId || undefined,
        })
          .then((r) => {
            if (r.status >= 400) {
              const msg = (r.data && (r.data.error || r.data.message)) ? String(r.data.error || r.data.message) : 'HTTP ' + r.status
              const err = new Error(msg)
              err.credential = !!(r.data && r.data.credential)
              throw err
            }
            return r.data
          })
          .then(() => {
            // Connection re-established: drop the cached tree so every open
            // level re-lists fresh (a plain refreshStatus keeps loaded
            // levels when the root did not change).
            dataRef.current = {}
            setData({})
            setErr('')
            if (root) storeLevel(root, { loading: true })
            return refreshStatus()
          })
          .catch((e) => {
            console.error('[dsh-remote] reconnect failed:', (e && e.message) || e)
            const msg = (e && e.credential) || /no credentials/i.test(String((e && e.message) || e))
              ? tr('explorer.reconnectCredential')
              : String((e && e.message) || e)
            setErr(msg)
            if (root) {
              const prev = dataRef.current[root]
              storeLevel(root, prev && prev.entries ? { ...prev, softError: msg } : { error: msg })
            }
          })
          .finally(() => setReconnecting(false))
      }, [reconnecting, root, status, refreshStatus, sessionId])

      React.useEffect(() => { refreshStatus() }, [refreshStatus])
      React.useEffect(() => { if (props.visible) refreshStatus({ visible: true }) }, [props.visible])
      // Load dirs as they get expanded (keep already-loaded content).
      // Tab mode: driven by the framework's expanded set; section mode:
      // driven by our own localOpen set — both load through the remote.
      const openDirsRef = React.useRef(openDirs)
      openDirsRef.current = openDirs
      React.useEffect(() => { if (root) for (const dir of expanded) loadDir(dir, { keep: true }) }, [root, expanded, loadDir])
// Issue #32 healing: once the remote root is known, drop the paths an
      // older dsh-remote left in better-sidebar's PERSISTED session-shared
      // expansion set (the built-in local tree was loading them through a local
      // fs.realpath and failing). See strayRemoteSharedPaths().
      React.useEffect(() => {
        if (root && typeof props.evictStray === 'function') props.evictStray(root)
      }, [root, props.evictStray])
      React.useEffect(() => { if (root) for (const dir of localOpen) loadDir(dir, { keep: true }) }, [root, localOpen, loadDir])
      // ── Context-menu portal: append to document.body so the sidebar's
      //    overflow/transform cannot clip it. Pure DOM (icons included), no
      //    React portal needed.
      React.useEffect(() => {
        if (!menu) return
        const host = document.createElement('div')
        host.style.cssText = 'position:fixed;z-index:999999;pointer-events:auto'
        const box = document.createElement('div')
        box.className = 'drx-menu'
        box.style.cssText = 'position:fixed;left:' + menu.x + 'px;top:' + menu.y + 'px;z-index:999999'
        const itemIcon = (name, size) => {
          const span = document.createElement('span')
          span.style.cssText = 'flex:none;display:inline-flex'
          span.appendChild(makeIconSvg(name, size || 14))
          return span
        }
        const mkItem = (icon, text, danger, fn) => {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = 'drx-menurow' + (danger ? ' drx-danger' : '')
          if (icon) b.appendChild(itemIcon(icon))
          const t = document.createElement('span')
          t.textContent = text
          t.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left'
          b.appendChild(t)
          b.addEventListener('click', (e) => { e.stopPropagation(); setMenu(null); fn() })
          return b
        }
        box.appendChild(mkItem(menu.isDir ? 'folder-open' : 'code', menu.isDir ? tr('explorer.menuExpand') : tr('explorer.menuOpen'), false, () => { if (menu.isDir) { toggleDir(menu.path) } else openFile(menu.path) }))
        box.appendChild(mkItem('download', tr('explorer.menuDownload'), false, () => doFs('download', { path: menu.path })))
        box.appendChild(mkItem('copy', tr('explorer.menuCopyRel'), false, () => copyPath(relPath(menu.path), menu.path)))
        box.appendChild(mkItem('copy', tr('explorer.menuCopyAbs'), false, () => copyPath(menu.path, menu.path)))
        box.appendChild(mkItem('pen', tr('explorer.menuRename'), false, () => { const nm = window.prompt(tr('explorer.renamePrompt'), menu.name); if (nm && nm.trim() && nm.trim() !== menu.name) doFs('rename', { path: menu.path, dest: joinRemote(String(menu.path).replace(/[\\/][^\\/]*$/, ''), nm.trim()) }, true) }))
        box.appendChild(mkItem('trash', menu.isDir ? tr('explorer.menuDeleteDir') : tr('explorer.menuDelete'), true, () => { if (window.confirm(tr('explorer.deleteConfirm', { path: menu.path }))) doFs('remove', { path: menu.path }, true) }))
        host.appendChild(box)
        document.body.appendChild(host)
        const close = (e) => { if (!box.contains(e.target)) { setMenu(null) } }
        // Delay adding listener so the same mousedown that opened the menu doesn't close it
        const tid = setTimeout(() => document.addEventListener('mousedown', close), 0)
        return () => { clearTimeout(tid); document.removeEventListener('mousedown', close); host.remove() }
      }, [menu])

      const openFile = (p) => {
        const name = String(p).split(/[\\/]/).pop() || p
        if (props.onOpenFile) props.onOpenFile(p)
        else props.ctx.betterSidebar.openTab({ type: SIDEBAR_FILE_ID, title: name, path: p }, props.scope)
      }

      const doFs = (op, payload, refreshParent) => {
        setBusy(op)
        return api('POST', '/dsh-remote/fs', withSessionBody({ op, ...payload }, sessionId))
          .then(() => {
            setErr('')
            if (refreshParent) {
              dataRef.current = {}
              setData({})
              if (root) { storeLevel(root, { loading: true }); loadDir(root) }
              for (const dir of openDirsRef.current()) loadDir(dir)
            }
          })
          .catch((e) => setErr(String((e && e.message) || e)))
          .finally(() => setBusy(''))
      }

      const onCtx = (e, path, isDir, name) => {
        e.preventDefault(); e.stopPropagation()
        setMenu({ x: e.clientX, y: e.clientY, path, isDir, name })
      }

      // The path shown by「复制相对地址」: relative to this session's remote
      // workspace root (mirror of the built-in local tree's cwd-relative copy).
      const relPath = (p) => {
        if (!root) return p
        const r = String(root).replace(/[\\/]+$/, '')
        const s = String(p)
        if (s === r) return '.'
        if (s.startsWith(r + '/')) return s.slice(r.length + 1)
        if (s.startsWith(r + '\\')) return s.slice(r.length + 1)
        return s
      }
      // The MIRROR path is NOT what「@引用」inserts anymore (v0.8.12+): the
      // pill inserts the tagged `@remote:` form, so the model never mistakes
      // a remote file for a local one. relPath stays for「复制相对地址」.
      // Copy `text`, then briefly flag the row whose path was copied.
      const copyPath = (text, path) => {
        copyToClipboard(text).then((ok) => {
          if (!ok) return
          setCopiedPath(path)
          window.setTimeout(() => {
            setCopiedPath((cur) => (cur === path ? '' : cur))
          }, 1200)
        })
      }
      // The @-reference pill inserts the TAGGED REMOTE path (REF_REMOTE +
      // the remote entry path) into the composer — never the raw mirror path,
      // which the model could mistake for a local file (and fail to read
      // when the mirror is not synced).
      /** The hover-revealed @-reference pill (same as the local tree's
       *  row action) — hidden when the framework did not wire
       *  onReferenceFile. Inserts `@remote:<remote path>`. */
      const refPill = (path) => (typeof props.onReferenceFile === 'function' && props.scope && props.scope.cwd
        ? React.createElement('button', {
            type: 'button', className: 'drx-ref',
            title: tr('explorer.reference'), 'aria-label': tr('explorer.reference'),
            onClick: (e) => { e.stopPropagation(); props.onReferenceFile(REF_REMOTE + path) },
          }, tr('explorer.reference'))
        : null)
      /** Row action slot: the brief「已复制」label replaces the pill after a copy. */
      const rowAction = (path) => (copiedPath === path
        ? React.createElement('span', { className: 'drx-copied' }, tr('explorer.copied'))
        : refPill(path))
      /** 「新建目录」toolbar glyph: the harness folder icon with a plus chip. */
      const folderPlusGlyph = () => React.createElement('span', { style: { position: 'relative', display: 'inline-flex', width: 14, height: 14, flexShrink: 0 } },
        React.createElement('span', { style: { position: 'absolute', left: 0, top: 0, display: 'inline-flex' } }, Icon('folder', 14)),
        React.createElement('span', { style: { position: 'absolute', right: -3, bottom: -3, width: 11, height: 11, boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 99, background: 'var(--dsw-alias-bg-layer-2,#1e1e1e)', border: '1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.15))' } },
          React.createElement('svg', { width: 7, height: 7, viewBox: '0 0 16 16', fill: 'none' }, React.createElement('path', { d: ICON.plus[0].d, fill: 'currentColor' })),
        ),
      )

      // One tree row (dir toggles via the framework's onToggleDir; file opens),
      // styled exactly like the built-in local tree: 34px row, 22px indent
      // step, guide lines, strong dir names, dotfiles dimmed, symlink badge,
      // size/mtime meta, and the trailing @-reference pill / copied label.
      const row = (entry, depth) => {
        const isDir = entry.type === 'dir'
        const isOpen = isDir && isExpanded(entry.path)
        const cls = 'drx-row' + (isDir ? ' drx-dir' : '') + (entry.hidden ? ' drx-hidden' : '')
        const style = { paddingLeft: depth * INDENT_STEP + INDENT_BASE, ...treeGuides(depth, isOpen) }
        const icon = React.createElement('span', { style: { flexShrink: 0, display: 'inline-flex' } }, Icon(isDir ? (isOpen ? 'folder-open' : 'folder') : 'code', 14))
        const name = React.createElement('span', { className: 'drx-name' }, entry.name)
        const link = entry.type === 'symlink' ? React.createElement('span', { className: 'drx-link' }, Icon('link', 12)) : null
        const meta = (!isDir && (entry.size != null || entry.mtime))
          ? React.createElement('span', { className: 'drx-meta' }, humanSize(entry.size) + (entry.mtime ? '  ' + fmtTime(entry.mtime) : ''))
          : null
        if (isDir) {
          return React.createElement('div', { key: entry.path },
            React.createElement('div', {
              role: 'button', tabIndex: 0, className: cls, style, title: entry.path,
              onClick: () => { toggleDir(entry.path) },
              onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDir(entry.path) } },
              onContextMenu: (e) => onCtx(e, entry.path, true, entry.name),
            },
              icon, name, link, rowAction(entry.path),
            ),
            isOpen ? renderLevel(entry.path, depth + 1) : null,
          )
        }
        return React.createElement('div', {
          role: 'button', tabIndex: 0, key: entry.path, className: cls, style, title: entry.path,
          onClick: () => openFile(entry.path),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFile(entry.path) } },
          onContextMenu: (e) => onCtx(e, entry.path, false, entry.name),
        },
          icon, name, link, meta, rowAction(entry.path),
        )
      }

      const renderLevel = (dir, depth) => {
        const level = data[dir]
        if (level === undefined || (level.loading && !level.entries)) {
          return React.createElement('div', { key: dir + ':loading', className: 'drx-row', style: { paddingLeft: depth * INDENT_STEP + INDENT_BASE, color: T.label3, cursor: 'default' } }, tr('explorer.loading'))
        }
        if (level.missing) {
          return React.createElement('div', { key: dir + ':missing', className: 'drx-row', style: { paddingLeft: depth * INDENT_STEP + INDENT_BASE, color: T.label3, cursor: 'default' } }, tr('explorer.dirMissing'))
        }
        if (level.error !== undefined) {
          // Error rows carry a reconnect action: the most common failure here
          // is a dropped SSH connection / credential-less pool, and one click
          // re-establishes it host-side and re-lists this level.
          return React.createElement('div', { key: dir + ':err', className: 'drx-row', style: { paddingLeft: depth * INDENT_STEP + INDENT_BASE, gap: 6, color: T.errorState, cursor: 'default', whiteSpace: 'normal', lineHeight: '20px' } },
            React.createElement('span', { style: { flex: 1, minWidth: 0 } }, level.error),
            React.createElement('button', {
              type: 'button', className: 'drx-iconbtn', title: reconnecting ? tr('explorer.reconnecting') : tr('explorer.reconnect'),
              'aria-label': tr('explorer.reconnect'), onClick: reconnect, disabled: reconnecting,
            }, Icon('refresh', 13)),
          )
        }
        const items = level.entries || []
        const soft = level.softError
          ? React.createElement('div', { key: dir + ':softerr', className: 'drx-caption', style: { display: 'flex', alignItems: 'center', gap: 6, paddingLeft: depth * INDENT_STEP + INDENT_BASE } },
              React.createElement('span', { style: { flex: 1, minWidth: 0, whiteSpace: 'normal', lineHeight: '16px' } }, tr('explorer.softError', { msg: level.softError })),
              React.createElement('button', {
                type: 'button', className: 'drx-iconbtn', title: reconnecting ? tr('explorer.reconnecting') : tr('explorer.reconnect'),
                'aria-label': tr('explorer.reconnect'), onClick: reconnect, disabled: reconnecting,
              }, Icon('refresh', 11)),
            )
          : null
        if (!items.length) return soft || null
        return React.createElement('div', { key: dir + ':list' },
          items.map((it) => {
            // Dotfiles dim like the built-in tree's hidden entries.
            const hidden = !!(it.hidden || (typeof it.name === 'string' && it.name.startsWith('.')))
            return row({ ...it, path: joinRemote(dir, it.name), hidden }, depth)
          }),
          soft,
        )
      }

      const rootName = root ? String(root).split(/[\\/]/).filter(Boolean).pop() || root : ''
      const rootLevel = data[root]

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        // Toolbar (the file side's search-row slot): refresh (re-establishes
        // the SSH connection when a machine is in play, then re-lists) /
        // new dir / picker.
        React.createElement('div', { style: { flex: 'none', display: 'flex', alignItems: 'center', gap: 2, padding: '6px 8px', borderBottom: '1px solid ' + T.borderL1 } },
          React.createElement('button', {
            type: 'button', className: 'drx-iconbtn',
            title: reconnecting
              ? tr('explorer.reconnecting')
              : (root ? tr('explorer.reconnect') + ' / ' + tr('explorer.refresh') : tr('explorer.refresh')),
            'aria-label': tr('explorer.refresh'),
            onClick: () => { if (root) reconnect(); else refreshStatus() },
            disabled: reconnecting,
          }, Icon('refresh', 14)),
          React.createElement('button', {
            type: 'button', className: 'drx-iconbtn', title: tr('explorer.newDir'), 'aria-label': tr('explorer.newDir'),
            onClick: () => { const nm = window.prompt(tr('picker.newDirName', { path: (root || '/') })); if (nm && nm.trim()) doFs('mkdir', { path: joinRemote(root, nm.trim()) }, true) },
          }, folderPlusGlyph()),
          React.createElement('div', { style: { flex: 1 } }),
          React.createElement('button', { type: 'button', className: 'drx-iconbtn', title: tr('explorer.pickWorkspace'), 'aria-label': tr('explorer.pickWorkspace'), onClick: () => setPicker(true) }, Icon('ellipsis', 14)),
        ),
        picker ? React.createElement('div', { style: { padding: 8, borderBottom: '1px solid ' + T.borderL1 } }, React.createElement(DirPicker, {
          open: true, busy: false, onPicked: () => { setPicker(false); refreshStatus() }, onCancel: () => setPicker(false),
        })) : null,
        React.createElement('div', { style: { flex: 1, overflowY: 'auto', overflowX: 'hidden', minHeight: 0, padding: '4px 8px 8px' } },
          !root
            ? React.createElement('div', { className: 'drx-empty' }, tr('explorer.localSession'))
            : React.createElement('div', { key: root },
                React.createElement('div', {
                  role: 'button', tabIndex: 0,
                  onClick: () => setRootOpen((v) => !v),
                  onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setRootOpen((v) => !v) } },
                  onContextMenu: (e) => onCtx(e, root, true, rootName),
                  className: 'drx-row drx-dir',
                  style: { paddingLeft: INDENT_BASE, fontWeight: 600, ...treeGuides(0, false) },
                  title: root,
                },
                  React.createElement('span', { style: { flexShrink: 0, display: 'inline-flex' } }, Icon(rootOpen ? 'folder-open' : 'folder', 14)),
                  React.createElement('span', { className: 'drx-name' }, rootName || root),
                  rowAction(root),
                ),
                rootLevel && rootOpen ? renderLevel(root, 1) : null,
              ),
        ),
        // Footer (the file side's status-footer slot): the remote workspace
        // path + host, or the per-session state hint.
        React.createElement('div', { className: 'drx-footer' },
          React.createElement('span', { style: { flex: 'none', display: 'inline-flex' } }, Icon('folder-open', 11)),
          React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            (status && status.workspace && root)
              ? tr('explorer.remoteWs', { path: root, host: (status.host ? tr('explorer.hostTag', { user: status.username, host: status.host }) : '') })
              : (root ? tr('explorer.noRemoteWs') : tr('explorer.sessionLocal'))),
        ),
        err ? React.createElement('div', { className: 'drx-error' }, (busy ? tr('explorer.busy') : '') + err) : null,
      )
    }

    // ── Remote file tab (opened by the explorer; live read + explicit edit) ──
    // Same chrome as the built-in file tabs (editorHeader): a compact path
    // header with the read-only/edit status, action buttons in the file-side
    // button vocabulary, the amber truncation banner, and a plain editor-like
    // body. Read-only by default;「编辑」opens the draft and「保存到远程」
    // writes it back (mtime optimistic lock via POST /dsh-remote/write).
    function RemoteFileTab(props) {
      const { tab, scope } = props
      const path = tab.path || ''
      const fileSessionId = scope && scope.sessionId
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const [edit, setEdit] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      React.useEffect(() => { ensureChromeCss() }, [])

      const originalText = (data && data.content != null ? data.content : '').replace(/\n…\[truncated:.*$/, '')
      const dirty = edit && draft !== originalText

      // Scoped styles (idempotent across tabs / hot reloads).
      React.useEffect(() => { ensureDshCss('dsh-remote-drx-css', DRX_CSS) }, [])

      const load = React.useCallback(() => {
        if (!path) { setLoading(false); return }
        let cancelled = false
        setLoading(true); setErr(''); setNotice(''); setData(null); setEdit(false)
        readRemoteFile(path, 256 * 1024)
          .then((d) => { if (!cancelled) { setData(d); setLoading(false) } })
          .catch((e) => { if (!cancelled) { setErr(String((e && e.message) || e)); setLoading(false) } })
        return () => { cancelled = true }
      }, [path])
      // `load` is stable per `path` (useCallback above) — the effect only
      // re-fires when the tab's path actually changes, never on host
      // re-renders (a per-render `load` identity would make the effect
      // re-run whenever the host re-renders this tab with fresh props).
      React.useEffect(() => load(), [load])

      const startEdit = () => {
        if (!data || data.binary) return
        setDraft((data.content != null ? data.content : '').replace(/\n…\[truncated:.*$/, ''))
        setEdit(true); setErr(''); setNotice('')
      }
      const saveRemote = () => {
        setSaving(true); setErr(''); setNotice('')
        apiRaw('POST', '/dsh-remote/write', { path, content: draft })
          .then((r) => {
            if (r.status === 409) {
              setErr(String((r.data && r.data.error) || tr('file.conflict')))
              return
            }
            if (r.status >= 400) throw new Error((r.data && (r.data.error || r.data.message)) || 'HTTP ' + r.status)
            setEdit(false)
            load()
          })
          .catch((e) => setErr(String((e && e.message) || e)))
          .finally(() => setSaving(false))
      }
      const downloadMirror = () => {
        setSaving(true); setErr(''); setNotice('')
        api('POST', '/dsh-remote/fs', { op: 'download', path })
          .then((r) => setNotice(tr('file.downloaded', { local: (r && r.local ? tr('file.downloadedAt', { path: r.local }) : '') })))
          .catch((e) => setErr(String((e && e.message) || e)))
          .finally(() => setSaving(false))
      }

      const baseName = path.split(/[\\/]/).pop() || path
      const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        // Header — the built-in editorHeader vocabulary.
        React.createElement('div', { style: { flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderBottom: '1px solid ' + T.borderL1 } },
          React.createElement('span', { style: { flexShrink: 0, display: 'inline-flex', color: T.label3 } }, Icon('code', 13)),
          React.createElement('span', { style: { flexShrink: 0, maxWidth: '40%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 500, lineHeight: '18px', color: T.label2 } }, baseName),
          React.createElement('code', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, lineHeight: '14px', color: T.label3, ...mono } }, path),
          React.createElement('span', { style: { flexShrink: 0, fontSize: 11, lineHeight: '14px', color: edit ? T.warn : T.label3 } }, edit ? tr('file.editing') : tr('file.readonly')),
          edit
            ? React.createElement(React.Fragment, null,
                React.createElement('button', { type: 'button', className: 'drx-btn drx-btn-primary', onClick: saveRemote, disabled: saving, title: tr('file.saveToRemote') },
                  saving ? null : Icon('check', 12),
                  saving ? tr('file.saving') : tr('file.saveToRemote')),
                React.createElement('button', { type: 'button', className: 'drx-btn', onClick: () => { setEdit(false); setErr(''); setNotice('') }, disabled: saving }, tr('file.cancel')))
            : React.createElement(React.Fragment, null,
                React.createElement('button', { type: 'button', className: 'drx-btn', onClick: startEdit, disabled: !data || data.binary || saving, title: tr('file.edit') }, Icon('pen', 12), tr('file.edit')),
                React.createElement('button', { type: 'button', className: 'drx-btn', onClick: downloadMirror, disabled: saving, title: tr('file.download') }, Icon('download', 12), tr('file.download'))),
        ),
        // Amber truncation banner (the editorBanner slot).
        (!edit && data && data.truncated)
          ? React.createElement('div', { className: 'drx-banner' }, tr('file.truncated'))
          : null,
        React.createElement('div', { style: { flex: 1, overflow: 'auto', minHeight: 0 } },
          loading
            ? React.createElement('div', { className: 'drx-caption', style: { padding: 12, fontSize: 13, lineHeight: '20px' } }, tr('file.loading'))
            : err
              ? React.createElement('div', { className: 'drx-error', style: { padding: 12, fontSize: 13, lineHeight: '20px', whiteSpace: 'normal' } }, err)
              : (data && data.binary
                  ? React.createElement('div', { className: 'drx-caption', style: { padding: 12, fontSize: 13, lineHeight: '20px', color: T.warn } },
                      tr('file.binary', { size: (data.size != null ? data.size + ' bytes' : tr('file.unknownSize')) }))
                  : (edit
                      ? React.createElement('textarea', {
                          value: draft, onChange: (e) => setDraft(e.target.value), spellCheck: false,
                          style: { width: '100%', height: '100%', boxSizing: 'border-box', border: 'none', outline: 'none', resize: 'none', background: 'transparent', color: T.label, fontSize: 13, lineHeight: 1.55, ...mono, padding: '10px 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
                        })
                      : React.createElement('div', { style: { fontSize: 13, lineHeight: 1.55, color: T.label, ...mono, padding: '10px 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
                          (data && data.content != null) ? data.content : tr('file.empty'),
                        )))),
        // One-line feedback: success notices vs errors.
        (notice || err)
          ? React.createElement('div', { className: err ? 'drx-error' : 'drx-footer', style: err ? { whiteSpace: 'normal' } : { borderTop: 'none', padding: '4px 12px' } }, err ? err : notice)
          : null,
      )
    }

    // ── better-sidebar file-tree integration (v0.17 … v0.19, feature-graded) ─
    // The Files panel's tree area is consumed through TWO successive slot
    // generations; dsh-remote adapts to whichever the sidebar offers:
    //   • fileTreeSection (v0.19.0+, PRIMARY): the tree area is a dual
    //     module — the top section is an injection slot and the bottom is
    //     better-sidebar's own local tree. dsh-remote injects its OWN remote
    //     tree component (RemoteExplorerTab: toolbar / tree / context-menu
    //     ops / open-remote-file) into the TOP section; the bottom tree
    //     stays PURELY local (no provider registered → no remote roots, no
    //     data-source takeover). This is the "local file system below,
    //     remote above" design — the 🌐 tab is retired in this mode.
    //   • fileTreeSource (v0.17.0/v0.18.0, FALLBACK): provider with
    //     match/createSource/roots — v0.17 single-source takeover or
    //     v0.18 multi-root remote starting points inside one tree.
    //   • neither (pre-v0.17): the 🌐 explorer tab stays registered.
    // Feature detection decides; the fallbacks keep older sidebar versions
    // fully usable.
    const REMOTE_TREE_PROVIDER_ID = 'dsh-remote'
    const REMOTE_GIT_PROVIDER_ID = 'dsh-remote:git'
    const REMOTE_TREE_ROOT_ID = 'dsh-remote:remote'
    const REMOTE_TREE_SECTION_ID = 'dsh-remote:tree'

    /** Remote basename of a path (POSIX /a/b or Windows D:\x). */
    function remoteBaseName(p) {
      const seg = String(p || '').replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean).pop()
      return seg || 'remote'
    }

    // Consulted by `roots()` (multi-root mode): the session's resolved
    // remote root, TTL-cached — a workspace switch re-resolves on the next
    // consultation after expiry (10s). An empty string means "not a remote
    // session" (no remote starting point contributed). EMPTY resolutions are
    // NOT cached: a transient failure must not lock the session out of the
    // tree for the TTL (the host settles roots once per session — see
    // remoteTreeRootsFor), so the next consultation re-resolves.
    const remoteRootCache = new Map()
    const remoteRootOf = (sessionId) => {
      const hit = remoteRootCache.get(sessionId)
      if (hit && Date.now() - hit.at < 10 * 1000) return hit.p
      const p = resolveSessionRemote(sessionId).catch(() => '')
      remoteRootCache.set(sessionId, { p, at: Date.now() })
      p.then((root) => {
        if (!root) remoteRootCache.delete(sessionId)
      }).catch(() => { remoteRootCache.delete(sessionId) })
      return p
    }

    // Shared by both `roots` implementations (section source form and
    // provider form): the session's remote starting point, or [] (nothing
    // to render). The host settles roots at most ONCE per session/cwd — an
    // empty first resolve (app boot race, host half still warming, a
    // transient resolve-mirror failure) would leave the tree section
    // unrendered forever. When the session LOOKS remote (its cwd sits
    // inside the mirror root) but the first resolve came back empty, retry
    // briefly INSIDE this one call so the host's single shot still lands.
    // The HOST settles roots once per session/cwd change, but re-settle
    // churn (registry ticks, panel re-resolves) calls it repeatedly — same
    // settle-window memoization as the source factory: within ROOTS_MEMO_TTL
    // repeated calls return the SAME array/root objects (a re-settle loop
    // converges instead of minting new references every cycle); after the
    // TTL the next call re-resolves (fresh identity, one settle, stable).
    const remoteRootsMemo = new Map() // sessionId + '\u0000' + cwd -> { at, value }
    const ROOTS_MEMO_TTL = 5000 // ms
    const remoteTreeRootsFor = async (sessionId, cwd) => {
      const memoKey = String(sessionId || '') + '\u0000' + String(cwd || '')
      const memoHit = remoteRootsMemo.get(memoKey)
      if (memoHit && Date.now() - memoHit.at < ROOTS_MEMO_TTL) return memoHit.value
      const settle = async () => {
        const root = await remoteRootOf(sessionId)
        if (root) return [{ id: REMOTE_TREE_ROOT_ID, label: remoteBaseName(root), dir: root }]
        if (sessionIsRemote(cwd)) {
          for (let attempt = 0; attempt < 3; attempt++) {
            await new Promise((r) => setTimeout(r, 700))
            const again = await remoteRootOf(sessionId)
            if (again) return [{ id: REMOTE_TREE_ROOT_ID, label: remoteBaseName(again), dir: again }]
          }
          // The session LOOKS remote (cwd under the mirror root) but the root
          // never resolved: NEVER leave the tree silently empty — the host
          // consults roots only once per session, so this failure would render
          // nothing forever. Log it loudly for DevTools.
          console.error('[dsh-remote] cannot resolve the remote root for a remote-looking session (cwd=' + cwd + ', sessionId=' + sessionId + ') — the remote tree will stay empty')
        }
        return []
      }
      const value = await settle()
      remoteRootsMemo.set(memoKey, { at: Date.now(), value })
      return value
    }

    // Shared live-source factory for BOTH registrations that hand data to
    // the host's own FileTree — the fileTreeSource provider (v0.17/0.18
    // fallback) and the v0.20 fileTreeSectionSource section form:
    // `list(dir)` serves every listing, `open(path)` is the row-click open
    // delegation (host contract: declared via `capabilities.open`, the
    // built-in local editor route can never serve remote paths), and
    // `reference(path)` (v0.21+, optional — older hosts ignore it) maps a
    // remote row path to the tagged `@remote:` reference the composer can
    // hand to the model (see REF_REMOTE above).
    // Path semantics per the slot contract: the ROOT listing arrives as the
    // session cwd (a LOCAL mirror dir — mapped here), every deeper level
    // arrives as our own remote entry paths (already remote — verbatim,
    // no path conversion on our side).
    // The host may invoke `createSource` more than once per session (panel
    // re-resolves, registry ticks, multiple TreePanel consumers). Each call
    // used to mint a FRESH source (fresh listing memo / fresh root promise) —
    // under a host-side re-settle loop that keeps handing the renderer new
    // objects the churn never converges ("Maximum update depth exceeded"
    // class). Memoize per (sessionId, cwd): repeated calls return the SAME
    // source object, so re-settles reuse one stable memo and stop producing
    // new references.
    const remoteSourceMemo = new Map() // sessionId + '\u0000' + cwd -> source
    function makeRemoteTreeSource(ctx) {
      return (sessionId, cwd) => {
        const memoKey = String(sessionId || '') + '\u0000' + String(cwd || '')
        const memoHit = remoteSourceMemo.get(memoKey)
        if (memoHit) return memoHit
        const mirrorBase = String(cwd || '').replace(/[\\/]+$/, '')
        const sep = mirrorBase.includes('\\') ? '\\' : '/'
        let remotePromise = null
        // The session's remote root, mirrored into a SYNCHRONOUS closure
        // variable for `reference()` (host v0.21 contract): the host calls
        // `source.reference?.(path)` straight from the pill click, but
        // remoteRootOf returns a promise under a cold cache. roots() settles
        // before the tree renders (section/provider forms alike), so by
        // click time this has usually landed. Until it does — or when the
        // session resolves to nothing — `reference()` degrades to the
        // identity (path as-is), byte-for-byte the old pre-v0.21 behavior.
        let settledRoot = ''
        remoteRootOf(sessionId).then((r) => { settledRoot = r || '' }).catch(() => { settledRoot = '' })
        const remoteOf = (dir) => {
          if (remotePromise === null) {
            // Shared TTL cache with roots() — one resolve-mirror round trip
            // per session, not one per listing.
            remotePromise = remoteRootOf(sessionId)
          }
          return remotePromise.then((remoteRoot) => {
            if (!remoteRoot) {
              const msg = 'remote engine not mounted for this session — cannot list ' + (dir || '')
              console.error('[dsh-remote] ' + msg)
              throw new Error(msg)
            }
            const local = String(dir || '').replace(/[\\/]+$/, '')
            // Form 1: a local mirror path under the session cwd → map it.
            const rel = local === mirrorBase ? '' : (mirrorBase && local.startsWith(mirrorBase + sep))
              ? local.slice(mirrorBase.length + 1)
              : null
            if (rel !== null) {
              if (!rel) return remoteRoot
              const segs = rel.split(/[\\/]+/).filter(Boolean)
              return remoteRoot.includes('\\')
                ? remoteRoot + '\\' + segs.join('\\')
                : remoteRoot.replace(/[\\/]+$/, '') + '/' + segs.join('/')
            }
            // Form 2: already a remote path (our own entry paths) → verbatim
            // (trailing separators stripped so the list-cache keys can never
            // drift between spellings like '/home/u' and '/home/u/' — a
            // Windows drive root 'C:\\' (len 3) is kept untouched).
            return local.length > 3 ? local.replace(/[\\/]+$/, '') : local
          })
        }
        // Per-dir listing memo. The host tree consumes `list(dir)` from its
        // own load effects and may re-ask for a level many times per render
        // cycle (re-resolves, mode re-resolutions, re-renders with a pending
        // level). Returning a NEW promise + NEW { entries } object on every
        // call makes any consumer that writes the result back into state
        // never converge — the classic React "Maximum update depth
        // exceeded" (getSnapshot-should-be-cached class) loop. Keep the
        // in-flight promise AND the settled result STABLE per dir inside a
        // short TTL; once the TTL lapses the next call re-fetches (one new
        // settle, then stable again) so a panel refresh still gets fresh
        // listings. Failed levels are memoized with a MUCH shorter TTL so an
        // early failure (SSH connection still establishing, host half
        // warming up) retries within a second instead of pinning an error
        // row for the full freshness window.
        const LIST_TTL = 2000 // ms — render-loop absorb window vs freshness
        const LIST_ERR_TTL = 800 // ms — failed levels retry sooner
        const listMemo = new Map() // remotePath -> { at, promise, value, kind }
        const listCached = (remotePath) => {
          const hit = listMemo.get(remotePath)
          if (hit) {
            const ttl = hit.kind === 'err' ? LIST_ERR_TTL : LIST_TTL
            if (Date.now() - hit.at < ttl) return hit.promise
            listMemo.delete(remotePath)
          }
          const entry = { at: Date.now(), promise: null, value: null, kind: 'ok' }
          const promise = listRemoteDir(remotePath)
            .then((r) => {
              let value
              if (!r || !Array.isArray(r.items)) {
                // A malformed / failed listing must NEVER masquerade as an
                // empty success — the host FileTree renders nothing for
                // `{entries: []}` ("loading flash then blank"), while
                // `{error}` shows a red reason row.
                const msg = 'cannot list ' + remotePath + ': ' + (r && r.error ? String(r.error) : 'empty listing response')
                console.error('[dsh-remote] ' + msg)
                value = { error: msg }
                entry.kind = 'err'
              } else if (r.missing) {
                // Host reports missing dirs as a 200 with `missing` (not a
                // hard failure) — surface it as the level's error row, like
                // the plugin's own tree does (「目录不存在」).
                const msg = 'cannot list ' + remotePath + ': directory missing' + (r.path ? ' (' + r.path + ')' : '')
                console.error('[dsh-remote] ' + msg)
                value = { error: msg }
                entry.kind = 'err'
              } else {
                // Fixed ordering: dotfiles → dirs → files, ASCII within
                // each group (the host renders provider order verbatim).
                const sorted = sortRemoteEntries(r.items)
                value = { entries: sorted.map((it) => ({ name: it.name, path: it.path, isDir: it.type === 'dir', hidden: !!(it.hidden || (typeof it.name === 'string' && it.name.startsWith('.'))), meta: (it.size != null || it.mtime != null) ? { size: it.size, mtime: it.mtime } : undefined })) }
              }
              entry.value = value
              return value
            })
            .catch((e) => {
              // A credential-classified failure (no saved password / private
              // key) cannot heal by retrying — append the actionable hint so
              // the host FileTree's red reason row tells the user where to
              // re-enter credentials.
              const hint = (e && e.credential) ? tr('explorer.credentialHint') : ''
              const msg = 'cannot list ' + remotePath + ': ' + String((e && e.message) || e) + hint
              console.error('[dsh-remote] ' + msg)
              const value = { error: msg }
              entry.value = value
              entry.kind = 'err'
              return value
            })
          entry.promise = promise
          listMemo.set(remotePath, entry)
          return promise
        }
        const created = {
          list(dir) {
            return remoteOf(dir).then(listCached)
          },
          open(path) {
            // v0.20 file-row open delegation: the host tree clicked a remote
            // file — route it to the plugin's own remote file tab (the host
            // editor would read the path as a LOCAL file).
            try {
              const bs = ctx && ctx.betterSidebar
              if (!bs || typeof bs.openTab !== 'function') return
              const name = String(path).split(/[\\/]/).pop() || path
              bs.openTab({ type: SIDEBAR_FILE_ID, title: name, path }, { sessionId, cwd })
            } catch (e) {
              console.warn('[dsh-remote] open remote file failed:', e)
            }
          },
          // v0.21 data-source contract (optional, host falls back to the
          // raw path when absent): the host calls reference(rowPath) from
          // the pill click and inserts the return value into the composer.
          // Emit the @-protocol form `@remote:<remote path>` so the model
          // knows the file lives on the HOST and goes straight to rw_* — a
          // bare mirror path would tempt local reads that fail whenever the
          // mirror is not synced. Row paths are remote (our list() entries)
          // except the root row, which arrives as the LOCAL mirror cwd —
          // map that one back to the settled remote root. When nothing has
          // settled yet, pass through unchanged (old behavior; the host
          // prompt's PATH RULES still treat an untagged absolute path as
          // remote).
          reference(path) {
            if (!settledRoot) return path
            const r = String(settledRoot).replace(/[\\/]+$/, '')
            const s = String(path == null ? '' : path)
            if (s === r) return REF_REMOTE + s
            if (s.startsWith(r + '/') || s.startsWith(r + '\\')) return REF_REMOTE + s
            const base = String(mirrorBase || '')
            if (base && (s === base || s.startsWith(base + '/') || s.startsWith(base + '\\'))) return REF_REMOTE + r
            return s
          },
        }
        remoteSourceMemo.set(memoKey, created)
        return created
      }
    }

    // Register the provider against a better-sidebar service that supports
    // the feature. Returns the disposer or null (feature absent).
    function registerRemoteTreeProvider(bs, ctx) {
      const features = bs && Array.isArray(bs.features) ? bs.features : []
      if (typeof bs.registerFileTreeProvider !== 'function' || !features.includes('fileTreeSource')) return null
      const match = (sessionId, cwd) => sessionIsRemote(cwd)
      const createSource = makeRemoteTreeSource(ctx)
      // Multi-root (v0.18.0+): a remote session contributes its remote
      // workspace as a SECOND starting point, next to the always-local cwd
      // root — "local file system + remote" in one tree. All expansions
      // under this root run through our `list()` (Form 2, verbatim).
      // Empty (not a remote session / resolve failed) → the files panel
      // stays single-root; the v0.17 single-source takeover may still apply
      // (see the provider header comment).
      const roots = (sessionId, cwd) => remoteTreeRootsFor(sessionId, cwd)
      return bs.registerFileTreeProvider({
        id: REMOTE_TREE_PROVIDER_ID,
        match,
        createSource,
        roots,
        // v0.23.0 (feature 'gitSource'): git-status decorations of provider
        // sessions are gated on this capability. The DATA comes from the
        // git data-source slot (registerRemoteGitProvider) — our
        // GitStatusResult.root is a remote absolute path, the same
        // namespace as the tree rows, so the overlay joins right onto them.
        capabilities: { git: true },
      })
    }

    // Register the fileTreeSection integration (v0.19 vs v0.20, feature-
    // graded): the Files panel's TOP module, the bottom module stays the
    // local tree, untouched.
    //   • v0.20 (feature 'fileTreeSectionSource'): DATA-ONLY section — the
    //     host renders its OWN FileTree bound to our live source (display
    //     reuse: guide-band collapse, capability faces, row menus, expand
    //     handling all host-side). No global provider registration → the
    //     bottom tree never gets taken over. roots() settles the remote
    //     starting point; empty → the section renders nothing.
    //   • v0.19 (feature 'fileTreeSection' only): render form — our own
    //     RemoteExplorerTab (toolbar / tree / context-menu ops / open-
    //     remote-file) in the top module.
    // Section renders only for sessions whose cwd sits inside a mirror
    // (sessionIsRemote — the shared synchronous MIRROR_ROOT test).
    function registerRemoteTreeSection(bs, ctx) {
      const match = (sessionId, cwd) => sessionIsRemote(cwd)
      const features = Array.isArray(bs.features) ? bs.features : []
      if (features.includes('fileTreeSectionSource')) {
        return bs.registerFileTreeSection({
          id: REMOTE_TREE_SECTION_ID,
          match,
          source: {
            createSource: makeRemoteTreeSource(ctx),
            roots: (sessionId, cwd) => remoteTreeRootsFor(sessionId, cwd),
            // Row-click open delegation (source.open → the remote file tab);
            // everything else degrades off in the section tree.
            capabilities: { open: true, git: true },
          },
        })
      }
      const render = (scope) => React.createElement(RemoteExplorerTab, {
        scope: { sessionId: scope.sessionId, cwd: scope.cwd },
        ctx: scope.ctx,
      })
      return bs.registerFileTreeSection({ id: REMOTE_TREE_SECTION_ID, match, render })
    }

    // ── Remote git data source (better-sidebar 'gitSource' slot, v0.23.0) ──
    // The host's GitView panel, explorer git-status decorations and diff
    // tabs resolve a GitDataSource per session: when our provider's `match`
    // accepts the (sessionId, cwd), EVERY `api.gitX(...)` call on those
    // surfaces becomes `source.gitX(...)` — each method is one remote
    // `git -C <dir> …` command executed by the host half
    // (POST /dsh-remote/git, porcelain-parsed in lib/git-parse.js). No
    // provider match → the host keeps its local git.* routes byte for byte
    // (api itself is a valid default data source — no adapter layer).
    // Path semantics: `worktree` is a remote linked-checkout path from our
    // own gitWorktrees (verbatim), `scope.repoRoot` is a remote repo root
    // from our own status.root (verbatim), and the session cwd is a LOCAL
    // mirror path — mapped to its remote base (same MIRROR_ROOT semantics
    // as the tree source, sharing remoteRootOf's per-session TTL).
    const remoteGitBaseMemo = new Map() // sessionId + '\0' + cwd -> Promise<remoteBase>
    const remoteGitBaseOf = (sessionId, cwd) => {
      const memoKey = String(sessionId || '') + '\u0000' + String(cwd || '')
      const memoHit = remoteGitBaseMemo.get(memoKey)
      if (memoHit) return memoHit
      // The git source only ever maps the SESSION cwd — which by definition
      // IS the local mirror dir — so the mapping is one resolve-mirror hop
      // to the session's remote base (shared TTL with the tree source via
      // remoteRootOf; one round trip per session, not per call).
      const promise = remoteRootOf(sessionId).then((remoteRoot) => {
        if (!remoteRoot) {
          const msg = 'remote engine not mounted for this session — cannot run git for ' + (cwd || '')
          console.error('[dsh-remote] ' + msg)
          throw new Error(msg)
        }
        return remoteRoot
      })
      remoteGitBaseMemo.set(memoKey, promise)
      promise.catch(() => { if (remoteGitBaseMemo.get(memoKey) === promise) remoteGitBaseMemo.delete(memoKey) })
      return promise
    }

    // The source factory is memoized per (sessionId, cwd) like the tree
    // source: the host may invoke createSource on every resolving render,
    // and a fresh object per invocation would churn the host's consumers.
    const remoteGitSourceMemo = new Map() // sessionId + '\0' + cwd -> source
    function makeRemoteGitSource(ctx) {
      return (sessionId, cwd) => {
        const memoKey = String(sessionId || '') + '\u0000' + String(cwd || '')
        const memoHit = remoteGitSourceMemo.get(memoKey)
        if (memoHit) return memoHit
        const trimPath = (p) => {
          const s = String(p || '')
          return s.length > 3 ? s.replace(/[\\/]+$/, '') : s
        }
        const gitCall = (op, scope, worktree, payload, signal) =>
          remoteGitBaseOf(sessionId, (scope && scope.cwd) || cwd).then((dir) => {
            const commandDir = worktree ? trimPath(worktree)
              : (scope && scope.repoRoot) ? trimPath(scope.repoRoot)
                : dir
            return apiGit(op, { dir: commandDir, ...payload }, signal)
          })
        const created = {
          // One status snapshot (porcelain v1 -b: branch header + entries;
          // `root` is the remote repo top level — decorations join it onto
          // the tree rows, which live in the same path namespace).
          gitStatus(scope, worktree, signal) {
            return gitCall('status', scope, worktree, {}, signal)
          },
          // The linked checkouts of the remote repository; the dirty count
          // (changes>0) participates in the host's dirty-checkout auto-select.
          gitWorktrees(scope, signal) {
            return gitCall('worktrees', scope, undefined, {}, signal)
          },
          gitBranch(scope, worktree, signal) {
            return gitCall('branch', scope, worktree, {}, signal)
          },
          gitBranchStatus(scope, worktree, signal) {
            return gitCall('branchStatus', scope, worktree, {}, signal)
          },
          gitBranchTips(scope, branches, worktree, signal) {
            return gitCall('branchTips', scope, worktree, { branches: Array.isArray(branches) ? branches.slice() : [] }, signal)
          },
          gitLogGraph(scope, count, skip, worktree, signal) {
            return gitCall('logGraph', scope, worktree, { count, skip }, signal)
          },
          gitDiff(scope, path, staged, worktree, signal) {
            return gitCall('diff', scope, worktree, { path: path === undefined || path === null ? undefined : path, staged: staged === true }, signal)
          },
          gitCommitDiff(scope, hash, worktree, signal) {
            return gitCall('commitDiff', scope, worktree, { hash }, signal)
          },
          gitStage(scope, path, worktree) {
            return gitCall('stage', scope, worktree, { path: path === undefined || path === null ? undefined : path })
          },
          gitUnstage(scope, path, worktree) {
            return gitCall('unstage', scope, worktree, { path: path === undefined || path === null ? undefined : path })
          },
          gitCommit(scope, message, worktree) {
            return gitCall('commit', scope, worktree, { message })
          },
          gitCheckout(scope, branch, worktree) {
            return gitCall('checkout', scope, worktree, { branch })
          },
          // A repo without a remote rejects with a message containing
          // 'no remote' (the host panel maps that wire copy).
          gitFetch(scope, worktree, prune, signal) {
            return gitCall('fetch', scope, worktree, { prune: prune === true }, signal)
          },
          gitDiscard(scope, path, worktree) {
            return gitCall('discard', scope, worktree, { path })
          },
          gitRevert(scope, hash, worktree) {
            return gitCall('revert', scope, worktree, { hash })
          },
          gitCherryPick(scope, hash, worktree) {
            return gitCall('cherryPick', scope, worktree, { hash })
          },
          // No subscribe (optional per the slot contract): the host's 2s
          // silent polling + shared git-status bus keep every surface fresh;
          // external remote mutations surface within one poll cycle. The
          // host polls only when this channel is absent — by omitting it we
          // keep that fallback active.
        }
        remoteGitSourceMemo.set(memoKey, created)
        return created
      }
    }

    // Register the git data-source provider against a better-sidebar service
    // that supports the slot. Returns the disposer or null (feature absent —
    // older hosts keep their local git.* routes; bidirectional compat).
    function registerRemoteGitProvider(bs, ctx) {
      const features = bs && Array.isArray(bs.features) ? bs.features : []
      if (typeof bs.registerGitProvider !== 'function' || !features.includes('gitSource')) return null
      const match = (sessionId, cwd) => sessionIsRemote(cwd)
      const createSource = makeRemoteGitSource(ctx)
      return bs.registerGitProvider({ id: REMOTE_GIT_PROVIDER_ID, match, createSource })
    }

    // v0.20: row-op migration into the HOST's row context menu (the
    // registerCommand contract: menus with where + when + run). Registered
    // only for fileTreeSectionSource hosts — the v0.19 fallback tree keeps
    // its own drx-menu. `when` gates on the row's session + a KNOWN remote
    // root (the v0.20 command payload carries sessionId), so the LOCAL
    // tree's menus are never polluted. Only the settled TTL root cache is
    // consulted: a session whose root hasn't resolved yet shows no
    // dsh-remote rows (safe, converges on the next menu open).
    function registerRemoteRowCommands(bs) {
      if (typeof bs.registerCommand !== 'function') return null
      const features = Array.isArray(bs.features) ? bs.features : []
      if (!features.includes('fileTreeSectionSource')) return null
      const disposers = []
      const isRemoteRow = (menu) => {
        if (!menu || typeof menu.sessionId !== 'string' || typeof menu.path !== 'string') return false
        const hit = remoteRootCache.get(menu.sessionId)
        const root = (hit && typeof hit.p === 'string' && hit.p) || ''
        if (!root) return false
        return menu.path === root || menu.path.startsWith(root + '/') || menu.path.startsWith(root + '\\')
      }
      const fsOp = (op, payload) => api('POST', '/dsh-remote/fs', { op, ...payload })
        .catch((e) => console.warn('[dsh-remote] ' + op + ' failed:', (e && e.message) || e))
      disposers.push(bs.registerCommand({
        id: 'dsh-remote:download',
        title: () => tr('explorer.menuDownload'),
        icon: (size) => React.createElement('span', { style: { flex: 'none', display: 'inline-flex' } }, makeIconSvg('download', size || 14)),
        menus: [{ where: 'file-row', when: isRemoteRow, order: 150 }],
        run: (payload) => { if (payload && payload.path) fsOp('download', { path: payload.path }) },
      }))
      return () => { disposers.forEach((d) => { try { d() } catch {} }) }
    }

    // ── Remote terminal tab (reuses better-sidebar's TerminalView) ─────────
    // The transport slot: dsh-better-sidebar's TerminalView accepts an
    // injectable `transport` whose open() hands back { input, resize, close,
    // park, dispose, retry? }. The default transport talks to the LOCAL
    // node-pty over /sidebar/ws/terminal; this transport talks to dsh-remote's
    // host half over /dsh-remote/ws/terminal, which spawns an interactive
    // shell on a DEDICATED ssh2 connection (SshPool.openPty) — same frame
    // vocabulary, so all TerminalView UI (blocks overlay, selection popup,
    // info bar, banners, fit/theme/font) works unchanged.
    const SIDEBAR_TERMINAL_ID = 'dsh-remote:terminal'
    // The terminal-source provider id: the DEFAULT terminal tab's takeover
    // (see registerRemoteTerminalProvider). Its own id, distinct from the
    // 🖥 tab TYPE id above — the two live in different registries but a
    // collision would confuse diagnostics.
    const REMOTE_TERMINAL_PROVIDER_ID = 'dsh-remote:term'

    // Frame sniffing mirror of the view's parseDownlinkFrame: bounded, leading
    // '{' fast path, only known control types intercepted.
    const TERMINAL_DOWNLINK_TYPES = new Set(['init', 'title'])
    function parseTerminalDownlink(data) {
      if (data.length > 512 || data.charCodeAt(0) !== 0x7b) return null
      try {
        const parsed = JSON.parse(data)
        if (parsed === null || typeof parsed !== 'object') return null
        if (typeof parsed.type !== 'string' || !TERMINAL_DOWNLINK_TYPES.has(parsed.type)) return null
        return parsed
      } catch {
        return null
      }
    }

    // Lazy cross-plugin module resolution — the OFFICIAL stable path per the
    // dsh-better-sidebar slot docs: `ctx.modules.import('dsh-better-sidebar')`
    // (rc.8+) or the `__DSH_MODULES__.import(...)` page global. A synchronous
    // require is explicitly NOT stable (loader order), kept only as a last
    // resort. The resolved module exports `loadTerminalView()` — the lazy
    // chunk loader that yields the TerminalView component + localTransport.
    let bsClientPromise = null
    function resolveBetterSidebarModules(ctx) {
      if (bsClientPromise) return bsClientPromise
      bsClientPromise = (async () => {
        const need = (m) => !!(m && typeof m.loadTerminalView === 'function')
        // 1) the client ctx's module system (preferred)
        try {
          if (ctx && ctx.modules && typeof ctx.modules.import === 'function') {
            const m = await ctx.modules.import('dsh-better-sidebar')
            if (need(m)) return m
          }
        } catch { /* not resolvable via ctx.modules */ }
        // 2) the page-global module system
        try {
          const ds = (typeof window !== 'undefined' && window.__DSH_MODULES__) || null
          if (ds && typeof ds.import === 'function') {
            const m = await ds.import('dsh-better-sidebar')
            if (need(m)) return m
          }
        } catch { /* not resolvable via __DSH_MODULES__ */ }
        // 3) sync require — order-dependent, last resort only
        try {
          const m = require('dsh-better-sidebar')
          if (need(m)) return m
        } catch { /* not resolvable synchronously */ }
        throw new Error('dsh-better-sidebar client is unavailable — install DSH-better-sidebar to use the remote terminal')
      })()
      return bsClientPromise
    }

    /** Build the RemoteTerminalTransport for one terminal tab — a handshake
     *  with dsh-remote's host half (/dsh-remote/ws/terminal), which spawns an
     *  interactive shell on a DEDICATED ssh2 connection per session. Wire
     *  frames: see lib/terminal.js. Implements the dsh-better-sidebar
     *  TerminalTransport contract (terminal-transport.ts). */
    function makeRemoteTransport({ scope, tab }) {
      const tabId = tab && tab.id ? String(tab.id) : 'term'
      let ws = null
      let termSurface = null
      let onOutput = null
      let onTitle = null
      let onConnected = null
      let onFatal = null
      let onEndpoint = null
      let ready = false
      let closed = false
      let parked = false
      let disposing = false
      let attempts = 0
      let reconnectTimer = null
      let started = false
      let lastCwd = null
      let lastMachine = ''
      const pendingInput = []

      const wsUrl = (cwd, machine) => {
        const url = new URL('/dsh-remote/ws/terminal', location.origin)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        // resume key: stable per machine + tab, so a page refresh / re-render
        // reattaches the SAME shell during the host's reconnect grace.
        const cols = (termSurface && termSurface.cols) || 80
        const rows = (termSurface && termSurface.rows) || 24
        const params = new URLSearchParams({
          resume: JSON.stringify(['term', scope && scope.sessionId, scope && scope.cwd, machine, cwd, tabId]),
          cols: String(cols),
          rows: String(rows),
          term: 'xterm-256color',
        })
        // Per-workspace isolation: the machine (registry id of the workspace's
        // mirror owner / selection) rides the handshake so the host opens the
        // pty on THAT machine's pool, not some other project's.
        if (scope && scope.cwd) params.set('workspace', scope.cwd)
        if (scope && scope.sessionId) params.set('sessionId', scope.sessionId)
        if (machine) params.set('machine', machine)
        if (cwd) params.set('cwd', cwd)
        url.search = params.toString()
        return url.toString()
      }

      const connect = (cwd, machine) => {
        if (closed || disposing) return
        lastCwd = cwd
        lastMachine = machine
        const url = wsUrl(cwd, machine)
        if (onEndpoint) { try { onEndpoint(url) } catch {} }
        ws = new WebSocket(url)
        ws.onopen = () => {
          attempts = 0
          if (onConnected) { try { onConnected(true) } catch {} }
        }
        ws.onmessage = (event) => {
          if (typeof event.data !== 'string') return
          const frame = parseTerminalDownlink(event.data)
          if (frame !== null) {
            if (frame.type === 'init') {
              ready = true
              if (onConnected) { try { onConnected(true) } catch {} }
              while (pendingInput.length) {
                if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(pendingInput.shift()) } catch { break } } else break
              }
            } else if (frame.type === 'title' && onTitle) {
              try {
                onTitle(frame.title || '', { cwd: frame.cwd, command: frame.command })
              } catch { /* view callback */ }
            }
            return
          }
          if (onOutput) { try { onOutput(event.data) } catch {} }
        }
        ws.onclose = (event) => {
          ws = null
          ready = false
          if (closed || disposing || parked) return
          if (onConnected) { try { onConnected(false) } catch {} }
          // 1011 + reason = server-side refusal (spawn failure, session
          // poisoned, quota) — surface with the view's retry banner.
          if (event.code === 1011 && event.reason !== '') {
            if (onFatal) { try { onFatal(event.reason) } catch {} }
            return
          }
          attempts += 1
          if (attempts >= 3) {
            if (onFatal) { try { onFatal(tr('terminal.connFail') + ' (' + event.code + ')') } catch {} }
            return
          }
          reconnectTimer = setTimeout(() => connect(lastCwd, lastMachine), 2000)
        }
        ws.onerror = () => { try { ws.close() } catch {} }
      }

      const send = (payload) => {
        if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(payload) } catch {} }
      }

      const handle = {
        input(data) {
          if (closed) return
          if (ready) send(data)
          else {
            pendingInput.push(data)
            if (pendingInput.length > 256) pendingInput.splice(0, pendingInput.length - 256)
          }
        },
        resize(cols, rows) {
          send(JSON.stringify({ type: 'resize', cols, rows }))
        },
        close() {
          closed = true
          if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
          send(JSON.stringify({ type: 'close' }))
          try { if (ws) ws.close() } catch {}
        },
        park() {
          parked = true
          send(JSON.stringify({ type: 'park' }))
        },
        dispose() {
          disposing = true
          if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
          try { if (ws) ws.close() } catch {}
        },
        retry() {
          if (closed || disposing) return
          if (onFatal) { try { onFatal(null) } catch {} }
          attempts = 0
          if (ws) { try { ws.close() } catch {} }
          if (lastCwd !== null) connect(lastCwd, lastMachine)
          else { started = false; start() }
        },
      }
      const start = () => {
        if (started) return
        started = true
        // Resolve machine + starting cwd, then connect. Failures surface via
        // onFatal (the view shows the banner with a retry button).
        const boot = async () => {
          if (!scope || (!scope.cwd && !scope.sessionId)) throw new Error('No workspace context for remote terminal')
          let status = null
          let cwd = ''
          let machine = ''
          // Session-scoped status: the machine of the session's OWN workspace
          // (mirror owner / per-workspace selection) — never a global current.
          try { status = await fetchRemoteStatus(scope && scope.sessionId, scope && scope.cwd) } catch {}
          if (!status || status.sessionMode !== 'remote') {
            if (onFatal) onFatal(tr('explorer.sessionLocal'))
            return
          }
          machine = (status && status.currentId) || ''
          if (!machine && status && status.activeSource === 'config') machine = 'config'
          if (!machine) {
            if (onFatal) { try { onFatal(tr('terminal.noMachine')) } catch {} }
            return
          }
          cwd = status.sessionRemotePath
          connect(cwd, machine)
        }
        void boot().catch((e) => { if (onFatal) onFatal(String(e.message || e)) })
      }

      return {
        kind: 'dsh-remote-ssh',
        open(session) {
          // The slot session: term (write-only surface), scope, tabId, cwd
          // hint + the view's callbacks.
          termSurface = session.term || null
          onOutput = session.onOutput || null
          onTitle = session.onTitle || null
          onConnected = session.onConnected || null
          onFatal = session.onFatal || null
          onEndpoint = session.onEndpoint || null
          start()
          return handle
        },
      }
    }

    /** The tab body: loads better-sidebar's TerminalView (via the official
     *  cross-plugin loader) and mounts it with the remote transport. */
    function RemoteTerminalPane(props) {
      const { ctx, scope, tab, store, visible } = props
      const [termSlice, setTermSlice] = React.useState(null)
      const [loadError, setLoadError] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        resolveBetterSidebarModules(ctx).then(
          async (mod) => {
            const slice = await mod.loadTerminalView()
            if (alive) setTermSlice(slice)
          },
          (e) => { if (alive) setLoadError(String((e && e.message) || e)) },
        )
        return () => { alive = false }
      }, [ctx])
      if (loadError) {
        return React.createElement('div', null,
          React.createElement('div', { style: { fontSize: 12, lineHeight: '18px', color: T.danger, padding: '12px 16px' } },
            tr('terminal.loadFail', { msg: loadError })))
      }
      if (!termSlice) {
        return React.createElement('div', null,
          React.createElement('div', { style: { fontSize: 12, lineHeight: '18px', color: T.label3, padding: '12px 16px' } }, tr('terminal.loading')))
      }
      const TerminalView = termSlice.TerminalView
      return React.createElement(TerminalView, {
        ctx,
        scope,
        store,
        tabId: tab && tab.id,
        visible,
        transport: makeRemoteTransport({
          scope,
          tab,
        }),
        onTitleChange: (title) => {
          try {
            if (ctx && ctx.betterSidebar && typeof ctx.betterSidebar.updateTab === 'function') {
              ctx.betterSidebar.updateTab(tab.id, { title })
            }
          } catch { /* older sidebar hosts */ }
        },
      })
    }

    // ── better-sidebar registration (guarded: plugin may be absent) ────────
    // Register the terminal-source provider: the DEFAULT terminal tab — the
    // term TerminalView renders in its hostRef div — becomes dsh-remote's
    // remote SSH shell in remote sessions, mirroring the FileTree source
    // takeover above. The slot only resolves TerminalView's `transport`
    // prop, so all TerminalView UI (blocks overlay, selection popup, info
    // bar, banners, fit/theme/font) stays the built-in one. Match:
    //   - agent terminals (tabId `agent:...`) are owned by the agent
    //     (close-frame lifetime) — never taken over,
    //   - global shared terminals (`gb:...`) stay local,
    //   - otherwise only sessions whose cwd sits inside a mirror dir get
    //     the remote transport; local sessions keep localTransport (the
    //     byte-for-byte default). Same synchronous MIRROR_DIRS test as the
    //     tree/section matchers (sessionIsRemote).
    // Returns the disposer, or null when the slot is absent.
    function registerRemoteTerminalProvider(bs) {
      if (typeof bs.registerTerminalProvider !== 'function') return null
      const match = (sessionId, cwd, tabId) => {
        if (typeof tabId === 'string' && (tabId.startsWith('agent:') || tabId.startsWith('gb:'))) return false
        return sessionIsRemote(cwd)
      }
      const createTransport = (sessionId, cwd, tabId) => makeRemoteTransport({
        // The transport only reads sessionId + cwd (scope for the handshake
        // + resume key); the built-in tab's scope carries the same fields.
        scope: { sessionId: sessionId || undefined, cwd: cwd || undefined },
        tab: { id: tabId },
      })
      return bs.registerTerminalProvider({ id: REMOTE_TERMINAL_PROVIDER_ID, match, createTransport })
    }

    function registerSidebarIntegration(ctx) {
      const bs = (ctx && ctx.get && ctx.get('betterSidebar')) || null
      if (!bs || typeof bs.registerTab !== 'function') return
// Issue #32 migration: drop the remote paths an older dsh-remote left in
      // PERSISTED sidebar state, BEFORE the built-in Files tree loads them
      // through its local fs guard. Runs once per activation; a failure is
      // harmless because the tab-level healing repeats it.
      try {
        migratePollutedSidebarState(typeof window !== 'undefined' ? window.localStorage : null)
      } catch { /* best-effort migration */ }
      const features = () => (bs.features && Array.isArray(bs.features)) ? bs.features : []
      const hasFeature = (name) => features().includes(name)
      const disposers = []
      let disposed = false
      let mirrorTimer = 0 // pending MIRROR_ROOT retry (cleared on dispose)
      let termTimer = 0 // pending terminal-provider mirror retry (cleared on dispose)
      let gitTimer = 0 // pending git-provider mirror retry (cleared on dispose)

      // ── File-tree integration (section v0.19/source v0.20, provider
      // v0.17/0.18) — handled FIRST and INDEPENDENTLY of the tab
      // registrations below: a tab registration failure (e.g. a duplicate
      // id left by a re-activation whose disposer never ran) must NOT
      // silently drop the file-tree takeover. That coupled failure mode
      // left the Files tree permanently on the empty local mirror — the
      // "no data" symptom. Feature-graded:
      //   fileTreeSection (+fileTreeSectionSource) → section (v0.20: host
      //     FileTree + our data source; v0.19: our own tree component);
      //   fileTreeSource only → provider (multi-root/single-source fallback);
      //   neither → the 🌐 tab (registered below) stays the remote surface.
      // The mirror root (MIRROR_ROOT) gates every tree match synchronously.
      // It is fetched from /dsh-remote/status at startup; when the fetch
      // fails or the host still reports an empty root (boot race, host half
      // warming up, transient error) it is RETRIED with backoff, so a late
      // landing still takes the tree over. The section/provider is
      // registered only once the mirror root is non-empty: registering
      // earlier would occupy the first-match slot with a never-matching
      // descriptor, and the host resolves the tree only on registry ticks —
      // the takeover must not be missed.
      const treeCapable = typeof bs.registerFileTreeSection === 'function' || typeof bs.registerFileTreeProvider === 'function'
      const treeWillRegister = treeCapable && (hasFeature('fileTreeSection') || (hasFeature('fileTreeSource') && typeof bs.registerFileTreeProvider === 'function'))
      // Host-registry sight check: the section/provider is ALREADY up (e.g.
      // a previous activation registered it and its disposer never ran).
      // Registering again would throw a duplicate id — treat the takeover
      // as present and stop.
      const treeAlreadyUp = () => {
        try {
          if (hasFeature('fileTreeSection') && typeof bs.getFileTreeSections === 'function') {
            if (bs.getFileTreeSections().some((s) => s && s.id === REMOTE_TREE_SECTION_ID)) return true
          }
          if (!hasFeature('fileTreeSection') && hasFeature('fileTreeSource') && typeof bs.getFileTreeProviders === 'function' && typeof bs.registerFileTreeProvider === 'function') {
            if (bs.getFileTreeProviders().some((p) => p && p.id === REMOTE_TREE_PROVIDER_ID)) return true
          }
        } catch { /* registry-less stub */ }
        return false
      }
      if (treeWillRegister && !treeAlreadyUp()) {
        let treeRegistered = false
        let mirrorAttempts = 0
        const fillMirrorRoot = () => {
          if (disposed) return
          mirrorAttempts += 1
          fetchMirrorRoot().then((root) => {
            if (disposed) return
            if (root) {
              if (!treeRegistered) {
                try {
                  if (hasFeature('fileTreeSection')) {
                    const off = registerRemoteTreeSection(bs, ctx)
                    if (off) { disposers.push(off); treeRegistered = true }
                    // v0.20: row ops ride the host's command menus.
                    if (hasFeature('fileTreeSectionSource')) {
                      const off2 = registerRemoteRowCommands(bs)
                      if (off2) disposers.push(off2)
                    }
                  } else if (hasFeature('fileTreeSource') && typeof bs.registerFileTreeProvider === 'function') {
                    const off = registerRemoteTreeProvider(bs, ctx)
                    if (off) { disposers.push(off); treeRegistered = true }
                  }
                } catch (e) {
                  console.warn('[dsh-remote] file-tree integration skipped:', e)
                }
              }
              return // mirror root known + tree handled → stop polling
            }
            // Empty mirror root (status fetch failed / host half not ready):
            // retry with backoff (1s, 2s, 4s, 8s, 16s, then 30s cap).
            const backoff = Math.min(30000, 1000 * Math.pow(2, Math.min(mirrorAttempts, 5)))
            mirrorTimer = setTimeout(fillMirrorRoot, backoff)
          })
        }
        fillMirrorRoot()
      }

      // ── Terminal-source takeover (registerTerminalProvider / terminal-
      // source slot) — INDEPENDENT of the file-tree block and the tab
      // registrations: a tab registration failure must not drop it (same
      // reasoning as the tree block above). Capability-graded by the
      // method's presence (the slot's only version shape). Registered only
      // once the mirror root is known — a provider registered earlier with
      // empty MIRROR_DIRS would never match, and the host resolves the
      // transport only when a terminal tab MOUNTS: a terminal opened in
      // the boot window would be pinned to the local pty forever. Same
      // backoff loop as the tree (1s…30s cap).
      const termCapable = typeof bs.registerTerminalProvider === 'function'
      // Host-registry sight check: already up (re-activation whose disposer
      // never ran) → registering again would throw a duplicate id.
      const termAlreadyUp = () => {
        if (!termCapable) return true
        try {
          if (typeof bs.getTerminalProviders === 'function') {
            return bs.getTerminalProviders().some((p) => p && p.id === REMOTE_TERMINAL_PROVIDER_ID)
          }
        } catch { /* registry-less stub */ }
        return false
      }
      if (termCapable && !termAlreadyUp()) {
        let termRegistered = false
        let termAttempts = 0
        const fillTermMirror = () => {
          if (disposed) return
          termAttempts += 1
          fetchMirrorRoot().then((root) => {
            if (disposed) return
            if (root) {
              if (!termRegistered) {
                try {
                  const off = registerRemoteTerminalProvider(bs)
                  if (off) { disposers.push(off); termRegistered = true }
                } catch (e) {
                  console.warn('[dsh-remote] terminal-source takeover skipped:', e)
                }
              }
              return // mirror root known → stop polling
            }
            const backoff = Math.min(30000, 1000 * Math.pow(2, Math.min(termAttempts, 5)))
            termTimer = setTimeout(fillTermMirror, backoff)
          })
        }
        fillTermMirror()
      }

      // ── Git-source takeover (registerGitProvider / gitSource slot,
      // v0.23.0+) — INDEPENDENT of the file-tree and terminal blocks: a
      // failure anywhere else must not leave remote sessions pinned to the
      // LOCAL git.* routes (they describe the MIRROR, whose .git is usually
      // absent/stale). Feature-gated ('gitSource' + the method's presence):
      // older hosts keep their own git surface byte for byte. Like the tree
      // and terminal providers, registration waits for a known mirror root —
      // `match` uses the synchronous MIRROR_DIRS test, and the host resolves
      // the source per render, so an early (pre-root) registration would
      // never match anything. Same backoff loop (1s…30s cap).
      const gitCapable = hasFeature('gitSource') && typeof bs.registerGitProvider === 'function'
      const gitAlreadyUp = () => {
        if (!gitCapable) return true
        try {
          if (typeof bs.getGitProviders === 'function') {
            return bs.getGitProviders().some((p) => p && p.id === REMOTE_GIT_PROVIDER_ID)
          }
        } catch { /* registry-less stub */ }
        return false
      }
      if (gitCapable && !gitAlreadyUp()) {
        let gitRegistered = false
        let gitAttempts = 0
        const fillGitMirror = () => {
          if (disposed) return
          gitAttempts += 1
          fetchMirrorRoot().then((root) => {
            if (disposed) return
            if (root) {
              if (!gitRegistered) {
                try {
                  const off = registerRemoteGitProvider(bs, ctx)
                  if (off) { disposers.push(off); gitRegistered = true }
                } catch (e) {
                  console.warn('[dsh-remote] git-source takeover skipped:', e)
                }
              }
              return // mirror root known → stop polling
            }
            const backoff = Math.min(30000, 1000 * Math.pow(2, Math.min(gitAttempts, 5)))
            gitTimer = setTimeout(fillGitMirror, backoff)
          })
        }
        fillGitMirror()
      }

      try {
        // v0.19+: the remote tree lives in the Files panel's top section —
        // the standalone 🌐 explorer tab is retired. Older sidebars keep it.
        if (!hasFeature('fileTreeSection')) {
          disposers.push(bs.registerTab({
            id: SIDEBAR_EXPLORER_ID,
            title: () => tr('explorer.tabTitle'),
            icon: (size) => React.createElement('span', { style: { fontSize: (size || 14), lineHeight: 1 } }, '🌐'),
            order: 55,
            single: true,
            // Issue #32: own the expansion state (see RemoteExplorerTabOwned).
            component: RemoteExplorerTabOwned,
          }))
        }
        disposers.push(bs.registerTab({
          id: SIDEBAR_FILE_ID,
          title: () => tr('explorer.tabTitle'),
          hidden: true, // not in the + menu; opened from the explorer tree
          dedupeKey: (tab) => tab.path,
          component: (props) => React.createElement(RemoteFileTab, props),
        }))
        disposers.push(bs.registerTab({
          id: SIDEBAR_TERMINAL_ID,
          title: () => tr('terminal.tabTitle'),
          icon: (size) => React.createElement('span', { style: { fontSize: (size || 14), lineHeight: 1 } }, '🖥'),
          order: 60,
          // The default sidebar terminal is local; remote mirrors need this tab.
          available: (_ctx, scope) => sessionIsRemote(scope && scope.cwd),
          component: (props) => React.createElement(RemoteTerminalPane, props),
        }))
      } catch (e) {
        console.warn('[dsh-remote] better-sidebar integration skipped:', e)
        disposers.forEach((d) => { try { d() } catch {} })
        return
      }
      let autoOpenedFor = new Set()
      let disposeAuto = null
      const tryAutoOpen = () => {
        // v0.19+: the remote tree is already the Files panel's top section —
        // popping a 🌐 tab on top would duplicate the surface.
        if (hasFeature('fileTreeSection')) return
        if (typeof bs.subscribeState !== 'function') return
        const snap = bs.getSnapshot && bs.getSnapshot()
        if (!snap || !snap.sessionId) return
        if (autoOpenedFor.has(snap.sessionId)) return
        const sessionId = snap.sessionId
        // Issue #13: only auto-open the Remote Files tab for sessions that are
        // genuinely remote (cwd inside a mirror). A plain local session must
        // not get a remote tab popped open by a machine that happens to be
        // saved as "current".
        resolveSessionRemote(sessionId).then((remotePath) => {
          if (!remotePath || autoOpenedFor.has(sessionId)) return
          autoOpenedFor.add(sessionId)
          try {
            bs.openTab({ type: SIDEBAR_EXPLORER_ID, title: tr('explorer.tabTitle'), path: remotePath })
          } catch (e2) {
            console.warn('[dsh-remote] better-sidebar auto-open skipped:', e2)
          }
        })
      }
      tryAutoOpen()
      if (typeof bs.subscribeState === 'function') {
        disposeAuto = bs.subscribeState(tryAutoOpen)
        disposers.push(disposeAuto)
      }
      return () => {
        disposed = true
        if (mirrorTimer) { clearTimeout(mirrorTimer); mirrorTimer = 0 }
        if (termTimer) { clearTimeout(termTimer); termTimer = 0 }
        if (gitTimer) { clearTimeout(gitTimer); gitTimer = 0 }
        disposers.forEach((d) => { try { d() } catch {} })
      }
    }

    // 读取宿主下发的侧栏 directory-flow 槽位 key（GET /dsh-remote/slot-config，
    // 返回最终生效值：显式 config > patch 表达式自动匹配 > loader.entries() 兜底
    // 探测 > 官方默认）。读取失败/未设置 → ''（调用方用官方 key 兜底）。3s 超时
    // 兜底，防止宿主异常时插件激活被挂起（browser 半没有宿主半的超时习惯，这里
    // 显式保护；CJS bundle 内无 top-level await，只在 apply 内 await）。
    function fetchSidebarDirectoryFlowSlot() {
      return Promise.race([
        fetch('/dsh-remote/slot-config', { method: 'GET' })
          .then((r) => r.json().catch(() => ({})))
          .then((data) => {
            const slot = data && typeof data.sidebarDirectoryFlowSlot === 'string' ? data.sidebarDirectoryFlowSlot.trim() : ''
            return slot
          })
          .catch(() => ''),
        new Promise((resolve) => setTimeout(() => resolve(''), 3000)),
      ])
    }

    async function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      wireLocale(ctx)
      WORKSPACES = (ctx && ((ctx.get && ctx.get('workspaces')) || ctx.workspaces)) || null
      SESSIONS = (ctx && ((ctx.get && ctx.get('sessions')) || null)) || null
      slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: 'dsh-remote', priority: 40, label: () => tr('settings.title') }, () => React.createElement(RemoteWorkspacePage, null)),
      )
      // 侧栏 directory-flow 槽位 key（DirPicker 的第二条注册）。默认 = 官方
      // ui-workspace hole，独立安装 dsh-remote 时行为不变；组合 dsh-enhanced-workspace
      // 的 profile 下（其 priority -1 遮蔽 sidebar.workspaces，官方子槽位「已注册、
      // 无人渲染」），宿主在装配期自动匹配（cordis.patch.yml 的 config: !!js 表达式
      // + loader.entries() 兜底探测）并经 /dsh-remote/slot-config 下发。这里 apply
      // 时异步读取（限时，失败/未设置 → 官方 key 兜底），拿到值后才声明侧栏注册。
      // 注意 slots.inject 的声明语义：外层 hero inject 必须在本 apply 内执行，侧栏
      // inject 留在 hero 回调里延迟到渲染期执行——届时上面的异步值已就位，渲染
      // 不会早于插件激活完成。
      // hero 侧注册保持官方 key 不动：enhanced-workspace 不遮蔽 hero，官方 hole
      // 在那里正常渲染（hero 若也切新 key，其 + 按钮会因自己的 hole 无人占用而隐藏）。
      const remoteSlot = await fetchSidebarDirectoryFlowSlot()
      const SIDEBAR_DIRECTORY_FLOW_SLOT = remoteSlot || 'sidebar.workspaces.directoryFlow'
      slots.inject(
        'conversation.hero.workspace.directoryFlow',
        () => slots.inject(SIDEBAR_DIRECTORY_FLOW_SLOT,
          function* () {
            yield slots.register({ name: 'conversation.hero.workspace.directoryFlow', id: 'dsh-remote', priority: -100 }, DirPicker)
            yield slots.register({ name: SIDEBAR_DIRECTORY_FLOW_SLOT, id: 'dsh-remote', priority: -100 }, DirPicker)
          },
        ),
      )
      ctx.inject(['betterSidebar'], (inner) => {
        const bsDispose = registerSidebarIntegration(inner)
        if (bsDispose) {
          inner.effect(() => bsDispose, 'dsh-remote.betterSidebar')
        }
      })
    }
    exports.name = name
    exports.apply = apply
    return module.exports
  },
})
