# PickUp 工程初始化验证记录

日期：2026-09-10。仅描述当前工程基线；M1 全部技术验证和完整 P0 尚未完成。

## 通过的检查

| 检查 | 实际结果 |
| --- | --- |
| 精确直接版本与锁文件 | 已生成 package.json、package-lock.json；npm ls --depth=0 正常 |
| 锁文件重新安装 | npm ci --no-audit --no-fund 成功，包含官方 Electron 下载与原生依赖准备 |
| TypeScript | main/worker/preload/shared 和 renderer 分区检查通过 |
| 格式 | Prettier 检查通过 |
| 单元/组件 | 2 个测试文件、3 个用例通过：请求边界、中文标题、保存失败保留输入及复用提交标识 |
| 真实 SQLite | Electron ABI 146 下 worker 成功加载 better-sqlite3，SQLite 3.53.2 |
| 幂等 | 相同命令重复 10 次保持同任务和 revision；不同内容复用 ID 被拒绝 |
| 同名事项 | 不同 commandId 可创建相同标题的独立事项 |
| 重启持久化 | 关闭并重新建立 worker，任务、备注、revision、回执仍存在 |
| React / IPC | 构建版页面完成真实创建；renderer 无 require，只有受限 bridge |
| Windows 打包 | NSIS 完整安装包生成，解包产物生成 |
| 包内运行 | Playwright 启动 dist/win-unpacked/PickUp.exe，页面真实保存与 renderer 隔离断言通过 |
| 生产依赖审计 | npm audit --omit=dev 本次报告 0 个已知漏洞；不是完整发布安全评估 |
| 签名检查 | 安装包为 NotSigned，未声明已签名 |

## 过程中处理的问题

1. 最新依赖不能直接组合：electron-vite peer 范围未覆盖 Vite 最新主版本，选择已匹配版本。
2. better-sqlite3 13.0.3 无对应官方预编译附件，重建要求本机没有的 Visual Studio；切换至有 ABI 146 附件的 12.11.1 与 Electron 42.11.3，真实加载通过。
3. Electron 官方下载脚本未自动采用现有环境代理，显式在下载子进程启用 Node 环境代理支持；之后锁文件重装通过。
4. Vitest 的 JSX 编译设置补齐 React 插件，保存失败测试通过。
5. 一次包构建与 npm ci 重叠，依赖目录替换导致打包失败；随后按串行方式重新构建，NSIS 成功。工程说明已明确禁止并发安装和构建。
6. 隐藏 Electron 窗口截图超时，创建和隔离断言此前已通过。移除非必要截图动作后，包内端到端检查通过；未宣称视觉验收完成。

## 尚未验证或实现

- 独立 capture、widget、托盘、全局快捷键和开机启动。
- 任务开始/切换/暂停/等待/完成/重新打开、断点与每日收尾。
- 关闭草稿保留、多窗口业务一致性、消息超时完整恢复和 SQLite 写失败的实机注入。
- 跨进程强制退出、跨午夜、DPI/多显示器、P95 性能和资源门槛。
- 非空库版本升级保护副本、安装向导、卸载、覆盖升级及断网安装。
- 产品视觉验收、应用图标、正式签名与发布渠道。

当前主窗口关闭即退出。当前界面是工程验证界面，没有覆盖原型全部功能；不能作为完整 F01 或 F07 验收结果。

## 复现方式

见 [ENGINEERING.md](ENGINEERING.md) 的命令表。安装、构建、测试串行执行。测试使用隔离临时目录，不使用正式数据。版本和环境已记录于同一工程说明。
