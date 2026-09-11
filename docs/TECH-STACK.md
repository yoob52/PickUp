# PickUp MVP 技术选型

| 项目 | 内容 |
| --- | --- |
| 版本 | v1.0 |
| 日期 | 2026-09-09 |
| 状态 | 根据用户明确要求更新的技术基线 |
| 约束 | 团队不熟悉 Rust；应用业务统一使用 TypeScript；前端使用 React |
| 正式架构 | [ARCHITECTURE.md](ARCHITECTURE.md) |

## 1. 选型结论

**Electron + React + TypeScript + electron-vite + SQLite（better-sqlite3）。**

本版替代此前 Tauri + Vue + Rust 推荐。正式实现以 ARCHITECTURE.md 为架构依据，功能规则以 PRD.md 为准。

| 领域 | 选择 |
| --- | --- |
| 桌面宿主 | Electron |
| 前端 | React、TypeScript、普通 CSS / CSS Modules、lucide-react |
| 构建与依赖 | electron-vite、Vite、npm，锁定精确版本和 package-lock.json |
| 业务执行 | TypeScript；main 管理桌面能力，单一 Node.js worker 执行业务和持久化 |
| 本地数据库 | SQLite + better-sqlite3，同步短事务置于 worker |
| 通信 | contextBridge 暴露固定业务方法；IPC 输入以 Zod schema 校验 |
| 界面状态 | React 局部状态和共享快照订阅；数据库为业务事实来源 |
| 测试 | Vitest、React Testing Library、Electron 集成入口、Playwright 和 Windows 实机专项 |
| 打包 | electron-builder / NSIS，暂按 Windows 11 x64 用户级安装 |

## 2. 关键取舍

- 全部应用业务代码使用 TypeScript，无自定义 Rust/C++ 代码。better-sqlite3 含原生依赖，构建时需匹配 Electron 版本和 CPU 架构；这属于依赖打包职责。
- SQLite 由一个 worker 独占连接，避免保存时阻塞 main；切换涉及的断点、状态、引用和回执作为一个事务提交。
- 主窗口、快速记录窗口、轻量桌面入口共享数据库，通过提交版本通知刷新，不各自保存任务状态。
- 保持原型视觉，但将演示逻辑改为受校验的生产命令。所有 PRD P0 保留，包括桌面入口、全局快捷键、每日收尾和异常恢复。
- Electron 运行时随安装包交付，原方案中的 WebView2 安装前置要求不再适用。核心使用离线；包体和全进程资源消耗在 M1 实测。
- 初期不引入云端、ORM、Redux、跨设备同步或自动更新服务。

## 3. 默认交付条件

Windows 11 x64、小范围试用、手动安装完整更新包为当前工程默认值；最低系统、内存/安装包门槛和正式分发签名尚需在对应验收前落实，不标记为用户已逐项确认。无需再确认 TypeScript 与 React 的选择。

详细模块职责、数据库表结构、IPC 契约、故障语义、工程目录、需求追踪和官方参考资料统一维护于 [ARCHITECTURE.md](ARCHITECTURE.md)，避免多处定义不一致。

## 4. 变更记录

| 日期 | 版本 | 说明 |
| --- | --- | --- |
| 2026-09-09 | v0.1 | 初始推荐 Tauri + Vue + Rust，待团队约束确认 |
| 2026-09-09 | v1.0 | 按用户要求采用 Electron + React + TypeScript，正式架构迁入 ARCHITECTURE.md |
