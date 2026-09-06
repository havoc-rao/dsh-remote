#!/usr/bin/env bash
# dsh-remote —— 生成「DCF 注入版部署包」并接线 profile（零构建插件的 dev 语义 build）
#
# 背景：profile（~/.dsh/profiles/web）里任何 pnpm 重装都会把手工放入的目录隔离为
# .ignored_* 并按 package.json 的 link: 规格重建符号链接——直接把注入写进 profile
# 会被冲掉。所以注入版放到仓库内 gitignore 的部署包 dev-harness/deploy-pkg，
# profile 的依赖规格指向它：重装后链接目标依然是注入版，永不回退。
#
# 用法：
#   ./scripts/sync-profile.sh            # 重建部署包（改完 dsh-remote 源码后必跑）
#   ./scripts/sync-profile.sh --wire     # 重建 + 把 ~/.dsh/profiles/web 依赖指向部署包 + pnpm install
#   ./scripts/sync-profile.sh --clean    # 删除部署包（回到纯开发状态）
#
# 语义与 DCF 一致：
#   - NODE_ENV=development（或 CODE_FINDER=1）才注入；未设 = 生产语义不注入；
#   - 注入属性烘焙「仓库 lib/*.js 的绝对路径 + 源码行号」→ 点击打开仓库源码位置精确；
#   - 幂等，可重复执行；仓库 lib/ 永不落注入。
set -euo pipefail

WORKSPACE="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY="$WORKSPACE/dev-harness/deploy-pkg"
PROFILE_PKG="$HOME/.dsh/profiles/web/package.json"
PROFILE_DIR="$HOME/.dsh/profiles/web"
DCF_BIN="$WORKSPACE/node_modules/.bin/dcf"
DCF_FALLBACK="link:/Users/havoc/Documents/Projects/tools/DSH-code-finder"

action="${1:-build}"

case "$action" in
  clean)
    rm -rf "$DEPLOY"
    echo "✅ 部署包已删除。"
    exit 0
    ;;
  build|--wire)
    ;;
  *)
    echo "用法: $0 [build|--wire|--clean]" >&2
    exit 2
    ;;
esac

# ── 1) 重建部署包 ────────────────────────────────────────────────────────
echo "→ 重建部署包: $DEPLOY"
rm -rf "$DEPLOY"
mkdir -p "$DEPLOY"
cp -R "$WORKSPACE/lib" "$DEPLOY/lib"
cp "$WORKSPACE/package.json" "$WORKSPACE/cordis.patch.yml" "$WORKSPACE/LICENSE" "$DEPLOY/"

if [ ! -x "$DCF_BIN" ]; then
  echo "⚠ 未找到 dcf 依赖，安装后重试：pnpm add -D $DCF_FALLBACK" >&2
  exit 1
fi
(cd "$WORKSPACE" && NODE_ENV=development "$DCF_BIN" instrument "$WORKSPACE/lib" --write --out "$DEPLOY")
# ── 1.5) 侧栏 directory-flow 槽位：装配期自动匹配（config 方案，无构建期烘焙）──
# 最终值由宿主在装配期决定：cordis.patch.yml 的 `config: !!js` 表达式扫描 composed
# patch stack（找到 dsh-enhanced-workspace 行 → 插件自有 hole）+ loader.entries()
# 兜底探测 + 显式 config 覆盖，经 GET /dsh-remote/slot-config 下发。这里回显诊断：
# 首选「配置端点实际值」（宿主在跑时 curl，`source` 标注命中优先级）；宿主不在跑时
# 退到 profile 依赖的静态预期 + curl 提示。
count="$(grep -c data-locatorjs "$DEPLOY/lib/client.js" 2>/dev/null || echo 0)"
if [ "$count" = "0" ]; then
  echo "⚠ 注入未产生（当前非 dev 语义？），部署包保留源码原样。" >&2
