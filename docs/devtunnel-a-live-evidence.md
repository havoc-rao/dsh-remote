# A 实机实验记录 — 2026-10-08

用户明确授权开始 A 部分实验。用户提供当前 CLI 1.0.2094、Tunnel fun-mountain-924p0qw.jpe1、A loopback 55981 → B22。只读 lsof 确认官方 CLI 进程在IPv4/IPv6 loopback监听；环境已有可用agent socket，不读取私钥或钥匙串内容。

通过 [只读实验脚本](<../scripts/devtunnel-a-readonly-experiment.mjs>)创建独立仓库内DSH_HOME，以真实 Cordis Context/plugin 装载新插件source（显式公共carrier API loader注入）和当前dsh-remote底座。提供测试工具与HTTP路由注册服务，没有启动HTTP浏览器服务器、安装产品profile或替代当前GUI。

## 实际结果

- 隔离machines CRUD成功，外部carrier + useAgent，严格pin为此前人工核对的B Ed25519主机指纹。
- 实际test-connect返回ok=true，hostKeyVerified=true，latencyMs3186，platform posix。
- 实际session-bound rw_exec执行 `hostname; whoami; uname -s; pwd` 返回 HAVOCRAO-MC1 / havocrao / Darwin / /Users/havocrao。
- 未输入密码：证明此工具运行上下文中的Node ssh2可使用现有SSH agent完成B认证（不代表所有桌面启动环境都有相同agent）。
- 真实fiber卸载后结束；进程exit0。未更改产品profile、未写远端文件、未启动/停止用户CLI。

原始记录：[readonly-results.json](<../.dsh/a-experiment-rdzlKW/readonly-results.json>)。临时隔离配置为可审计实验产物，未自动删除。

## 第二轮只读目录与 PTY

[第二轮原始结果](<../.dsh/a-experiment-FXD6AS/readonly-results.json>)：脚本exit0，真实pin+agent探活3112ms。

- session-bound `rw_list_dir` 成功列出此前B专用测试目录的两个中文文件；不读取其他个人文件内容、不新增或删除远端文件。
- carrier工厂真实独立PTY返回 HAVOCRAO-MC1 / havocrao / /dev/ttys006。
- `stty size` 从30 100到41 132，输出完成标记验证，而非仅发送resize调用。
- PTY显式end及pool.close，随后真实Cordis fibers卸载成功。用户CLI不被停止。
- 目录mtime输出按脚本进程默认时区显示，未以该文本推断事件时间。

## 第三轮 managed manager 实机路由

[第三轮结果](<../.dsh/a-experiment-BFHUPe/readonly-results.json>)：真实session fixture + Cordis底座路由 `/workspace-terminals/create`、`list`、`terminate` 全部status200。创建独立B PTY（非exited），list返回同一terminalId，terminate ok=true；随后fibers卸载、脚本exit0。再次通过SFTP list/agent/严格pin/直接PTY resize。

该轮没有WebSocket浏览器连接，不冒充managed WS输入输出验收；路由注册服务是隔离in-process服务，SSH/SFTP/PTY为真实B。只验证manager生命周期，不新增远端文件。

## 扩展功能第一轮（2026-10-08，用户授权继续完善）

[功能轮原始结果](<../.dsh/a-experiment-pBWCK4/readonly-results.json>)：只在B新建 `/tmp/dsh-a-functional.PYBXbR` 专用目录；保留测试文件，不删除旧数据。产品配置与系统服务不变。

- 真实 rw_write_file → rw_edit → rw_read_file：中文空格路径22B文本正确变更为“编辑成功”。
- 真实 rw_upload → rw_download：65536B随机二进制，SHA256两端一致 `12bcb3b5e2109ae230af145f0c88f4073fc607a5a6e637b4796c771b745f9400`。
- 上传2791ms，下载4777ms；小文件延迟与吞吐不能外推长期性能。
- pin/agent/命令/SFTP/PTY resize/managed manager create-list-terminate均再次成功。exit0。
- 当前写入工具直接覆盖原文件，正常成功不证明断线安全；正在审查原子保存与冲突测试。

## 原子暂存保存实机复验

