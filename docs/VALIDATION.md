# PickUp 验证记录

## 2026-10-24 · 主窗口独立滚动

主窗口固定为视口高度，通过两行 Grid 保持 72px 顶栏和左侧导航在各自区域；仅 `main.main` 承担核心内容的纵向滚动。移除侧栏、顶栏对整页 sticky 的依赖，侧栏在极小高度下保留自身溢出访问。快速记录和桌面入口不采用主窗口的页面滚动限制。任务筛选继续使用原有 `scrollIntoView`，滚动目标留白调整为内容区内的 20px。

`npm run check` 通过（54 项单元/组件测试）；相关 Electron E2E 3 项通过，覆盖完整交互、窗口生命周期，以及 1440 / 900 / 600 / 390 宽度下滚轮滚动后顶部/侧栏坐标不变、页面 scrollY 为 0、侧栏筛选定位仍在内容区域。已查看 [桌面滚动截图](verification/chrome-ui/scrolled-1440.png) 和 [窄窗口滚动截图](verification/chrome-ui/scrolled-600.png)。dev 已热更新，本轮未打包。

## 2026-10-24 · 窗口边框与标题区

主窗口使用 Electron `titleBarStyle: hidden` 和同色 `titleBarOverlay`，把原生最小化、最大化/还原、关闭按钮合入 72px 顶栏；快速记录使用同色 40px 标题区。移除各窗口默认英文菜单，统一细滚动条，并按系统实际按钮区域预留空间。保留原生边缘缩放与阴影；窗口控制无需新增 IPC，关闭隐藏、草稿保存逻辑沿用原实现。

- `npm run check`：类型、格式、54 项单元/组件测试通过。
- 相关 Electron E2E：铬白布局、桌面桥接、完整交互、视觉 4 项通过；新增 `window-chrome.spec.ts` 修正测试模式隐藏窗口的显示准备后单独复测通过，覆盖覆盖层尺寸与预留、菜单移除、设置按钮、最大化/最小化、关闭隐藏、草稿保留。
- 使用 Electron `desktopCapturer` 保存并实际查看包含原生按钮的窗口截图：[native-main.png](verification/window-chrome/native-main.png)。普通 renderer 截图之外，补充真实窗口外观证据。
- 本轮未打包。Windows 多屏贴靠、边缘拖拽和不同 DPI 的手动体验留待试用；自动化覆盖的是本机窗口状态与布局。

## 2026-10-24 · 08 号铬白 UI

基于 `template/08-chrome.html` 和对应源码重构正式界面，保留纵向侧边栏；使用铬银交扣 SVG、工业字排版、信号橙当前任务舱、浅色恢复卡和收尾面板。顶部常驻记录按钮，详情、设置、快速记录和桌面入口沿用同套颜色。所有业务继续连接原 IPC/SQLite，没有移入模板演示数据或新增依赖。

- 最终验证：`npm run check` 通过（类型、格式、6 个文件 / 54 项单元与组件测试）；`npm run test:e2e` 完成源码构建，修正测试启动等待后 `npx playwright test` 全量 8 项通过，含千条任务规模测试。
- 新增 `tests/e2e/chrome-ui.spec.ts`：检查 1440 / 900 / 600 / 390 宽度、双栏位置、侧栏筛选、长标题、暂停/断点/恢复、设置关闭后的焦点和减少动效。
- 补齐原规模测试缺失的详情分页参数与结果分支类型；界面测试按真实任务行定位，避免恢复推荐前置后误点同名文本。
- 测试启动器等待预热的 capture/widget 挂载后再交还应用，避免快速重启测试在启动尚未完成时退出；未改生产启动/退出逻辑。
- 截图与本轮规模结果保存在 `verification/chrome-ui/`，历史截图保留。已查看桌面空状态、当前任务、设置及窄窗口长标题。
- 开发模式服务复用 `http://localhost:5173`，已核对返回新版源码并唤起“接着 PickUp”主窗口。按要求暂不打包。

实机中文输入法候选确认、系统快捷键冲突、托盘、多显示器和安装升级本轮未重新验收；本轮不修改这些功能。390 宽度用于额外布局检查，原生主窗口最小尺寸继续为 600 × 540。

---

日期：2026-09-12。本轮 `feature/mvp-p0`：补齐桌面集成与审查 R01—R08，并重新打包。

审查基线 `aa2064b` 为历史对照。本文件只记录本轮实际执行的检查。

