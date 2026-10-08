# Dev Tunnel SSH 实验交付检查单

## 本轮交付范围

独立 `dsh-devtunnel-ssh@0.0.1-experimental` 插件 + dsh-remote 通用 SSH carrier 底座。初始使用模式为 external/manual；两端手工安装官方 devtunnel CLI、GitHub 登录，B 明确授权 sshd，A 手动 connect 提供当前 loopback 端口。无自动安装、登录、系统服务调整或产品 profile 部署。

实验启用需隔离 sandbox 的底座配置 `experimentalSshCarrier:true`，默认 false。生产 ready 始终 false。工具/机器/镜像/探活的实验接线不等于现 GUI 已更新。

## 实现核验

- carrier 注册和 lease acquire/release，动态端口与稳定身份分离。
- pinned SSH 主机校验：不能通过 off/TOFU 绕过。
- 每机器 cache 并发去重、变更/卸载失效、晚到连接释放；carrier 不按旧 TTL 强关活终端。
- CRUD opt-in/白名单脱敏，拒绝原地改变目标/指纹，初版不存新密码/口令。
- schema3 mirror、文件引用与自动推送严格归属；旧 SSH 与 Bridge mirror 兼容。
- fresh connector probe，未知 ID 拒绝，不回退 profile 主机。
- managed terminal target guards；旧 terminal backend、additional forwards、per-workspace disconnect、remote DSH Web 部署不对 carrier 开放。
- 独立插件 status capability 解析，不用注册存在推断运行实例能力。

## 测试证据分层

1. 用户人工双 Mac：SSH/公钥免交互认证、主机指纹、PTY resize、256 KiB SFTP 中文名往返、端口改变后重连。大文件中断、低吞吐及通道告警不冒充通过。
2. 本机真实 SSH wire：底座 apply/rw_exec、身份校验、池隔离、清理。只触本机 fixture，不读个人 SSH state。
3. 本机真实 Cordis：Context/plugin/effect/Fiber装载卸载，晚到 lease 释放；不是 browser 验收。
4. fixture/跨仓契约：机器/镜像/探活/adapter/managed生命周期。
5. 父侧全套最终审计后结果：680 pass、0 fail、2 credential skip（682 total），使用 bundled Python/Pillow PATH；静态闸门通过。
6. 插件侧最终 source 组合复验：83 pass；实际 npm包清单14文件逐字节匹配当前源码/文档，包内无秘密。

测试次数并不合并计算；每次套件结果是各自时点与范围的记录。

## 构建产物与使用文档

- [独立插件实际包](<../../dsh-remote-vscode/.dsh/artifacts/dsh-devtunnel-ssh-0.0.1-experimental.tgz>)。
- [包内 MANUAL](<../../dsh-remote-vscode/packages/devtunnel-ssh/MANUAL.md>)。
- [sandbox API验收步骤](<../../dsh-remote-vscode/docs/devtunnel-ssh/sandbox-api-acceptance.md>)。
- [底座接口及分阶段记录](<ssh-carrier-contract.md>)。

底座源码依赖目前尚未发布版本；不能只安装新插件tgz就声称当前旧底座已具备支持。底座产品部署需另行授权，禁止手工覆盖 profile。

## 发布前尚未声明通过

- 已认证 sandbox 宿主/浏览器实际装配与真正用户接线。
- DSH宿主agent/私钥可达性与完整SFTP/terminal两机插件集成。
- 私有Tunnel未授权负测、关闭VSCode独立性、完整8 MiB、睡眠恢复。
- managed auto-start安全配置/审批、真实CLI监听所有权及受控前提runner。
- 性能及长期稳定性；不承诺无人登录重启恢复或生产SLA。

以上是明确留存的下一次实机/产品化验收，不以自动安装或登录绕过。旧 Bridge 与生产实例保持不动。