[原子保存轮结果](<../.dsh/a-experiment-ps2QMB/readonly-results.json>)：B新专用目录 `/tmp/dsh-a-functional.y9aoHZ`，carrier-only rw_write/rw_edit/rw_upload已走随机同目录temp + OpenSSH posix rename，无就地覆盖回退。真实B支持extension；text write/edit/read及65536B upload/download通过。hash一致 `46696ce372b5bfca139ffba55e27fc29c9b945cfb86db19491d58da0e0e62960`，upload3761ms/download4771ms。16本机故障单测覆盖失败暂存/冲突/权限/unknown commit等；正常实机不冒充断线注入验收。未删除测试产物。

## 日常remote推进：append与冲突

[真实追加与冲突结果](<../.dsh/a-experiment-khVyCo/readonly-results.json>)：B专用目录 `/tmp/dsh-a-functional.tJF3ye`。carrier rw_append走原子暂存，追加中文成功；`/write`使用过期expectedContent返回409 conflict，随后rw_read确认原文件保留“追加验证”，没有出现MUST_NOT_REPLACE。再次64KiBhash往返一致；CLI/系统/产品配置未变。

## 常规remote安全写入扩展（源码验证）

carrier rw_append、/write及/fs write/append均使用原子暂存；同步pushTree/pushOneFile与autoPush在carrier模式传atomicWrites=true，失败/unknown commit不会静默推进state。旧直连SSH默认路径保持原行为。sync+atomic+editor组合52测试通过；任务取消仍需单独接线，不声称已验证。相关代码变更尚未部署GUI。

## 常规remote轮1：managed 数据路径

[managed数据实机结果](<../.dsh/a-experiment-uMrpCO/readonly-results.json>)：ManagedTerminalManager真实连接B，通过in-process View协议适配器发送input和resize并接收init/title/output/closed；远端身份正确，尺寸32 104→43 134，terminate后list为空。该层没有真实浏览器WebSocket网络连接，不能声称GUI验收。

原子保存集成后完整回归：716 pass、0 fail、2 credential skips（718 total）。

## 常规remote轮1：真实镜像同步/推送

[同步实机原始结果](<../.dsh/a-experiment-sGJ0ft/readonly-results.json>)：B专用 `/tmp/dsh-a-functional.9XatPJ` 经真实mirror路由建立schema3本地隔离镜像，rw_sync下载2文件，修改本地文本后rw_push原子上传1文件/跳过1未变文件，rw_read确认“镜像推送验证”。之后managed输入输出/resize/terminate再次成功，exit0。只操作本次专用测试目录。

## GUI与取消阶段

用户确认隔离GUI内已出现 Dev Tunnel SSH 设置区；这证明实际装配加载，尚未收到表单探活/工作区交互结果。隔离实例loopback51106由managed job管理，产品GUI保持不变。

同步取消已经接TaskManager.cancelled及执行AbortSignal，停止新IO调度和提交；暂存后提交前再检查，不强制打断在途IO。sync+helper55测试通过，unknown commit不伪装取消。脚本改为必须显式DSH_EXPERIMENT_TUNNEL及DSH_EXPERIMENT_PORT，拒绝静默复用旧Tunnel目标。

## 等待新Tunnel确认期间的离线加固

上传暂存后检查本地源size/mtimeMs/ctimeMs/inode/device变化，变化则LOCAL_UPLOAD_CHANGED并放弃rename，保护原目标。不是内容级OS快照，但避免常见上传期间改写。sync+atomic组合56测试通过。新Tunnel interesting-pond-7vcxn8k.jpe1 /57680只由用户给出，尚未收到B归属或GUI探活结果，因此未对新目标执行写入。

## 常规remote轮4：离线回归与端点UX修复

最新父侧全量728pass0fail2skip（730total），静态检查通过。同步保存失败/提交不明提示不再建议直接force重试，而是重新读取对账。carrier upload新增maxFileBytes限制。

插件端修复“未保存端口却probe旧machineID端点”问题：dirty参数必须先保存，保存后重置lastprobe；当前target/endpoint/测试状态明示，目标ID/pin编辑锁定。95插件测试通过，新实验包17文件SHA256 bfca6d786b6f301a01d391ae5da07e1a3fd1534d4f103405b4a6e033c71d6d92。隔离GUI未重装该新包，需明确重装/重启后验收，不声称已在页面生效。

## 常规remote轮5：隔离GUI更新

