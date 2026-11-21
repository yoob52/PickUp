# PickUp 验证记录

## 2026-11-21 · iOS 壳（免费 Apple ID 侧载）

- 新增 Capacitor 7.6.10 iOS 工程（SPM）、`ios:sync` / `ios:ipa` 与 `ios.yml`；Info.plist 加相机说明，最低 iOS 16.4。
- macOS 26.6 + Xcode 26.6 本地：`npm run ios:sync`、模拟器（iPhone 17）构建安装启动，主界面正常渲染、本地 OPFS 库可用；`npm run ios:ipa` 生成 `PickUp-1.0.0-unsigned.ipa`（bundle id `com.yoob52.pickup`，版本 1.0.0 / 10000）。
- 线上 relay 对 `capacitor://localhost` 预检返回 403；relay 默认来源加入该值并加测试，`npm run server:test`、`npm run check` 通过。新镜像部署并更新 `PICKUP_ALLOWED_ORIGINS` 前 iOS 无法同步。
- 未验证：真机 Sideloadly 签名安装、7 天续签、真机扫码与同步；`ios.yml` 首次远端运行以 PR CI 为准。

## 2026-11-20 · 1.0.0 发版准备（未打标签）

根 package.json / package-lock.json 版本统一为 `1.0.0`；Android 默认从 package.json 读取版本，标签构建仅覆盖 versionName，所有构建统一按 `major*10000 + minor*100 + patch` 计算 versionCode（`1.0.0 → 10000`，`1.0.1 → 10001`）。minor / patch 限定为 0..99，拒绝非法版本或 Android 整数范围溢出，避免版本码碰撞或降级。`v1.0.0` 标签将触发 Windows NSIS 构建并创建包含安装器和 SHA-256 校验文件的 Release；Android 有完整签名 secrets 才正式签名，等待 Windows 创建同名 Release 后追加 APK。修正 Android 工作流，不再使用 GITHUB_RUN_NUMBER；未推送标签或创建 Release。

新增 `tests/real-server.test.ts`：默认启动隔离本地中继，使用 better-sqlite3 与 WASM 两个 store 注册临时账户、双向创建和同步、处理 doing 冲突并验证完成胜者后不自动恢复被压制任务。运行 `npm test -- tests/real-server.test.ts`；只有明确提供 `PICKUP_E2E_SERVER_URL=https://your-server.example` 才访问外部服务。账户为 `e2e+<ts>@pickup.test`，成功后撤销会话；外部服务没有账户删除接口，临时账户与少量密文仍会保留。

经机主追加授权，通过本地及 `https://pickup.3352378.xyz` 双 store 验证；生产共创建两个临时账户，其中第二个由 Android 模拟器注册，使用默认服务器、无 adb reverse，通过电脑“复制登录码”→手机确认完成登录，并验证两端分别创建的任务收敛，最后撤销两端会话。模拟器安装版本经 dumpsys 确认为 `1.0.0` / `10000`。实际查看截图 `~/android-setup/v1-*.png`；日志为 `v1-production-store-test.log`、`v1-emulator.log`。未测试光学扫码或真机，未发版。

## 2026-11-20 · 移动布局与交互（PR4）

机主反馈后的手机结构改版：不再复用桌面顶栏/侧栏，采用品牌小标题、底部“工作台 / 今日收尾”导航与居中记录操作。恢复区减轻边框与留白，移除重复统计/收尾面板。新增 DOM 断言禁止 `.topbar/.sidebar/.window-controls/.side-nav` 出现在移动宿主，验证底部导航完整可见、标题高度小于 60px，继续覆盖原触屏流程。

改版后重新通过 `npm run check`（9 个文件 / 127 项）、`npm run test:mobile`（5 项）、桌面构建、17 组集成场景和 3 项相关 Electron E2E；重建、安装 APK 后重新点击验证完整流程，并从底部打开“今日收尾”、通过 Android 返回关闭、点击“工作台”回顶。模拟器实测品牌标题 48px、底部导航 73px、桌面 chrome 节点数为 0，无页面异常或横向溢出。以下 `pr4-*.png` 已刷新并实际查看，新增 `pr4-review.png`；主界面和空状态证明无桌面顶栏、顶部导航或窗口按钮，覆盖层右上角仅保留关闭该表单的按钮。改版日志为 `~/android-setup/pr4-owner-*.log`。

共享 renderer 按只读 `PickupAPI.host` 切换宿主能力。移动端通过全屏覆盖层复用记录表单，记录/现在处理/稍后处理后返回工作台，关闭/返回保存草稿；不显示桌面窗口控件、桌面入口及系统偏好设置。手机采用单列、长中文换行、44px 触控目标和安全区留白；桌面保留独立记录窗口与原布局。

