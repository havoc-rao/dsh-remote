# 远程文件与 editor-workbench 兼容

## 原因与公共接线

旧远程文件区域只提供自有 textarea，未注册 Document provider，并直接打开远程标签，绕过 better-sidebar 的资源动作/文件激活入口。

现在通过 better-sidebar 公开 API 接线，不引用工作台私有模块：

- `registerDocumentProvider` 注册 `dsh-remote:documents`；只匹配宿主已验证的远程镜像 cwd。
- `readText` / `writeText` 通过远程 HTTP 路由与 SFTP 操作，携带原会话 ID、镜像 cwd，绝不将远程绝对路径交给本地文件 API。
- 远程预览工具栏展示 `getResourceActions`，以 `runResourceAction` 进入中央工作台。
- 工作台已激活时，树点击通过 `dispatchFileActivation` 接管；未接管时保留旧远程标签。已接管请求失败不会回退。
- 原生右侧远程标签与 better-sidebar 远程标签都显示公共工具栏动作。
- 旧 textarea 通过 `reportFileDocument` 报告 dirty/readOnly；有未保存草稿时不允许工作台盲接管。
- provider 不支持的旧版侧栏继续提供原有编辑区。

## 保存语义

严格读取保留 CRLF，避免 baseline 比较时改变文本。超过 512 KiB 的预览或二进制不可作为可写 baseline。
工作台保存携带 `expectedContent`，服务端在写入前读取远端当前文本，变化/删除时返回 `409 conflict`，不重新创建被删除的文件。
连接错误的保存结果标记 `write-outcome-unknown`，不盲重试；provider 绑定变化调用公共代际失效接口。

注意：SFTP 本身没有原子 compare-and-swap。这是写前内容比较，不保证外部进程恰在比较与 writeFile 之间修改时的原子互斥；不宣称原子条件写。

## 验证与运行

回归覆盖见 `test/document-provider.test.js` 与 `test/client-lifecycle.test.js`。
需要运行时 better-sidebar 提供公开 `textDocuments:v1` / `resourceActions:v1` / `fileOpenTargets:v1` 接口，且工作台插件已启用。
源码修改不等于当前产品 GUI 已更新；宿主半需重新加载，注入开发包需重建并重启，不自动部署产品 profile。
