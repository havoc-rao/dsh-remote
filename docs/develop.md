# dsh-remote 开发指南（本地 build · 就地更新产物 · dsh 动态更新）

> 适用形态：**link 部署**（产品 profile 把插件声明为 `link:/…/dsh-remote`，运行中的 dsh 从
> `$DSH_HOME/profiles/<p>/node_modules/dsh-remote` 读取插件代码）。
> 如果产品 profile 仍是旧式 registry 声明（`dsh-remote: ^0.5.10`），先改成 link 再谈动态更新，
> 否则任何 `dsh plugin` 重装都会把本地改动顶回发行版（历史教训：v0.6.4 / v0.5.10 被顶掉）。

## 0. 一句话流程

改源码 → `node scripts/build.mjs` → 刷新浏览器（浏览器半）／HMR 或重启实例（宿主半）。

```
① 本地 build       ② 就地更新产物             ③ 影响 dsh 动态更新
语法检查 + 闸门   →  同步进每个安装目录     →  运行实例 HMR 自动改 rev
（可选 dcf 注入）    （inode 守卫）             浏览器 SSE 热替换
```

## 1. 运行时拓扑（本机实测，先分清再动手）

| 组件 | 位置 | 说明 |
|---|---|---|
| dsh CLI | `~/.local/share/mise/installs/dsh/dev/bin/dsh` → `deepseek-harness/apps/cli/lib/bin.js` | 仓库构建产物；`pnpm build` 后即新 |
| 核心包 | `deepseek-harness/packages/*`（经 workspace 链接进 `apps/electron/node_modules`） | 仓库源码直连，rebuild 就地生效 |
| 产品实例 | `DSH_HOME=~/.dsh`（`profiles/web`） | 日常使用的 profile |
| 沙箱实例 | `dev-harness/harness`（`scripts/dev-run.sh` 管理，50599 端口） | 旧式隔离迭代，见 §4 |
| 验证实例 | `/private/tmp/dsh-verify`（常见于「cwd=仓库 启动 `dsh web`」） | 本次实测的 3080 实例就是它 |

**插件安装的两种形态（决定要不要同步）：**

- `node_modules/dsh-remote` 是 **symlink → 仓库**：天然动态，改源码刷新即生效，无需任何步骤。
- 是**物化拷贝**（实目录）：运行实例读的是这份拷贝，必须就地更新产物（§2 的 ②），否则改了什么都不会生效——本次排查就是栽在这：3080 实例一直服务一份 01:21 物化的旧 dcf 注入版 client。

**client 服务与动态更新原理**（`packages/client/modules` + `packages/client/hmr`）：

- 浏览器按 `/plugins/<id>/client.js?rev=<hash>` 加载插件 client；`rev` 是文件内容的短哈希。
- `/plugins/<id>/client.js` 端点**每次请求从磁盘读文件**（`cache-control: no-cache`），rev 由 `clientModuleHost` 维护。
- `client-hmr` 插件每 500ms stat 轮询 graph 各行的 bundle 路径，mtime/size 变化 → `rebuilt(id)` 重新哈希 → rev 变化 → `/plugins/events` SSE 推送 → 浏览器热替换该模块。
- 所以：**文件就位 → rev 自动变 → 浏览器自动更新，无需重启实例**（重启只会在极端情况兜底）。

## 2. 本地 build CLI：`scripts/build.mjs`

零依赖（仅 node 内置模块），也是 `package.json` 的 `"build"` 脚本 —— **`dsh update --profile <name>` 就是就地跑它**（dsh CLI 对 link 安装插件的官方更新路径：`apps/cli/src/update.ts`）。

```bash
node scripts/build.mjs                  # ① build + ② 就地更新所有安装
node scripts/build.mjs --profile web    # 只更新指定 profile
node scripts/build.mjs --target <dir>   # 额外指定安装目录（可重复）
node scripts/build.mjs --dry-run        # 只预览，不写任何文件
node scripts/build.mjs --no-sync        # 只 ① 不同步（纯 build）
node scripts/build.mjs --instrument     # 同步时使用 dcf 注入版 client.js
```

**① 本地 build**：`lib/*.js` 逐个 `node --check`（14 个文件）+ `check.mjs` 框架闸门（命令名 / 工具名 / 路由前缀 / object schema，任何一项不过都拒绝同步）。`--instrument` 且装有 `node_modules/.bin/dcf` 时，用 dsh-code-finder 生成元素级注入 client 到 `dev-harness/dcf/lib/client.js`（仓库 `lib/` 永不落注入；dcf 缺失自动降级为原名 client.js）。

**② 就地更新产物**：把 `lib/`、`package.json`、`cordis.patch.yml`、`LICENSE` 同步进**每一个发现的安装目录**：