- `npm run check`：类型、格式、9 个文件 / 127 项单元与组件测试通过；含 desktop/mobile 能力分支、移动宿主忽略 widget URL、草稿关闭失败保留输入、只读宿主标记及 IPC 契约。
- `npm run build`、`DISPLAY=:0 npm run test:integration` 通过，后者 17 组现有集成场景全部通过。相关 Electron E2E 3 项通过：桥接完整业务链路、重启持久化、独立 capture/桌面状态桥接；未运行历史全量视觉 E2E，也未修改其旧标题断言。
- `npm run test:mobile`：393×851 Chromium 触屏项目 5 项通过。覆盖记录/开始、详情/返回、嵌套收尾/详情返回、暂停/继续/完成、稍后处理、草稿恢复与失败关闭保护，以及 OPFS 持久化/不可用/并发页保护；360 / 393 / 412px 检查横向溢出与 44px 按钮目标。
- 重建并安装 debug APK，在 Android 15 / WebView 124 的 `pickup` 模拟器以 393×851 分辨率实际点击同一流程，使用物理返回键事件关闭详情，再暂停、继续、完成及稍后保存。未清除应用数据。AndroidX 回调只把系统返回键连接到 WebView history，无历史时交回系统；Insets 处理状态栏、导航栏、刘海与键盘，未增加插件。键盘显示时 viewport 高度从 803px 缩小到 548px，活动文本框底部 438px，未被键盘遮挡。
- 实际查看 `~/android-setup/pr4-main.png`、`pr4-capture.png`、`pr4-detail.png`、`pr4-empty.png`，另有 `pr4-capture-keyboard.png`、`pr4-pause-keyboard.png`。首轮发现 Android 15 系统栏覆盖和默认返回退出 Activity，均由上述原生桥接修正后复验。无捕获的页面异常；logcat 仍有 SQLite 对另一个 SharedArrayBuffer OPFS VFS 的既有警告，实际使用 sahpool。

本轮未做真机、多密度、Windows 输入法或全量桌面视觉验收；截图及本地日志位于模拟器环境的 `~/android-setup/`，不作为仓库内发布素材。

## 2026-11-20 · 0.3.0 发版版本更新

将 package.json、package-lock.json 顶层及根包版本统一为 `0.3.0`，同步更新工程说明中的安装器名称和后续发版示例。标签发版使用 `v0.3.0`，包含界面现代化（#3）、移除重复状态导航（#4）、完成提示支持重新打开（#5）和等待事项回看时间（#6）。历史记录中的 `0.2.0` 保留为当时实际版本。

`npm run check` 通过（类型、格式、6 个文件 / 69 项单元与组件测试）。本轮仅修改版本元数据和文档；`0.3.0` 的打包、集成测试、包内冒烟与 Release 结果以 GitHub Actions 为准。

## 2026-10-24 · 0.2.0 发版版本更新

将 package.json、package-lock.json 顶层及根包版本统一为 `0.2.0`，同步更新工程说明中的安装器名称和后续发版示例。标签发版使用 `v0.2.0`；历史审查和验证记录中的 `0.1.0` 保留为当时实际版本，不回写为新版本。

版本一致性断言通过；`npm run check` 通过（类型、格式、6 个文件 / 59 项单元与组件测试）。本轮仅修改版本元数据和文档，本机未重新打包或运行集成/E2E；`0.2.0` 的打包、集成测试、包内冒烟与 Release 结果以标签触发的 GitHub Actions 为准。

## 2026-10-24 · GitHub Actions Windows 打包发版

