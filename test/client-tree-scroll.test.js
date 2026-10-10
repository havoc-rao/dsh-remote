// 远程文件标签页（RemoteExplorerTab 的 drx 树）横向滚动 / 长文件名不截断。
//
// 背景：原先树滚动体 `overflowX: 'hidden'`、行 `width: 100%`、名字
// `.drx-name` 带 `text-overflow:ellipsis`，于是远程长文件名被压成省略号。
// 改为「滚动体横向 auto + 内容列 width:max-content/min-width:100%」后，
// 列按最宽一行撑开，行依旧 `width: 100%`（hover 填充照旧铺满），
// @ 引用药丸改为「占位但不可见 + sticky right」以免 hover 时列宽跳动。
//
// 这些是源码文本级断言（本仓库零构建，lib/client.js 即手写产物），
// 用于挡住回归；正则刻意锚定到具体片段，避免误伤 DirPicker 目录选择器
// （它同样用 `overflowX: 'hidden'`，属于另一个界面，明确不在本次改动范围）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')
const lines = src.split('\n')

/** 按 `contains` 片段过滤出的源码行。 */
const rowsWith = (needle) => lines.filter((l) => l.includes(needle))

test('树滚动体放开横向滚动（但不动 DirPicker）', () => {
  // 锚定这段树体的唯一特征：padding: '4px 8px 8px'。
  const body = rowsWith("padding: '4px 8px 8px'")
  assert.equal(body.length, 1, 'drx 树滚动体应只有一处（padding: 4px 8px 8px）')
  const line = body[0]
  assert.match(line, /overflowX: 'auto'/, '滚动体必须允许横向滚动')
  assert.match(line, /flex: 1/, '滚动体保留 flex: 1')
  assert.match(line, /minHeight: 0/, '滚动体保留 minHeight: 0')
  assert.doesNotMatch(line, /overflowX: 'hidden'/, '滚动体不得再隐藏横向溢出')

  // DirPicker（目录选择器）的两处 overflowX: 'hidden' 原样保留：这是锚定断言，
  // 不是全局否定——只要求它们不落在 drx 树滚动体那一行。
  const hidden = rowsWith("overflowX: 'hidden'")
  assert.equal(hidden.length, 2, 'DirPicker 的两处 overflowX: hidden 应保持不变')
  assert.ok(hidden.every((l) => !l.includes("padding: '4px 8px 8px'")), '树滚动体不得混入 hidden')
})

test('内容列按最宽行撑开，且不窄于视口', () => {
  assert.ok(
    src.includes("React.createElement('div', { key: root, style: { width: 'max-content', minWidth: '100%' } }"),
    '内容列必须是 width: max-content + minWidth: 100%',
  )
  // 兜底仍在：短名字时行宽够用，省略号规则保留但不会触发。
  assert.ok(
    src.includes('.drx-name{min-width:0;overflow:hidden;text-overflow:ellipsis'),
    '.drx-name 的省略号兜底应保留',
  )
})

test('@ 引用药丸：占位不可见 + sticky，而非 display:none', () => {
  const rule = lines.find((l) => /'\.drx-ref\{/.test(l))
  assert.ok(rule, '.drx-ref 规则应存在')
  assert.match(rule, /display:inline-flex/, '药丸必须参与布局（inline-flex）')
  assert.match(rule, /visibility:hidden/, '静止时不可见用 visibility 而非 display')
  assert.match(rule, /position:sticky/, '药丸需 sticky 以钉在滚动视口右缘')
  assert.match(rule, /right:0/, 'sticky 的锚点应为 right: 0')
  assert.doesNotMatch(rule, /display:\s*none/, '不得再用 display:none（那会让 hover 改变列宽）')

  const hover = lines.find((l) => /\.drx-row:hover \.drx-ref,\.drx-row:focus-within \.drx-ref\{/.test(l))
  assert.ok(hover, 'hover/focus-within 药丸规则应存在')
  assert.match(hover, /visibility:visible/, 'hover 时用 visibility:visible 显示')
  assert.doesNotMatch(hover, /display:/, 'hover 规则不得再切换 display')
})
