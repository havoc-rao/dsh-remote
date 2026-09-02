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

## 4. 与 `scripts/dev-run.sh` 沙箱的关系

- `dev-run.sh` 绑定 **DSH Desktop 应用包**（顶部 `APP` 常量 → `…/dsh-desktop/dist/…/app/node_modules/@deepseek-ai/dsh/lib/bin.js` + `dsh-desktop.patch.yml`）。本机没有 Desktop 应用（mise/源码形态），所以 `--restart` 报「未找到桌面版 harness 入口」。
- 产品动态更新链路（本文 §0–§2）已覆盖同样目的：改源码 → build.mjs → 运行实例热更新，**不需要沙箱**。
- 若仍要恢复沙箱：把 `require_app()` 的解析改为来源回退 —— `NODE=$(command -v node)`、`BIN=$PROD_HOME/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js`、`PATCH=$PROD_HOME/profiles/$PROFILE/cordis.patch.yml`（PROD_HOME 已由 DSH_HOME 推导）。注意沙箱 `build_profile()` 的 `cp -al` 硬链接语义在新形态（link 部署）下会把 symlink 原样拷过去，`sync_lib` 的 `rm -rf "$INSTALL_DIR/lib"` 在 symlink 安装上是「删源文件」危险操作——恢复前先确认安装形态。

## 5. 常见问题

| 症状 | 原因 | 处理 |
|---|---|---|
| 改了 client.js 刷新没变化 | 实例读的安装目录没更新（物化拷贝）或浏览器缓存 | `node scripts/build.mjs`，确认输出列出该安装；再刷新 |
| build.mjs 报告该安装但 curl 还是旧内容 | HMR 未挂载（无 client-hmr 行） | 手动重启实例；或等 500ms 轮询后重查 rev |
| `dsh update` 提示没有 build/prepare 可跑 | 旧版本插件未声明 build | 用本仓库（已声明 `"build": "node scripts/build.mjs"`） |
| 报「与源码同 inode，拒绝覆写」 | 安装是 `cp -al` 硬链接产物 | 删掉该目录用 `cp -a`/`pnpm install` 重建，或改用 `--target` 指向别处 |
| 重启沙箱被新版顶掉 | profile 仍是 registry 依赖 | 改 profile `package.json` 为 `link:` 声明 + `pnpm install` |
| `dev-harness/dcf/` 变大 | dcf 注入产物（已 gitignore） | 可随手删，`--instrument` 会重新生成 |