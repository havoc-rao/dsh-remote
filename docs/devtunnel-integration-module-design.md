# Dev Tunnel SSH 对接模块化（设计 + 实施记录）

> 目标：把 dsh-remote 中与 `dsh-devtunnel-ssh` 对接的散落代码收拢为独立模块统一管理。
> 约束：**宿主 client 单文件契约**（`__ModuleLoader__.load` 只 serve 每插件一个
> `client.js`，factory 的 `require` 只解析声明 external，测试断言
> "requires only its declared React external"）——客户端**物理拆文件不可行**，
> 采用「文件内模块区段 + 依赖注入」；宿主侧为标准 ESM，可自由拆/加文件。
> 零行为变更：纯组织重构，所有逻辑逐行搬移，不顺手简化。**已实施并通过
> 全量测试（825 例 / 818 过，唯一失败为 docs-images 的 Python PIL 缺失环境
> 问题）与 `node check.mjs`。**

---

## 一、模块边界总览

### 宿主侧（可拆文件，独立模块已存在，只补一个入口）

| 模块 | 现状 | 本次改动 |
|---|---|---|
| `lib/ssh-carrier.js` | carrier 注册表（63 行，通用 ABI，不含 devtunnel 字样） | 新增 `sshCarrierCapabilitiesFor(config)` 纯函数，收走 index.js 的能力组装 |
| `lib/ssh-carrier-{pool,cache,record}.js` | 池/缓存/持久化门（通用语义） | 不动 |
| `lib/index.js` | L1938-1946 内联能力表达式（唯一硬编码 `'devtunnel'` 处，L1942） | 改为调用 `sshCarrierCapabilitiesFor` |

### 客户端侧（单文件契约，文件内模块化收拢）

| 现状（client.js） | 收拢后 |
|---|---|
| L1076-1078 三槽位常量 | `DevTunnel.SLOT_TRANSPORT_{OPTION,FIELDS,PANEL}` |
| L1083-1087 `canonicalJson` | `DevTunnel.canonicalJson` |
| L1056-1066 `isDevTunnelMachine/carrierAvailable/carrierModeAvailable` | `DevTunnel.*`（纯函数） |
| L1091-1108 `machineCarrierBody/carrierBodyKey` | `DevTunnel.*`（纯函数） |
| L1182-1186 `carrierAddrText` | `DevTunnel.carrierAddrText` |
| L1337-1342 carrier probe 体构造 | `DevTunnel.carrierProbeBody(carrier, form)` |
| L1216-1331 carrier 草稿状态机 | `DevTunnel.useCarrierDraft(getFormTransport)`（自定义 hook） |
| L1403-1475 隧道全局设置状态 + 3 个 API 调用 | `DevTunnel.useTunnelSettings({ apiRaw, tr, confirm, refresh })`（自定义 hook） |
| L1774-1790 隧道设置卡渲染 | `DevTunnel.tunnelCard({ tr, row, T, tunnel })`（纯渲染函数） |
| L5718-5735 槽位注册 | `DevTunnel.registerSlots(slots, RemoteWorkspacePage)` |
| L51-64/L364-377 隧道 i18n keys | 保留原位（字典按稳定 id 组织是既有约定，测试按 key 查，不抽） |
| L1118-1181 `SshTransportOption/SshMachineFields`（SSH 自身条目） | 保留主干（非 devtunnel 对接） |
| L1270-1331/L1618-1676/L1750-1767 owner 管线业务流 | 保留主干，数据存取改经 hook API |

---

## 二、宿主侧设计

### `lib/ssh-carrier.js` 新增导出

```js
// Pure capability surface for /status. Discovery must never probe/spawn the
// CLI nor expose config; the carrier registry is the only input besides the
// explicit sandbox opt-in.
export function sshCarrierCapabilitiesFor({ experimentalSshCarrier } = {}) {
  const enabled = experimentalSshCarrier === true
  return {
    apiVersion: 1,
    experimental: true,
    workspaceSupported: enabled,
    carrierIds: sshCarrierIds(),
    // 'devtunnel' is a registry key, not a dsh-remote feature name: kept next
    // to the registry so future transport plugins only extend `carrierIds`.
    devTunnelManaged: enabled && sshCarrierOf('devtunnel')?.capabilities?.managedConnect === true,
    freshProbe: enabled,
    schemaVersion: 3,
    authModes: ['agent', 'private-key'],
    productionReady: false,
    additionalForwards: false,
    perWorkspaceDisconnect: false,
  }
}
```

### `lib/index.js` 改动

- import 增加一个名字；L1938-1946 替换为 `sshCarrierCapabilities: sshCarrierCapabilitiesFor(config)`。
- 其余（`Config.experimentalSshCarrier`、`carrierPools`、`machinePoolOf`、save/test-connect 门、镜像身份）不动——它们是 carrier 通用语义，非 devtunnel 专用。