新增 `.github/workflows/release.yml`：手动运行生成 Windows x64 NSIS 安装器 artifact；推送与 package.json 版本一致的 `v*` 标签时，验证完成后创建 GitHub Release，上传安装器及 SHA-256 校验文件。预发布版本标记为 prerelease。构建与发布分开授权，官方 Actions 固定提交 SHA，使用内置 `GITHUB_TOKEN`；具体操作见 [ENGINEERING.md](ENGINEERING.md#github-actions-打包与发版)。

- `actionlint 1.7.12` 工作流检查通过（本机未启用可选 ShellCheck/Pyflakes）；YAML 解析和 Prettier 检查通过。实际执行版本检查脚本，确认匹配标签通过、错误版本标签失败、手动分支通过。
- `npm run check` 通过：类型、格式、6 个文件 / 59 项单元与组件测试。
- `npm run test:integration` 通过：Electron 中真实 SQLite/worker 的 16 组集成场景。
- `npm run dist -- --publish never` 通过，生成 `dist/PickUp Setup 0.1.0.exe`；实际执行工作流的校验文件脚本，重新计算 SHA-256 核对通过。
- 设置 `PICKUP_PACKAGED_EXE` 指向本次解包产物后，工作流选择的 4 项包内冒烟通过：品牌资源及桌面入口展开/收起、独立 capture 桥接、完整业务链路、重启持久化。首次运行发现 `tests/e2e/app.spec.ts` 的桥接预期清单落后于现有契约，补齐 `controlMainWindow` / `moveWidget` / `setWidgetExpanded` 后复测通过；未修改应用 API 或业务逻辑。

本轮完成本地验证，尚未推送工作流、标签或创建远端 Release；GitHub 托管 runner 的首次清洁安装、Actions artifact 上传和 Release 权限需在实际运行中确认。未运行全量视觉 E2E，既有旧标题断言与透明窗口截图问题仍保留；未签名、安装升级及 Windows 专项边界沿用原记录。

## 2026-10-24 · 统一品牌 Logo

使用 `docs/logo.png` 替换主窗口左上角、桌面圆形入口及展开卡片标识，保留原图色彩和比例；图片禁用浏览器原生拖动，桌面入口仍使用原有整球拖动、键盘展开和收起逻辑。原生窗口和系统托盘共用同一 PNG；`resources/icon.ico` 包含 16 / 24 / 32 / 48 / 64 / 128 / 256 像素，electron-builder 用于 Windows EXE、NSIS 安装器、卸载器和快捷方式。未增加应用依赖。

- `npm run check`：类型、格式、59 项单元/组件测试通过。
- 源码构建后相关 Electron E2E：Logo 原图字节一致性、展开/收起、整球拖动/四角定位、独立 capture/桌面桥接共 3 项通过。已实际查看 [主窗口](verification/logo/main.png)、[圆形入口](verification/logo/orb.png) 和 [展开卡片](verification/logo/expanded.png) 截图。
- `npm run dist` 通过，更新 `dist/win-unpacked/PickUp.exe` 和 `dist/PickUp Setup 0.1.0.exe`。从 Windows `ExtractAssociatedIcon` 提取应用 EXE 和安装器的 32px 图标，与 ICO 对应尺寸逐像素一致；记录见 [EXE 图标](verification/logo/windows-exe.png)、[安装器图标](verification/logo/windows-installer.png)。
- 解包产物运行：Logo 原图字节一致性、桌面入口展开/收起、独立 capture/桌面桥接 2 项通过。首轮含截图测试在隐藏/透明窗口截图调用处达到 30 秒超时；新增 Logo 行为测试移除截图采集后通过，视觉验收使用已取得的源码运行截图。原有四角截图用例在包内的截图超时保留为未通过项。
- 同轮额外运行的 `chrome-ui.spec.ts` 在首个断言失败：用例仍引用当前页面已移除的“接上思路，继续推进。”标题，尚未进入 Logo 或布局交互。该测试与当前界面的既有差异留待单独修正。

本次未执行安装/覆盖安装/卸载，也未重新做多 DPI、Windows 图标缓存刷新和托盘点击的手工验收；已安装版本需要使用本次安装包更新后才应用新的 EXE 与快捷方式图标。

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

## 验证产物保存约定

`docs/verification/` 为本地验收产物目录，已加入 Git 忽略规则。下文截图及报告路径是历史或本地验证记录，不随仓库分发；运行 `tests/e2e/` 中对应测试可重新生成当前测试的截图和报告。历史审查中的临时探针也仅保留在本地，不作为仓库提供的复现工具。

## 2026-10-24：圆形桌面入口拖动与展开方向

- 点击圆球展开，悬停/聚焦保持收起；整球支持指针捕获拖动，5 DIP 移动阈值区分拖动与点击。移出保持展开，通过收起按钮或 Escape 收起。
- 以圆球为锚点选择左右、上下展开方向，圆球可到工作区四边；展开卡片位置与圆球锚点分别处理，收起不改变锚点。沿用旧位置数据格式，不增加数据库迁移。
- `npm run check`：59 项单元测试通过，包含四角方向、收起锚点和负坐标显示器测试。
- 直接运行 Playwright 桌面测试并连接 dev renderer：2 项通过。覆盖真实指针拖动、拖后保持收起、点击/键盘展开、移出保持展开、Escape、四角原生窗口坐标、收起回原位和非法坐标校验。截图已查看：`docs/verification/widget/corner-0.png` 至 `corner-3.png`。
- 按用户要求重启 `npm run dev`，本轮没有单独执行 build 或打包。实体多显示器拔插、跨不同 DPI 屏幕拖动尚未验证。
