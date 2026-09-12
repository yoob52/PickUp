# PickUp 工程说明

状态：本地业务后端、正式产品界面与 Windows 桌面集成（托盘、全局快捷键、capture/widget、关闭到托盘、开机启动协调）已实现（2026-09-12）。产品架构以 [ARCHITECTURE.md](ARCHITECTURE.md) 为目标，接口语义见 [IPC-CONTRACT.md](IPC-CONTRACT.md)，验收见 [VALIDATION.md](VALIDATION.md) 与 [ACCEPTANCE-TRACKING.md](ACCEPTANCE-TRACKING.md)。

## 1. 环境及依赖锁定

验证环境：Windows 11 x64（系统 build 26200），开发 Node.js 24.12.0、npm 11.6.2。`.node-version`、package.json 的 engines/packageManager 记录开发基线；本机运行版本仍需实际检查，配置本身不会自动切换工具链。

Electron 42.11.3 携带 Node.js 24.19.0、Chromium 148.0.7778.280，原生模块 ABI 146。better-sqlite3 实际 SQLite 版本为 3.53.2；Electron `process.versions.sqlite` 的 3.53.3 属于运行时内置 SQLite，不是本项目数据库依赖版本。

| 直接依赖 | 精确版本 |
| --- | --- |
| `better-sqlite3` | `12.11.1` |
| `lucide-react` | `1.43.0` |
| `react` | `19.3.0` |
| `react-dom` | `19.3.0` |
| `zod` | `4.6.1` |
| `@playwright/test` | `1.63.0` |
| `@testing-library/dom` | `10.4.1` |
| `@testing-library/jest-dom` | `7.0.1` |
| `@testing-library/react` | `16.3.3` |
| `@types/better-sqlite3` | `9.6.0` |
| `@types/node` | `24.13.4` |
| `@types/react` | `19.3.0` |
| `@types/react-dom` | `19.3.0` |
| `@vitejs/plugin-react` | `5.2.0` |
| `electron` | `42.11.3` |
| `electron-builder` | `26.15.3` |
| `electron-vite` | `5.0.0` |
| `jsdom` | `26.1.0` |
| `prettier` | `3.9.6` |
| `typescript` | `5.9.3` |
| `vite` | `7.3.6` |
| `vitest` | `4.1.11` |

全部直接依赖使用精确版本；传递依赖由 package-lock.json 固定。`.npmrc` 设置 save-exact 和 npm 官方 registry。正式验证使用 `npm ci`，不采用 `--legacy-peer-deps` 或强行忽略相容性。本轮后端实现未新增任何依赖：命令、查询、校验和测试都复用已锁定的 better-sqlite3、zod、Vitest 与 Playwright。

选取依据：electron-vite 5 的 peer 范围支持 Vite 7，故搭配 Vite 7.3.6 与 React 插件 5.2.0；TypeScript 5.9.3 和 Vitest 4.1.11 已通过实际类型/测试构建。Electron 42.11.3 与 better-sqlite3 12.11.1 有匹配 Windows x64 / ABI 146 预编译文件。更高版本尝试缺少对应预编译文件，触发本机未安装的 C++ 编译工具链，因此没有锁定该组合。当前选择是已验证组合，不宣称所有包均为最新版本。

`postinstall` 先调用官方 Electron 下载脚本，再使用 `electron-builder install-app-deps` 作为唯一原生模块准备入口。下载器在存在 HTTP_PROXY/HTTPS_PROXY 时通过子进程启用 Node 的环境代理支持；不写入代理地址、不关闭 TLS 校验、不修改系统设置。首次安装需要网络；缓存命中后可复用下载内容。

## 2. 实际工程结构

- `src/shared/`
  - `contracts.ts`：DTO、Zod 输入 schema、结果与错误码、命令结果值、`PickupAPI`。
  - `task.ts`：状态类型、中文名称、状态转换表与空快照（纯规则，不依赖 Electron/数据库）。
  - `local-date.ts`：本地日期区间计算（平台原生本地日历能力，左闭右开，含夏令时与不存在/重复午夜）。
  - `worker-protocol.ts`：main → worker 的固定请求/应答与启动消息类型。