- 发现规则：`$DSH_HOME/profiles/*/node_modules/dsh-remote`、`dev-harness/harness/profiles/*/…`、`/private/tmp/dsh-*/profiles/*/…`（验证类实例）、`--target` 追加；`DSH_HOME` 未设时回退 `~/.dsh`。
- **symlink 安装自动跳过**（本就直连源码，写了反而多此一举）。
- **硬链接守卫**：目标与源码 package.json 同 inode（旧 `cp -al` 沙箱产物）→ 拒绝覆写，防止顺着硬链接写穿源文件/产品文件（v0.6.5 教训）。同步完成后复查 inode 不同才报成功。

**③ 动态更新**：见 §1 原理——同步后 HMR 轮询自动检测并改 rev，浏览器热替换。CLI 只负责「文件就位」和提示，机制在运行中的 dsh 一侧。

## 3. 验证（本次实测全链路）

```bash
# 就地更新前：实例服务的是旧产物（349184B、无 drp-ovl，有旧 bg-overlay 标记）
curl -s "http://127.0.0.1:3080/plugins/dsh-remote/client.js" | grep -c "drp-ovl"        # 0
curl -s http://127.0.0.1:3080/ | grep -o "dsh-remote/client.js?rev=[a-f0-9]*"            # rev=4499dc1a562b

# 跑 build（就地更新全部安装）后：无需重启
curl -s "http://127.0.0.1:3080/plugins/dsh-remote/client.js" | grep -c "drp-ovl"        # 3（新 dialog 已在服务）
curl -s http://127.0.0.1:3080/ | grep -o "dsh-remote/client.js?rev=[a-f0-9]*"            # rev=ae9bb578fded（已变，HMR 生效）
```

定位「实例到底读哪个文件」：

```bash
lsof -iTCP:3080 -sTCP:LISTEN -n -P                          # 找到 PID
lsof -p <pid> | grep -E "cwd"                               # 实例 cwd（常为仓库根）
lsof -p <pid> | grep -E "profiles|dsh-remote"               # 实例实际读的 profile 文件
grep -rl "bg-overlay" <DSH_HOME>                            # 找还有旧标记的残留拷贝
```

**本次的坑**：`dev-harness/dcf/lib/client.js`（旧 dcf 注入产物，349184B）曾被物化进 `/private/tmp/dsh-verify/profiles/web/node_modules/dsh-remote/`，实例逐字节服务它 —— 只更新 `~/.dsh` 和沙箱目录是看不到效果的，必须把 `dsh-*` 验证实例也纳入发现规则（build.mjs 已内置，`findInstalls()` 见源码）。

## 4. 侧栏 directory-flow 槽位 key：DSH 根目录配置 → 装配期自动匹配

侧栏「添加工作区」远程目录选择器（DirPicker）的**注册槽位 key** 由装配期配置自动
决定，不参与构建期烘焙（v0.7 前是 `DSH_REMOTE_SIDEBAR_DIRECTORY_FLOW_SLOT`
构建期注入，已移除）。关键洞见：**决定这个 key 的 config 就散在 DSH 根目录
（`$DSH_HOME`）的配置族里**——DSH 装配期把它们叠成一个 composed patch stack，
插件侧用 `!!js` 表达式 + 运行期探测从里面读出 key。

**DSH 根目录配置 → 槽位 key 的对应关系**：

| DSH 根目录配置文件 | 在机制中的角色 |
|---|---|
| `~/.dsh/profiles/<p>/package.json` 的 `dsh.profile.bundles` | 声明 bundle 列表；**每个 bundle 贡献一层 patch**，dsh-remote 的 bundle 层 patch 就是仓库根 `cordis.patch.yml` |
| `~/.dsh/profiles/<p>/cordis.yml` + `cordis.patch.yml` | profile 层 patch（叠在 bundle 层之后、home/overlay 层之前；本机当前为空数组） |
| home / overlay 层 patch | 最后叠入；`!!js` 表达式能看到整个已物化的 `patches` 数组 |

这几层按序叠成 `include.subtree.config.patches`（即 composed patch stack），
`cordis.patch.yml` 的 `config: !!js` 表达式（算 `sidebarDirectoryFlowSlot`）与
`disabled` 守卫（dsh-better-sidebar 去重）**共享同一份纯数据扫描**——不依赖
`loader.entries()` 创建顺序、不读其他行的 `disabled`，因此顺序无关且无递归。

**优先级链**（宿主半 `lib/index.js` 的 `effectiveSlot`；`source` 标注命中级别）：

1. **显式 config**：任何层对 dsh-remote 行的静态 `config` patch 写
   `sidebarDirectoryFlowSlot: <key>`（patch 机制整字段替换该行 config → 天然赢）。