---

## 三、客户端模块设计（`lib/client.js` 内）

模块区段插在 L1054 注释区（RemoteWorkspacePage 定义之前），采用**同一工厂
作用域的模块化区段**（非 IIFE：`row/SshTransportOption/SshMachineFields` 等
同作用域函数声明被提升、调用时解析，IIFE 反而需要额外注入，可平移性相同）。
依赖：`React`（factory 顶层已取）、`tr`/`T`、`apiRaw/api`——已列在区段头注释。
⚠ 区段头注释第一行必须保留 `── Settings` 字样：`workspace-isolation.test.js`
用它做 `scopeCwdGuess` 源码切片锚点。

```js
// ── Settings → 远程工作区 · Dev Tunnel SSH 对接模块（client.js 内独立区段）─
// 宿主 client 单文件契约（__ModuleLoader__ 只 serve 一个 client.js、require
// 只解析 external）：本模块物理上留在 client.js 内，逻辑上独立 —— 所有
// /dsh-devtunnel-ssh/* 对接、carrier 槽位 ABI、纯函数集中于此，并经依赖
// 注入消费，RemoteWorkspacePage 主干不直接触碰 devtunnel 语义。
// 若未来宿主支持多 client 文件，整段平移为 lib/devtunnel-client.js 即可。
const SLOT_TRANSPORT_OPTION = 'settings.remote.machine.transport.option'
const SLOT_TRANSPORT_FIELDS = 'settings.remote.machine.transport.fields'
const SLOT_TRANSPORT_PANEL = 'settings.remote.machine.transport.panel'

// canonical：递归按键名排序后 stringify（键序不构成契约）。
function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}'
  return JSON.stringify(v)
}

// UI-only transport label：持久化 carrier 机器仍是普通 SSH。
function isDevTunnelMachine(m) {
  return !!(m && m.connector && m.connector.kind === 'devtunnel')
}
function carrierAvailable(status) {
  const c = status && status.sshCarrierCapabilities
  return !!(c && c.workspaceSupported === true && Array.isArray(c.carrierIds) && c.carrierIds.includes('devtunnel'))
}
function carrierModeAvailable(status, mode) {
  if (!carrierAvailable(status)) return false
  if (mode === 'managed') return status.sshCarrierCapabilities.devTunnelManaged === true
  return mode === 'external'
}
// 已保存 carrier 机器的「与 occupant 同形」快照（POST body 同形 8 键）。
function machineCarrierBody(m) { /* 原实现逐行搬移（L1091-1102） */ }
// 草稿比较键：非法/非 SSH body 返回 ''。
function carrierBodyKey(body) { /* 原实现（L1104-1108） */ }
function carrierAddrText(m) { /* 原实现（L1182-1186），tr 走外层作用域 */ }
// carrier 探测体：已存且草稿未变 → { id }；新机器 → draft.body。
function carrierProbeBody(carrier, form) {
  if (carrier && form.id) return { id: form.id }
  return carrier ? (committedCarrier().body) : null // 实际签名见下方用法
}
```

### hook 1：carrier 草稿状态机

```js
// 草稿由占用方经 owner props 的 carrier.publish 发布；owner 只做「同形快照 +
// canonical 比较」通用管线，不解释字段语义。幂等是契约：canonical 与已存
// 草稿相同（含 valid）时不得 setState（occupant effect → publish → setState
// → 重渲染会成环）。对象引用/键序都不能当身份，身份 = canonical 串。
function useCarrierDraft(getFormTransport) {
  const [draftValid, setDraftValid] = React.useState(false)
  const [saved, setSaved] = React.useState('')
  const savedRef = React.useRef('')
  const pendingSave = React.useRef(null) // { key, canonical } 保存应答后纠正 dirty
  const draftRef = React.useRef(null)     // 渲染期 published 快照
  const draftCanonRef = React.useRef(canonicalJson(null))
  const draftTransport = React.useRef(getFormTransport())

  const publish = (draft) => { /* 原 publishCarrier 逐行搬移（L1278-1306） */ }
  const of = () => draftRef.current || { valid: false, body: null, key: '' }
  const dirty = (() => { const d = of(); return !d.valid || d.key !== savedRef.current })()
  // 渲染期 transport 切换作废旧草稿（原 L1313-1319）
  if (draftRef.current !== null && draftTransport.current !== getFormTransport()) {
    draftRef.current = null
    draftCanonRef.current = canonicalJson(null)
    draftTransport.current = getFormTransport()
  } else if (draftTransport.current !== getFormTransport()) {
    draftTransport.current = getFormTransport()
  }
  const committed = () => { const d = of(); return d.valid && d.body ? d : null }

  const committed = () => { const d = of(); return d.valid && d.body ? d : null }
  // 直接落 saved 基线（key 已算好；清空 pending 纠正）——save() 成功分支用。
  const commitSaved = (key) => {
    savedRef.current = key
    pendingSave.current = null
    setSaved(key)
  }
  // 编辑已存机器：saved 快照走同形构造（原 startEdit L1604-1607）
  const beginEdit = (savedBody) => commitSaved(savedBody ? carrierBodyKey(savedBody) : '')
  const reset = () => commitSaved('') // 原 clearForm L1615 前两行

  return { draftValid, saved, savedRef, pendingSave, publish, of, dirty, committed, commitSaved, beginEdit, reset }
}
```