- `src/worker/`
  - `index.ts`：顺序处理入口；每个请求必有且仅有一个应答，未知命令明确拒绝。
  - `database.ts`：唯一连接、pragma、版本迁移、升级前一致副本、一致性检查。
  - `commands.ts`：全部写命令的领域规则、回执幂等、版本校验与同步事务。
  - `queries.ts`：工作区快照、分页列表、详情、收尾查询、回执查询。
  - `rows.ts`：行映射、排序 SQL、revision 与状态历史辅助。
  - `errors.ts`：领域错误、schema/迁移/一致性/连接错误与启动诊断文案。
  - `migrations/`：`001.sql` 初始结构 + `index.ts` 顺序迁移清单（当前 schema 版本 1）。
- `src/main/`
  - `index.ts`：单实例、生命周期、资源协议、桌面宿主与 worker 装配。
  - `desktop.ts`：主窗口/唯一 capture/widget、托盘、全局快捷键、登录项、关闭隐藏、完全退出与草稿 flush。
  - `bounds.ts`：widget 工作区可见性校正（纯函数，可单测）。
  - `ipc.ts`：固定命令 allowlist、来源与主 frame 校验、参数校验、变更广播、日期边界与窗口 API。
  - `worker-client.ts`：请求关联、超时、pending 清理、启动/退出/关闭处理与诊断（含 ready 前退出的初始化结算）。
  - `integration.ts`：Electron 内的真实 worker + SQLite 集成验证（含故障注入与版本守卫）。
- `src/preload/index.ts`：暴露固定的 `window.pickup` 业务方法与 `onStateChanged` 订阅。
- `src/renderer/`：正式产品界面。主窗口覆盖当前任务、列表、恢复、记录、切换、详情、等待、收尾与设置；`?window=capture` / `?window=widget` 挂载独立窗口根组件。业务只通过 `window.pickup`。
- `tests/`：契约/状态规则/日期计算的单元测试、IPC 契约一致性、组件行为、Playwright 端到端。
- `scripts/`：官方运行时下载入口及 Electron 集成测试启动器。

当前 schema 仍为初始五表设计（tasks / breakpoints / task_transitions / app_state / command_receipts）：全部 P0 业务能力所需字段已经足够，本轮没有新增迁移文件。写入路径包括创建/编辑、开始、切换、暂停、等待与恢复、完成、取消、重新打开、断点、下次开工引用、草稿、偏好，全部在同步事务内完成并写回执或版本。

## 3. 命令及产物

| 命令 | 作用 |
| --- | --- |
| `npm ci` | 按锁文件安装，下载官方运行时并准备原生依赖 |
| `npm run dev` | 启动 Vite 开发服务和 Electron 主窗口 |
| `npm run start` | 运行已有 out 构建；首次需先 build |
| `npm run typecheck` | 分别检查 Node/Electron 与 Web 配置，strict、未使用声明检查 |
| `npm run format` / `format:check` | 格式化 / 检查源码、测试和配置 |
| `npm test` | Vitest：契约边界、状态规则、日期计算、IPC allowlist 一致性、组件行为 |
| `npm run check` | 类型 + 格式 + 单元/组件测试 |
| `npm run build` | 输出 main/preload/worker/renderer 到 out |
| `npm run test:integration` | 构建后通过 Electron 运行真实 worker/SQLite 的 16 组集成场景 |
| `npm run test:e2e` | 构建后运行 Playwright Electron 自动化（桥接、独立 capture、界面闭环、视觉、规模） |
| `npm run rebuild:native` | 为锁定 Electron/架构准备 better-sqlite3 原生模块 |
| `npm run pack` | 输出 dist/win-unpacked |
| `npm run dist` | 输出 dist/PickUp Setup 0.1.0.exe |

禁止同时执行安装/重建和构建/打包，它们共享依赖目录。不要用开发 Node.js 直接加载已经按 Electron ABI 准备的原生库；数据库集成测试刻意在 Electron 中执行。`scripts/run-integration.mjs` 的进程级超时为 120 秒，覆盖当前 16 组场景（含多次 worker 重启）。单元/组件测试数量以最近一次 `npm test` 为准，不要沿用旧轮次的 44/46。

