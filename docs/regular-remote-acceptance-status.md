# 常规 Dev Tunnel remote 验收状态

## 当前已具备（源码/隔离实机证据）

- 独立插件external设置区：用户确认隔离GUI已出现；当前最新包安装client逐字节匹配。
- stable机器+descriptor、严格pin、宿主agent、fresh probe、端口更新/目标更换隔离。
- 真实rw命令/SFTP目录、文本write/edit/append/read、64KiBhash往返。
- schema3mirror +真实sync/push读回。
- managed manager输入/输出/resize/terminate（真实PTY，View边界fixture）。
- 原子保存、冲突/unknowncommit、安全提示、上传源变化拒绝、工具/同步合作式取消。
- 最近全量728pass0fail2skip；后续定向工具取消20pass、sidebar unknowncommit9pass。

## GUI关键验收等待用户

新连接由用户给出 `interesting-pond-7vcxn8k.jpe1`，A端口57680、B端口22。用户已确认仍属HAVOCRAO-MC1，隔离source实机probe及完整功能复验通过；用户已确认最新设置区保存/probe成功；绑定后的localMirror及导航/文件树/终端点击结果仍未收到。此前旧目标实机成功不作为新目标自动授权写入。

下一次用户操作：确认B归属与已知主机pin；新Tunnel应新增稳定机器记录；保存→probe→绑定专用测试目录→文件树打开/编辑保存/managed终端。不得在目标/指纹变化时原地重置信任。

隔离GUI由受控job运行loopback51106；产品配置/页面不变。最新host安全修改需要后续仅重启实验实例后实际测试。一次性登录token不写本文件。

## 不可冒充已通过

真实浏览器点击/WS网络交互、未授权Tunnel负测、长期8MiB传输稳定性、sleep/wake、managed自动CLI托管、无人登录恢复、生产部署。

## 限制与操作原则

外部CLI由用户持有；插件不kill该进程。新文件原子提交设0600；替换保持mode但不保证ACL/xattr/所有权/hardlink元数据一致。最终比较+rename非远端原子CAS。rename确认丢失必须重新读取对账，禁止自动重放。取消不强断在途IO，仅阻止后续调度/提交。

证据入口：[实机记录](<devtunnel-a-live-evidence.md>)、[交付检查单](<devtunnel-ssh-experimental-delivery.md>)。
