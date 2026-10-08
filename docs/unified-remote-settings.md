# 统一 Remote 设置页集成

用户明确要求能力集成到现有 dsh-remote RemoteWorkspacePage / RemoteSettings机器卡，不新增独立Dev Tunnel SSH设置页。

## 结构

- dsh-remote现有机器列表/表单增加UI类型 Dev Tunnel SSH；wire transport仍ssh，connector.kind=devtunnel。
- independent dsh-devtunnel-ssh插件保留carrier、Config.cliExecutable、host-local预检route、status/help；移除独立settings.section注册与manifest客户端自动注入。旧client纯helpers可保留，不构成新UI入口。
- 统一列表显示Tunnel目标和当前endpoint，避免hostless undefined地址；编辑目标/pin锁定，端口可更新，dirty必须保存才探活/创建镜像。
- 严格pin与agent/private-key；隐藏SSH password/proxy/alias/TOFU等不兼容字段。
- 能力门同时核对实例workspaceSupported与carrierIds含devtunnel，未装provider时明确不可用。
- 同一设置页提供B远端目录/A镜像工作区创建、成功localMirror及侧栏手动选择说明，非自动跳转。

## 验收边界

旧独立设置区已在用户隔离GUI出现，但不再是最终设计；统一设置页源码需本轮测试并安装隔离包/重启实验宿主后刷新验收。当前产品GUI不改变。原SSH、旧vscode-tunnel兼容测试必须通过。

## 操作路径

Remote 设置 → 同一机器卡选择 Dev Tunnel SSH → 填目标/当前loopback端口/用户/独立核实pin/agent → 保存 → 探活 → 编辑已保存记录更新端口 → B授权目录创建A镜像 → 侧栏手动添加/选择返回localMirror。

## 本轮验证与隔离装配

真实ModuleLoader/apply/React hook模拟交互验证4项carrier集成与旧入口，28定向测试通过。最终父侧全量736pass0fail2credentialskip（738total），静态/语法检查通过。独立插件97测试通过、去掉额外settings注册/manifestclient注入，服务-only包hash b538fe3eed7783c74e8310c4e8070d5c8a1bc287aa552b9c151416c4ea0a9d62。

隔离carrier-lab安装hash归档并重启loopback51106，底座link当前源码。新一次性登录token不入文档。真实浏览器新统一入口需用户刷新查看，尚未声称点击验收；旧独立设置区不再注册。

产品部署/发布未执行。目标ID改变新增机器，不原地重置信任。CLI预检服务保留但统一页面按钮暂未接入，不把它伪装已经具备。