fi
echo "   deploy-pkg/lib/client.js: $count 处 data-locatorjs（侧栏槽位 = 官方默认字面量，装配期由宿主自动匹配）"
# 宿主探测：优先配置端点实际值（dev 沙箱端口，或 SLOT_URL 显式指定）。
# 注意：所有参数展开统一用 ${VAR} 花括号形式——macOS bash 3.2 会把
# `$VAR` 后紧跟的 UTF-8 首字节并入变量名（如 `$SLOT_URL）` 会查一个
# 不存在的变量而报 unbound），花括号是终结符，彻底免疫。
SLOT_HINT=""
SLOT_URL="${SLOT_URL:-}"
if [ -n "${SLOT_URL}" ]; then
  if body="$(curl -s -m 2 "${SLOT_URL}" 2>/dev/null)"; then
    SLOT_HINT="配置端点实际值（${SLOT_URL}）: ${body}"
  else
    SLOT_HINT="SLOT_URL 指定的端点不可达: ${SLOT_URL}"
  fi
elif [ -f "$WORKSPACE/dev-harness/dev.pid" ] && kill -0 "$(cat "$WORKSPACE/dev-harness/dev.pid" 2>/dev/null || echo 0)" 2>/dev/null; then
  port="${DEV_PORT:-50599}"
  if body="$(curl -s -m 2 "http://127.0.0.1:${port}/dsh-remote/slot-config" 2>/dev/null)"; then
    SLOT_HINT="dev 沙箱（:${port}）配置端点实际值: ${body}"
  else
    SLOT_HINT="dev 沙箱在跑但 :${port} 端点未响应（宿主未加载新代码？）"
  fi
fi
if [ -z "${SLOT_HINT}" ]; then
  SLOT_HINT="（宿主未运行：启动后 curl http://127.0.0.1:\${DEV_PORT:-50599}/dsh-remote/slot-config 查看实际值）"
  if [ "$action" = "--wire" ] && [ -f "$PROFILE_PKG" ]; then
    if grep -q 'dsh-enhanced-workspace' "$PROFILE_PKG"; then
      SLOT_HINT="profile 依赖含 dsh-enhanced-workspace → 预期 enhanced-workspace.workspace.directoryFlow"
    else
      SLOT_HINT="profile 依赖无 dsh-enhanced-workspace → 预期官方 sidebar.workspaces.directoryFlow"
    fi
  fi
fi
echo "   侧栏 directory-flow 槽位（装配期自动匹配）: ${SLOT_HINT}"
echo "   仓库 lib/client.js: $(grep -c data-locatorjs "$WORKSPACE/lib/client.js" || true) 处（应为 0，仓库保持干净）"

# ── 2) --wire：接线 profile 依赖 → 部署包 ────────────────────────────────
if [ "$action" = "--wire" ]; then
  echo "→ 接线 profile: $PROFILE_PKG"
  if [ ! -f "$PROFILE_PKG" ]; then
    echo "⚠ 未找到 profile: $PROFILE_PKG" >&2
    exit 1
  fi
  node -e "
    const fs = require('node:fs')
    const f = '$PROFILE_PKG'
    const pkg = JSON.parse(fs.readFileSync(f, 'utf8'))
    const want = 'link:$DEPLOY'
    const deps = pkg.dependencies || {}
    if (deps['dsh-remote'] !== want) {
      deps['dsh-remote'] = want
      pkg.dependencies = deps
      fs.writeFileSync(f, JSON.stringify(pkg, null, 2) + '\n')
      console.log('   dependencies.dsh-remote →', want)
    } else {
      console.log('   已指向部署包（无改动）')
    }
  "
  echo "→ pnpm install（profile 内重装，链接目标为部署包）…"
  (cd "$PROFILE_DIR" && pnpm install 2>&1 | tail -6)
  echo "→ 验证链接:"
  ls -la "$PROFILE_DIR/node_modules/dsh-remote" | grep -- '->' || true
  echo "   serve 的 client.js 注入: $(grep -c data-locatorjs "$PROFILE_DIR/node_modules/dsh-remote/lib/client.js" 2>/dev/null || echo 0) 处"
  echo "✅ 完成。重启宿主生效：NODE_ENV=development dsh electron（或 dsh web）。"
fi