2. **patch 表达式**：`cordis.patch.yml` 的 `config: !!js` 扫描 composed patch
   stack，发现 `dsh-enhanced-workspace` 行 → `enhanced-workspace.workspace.
   directoryFlow`；未发现 → `{}`（schemastery 默认值 = 官方 key）。
3. **宿主运行期兜底**：`loader.entries()` 探测（patch stack 不可见的注入形态，
   如 HMR / 运行期注入的 entry）。
4. **官方默认**：`sidebar.workspaces.directoryFlow`。

**为什么需要这套机制**：dsh-enhanced-workspace 以 priority -1 遮蔽官方
`sidebar.workspaces`，其子槽位 `sidebar.workspaces.directoryFlow` 处于「已注册、
永远无人渲染」状态；它的自有 hole `enhanced-workspace.workspace.directoryFlow`
保持同一 flowOwner 契约。所以组合了 enhanced-workspace 的 profile 必须把侧栏
注册切到新 key（hero 侧不受遮蔽，恒用官方 key `conversation.hero.workspace.
directoryFlow`）。装/卸 enhanced-workspace 因此自动跟随——无需构建期标志、无需 env。

**全链路与涉及文件**：

```
cordis.patch.yml（bundle 层 patch，config: !!js 扫描 composed patch stack）
   → lib/index.js effectiveSlot（优先级链 ①→④）
   → GET /dsh-remote/slot-config（返回 { slot, source }）
   → lib/client.js fetchSidebarDirectoryFlowSlot()（3s 超时）→ DirPicker 侧栏注册；
     读取失败/未设置 → 官方 key 兜底
```

- 仓库根 `cordis.patch.yml` —— 决定 key 的 bundle 层配置本体（本机制入口）。
- `lib/index.js` —— schema `sidebarDirectoryFlowSlot`（默认 `''`）、常量
  `SIDEBAR_DIRECTORY_FLOW_SLOT_OFFICIAL/_ENHANCED`、`effectiveSlot` 优先级链、
  `/dsh-remote/slot-config` 路由。
- `lib/client.js` —— 浏览器 half 消费端（`apply` 内异步取 key 后再声明侧栏注册）。
- `scripts/build.mjs` / `scripts/sync-profile.sh` —— 构建/接线**不烘焙 key**
  （产物逐字节等价），只回显诊断：宿主在跑时 curl 配置端点看实际值，不在跑时
  按 profile 依赖静态预期提示。
- README(.zh).md —— 用户侧说明 + 静态覆盖示例。

> 改 key 相关逻辑的验证点：宿主跑起来后
> `curl http://127.0.0.1:<port>/dsh-remote/slot-config` 看 `source`（config /
> patch / probe / default）；或直接跑 `./scripts/sync-profile.sh` 看槽位回显。

## 5. 与 `scripts/dev-run.sh` 沙箱的关系

- `dev-run.sh` 绑定 **DSH Desktop 应用包**（顶部 `APP` 常量 → `…/dsh-desktop/dist/…/app/node_modules/@deepseek-ai/dsh/lib/bin.js` + `dsh-desktop.patch.yml`）。本机没有 Desktop 应用（mise/源码形态），所以 `--restart` 报「未找到桌面版 harness 入口」。
- 产品动态更新链路（本文 §0–§2）已覆盖同样目的：改源码 → build.mjs → 运行实例热更新，**不需要沙箱**。
- 若仍要恢复沙箱：把 `require_app()` 的解析改为来源回退 —— `NODE=$(command -v node)`、`BIN=$PROD_HOME/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js`、`PATCH=$PROD_HOME/profiles/$PROFILE/cordis.patch.yml`（PROD_HOME 已由 DSH_HOME 推导）。注意沙箱 `build_profile()` 的 `cp -al` 硬链接语义在新形态（link 部署）下会把 symlink 原样拷过去，`sync_lib` 的 `rm -rf "$INSTALL_DIR/lib"` 在 symlink 安装上是「删源文件」危险操作——恢复前先确认安装形态。

## Terminal tunnel 与工作区终端管理契约

客户端服务 `dsh-remote.terminalTunnel`（version 1）提供 `registerTunnel`、
`unregisterTunnel`、`tunnelIds` 与 `resolveTunnel`。注册返回幂等 disposer，旧 disposer
不会卸载相同 id 后注册的替代实例。`id`、`match` 与普通 `createTransport` 为必填。

```js
registerTunnel({
  id: 'plugin:tunnel',
  match(sessionId, cwd, tabId) { /* 同步返回远程绑定是否命中 */ },
  createTransport(sessionId, cwd, tabId) { /* 既有普通终端 transport */ },
  // 可选；必须是同步工厂（不可 async），返回 source 或 undefined。
  createWorkspaceSource(sessionId, cwd) {
    return {
      create: async (title) => terminalInfo,
      list: async (signal) => ({ terminals: [] }),
      terminate: async (terminalId) => {},
      createTransport: (terminalId) => managedTransport,
    }
  },
})
```