### hook 2：隧道全局设置

```js
// 只读/保存永不执行 CLI；仅经 confirm 的 preflight 可运行它，恒用宿主设置。
function useTunnelSettings({ apiRaw, tr, confirm, refresh }) {
  const [settings, setSettings] = React.useState(null)
  const [draft, setDraft] = React.useState({ cliExecutable: '', managedEnabled: false })
  const [busy, setBusy] = React.useState(false)
  const lock = React.useRef(false)
  const [err, setErr] = React.useState('')
  const [msg, setMsg] = React.useState('')
  const [probe, setProbe] = React.useState(null)
  const ready = !!(settings && settings.available === true)
  const dirty = ready && (draft.cliExecutable !== settings.settings.cliExecutable || draft.managedEnabled !== settings.settings.managedEnabled)
  const path = draft.cliExecutable.trim()
  const valid = draft.cliExecutable.length <= 4096 && !/[\u0000-\u001f\u007f-\u009f]/.test(draft.cliExecutable) && (!path || path.startsWith('/'))
  const apply = (r) => { /* 原 applyTunnelSettings（L1414-1419） */ }
  const errorText = (r, status, shape) => { /* 原 tunnelError（L1421-1433） */ }
  const refreshSettings = async (initial = false) => { /* 原 refreshTunnelSettings，apiRaw 注入（L1434-1446） */ }
  const save = async () => { /* 原 saveTunnelSettings，confirm/refresh 注入（L1448-1464） */ }
  const preflight = async (checkLogin) => { /* 原 preflightTunnel（L1465-1475） */ }
  React.useEffect(() => { refreshSettings(true) }, [])
  // setter 一并返回（tunnelCard 的 onChange 直接消费：清 probe/msg 等）。
  return { settings, draft, setDraft, busy, setBusy, err, setErr, msg, setMsg, probe, setProbe, ready, dirty, path, valid, refreshSettings, save, preflight }
}
```

### 渲染 + 槽位注册

```js
// 隧道全局设置卡（原 L1774-1790）。row/tr/T 注入；返回单个 vnode。
function tunnelCard({ tr, row, T, tunnel }) {
  // 原渲染逐行搬移；data-testid 不变：devtunnel-global-settings / devtunnel-resolved-executable
}

// settings.section 条目 + 三子槽位声明 + SSH 自身条目（原 apply() 内 L5718-5735）。
// 子槽位声明随 register 提交（occupant 的 slots.inject 一定能等到声明，与加载
// 顺序无关）；renderSlot 必须透传进页面：声明即认领。
function registerSlots(slots, RemoteWorkspacePage, sshEntries) {
  slots.inject('settings.section', () =>
    slots.register({
      name: 'settings.section', id: 'dsh-remote', order: 40, label: () => tr('settings.title'),
      children: {
        [SLOT_TRANSPORT_OPTION]: { kind: 'list', scope: 'root' },
        [SLOT_TRANSPORT_FIELDS]: { kind: 'keyed', scope: 'root' },
        [SLOT_TRANSPORT_PANEL]: { kind: 'list', scope: 'root' },
      },
    }, (props) => React.createElement(RemoteWorkspacePage, { renderSlot: props && props.renderSlot })),
  )
  // SSH 自身条目经参数注入（模块区段可平移性：不隐式依赖同作用域组件）。
  slots.inject(SLOT_TRANSPORT_OPTION, () =>
    slots.register({ name: SLOT_TRANSPORT_OPTION, id: 'ssh', order: 0 }, sshEntries.option),
  )
  slots.inject(SLOT_TRANSPORT_FIELDS, () =>
    slots.register({ name: SLOT_TRANSPORT_FIELDS, key: 'ssh' }, sshEntries.fields),
  )
}
```

> `SshTransportOption/SshMachineFields/machineFieldsBag` 仍留在主干（SSH 自身
> 条目 + owner props 组装，非 devtunnel 语义）。`row/formText/formCheck` 亦不抽。

