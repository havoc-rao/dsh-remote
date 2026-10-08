# Dev Tunnel + SSH 远程工作区构建计划

> 日期：2026-10-07（Asia/Shanghai）
> 状态：待评审，尚未实施。本文仅定义构建和验收计划，不授权登录、安装服务、修改 SSH/防火墙、部署产品 profile 或迁移现有机器。
> 方向：用微软 Dev Tunnels 承载标准 SSH，复用 dsh-remote 的 SSH/SFTP/PTY 能力，取消新连接模式对 VS Code、扩展和自定义 Bridge Worker 的依赖。

## 1. 目标与结论

交付一种“无需公网入站端口、无需 VS Code 窗口、无需自定义远端 Worker”的远程工作区连接方式。

远端仍必须运行两个组件：系统 OpenSSH Server（sshd）负责执行；官方 devtunnel host 负责出站隧道。本机 DSH 所在主机运行 devtunnel connect，dsh-remote 使用现有 SSH 引擎连接其 loopback 端点。

这不是把 code tunnel 变成 SSH Server，也不是继续复用 VS Code 管理的 Tunnel。新模式使用独立创建、独立管理的 Dev Tunnel，避免端口条目受 VS Code 会话生命周期影响。

**证据边界**：官方文档说明 devtunnel host/connect 提供本地端口转发；旧 Bridge 已证明过真实双机 devtunnel 链路。尚未证明 SSH-over-Dev-Tunnel 在目标机器上的完整可用性、无交互后台认证和重启恢复。因此 Step0 是硬性实机门槛，失败就停止后续产品化。

## 2. 架构与责任划分

```text
控制端 A（DSH host 所在机器，而非仅浏览器所在机器）
  DSH / dsh-remote
    ├─ 机器注册、工作区绑定、镜像、rw_*、侧栏、Git、终端
    ├─ SSH 引擎：SshPool / ssh2 / SFTP / PTY
    └─ Dev Tunnel 连接管理器
          └─ 官方 devtunnel connect 子进程
                └─ 127.0.0.1:<实际本地端口> → 微软中继
                                                    ↓
远端 B                                              ↓
  官方 devtunnel host ← 出站连接至微软中继 ←───────────┘
    └─ SSH 服务端口 → 系统 sshd
                        ├─ SFTP
                        ├─ 命令执行
                        └─ PTY shell
```

- **系统 sshd**：用户认证、主机密钥、shell、文件访问权限；无需完整 DSH 或 Node Worker。
- **官方 devtunnel CLI**：账号授权、隧道和端口转发；不自行实现或逆向微软协议。
- **DSH 管理器**：有限范围内管理本机连接进程、状态、重连与清理；不持有浏览器登录令牌。
- **部署辅助材料**：检查远端先决条件、生成受控操作步骤和后台服务模板；首版不做自研远端 daemon。

## 3. 首版范围

### 3.1 平台策略

- 首个验收组合：macOS 控制端 → macOS 远端，复用现有双 Mac 条件。
- Windows PC：列为第二验收里程碑，不能用 Mac 通过替代 Windows 支持声明。需独立验证 OpenSSH Server、SFTP、PowerShell/Git Bash、驱动器路径、PTY 和服务账号登录环境。
- Linux：后续增加 systemd 与发行版矩阵，不在首次交付中承诺。
- 若首个目标实际是 Windows，应在 Step0 前调整目标矩阵与优先级，而不是先写 macOS 专用安装器。

### 3.2 分两层交付

**M1：手动可用版**

1. 用户启用 SSH、安装并登录官方 devtunnel CLI。
2. 用户在远端独立 host 私有隧道，本机手动 connect。
3. 临时使用固定且经过核验的本地端口完成协议和 DSH 实验。
4. 产出安装/停用 runbook 与证据；不声称已具备全自动生命周期管理。

**M2：产品集成版**

1. dsh-remote 提供“SSH 经 Dev Tunnel”机器录入与诊断。
2. 本机 connect 进程管理、稳定机器身份、主机密钥校验、工作区隔离。
3. 经批准的远端后台托管与重启恢复验证。
4. 旧 SSH 与 vscode-tunnel 保留，用户可逐台迁移，不自动替换。

### 3.3 非目标

- 不复用 VS Code 登录凭据、内部 RPC、私有缓存或浏览器 cookie。
- 不重新实现文件 API、命令任务协议或 Bridge PTY。
- 不承诺断网期间命令不丢失、终端自动续接、跨 sshd/远端重启恢复任务。
- 不把 SSH 用户权限描述成按 workspace 限定的系统沙箱。
- 不默认启用 root、密码登录、匿名 Tunnel、广泛入站防火墙规则。
- 不承诺生产 SLA。Dev Tunnels 当前官方文档标为预览、无 SLA。

## 4. 现有代码约束与必要改造

