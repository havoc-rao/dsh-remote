// dsh-remote Provider 注册与分发层（Step2，ADR-0002）
// 零构建手写模块；只做注册/校验/分发，不持有任何 SSH 或 HTTP 语义。
// 约束（dev-standards.md）：provider id 匹配 /^[a-z][a-z0-9_-]*$/u；可选服务只能 ctx.get()；
// 本模块不依赖 cordis，纯数据层，便于单测。

const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]*$/u;

/** @type {Map<string, object>} */
const registry = new Map();

/**
 * 注册一个传输 Provider。
 * @param {object} def
 * @param {string} def.id            如 'ssh' | 'vscode-tunnel'
 * @param {number} [def.apiVersion]  默认 1
 * @param {string} [def.label]       展示名（可选）
 * @param {(record:object)=>void} [def.validateMachine]   校验机器记录，非法抛错
 * @param {(record:object)=>object} [def.sanitizeMachine] 输出脱敏（白名单），返回新对象
 * @param {(args:{machine:object, credentialResolver?:()=>Promise<string>, signal?:AbortSignal})=>Promise<object>} def.connect
 *        连接句柄：{ identity, capabilities, status, fs, exec, jobs, close }
 * @returns {()=>void} disposer（ctx.effect 用）
 */
export function registerProvider(def) {
  if (!def || typeof def !== 'object') throw new Error('provider: definition object required')
  if (typeof def.id !== 'string' || !PROVIDER_ID_RE.test(def.id)) {
    throw new Error(`provider: invalid id ${JSON.stringify(def && def.id)} (must match ${PROVIDER_ID_RE})`)
  }
  if (typeof def.connect !== 'function') throw new Error(`provider ${def.id}: connect() required`)
  if (registry.has(def.id)) throw new Error(`provider ${def.id}: already registered`)
  // 注：任务书逐字稿为 registry.set(def.id, {apiVersion:..., ...def})，disposer 却比较
  // registry.get(def.id) === def（原始引用）——存的是展开副本，比较恒 false，disposer 永远
  // 不注销（Step2 执行期偏离，已回报；行为保持不变，仅修复注销路径）。
  const entry = { apiVersion: def.apiVersion || 1, ...def }
  registry.set(def.id, entry)
  return () => { if (registry.get(def.id) === entry) registry.delete(def.id) }
}

/** @returns {string[]} 已注册 provider id */
export function providerIds() { return [...registry.keys()] }

/**
 * 取 provider 定义；未注册返回 undefined（调用方必须容忍，等同能力门禁拒绝）。
 * @param {string} id
 */
export function providerOf(id) { return registry.get(id) }

/**
 * 按机器记录分派 provider。记录缺省 transport='ssh'（兼容存量数据）。
 * @param {object} machine
 */
export function providerForMachine(machine) {
  const t = machine && machine.transport ? String(machine.transport) : 'ssh'
  return { transport: t, def: registry.get(t) }
}

/**
 * 校验机器记录（先 validateMachine 后补默认 transport/credentialRef）。
 * @param {object} machine
 */
export function validateMachineRecord(machine) {
  if (!machine || typeof machine !== 'object') throw new Error('machine record required')
  const { transport, def } = providerForMachine(machine)
  if (!def) throw new Error(`transport ${JSON.stringify(transport)}: provider not installed`)
  if (typeof def.validateMachine === 'function') def.validateMachine(machine)
  return machine
}

/**
 * 脱敏机器记录：先跑 Provider 的 sanitizeMachine（白名单），再统一剥除
 * password/私钥/凭据引用类字段，保证任何下发路径不泄露。
 * @param {object} machine
 */
export function sanitizeMachineRecord(machine) {
  const { def } = providerForMachine(machine)
  let out = { ...machine }
  if (def && typeof def.sanitizeMachine === 'function') {
    out = def.sanitizeMachine(out) || out
  }
  if ('password' in out && out.password !== undefined && out.password !== '') {
    out.passwordSet = true
    out.password = ''
  }
  if ('credentialRef' in out && out.credentialRef !== undefined) {
    out.credentialSet = !!out.credentialRef
    out.credentialRef = ''
  }
  if (out.tunnel && typeof out.tunnel === 'object') {
    out.tunnel = { ...out.tunnel }
    if ('secret' in out.tunnel) { out.tunnel.secretSet = !!out.tunnel.secret; out.tunnel.secret = '' }
  }
  return out
}

/**
 * 建立连接（概念形状见 ADR-0002 D2）。signal 可中止；credentialResolver 惰性取凭据。
 * @param {object} machine
 * @param {{signal?:AbortSignal, credentialResolver?:()=>Promise<string>}} [opts]
 */
export async function connectMachine(machine, opts = {}) {
  const { transport, def } = providerForMachine(machine)
  if (!def) throw new Error(`transport ${JSON.stringify(transport)}: provider not installed`)
  return def.connect({ machine, credentialResolver: opts.credentialResolver, signal: opts.signal })
}