## 1. 本轮检查

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型/格式/单元 | `npm run check` | 通过。6 个文件、54 个测试（原 46 + bounds/收尾分页/桌面相关 UI） |
| 集成 | `npm run test:integration` | 通过。16 组 Electron+SQLite 场景 |
| 端到端（源码构建） | `npx playwright test` | 通过。6 个用例（桥接×3、桌面窗口、界面闭环、视觉） |
| 规模 | `npx playwright test tests/e2e/scale.spec.ts` | 通过。1000 件任务；见 `docs/verification/scale-results.json` |
| 打包 | `npm run pack`（npmmirror 仅当前 shell） | 通过。`dist/win-unpacked` |
| 安装包 | `npm run dist` | 通过。`dist/PickUp Setup 0.1.0.exe` |
| 解包产物 E2E | `PICKUP_PACKAGED_EXE=dist/win-unpacked/PickUp.exe` | 5 通过；视觉用例在 30s 默认超时下失败，加长后源码构建视觉通过 |
| 安装包内应用 | 静默安装到临时目录后跑 `desktop.spec` | 通过 |
| 覆盖安装/卸载 | 同一目录再次 `/S`，然后卸载 | 安装与卸载 exit 0；卸载后 `PickUp.exe` 不存在 |

### 1.1 产物

版本 `0.1.0`。SHA-256：

| 文件 | 哈希 | 大小 |
| --- | --- | --- |
| `dist/win-unpacked/PickUp.exe` | `7B132397DBCE487D11D42167041898E4E634DDE17DCC5944CD5B08977F41EB56` | 235128320 |
| `dist/win-unpacked/resources/app.asar` | `D9A20DFBBDE7826E396A3BB44E00CBE078E914462C3761F610721047F2AFAA50` | 40142095 |
| `dist/PickUp Setup 0.1.0.exe` | `6CDE93B7627B830EF27667E25B39CF6C2DD62E0114558E345F713CF7077631D6` | 108484170 |

renderer 资源：`out/renderer/assets/index-Bv0xPFRr.js`。源码提交 `2051730`（`feature/mvp-p0`）。asar 由该提交的源码构建；本句是事后写入的提交号，不在包内。

设备：Windows 11 x64（build 26200），Electron 42.11.3。测试全程独立临时目录，未访问正式 userData。

### 1.2 性能（本机，n 见 JSON）

| 操作 | P50 | P95 | max | n |
| --- | --- | --- | --- | --- |
| createTask | 22 ms | 44 ms | 422 ms | 1000 |
| switchTask | 10 ms | 249 ms | 249 ms | 20 |
| showCapture（IPC 往返） | 11 ms | 25 ms | 25 ms | 20 |

showCapture 从 renderer 调用到主进程返回，**不是**操作系统快捷键按下到标题可输入。规模夹具：1000 件任务，前 10 件各 10 条短断点。

## 2. 视觉

截图（隐藏/自动化窗口渲染）：

- `docs/verification/01-main-empty.png`
- `docs/verification/02-capture.png`（独立 capture 窗口）
- `docs/verification/03-current-task.png`
- `docs/verification/04-small-window.png`（600×540，「今日收尾」仍在导航）
- `docs/verification/05-settings.png`（真实快捷键/开机启动状态，无「待接入」）
- `docs/verification/07-detail-contrast.png`（浅色侧栏次按钮为深色字）

未做：系统缩放 150%、屏幕阅读器、真实中文 IME 候选窗。

## 3. 未验证

| 项 | 限制 | 复验 |
| --- | --- | --- |
| OS 全局快捷键按下 | 自动化不能可靠注入系统热键 | 安装后按 Ctrl+Alt+N，标题可输入 |
| 快捷键被其他程序占用 | 未人为占用 | 用系统已占用组合保存，应 `SHORTCUT_CONFLICT` |
| 托盘点击 | Playwright 不操作托盘 | 点托盘「打开 / 记一件事 / 完全退出」 |
| 开机启动读回 | e2e 跳过 `setLoginItemSettings` | 正式包打开开关，任务管理器启动项对照 |
| 真实午夜 / 改系统时间 | 只用定时器与 `TZ` | 打开收尾跨 00:00 |
| 拔插显示器 / 改 DPI | 仅 `visibleBounds` 单测 | 拔屏后 widget 仍可见 |
| 睡眠恢复 | 已监听 `powerMonitor` | 睡眠再打开收尾日期 |
| 磁盘满 / 权限拒绝 | 故障注入非实盘 | 只读目录或磁盘满 |
| SIGKILL / 掉电 | 仅 worker 退出注入 | 任务管理器结束进程后重启 |
| Authenticode / SmartScreen | NotSigned | 签名后再验 |
| 向正式 `%APPDATA%/PickUp` 写入 | 禁止 | 试用安装走默认路径，卸载后数据仍在 |

## 4. 与上一轮口径

上一轮 VALIDATION 混有 44/46 测试和「本轮已 pack / 未 pack」。本轮单元 **54**；集成仍为 **16**；E2E 源码构建 **6**（含桌面窗口）。不要用旧安装包代表本源码。

追踪表：[ACCEPTANCE-TRACKING.md](ACCEPTANCE-TRACKING.md)。
