# 接着 PickUp

Electron + React + TypeScript 的本地桌面工作助手。

本地业务后端与正式产品界面已接入同一 IPC。完整功能范围见 [PRD](docs/PRD.md)。托盘、全局快捷键和独立桌面窗口仍待桌面集成。

## About

PickUp is a free, open-source local desktop assistant for Windows that helps you capture new work without losing track of unfinished work. Quick capture records a task in seconds; when you switch tasks, PickUp saves a short "where I left off" note on the paused task, so you can pick it up again later. Waiting items can be scheduled to come back for review, and a daily review summarizes the day. All data stays in a local SQLite database on your computer; the app has no accounts, cloud sync or telemetry.

## 下载与安装 / Download

- 下载：[GitHub Releases](https://github.com/yoob52/PickUp/releases/latest) 中的 `PickUp.Setup.<version>.exe`（Windows 10/11 x64），同页 `SHA256SUMS.txt` 可校验安装包。
- 安装包由 [release.yml](.github/workflows/release.yml) 在 GitHub Actions 上从本仓库源码构建并发布。
- 卸载：在 Windows **设置 → 应用 → 已安装的应用** 中卸载 PickUp，或运行安装目录中的 `Uninstall PickUp.exe`。卸载保留 `%APPDATA%/PickUp` 中的数据；如需彻底删除，卸载后手动删除该目录。

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

- Committers and reviewers: [yoob52](https://github.com/yoob52)
- Approvers: [yoob52](https://github.com/yoob52)

Every change from people other than the committers goes through a pull request reviewed by a committer. Only installers built by the [release workflow](.github/workflows/release.yml) from this repository are submitted for signing, and each signing request is approved manually by an approver.

## Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. PickUp stores its data only in a local SQLite database under `%APPDATA%/PickUp`.

## 启动开发

使用 Node.js **24.12.0** 和 npm **11.6.2**，在项目目录执行：

```powershell
npm ci
npm run dev
```

`npm ci` 会安装 Electron 运行时并准备匹配的 SQLite 原生模块。首次安装需访问 npm 和官方二进制下载源。开发数据存储在 `%APPDATA%/PickUp-development/data/pickup.sqlite`。

## 常用命令

```powershell
npm run check              # 类型、格式、单元和组件测试
npm run test:integration   # Electron 内真实 worker / SQLite 验证
npm run test:e2e           # 构建后端到端测试
npm run pack              # 生成 Windows 解包产物
npm run dist              # 生成 NSIS 安装包
```

测试使用独立临时数据目录；不要并行执行 `npm ci` 与构建/测试，因为安装会替换 node_modules。

## 文档

- [工程说明与锁定版本](docs/ENGINEERING.md)
- [实际验证记录及未完成范围](docs/VALIDATION.md)
- [软件架构](docs/ARCHITECTURE.md)
- [技术负责人计划](docs/TECH-LEAD-PLAN.md)

本版本关闭主窗口会退出应用。托盘、全局快捷键、独立快速记录窗和桌面入口窗口尚未由主进程创建。当前安装包未签名，使用默认 Electron 图标。