停止原受控实验job，独立DSH_HOME carrier-lab安装最新同名实验tgz；仅实验实例重启到loopback51106。安装client.js SHA256逐字节匹配当前源码，未认证status仍401。最新端点UX修复已由该实例serve；浏览器需重新进入/刷新。当前产品GUI/profile和用户devtunnel保持不变。新登录链接为实例生成一次性凭据，不存入本证据文档。

## 常规remote轮6：工具取消提交边界

rw_write_file/rw_edit/rw_append/rw_upload carrier路径接执行AbortSignal，在原子保存暂存与提交检查中响应取消。真实apply工具fixture验证四种取消都无write/fastPut提交；组合20测试通过。仍是合作式取消，不承诺终止在途SFTP传输；rename请求发出后结果未知需对账。隔离GUI已更新但该轮host源码需后续重启测试实例才能serve新版本，未自动改变产品GUI。

## 常规remote轮8：确认的新Tunnel全功能实机

用户通过确认工具明确新 interesting-pond-7vcxn8k.jpe1 /57680仍为B及原pin。首跑因旧/tmp测试目录已不存在退出1；保留失败记录并修脚本为不依赖旧目录，未改信任或fallback。

[新Tunnel复验结果](<../.dsh/a-experiment-AO0uBW/readonly-results.json>) exit0：pin+agent1796ms、B身份正确；专用/tmp/dsh-a-functional.rkK4ru文本原子write/edit/append/read、过期expectedContent409原文保留；64KiBhash往返一致5892854241727e627413562fe327786bd6092ff359409c3c9981cccd6493d97c（上传1913ms下载1430ms）；sync2/push1+unchanged1并读回；真实PTY和managedView协议input/output/resize/terminate通过。浏览器WS仍未验收，不改变产品环境。

## 常规remote轮9：完整8MiB通过

[8MiB原始结果](<../.dsh/a-experiment-n8p0ag/readonly-results.json>)：专用B/tmp/dsh-a-functional.TjDak8，完整8388608B upload/download，hash一致f04955fe5fe658edf1cda527078b3b79d5b053e1f3c0ed0623fc732922c4d86f，upload28195ms/download4682ms。并非此前中断8MiB证据的改写。实验operation timeout显式180s，本次上传超过普通15s/可能默认超时，日常大文件需有合适transfer deadline配置/提示，不能据成功假设默认参数足够。

sync2/push1/readback、managed数据resize/terminate再次成功exit0。最新底座完整730pass0fail2skip（732total），插件96pass。mirror导航新包17文件hash0bc02b229107b60e4b0c1c56604c13259552fe0f3651757710a7eb0c534ce4b5，尚未安装到隔离GUI。

## 常规remote轮10：独立传输期限

新增transferTimeoutMs配置默认180000ms、最大1800000ms，SFTP read/write/fastGet/fastPut使用独立传输期限；metadata与命令保持commandTimeout。33相关测试通过。

[短命令超时的大文件实机](<../.dsh/a-experiment-TbonqR/readonly-results.json>)：commandTimeoutMs15000，传输默认180s，完整8MiB上传24871ms（超过15s仍成功）、下载7886ms，hash一致b4d097ca7bb3f8ab3342e58e6346f8d8f3222ac4f36680074ff435d3a9a381c2；其余sync/terminal流程exit0。配置不等于SFTP timeout可中止在途IO，不自动重放。

## 常规remote轮11：配置期限缓存与GUI包缓存

carrier cache revision包含connect/command/transfer期限与输出/env，更新配置后替换旧pool；7定向测试通过。隔离GUI最新同名tgz重装时pnpm误保持旧内容（字节核对发现），未手改node_modules，改用hash命名归档0bc02b229107重新装，client逐字节匹配当前source。仅实验实例再次启动loopback51106，新一次性token不入文档；产品页面不变。

## 常规remote轮12：GUI保存探活确认

用户通过确认工具报告最新隔离GUI保存和探活成功（用户证据，未获得截图/DOM）。下一步请求绑定专用/tmp/dsh-a-functional.lqh0aD并返回localMirror；真实侧栏导航/文件树/WS终端未确认。managed归属额外校验strict identity machineId与上下文一致，28定向测试通过。

## 尚未执行

浏览器GUI/实际宿主profile装配、文件写入往返、managed WS浏览器终端入口、managed CLI自动启动、睡眠恢复。已通过source-loaded框架pin+agent+真实工具目录链路及carrier工厂PTY，不等于整个GUI插件已经安装或生产可用。