已核对当前实现：

- [连接池分派](<../lib/index.js#L922-L1017>)：SSH 池按 host:port:user 缓存；非 SSH 分支要求注册 Provider。
- [主机密钥校验](<../lib/hostkey.js#L48-L94>)：信任记录以 host:port 为键。
- [机器/工作区注册](<../lib/registry.js#L1-L19>)：保存不等于激活；选择按工作区隔离。
- [Provider 接口](<../lib/provider.js>)：已有独立传输分派，但不等于所有 transport 门控都已泛化。

**关键风险**：不能把 127.0.0.1:临时端口当作远端机器身份。端口复用会混淆池、镜像和主机信任；仅填写 localhost SSH 记录只能用于受控的 M1 实验，不能直接作为最终产品模型。

### 4.1 推荐模型：SSH transport + 连接承载字段

保持执行 transport 为 ssh，新增承载信息，不创建第二套 rw_*，不冒充 vscode-tunnel。

拟议记录形状（仅设计，不代表当前已支持）：

```json
{
  "id": "stable-registry-machine-id",
  "name": "Office PC",
  "transport": "ssh",
  "connector": {
    "kind": "devtunnel",
    "tunnelId": "explicit-tunnel-id",
    "remotePort": 22
  },
  "username": "remote-user",
  "privateKeyPath": "controller-side-key-path"
}
```

- 实际 dial host/port 仅由连接管理器生成，不能从浏览器任意提供或替换为外部地址。
- 稳定逻辑身份绑定 machineId、明确的 tunnelId 和远端服务端口；修改目标必须触发重新验证，不静默沿用原信任。
- 池键使用稳定机器身份 + 本次连接 generation，不能继续仅按 loopback 端口缓存。
- 新镜像元数据版本记录稳定机器归属；保留现有 SSH v1 和 vscode-tunnel v2 兼容读取。
- 主机指纹存储新增逻辑 host-key identity；直连 SSH 继续沿用旧键格式。
- 首次连接从远端独立渠道核对 SSH 指纹，再按严格校验连接；loopback 不代表可信。
- 盘点所有直接读取 host/port、useSshConfig、proxy、transport 的分支，包括终端、Git、rw_info、转发、镜像和远端 Web UI。connector 不能绕过解析器直连占位值。
- V1 不与 SSH-config ProxyJump/proxy 混用；不支持的组合在保存时明确拒绝。

### 4.2 连接承载接口

在 SshPool 之前增加解析层，拟议返回：

```text
acquire(machine, signal)
  -> { dialHost, dialPort, logicalIdentity, generation, release }
```

该接口只解决“怎么到达 SSH 服务”；SFTP/exec/PTY 继续走原实现。

本机 manager 的进程键按 Tunnel 目标管理；同一 Tunnel 的多机器记录/工作区共享 connect 进程，但 SSH 池按认证用户及稳定机器身份区分。引用计数释放最后一个使用者后，按策略停止本插件创建的进程。CLI 缺失或配置损坏只能让此连接不可用，不能阻止 DSH 启动。

## 5. 安全与运行生命周期

### 5.1 两层认证

1. Dev Tunnel 私有访问授权：用户通过官方 CLI 自行登录，选择最小授权范围。
2. SSH：远端用户公钥认证 + 严格主机指纹核对。Tunnel 登录不替代 SSH 登录。

私钥留在控制端；仅公钥按用户同意安装到远端。日志/导出/浏览器响应不得含 token、私钥、密码或未经清洗的 CLI 输出。不得将秘密放进命令参数、聊天或通用配置 JSON。

### 5.2 网络暴露

- 控制端监听只能为 loopback，实际核查 IPv4/IPv6，不能仅依据日志判断。
- 只登记明确的 SSH 服务端口；connect 若会转发同一 Tunnel 全部端口，需检查并拒绝不符合配置的额外端口。
- 远端优先限制 SSH 可达范围；启用 macOS“远程登录”可能同时开放 LAN 接口，必须预检和告知，不能声称自动仅监听 loopback。
- 不自动修改系统全局 sshd 配置或防火墙；需要调整时提供备份、差异和单独确认。

### 5.3 状态与重试

```text
unconfigured → needs-login → starting → forwarding → ssh-verifying → ready
                                     ↘ failed
ready → disconnected → reconnecting → ready
                    ↘ needs-login / failed
```

- CLI 输出不是最终 ready 证据：需要端点有效、SSH 握手、指纹及认证都成功。
- 重连有超时、退避、抖动和上限；先观察 CLI 自身恢复，再决定重启，避免双重重试风暴。
- 认证过期进入 needs-login，不自动打开浏览器循环登录。
- 新 endpoint/generation 淘汰旧 SSH 池和通道；不把旧终端指向新机器。
- 自动恢复连接不重放 exec、终端输入或结果不明的文件写入；报告结果未知并要求核查。
- 默认只停止本插件创建的本机 connect；不按进程名全局 kill、不关闭远端 sshd、不注销全局 CLI 账号。
- 用户已有手动 connect 可作为显式 external 模式使用，但插件不认领或终止它，且仍须验证目标指纹。

### 5.4 后台服务

- macOS LaunchAgent 与 LaunchDaemon 的凭据、钥匙串和用户会话不同；登录后后台可用不等于无人登录开机可用。
- 分别验收 DSH 重启、远端进程重启、远端重启后登录、远端重启未登录。
- Tunnel 资源有效期与 OAuth 凭据有效期分别管理；persistent 资源名称不意味着永不过期。
- 无法安全实现无人登录恢复时，明确交付为“登录后启动”；不要改用明文 token 或匿名 Tunnel 绕过。

## 6. 实施步骤与硬性验收门

| 步骤 | 工作与产物 | 通过条件 |
|---|---|---|
| Step0 实机可行性 | 固定 A/B OS、CLI 版本、账号类型；核对 CLI help；独立私有 Tunnel 转发真实 sshd | 真实双机 SSH/SFTP/PTY 全通，关闭 VS Code 仍可用，未授权账号被拒绝，loopback 监听证明 |
| Step1 冻结设计 | ADR：SSH connector、信任键、镜像版本、状态机、CLI 支持范围、模块归属 | 明确 CLI 端口选择/冲突行为、认证过期行为；所有开放问题有处理策略 |
| Step2 身份与底座 | connector 解析层、稳定池键、host-key identity、新镜像兼容、工具/路由接线 | 两台机器交换本地端口不串线；改目标/指纹变更拒绝；旧 SSH/vscode-tunnel 不回归 |
| Step3 本机进程管理 | CLI 探测、受控 spawn、就绪判定、引用计数、退出清理、有限重连 | 端口冲突不连接占用者；并发 acquire 不重复启动；卸载不遗留自有进程、不误杀外部进程 |
| Step4 产品 UI | 添加机器、分别诊断 Tunnel/SSH、登录提示、指纹确认、显式绑定 | 保存不激活；故障定位到正确层；浏览器不接触凭据；新模式测试连接真实可用 |
| Step5 部署与后台 | 远端预检、私有 Tunnel 配置、macOS 服务模板、停用/卸载文档 | 每项系统变更单独确认；重启恢复等级有实测证据；失败能回滚、不锁死原有 SSH |
| Step6 全链路验收 | 经新模式验证文件/搜索/镜像/Git/终端/多工作区，故障和安全矩阵 | 真双机功能、安全、隔离和恢复全部达到声明范围；不能仅以 mock 或本机回环通过放行 |
| Step7 灰度迁移 | 单台旧 Bridge 机器旁路新增新连接，确认后切工作区 | 不删除旧机器/镜像/秘密；回退明确；用户确认后才扩展迁移范围 |

依赖顺序：Step0 → Step1 → Step2/Step3 → Step4/Step5 → Step6 → Step7。Step0 未通过，不开发完整安装器，不实施自动迁移。

### 6.1 Step0 需要回答的具体问题

- 目标 CLI 是否能可靠承载原始 SSH/SFTP 字节流，长连接及大文件是否有服务端限制？
- 本地端口是否可选？冲突时 CLI 是失败还是改端口？有无稳定机器可读输出？先查真实 help，不在计划中编造参数。
- 如果仅支持远端同号映射，首版是否接受端口约束？不能自动强占本地 22 或假设可任意 remap。
- CLI 是否默认转发 Tunnel 全部端口？如何只暴露已批准服务？
- 同一账号的授权模型、资源到期、重新登录、断网恢复实际如何表现？
- SSH 服务当前监听哪些接口，开启后是否新增 LAN 暴露？
- 退出全部 VS Code 进程后，独立 host/connect 链路是否保持正常？

Step0 仅使用专用测试 Tunnel、临时远端测试目录和经批准账号；不触碰生产工作区。记录版本、时间、结果、脱敏日志与清理情况。

## 7. 验收矩阵

| 类别 | 必测项目 |
|---|---|
| 身份安全 | 首次独立核对指纹；已知指纹通过；指纹变化拒绝；错误账号/密钥拒绝；本地端口被无关 SSH 占用不误连 |
| 文件 | list/stat/read/write、中文/空格路径、二进制 hash、权限拒绝、上传下载取消、大文件有界资源占用 |
| 命令 | 返回真实远端 hostname/user/cwd；stdout/stderr/退出码；超时；断链结果未知且不重复执行 |
| PTY | 交互输入、resize、Ctrl-C、退出清理；断链明确提示，不假装会话持久化 |
| 工作区 | 两台远端 + 两个工作区并行；同远端同名目录；普通本地工作区不继承远端；保存机器不自动绑定 |
| 镜像与 Git | sync/push 三方冲突；稳定镜像归属；本地端口变化不生成错镜像；Git 读写操作按权限/确认执行 |
| 恢复 | host/connect 分别重启、网络中断恢复、sleep/wake、DSH 重启、OAuth 失效、资源过期 |
| 资源管理 | 并发连接只启动一个承载进程；关闭一工作区不影响另一工作区；最后引用释放；插件卸载清理 |
| 暴露 | 控制端 loopback-only；远端 sshd 接口核查；Tunnel 无匿名访问；未授权账号负测；日志无秘密 |
| 兼容 | 直连 SSH、SSH config、旧 vscode-tunnel、已有镜像和手动端口转发不回归 |

连接恢复与任务恢复分开报告。建议做一次 ≥2 小时空闲/活跃混合连接测试；实际服务限制如无法满足必须记录，不宣称无限长会话。

## 8. 代码与交付物规划

默认在 dsh-remote 内实现可选 connector，避免新增必须安装的插件；CLI 是外部先决条件，未安装时原 SSH 功能不受影响。若 Step1 判断需要独立包，再通过 ADR 调整。

拟新增模块（名称待实现冻结）：

- `lib/ssh-connector.js`：直连/Dev Tunnel 连接解析与稳定身份。
- `lib/devtunnel-manager.js`：本机 CLI 生命周期与端点状态。
- `lib/devtunnel-diagnostics.js`：只读环境检查、错误分类、脱敏。
- 对应测试：连接管理、端口冲突、主机密钥身份、隔离、镜像兼容、真实 SSH 集成。
- 部署 runbook 与按平台服务模板；不混用现有“部署远端 DSH Web”的流程。

修改边界：池创建、host-key guard、机器输入校验、镜像身份、客户端设置页及调用链；复用现有 fs/exec/PTY，不复制实现。

交付包包括：ADR、源码和测试、CLI/OS 兼容矩阵、真实双机证据、安装与停用指南、凭据失效指南、迁移与回退方案。

## 9. 迁移、回滚与发布

1. 保留旧 vscode-tunnel Provider 和远端 Bridge，不修改其 transport 字段来“就地转换”。
2. 新增独立 SSH-over-Dev-Tunnel 机器，核对与旧机器是同一物理目标和目录。
3. 旧镜像若有未同步修改，先备份并做冲突检查；默认新建镜像，不自动覆盖旧镜像元数据。
4. 用户确认后切换指定工作区；未完成的旧终端/任务留在原连接或明确终止，绝不自动转移。
5. 回退时切回旧绑定；停止本插件创建的 connect，不删远端文件、不删共用 SSH 公钥。
6. 旧 Bridge 卸载、Tunnel 删除、公钥移除均为后续独立确认动作。

遵守[开发规范](<../scripts/dev-standards.md>)与[工作区约束](<../AGENTS.md>)：隔离 DSH_HOME 验证；先读框架注册契约；保持手写 lib；静态检查、相关测试、启动冒烟通过后才申请产品部署。不得直接修改产品 profile。部署后重启实际宿主并核验现有 GUI，不以启动另一服务替代验证。

本次仅文档交付，不运行上述安装、登录、服务操作或部署，也不以未执行测试标注 PASS。

## 10. 开工前待确认

- 第一台远端究竟是 Mac 还是 Windows PC？默认双 Mac 是基于已有验证条件，不代表用户已确认。
- 是否允许启用/使用系统 SSH 服务，管理员授权由谁操作？
- 使用微软还是 GitHub 账号，A/B 的官方 CLI 登录由谁完成？
- “后台运行”要求是用户登录后恢复，还是开机无人登录即可连接？后者是额外认证/服务门槛。

这些信息不阻止评审设计，但 Step0 实机操作前必须明确。

## 11. 参考依据

- [Microsoft Dev Tunnels CLI reference](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/cli-commands)：host/connect、私有访问、loopback 转发、SSH 前缀含义、资源有效期、预览限制。
- [VS Code Remote Tunnels](https://code.visualstudio.com/docs/remote/tunnels)：code tunnel 面向 VS Code Server，而非 OpenSSH 登录服务。
- [已有独立 Worker 双机协议记录](<../../dsh-remote-vscode/docs/test-evidence/step0.md#L220-L268>)：仅证明历史 devtunnel 链路，不证明新 SSH 方案已通过。

**完成定义**：真实双机在未运行 VS Code/Bridge Worker 的情况下，经过私有 Dev Tunnel 使用 DSH 完成已声明的 SSH/SFTP/PTY 工作区操作；稳定身份、严格主机密钥校验、工作区隔离、故障诊断、清理回退全部通过；后台恢复能力按实际验证等级标注。
