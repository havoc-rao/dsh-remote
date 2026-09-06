# AGENTS.md — dsh-remote 开发须知（给 AI Agent / 协作者）

零构建 DSH 插件：`lib/*.js` 为**手写**产物（无 bundler、无 build script、无 src/），
宿主半 cordis Loader 直接加载，浏览器半 `lib/client.js` 按
`window.__ModuleLoader__.load` 契约由宿主 `/plugins/.../client.js` 直接 serve。

- 完整开发规范见 `scripts/dev-standards.md`（沙箱铁律 / 框架注册约束 / 发布流程）。
- 部署前静态闸门：`node check.mjs`；产品部署：`./sync.sh`（受控动作）。
- 仓库 root 就是「构建物」：**改完直接生效**，无需编译。

## 开发 / 构建循环

### DCF（dsh-code-finder，组件定位调试）注入构建 —— 一条龙

```bash
./scripts/sync-profile.sh --wire   # 重建 + 重接 profile + pnpm install（一条龙）
```

即：重建 `dev-harness/deploy-pkg`（注入版 client.js，attrs 指向仓库 clean 源码）→
把 `~/.dsh/profiles/web` 的 `dsh-remote` 依赖规格指向该部署包 → profile 内
`pnpm install`。之后**重启宿主**（`NODE_ENV=development dsh electron stop/start`，
或 `dsh web`）让新的 wire rev 烘焙，浏览器硬刷。

其他形态：

```bash
./scripts/sync-profile.sh          # 只重建部署包（链接/重装不变时用）
./scripts/sync-profile.sh --clean  # 删除部署包（回到纯开发状态）
```

### 宿主运行（overlay / 注入只认 dev 语义）

```bash
NODE_ENV=development dsh web       # CLI web 实例
NODE_ENV=development dsh electron  # 桌面壳（共享 web profile）
```

沙箱（隔离 DSH_HOME）见 `scripts/dev-run.sh`（本机需先修正顶部 APP 常量）。

## 铁律（都是踩过的坑）

1. **仓库 `lib/` 永不落注入**：发布零负担。改完源码后靠 `sync-profile.sh` 生成
   注入版，`grep -c data-locatorjs lib/client.js` 应恒为 0。
2. **profile 里任何 pnpm 重装都会冲掉手工部署**：pnpm 会把手动放入
   `node_modules` 的目录隔离为 `.ignored_*` 并按 `link:` 规格重建符号链接。
   所以注入版必须放 `dev-harness/deploy-pkg`（gitignored），profile 依赖规格
   指向它——重装后链接目标依然是注入版（已验证）。
3. **注入/挂载只认 dev 语义**：构建侧 `NODE_ENV=development`（或 `CODE_FINDER=1`）
   才注入；运行侧宿主进程同样要求 `NODE_ENV=development` 才挂载 overlay
   （mount 行 disabled 读 `process.env.NODE_ENV`）——electron 从 Dock 图标启动
   不带终端 env，从终端 `NODE_ENV=development dsh electron` 启动。
4. **改完源码必须重建 + 重启**：wire rev 在宿主启动时烘焙，client.js 字节变化
   后重启宿主才会 serve 新版本；只刷新页面不够。
5. **不要直接在 profile 的 dsh-remote 里手工改文件**（旧法被重装冲掉）——一律走
   `sync-profile.sh`。
6. 交付/发布前：`git` 提交干净基线 + `node check.mjs` + `scripts/boot-smoke.sh`，
   再 `./sync.sh`（见 dev-standards.md §3）。

## 验证注入是否生效

```bash
grep -c data-locatorjs dev-harness/deploy-pkg/lib/client.js   # >0（注入在）
grep -c data-locatorjs lib/client.js                          # 0（仓库干净）
ls -la ~/.dsh/profiles/web/node_modules/dsh-remote             # → .../dev-harness/deploy-pkg
grep -c data-locatorjs ~/.dsh/profiles/web/node_modules/dsh-remote/lib/client.js  # >0（宿主 serve 的是注入版）
# 浏览器：Opt+Shift 悬停 dsh-remote UI → 蓝框 + lib/client.js:行:列，点击打开仓库源码精确位置
```

工具：`@havocrao/dsh-code-finder`（devDependency，本机 link 源码仓库）提供
`dcf instrument`（零构建插件的独立注入入口，`--out` 镜像模式才能让 attrs 指向
仓库 clean 源码）；overlay 由 profile 层挂载的 DCF 提供。