验证解包后的应用：

```powershell
$env:PICKUP_PACKAGED_EXE=(Resolve-Path 'dist/win-unpacked/PickUp.exe').Path
npx playwright test
Remove-Item Env:PICKUP_PACKAGED_EXE
```

上述设置仅用于当前 shell。测试启动器给应用传入临时测试目录，结束后清理；不会读取个人开发库。

## 4. 数据与隔离

开发数据：`%APPDATA%/PickUp-development/data/pickup.sqlite`。正式包使用 Electron userData/data，实际默认目录由应用名称决定，禁止随意改名导致用户数据路径漂移。

升级前保护副本（`VACUUM INTO` 生成，轮换保留最近 2 份）写入同级目录 `data/backups/pickup-pre-upgrade-v<from>-to-v<to>-<时间戳>.sqlite`。该目录只保存内部可靠性副本，不是面向用户的数据导出功能。

测试使用 `os.tmpdir()` 中 `pickup-integration-*` 或 `pickup-e2e-*` 独立目录。`PICKUP_E2E=1` 配合 `PICKUP_TEST_DATA` 仅用于受控自动化启动，并隐藏主窗口；正常使用不要设置这些变量。

集成测试通过 `StoreClient(file, { faults })` 注入 `WorkerFaultStage`（见 `src/shared/worker-protocol.ts`）来验证事务中途失败后的整笔回滚，以及 worker 生命周期（`boot.exitBeforeReady` 启动阶段退出、`request.exitBeforeReply` 就绪后无应答退出）。故障注入只在 `workerData.faults` 存在时生效，生产启动路径不传递该参数，也不接受来自 renderer 的任何注入参数。

renderer 禁止 Node 集成并开启 contextIsolation/sandbox；IPC 检查已登记窗口、主 frame 与来源，参数由 Zod 校验，channel 为固定 allowlist。生产资源通过固定 pickup://app 协议加载，拒绝路径越界、任意导航和弹出新窗口。当前类型配置已按进程分区；自动禁止所有跨目录导入的静态规则尚未添加，评审需检查此边界。

## 5. 修改规范

- 修改接口同时更新 shared 类型、schema、preload、main/worker 与对应测试；`tests/ipc-contract.test.ts` 会检查 preload 方法集合与 main allowlist 完全一致。
- 数据库写入留在 worker，事务内不 await；确认提交后才呈现保存成功。
- 新增迁移使用新的顺序文件，禁止修改已发布数据库的历史迁移。迁移前必须生成并校验一致副本；发现 schema 版本更新、缺少版本信息但已有数据表、或一致性检查失败时停止写入并保留原文件。
- 不在日志中输出任务正文或 IPC payload；只记录通道、错误码、版本等元信息。
- 草稿、偏好与窗口位置写入使用各自的版本字段，不递增工作区 `revision`（不触发业务刷新），也不逐键写命令回执。
- 新增依赖先核对现有能力，精确锁定并验证；升级 Electron 后重新准备原生库并验证包内加载。
- 每次交付说明实际通过的命令、剩余范围及限制。`check` 通过不等同于完整 P0 验收通过。

## 6. 发布边界

NSIS 配置为用户级完整安装包、卸载保留数据，原生模块按需从 ASAR 解包。当前默认图标，Authenticode 为 NotSigned。本轮已静默安装到临时目录、对安装后的 exe 跑桌面 E2E、覆盖安装并卸载。签名信誉与向正式 `%APPDATA%/PickUp` 路径的手工试用未做。e2e 环境不调用 `setLoginItemSettings`，避免污染开发机启动项。

本地 Git 管理于 2026-09-11 初始化，默认分支为 `main`。源码、文档、配置、测试和依赖锁文件纳入版本控制；依赖目录、构建产物、测试结果、本地数据库和签名证书由 `.gitignore` 排除。文本换行由 `.gitattributes` 统一管理。远程仓库和远程 CI 尚未配置，构建、测试与诊断均在本机执行。