---

## 四、RemoteWorkspacePage 改造点（逐个动作）

| 动作 | 原位置 | 改成 |
|---|---|---|
| 删除 3 个槽位常量定义 | L1076-1078 | 引用模块导出 |
| 删除 `isDevTunnelMachine/carrierAvailable/carrierModeAvailable/machineCarrierBody/carrierBodyKey/canonalicalJson/carrierAddrText` 定义 | L1056-1108, L1182-1186 | 模块导出 |
| `const carrier = useCarrierDraft(() => form.transport)` | 新增（L1219 前） | 替换 L1219-1225 的 6 个 state/ref + L1278-1331 的发布/派生/切换作废 |
| 原 `publishCarrier` 调用点 | fieldsBag（L1761） | `carrier.publish` |
| 原 `carrierOf/carrierDirty/carrierSavedRef/committedCarrier` 引用 | L1307-1331, L1750-1754 等 | `carrier.of/carrier.dirty/carrier.savedRef/carrier.committed` |
| `testConn` carrier 分支 | L1324-1349 | 用 `carrier.committed()` + `carrier.savedRef.current`；probe 体构造改 `DevTunnel` 函数 |
| `startEdit` carrier saved 快照 | L1604-1607 | `carrier.beginEdit(machineCarrierBody(m))` |
| `clearForm` carrier 重置 | L1615 | `carrier.reset()` |
| `save` carrier 分支 | L1623-1643 | 引用替换（`pendingCarrierSave` → `carrier.pendingSave` 等），流程不动 |
| `createCarrierMirror/useNow` 门 | L1659-1676 | 引用替换 |
| 隧道设置 10 个 state/函数 | L1403-1475 | `const tunnel = useTunnelSettings({ apiRaw, tr, confirm: window.confirm.bind(window), refresh })` |
| 隧道卡渲染 | L1774-1790 | `DevTunnel.tunnelCard({ tr, row, T, tunnel })` |
| 槽位注册 | L5718-5735 | `DevTunnel.registerSlots(slots, RemoteWorkspacePage)` |

**不做**：i18n keys、所有权归属（隧道卡仍归 dsh-remote）、通信契约
（`/dsh-devtunnel-ssh/*` 路由归属不变）、carrier 通用语义浸染主干的部分。

---

## 五、测试影响与验证（已实施，结果见下）

| 项 | 处理 | 结果 |
|---|---|---|
| `node --test`（全量 825 例） | 全量跑 | 818 过 / 1 失败；**唯一失败 `docs-images` 的截图边缘检查是本机 Python 缺 PIL 的环境问题，与本次改动无关**。受影响专项（client-devtunnel-settings、client-carrier-integration、workspace-isolation、client-smoke、ssh-carrier-managed-contract 等）39/39 全过 |
| `test/ssh-carrier-managed-contract.test.js` | 表达式切片源改为 `lib/ssh-carrier.js`，vm 变量 `config.experimentalSshCarrier` → `enabled`（函数局部名） | 已同步并通过 |
| `node check.mjs` | 静态闸门（铁律 6） | OK（route/command/tool/schema lint 全过） |
| `scripts/boot-smoke.sh` | 本机 APP 常量指向他人路径，跑不了 | 宿主侧真实启动已被 `ssh-carrier-cordis.test.mjs`（真实 Cordis Context apply）与 `ssh-carrier-apply-wire.test.mjs`（真实 apply + 路由 + ssh2 回环）覆盖并通过 |
| 客户端字节变化 | 铁律 4：wire rev 宿主启动时烘焙，需重建+重启 | 未执行（改完需 `./scripts/sync-profile.sh --wire` + 重启宿主 + 浏览器硬刷）——**上线前必做** |
| DCF 注入 | 仓库 `lib/` 永不落注入 | `grep -c data-locatorjs lib/client.js` = 0，干净 |

## 六、风险清单

1. **publish 幂等环是最高风险点**：`useCarrierDraft` 搬移时逐行保留
   `validSame/bodySame/pending 结算` 逻辑，不得"顺手简化"——occupant
   （dsh-devtunnel-ssh）的 effect → publish → setState → 重渲染环依赖它。
2. **hooks 调用序**：`useCarrierDraft/useTunnelSettings` 必须留在
   RemoteWorkspacePage 顶层（与原 state 声明同位），不得进入条件分支。
3. **`getFormTransport` 必须返回渲染期 `form.transport`**（切换 transport 作废
   草稿依赖它），闭包即 `() => form.transport`。
4. **host 侧字符串切片测试**（上述 managed-contract）须同步，否则 check 挂。
5. 不引入任何新状态/新依赖；模块化不改变 wire 协议与持久化形态。