`terminalInfo` 字段：`terminalId`、`title`、`cwd`、`createdBySessionId`、`createdAt`
（number）、`exited`（boolean）、可选 `exitCode`（number 或 null）。终端 id 为不透明
字符串，不要求 `terminal:` 前缀。managed transport 使用 better-sidebar 的既有 transport
词汇，但 `close` / `park` / `dispose` **只分离视图**；仅 source 的 `terminate` 杀进程。

remote provider 的 source 工厂同步解析首个命中 tunnel，并**原样传递 sidebar 的
sessionId / cwd**（包括 undefined / 空字符串，不转换 home scope）；source 缺失、返回
undefined 或抛错均不会转入本地镜像管理，也不会把本插件 legacy SSH transport 冒充
managed source。**无命中 tunnel** 时现在同步返回原生 managed source：

- POST `/dsh-remote/workspace-terminals/{create,list,terminate}`，body 仅以真实 `sessionId`
  授权（`title?` / `terminalId?` 为操作参数），不以浏览器 cwd/workspace/machine 授权。
- WS `/dsh-remote/ws/workspace-terminal?sessionId=…&terminalId=…&cols=…&rows=…`。
  上行 JSON `input(data)` / `resize(cols,rows)`；下行 JSON `init` / `output(data)` /
  `title` / `closed(reason: exited|terminated|missing)` / `fatal`。`onClosed` 回调传字符串，权限拒绝
  只触发 fatal，不能当作 missing 自动换进程。
- 服务端沿用 mirror 的 saved machine 和 `machinePoolOf/openPty`，root 由该机器 SFTP
  `realpath` 规范化；同机器 + canonical root 的不同 session 共享实例。无独立 workbench
  target/binding 或秘密复制。每次管理/WS attach 校验真实 session，live view 重绑定后拒绝输入输出。
- ID 为 `remote-managed:<uuid>`；native scope source 在同页 tunnel 热加载后保持稳定，
  已保存 native ID 的 resume/terminate 不会改接 workbench namespace。
- 创建立即 spawn，active+spawning 受 `terminalMaxSessions` 限制；自然退出不自动 respawn，
  exited 元数据最多保留 64 条。多视图 detach 不杀进程，只有 terminate/宿主卸载会终止。
  transcript 48KiB、每次 replay 32KiB，slow WS 512KiB 单独断开，输入 64KiB。
- 实例为宿主内存状态；宿主重启后旧 ID 报 missing。host 改动需宿主插件 reload（无 HMR
  时重启）并刷新浏览器验证；仅更新磁盘不表示当前运行实例已启用。

普通 `createTransport` 的 legacy 回退/close/grace 行为以及 file/git 契约保持不变。

terminal provider 随 betterSidebar 服务就位立即注册，不依赖镜像 status 完成；tunnel
晚注册 / 卸载与镜像目录更新会触发 provider registry 更新。status 请求瞬时失败保留
已验证镜像，成功返回空目录则清除。**绑定真值与 cold cache 策略属于 tunnel 实现**：
必须同步识别已知远程绑定，不能因 refresh 未完成返回 false 并让 sidebar 偷开本地。
remote 不根据任意 cwd 或未确认 session 猜测远端，以免接管普通本地工作区。

验证：`node --test test/terminal-tunnel.test.js`（真实 client apply 的 VM 生命周期测试）。

## 6. 常见问题

| 症状 | 原因 | 处理 |
|---|---|---|
| 改了 client.js 刷新没变化 | 实例读的安装目录没更新（物化拷贝）或浏览器缓存 | `node scripts/build.mjs`，确认输出列出该安装；再刷新 |
| build.mjs 报告该安装但 curl 还是旧内容 | HMR 未挂载（无 client-hmr 行） | 手动重启实例；或等 500ms 轮询后重查 rev |
| `dsh update` 提示没有 build/prepare 可跑 | 旧版本插件未声明 build | 用本仓库（已声明 `"build": "node scripts/build.mjs"`） |
| 报「与源码同 inode，拒绝覆写」 | 安装是 `cp -al` 硬链接产物 | 删掉该目录用 `cp -a`/`pnpm install` 重建，或改用 `--target` 指向别处 |
| 重启沙箱被新版顶掉 | profile 仍是 registry 依赖 | 改 profile `package.json` 为 `link:` 声明 + `pnpm install` |
| `dev-harness/dcf/` 变大 | dcf 注入产物（已 gitignore） | 可随手删，`--instrument` 会重新生成 |