# PickUp 工程说明

状态：工程初始化基线已验证；日期：2026-09-10。产品架构以 [ARCHITECTURE.md](ARCHITECTURE.md) 为目标，本文件描述当前代码实际状态。

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

全部直接依赖使用精确版本；传递依赖由 package-lock.json 固定。`.npmrc` 设置 save-exact 和 npm 官方 registry。正式验证使用 `npm ci`，不采用 `--legacy-peer-deps` 或强行忽略相容性。

选取依据：electron-vite 5 的 peer 范围支持 Vite 7，故搭配 Vite 7.3.6 与 React 插件 5.2.0；TypeScript 5.9.3 和 Vitest 4.1.11 已通过实际类型/测试构建。Electron 42.11.3 与 better-sqlite3 12.11.1 有匹配 Windows x64 / ABI 146 预编译文件。更高版本尝试缺少对应预编译文件，触发本机未安装的 C++ 编译工具链，因此没有锁定该组合。当前选择是已验证组合，不宣称所有包均为最新版本。

`postinstall` 先调用官方 Electron 下载脚本，再使用 `electron-builder install-app-deps` 作为唯一原生模块准备入口。下载器在存在 HTTP_PROXY/HTTPS_PROXY 时通过子进程启用 Node 的环境代理支持；不写入代理地址、不关闭 TLS 校验、不修改系统设置。首次安装需要网络；缓存命中后可复用下载内容。

## 2. 实际工程结构

- `src/main/`：单实例、资源协议、安全 IPC、主窗口及 worker 客户端。
- `src/preload/`：暴露固定 snapshot/createTask/onStateChanged 方法。
- `src/worker/`：唯一 SQLite 连接，初始迁移、一致读取、创建事务和命令回执。
- `src/shared/`：类型与 Zod 输入 schema。
- `src/renderer/`：React 工程验证界面、表单及待处理列表。
- `tests/`：请求边界、保存失败保留输入、真实 Electron worker 和端到端验证。
- `scripts/`：官方运行时下载入口及 Electron 集成测试启动器。

初始迁移来自架构中的五表设计。当前只实现创建和读取命令，事务内包含任务、创建历史、revision 与幂等回执。没有示例数据种子，不把原型 localStorage 自动导入正式库。

## 3. 命令及产物

| 命令 | 作用 |
| --- | --- |
| `npm ci` | 按锁文件安装，下载官方运行时并准备原生依赖 |
| `npm run dev` | 启动 Vite 开发服务和 Electron 主窗口 |
| `npm run start` | 运行已有 out 构建；首次需先 build |
| `npm run typecheck` | 分别检查 Node/Electron 与 Web 配置，strict、未使用声明检查 |
| `npm run format` / `format:check` | 格式化 / 检查源码、测试和配置 |
| `npm test` | Vitest：输入 schema 和 React 保存失败行为 |
| `npm run check` | 类型 + 格式 + 单元/组件测试 |
| `npm run build` | 输出 main/preload/worker/renderer 到 out |
| `npm run test:integration` | 构建后通过 Electron 运行真实 worker，输出运行时与 SQLite 版本 |
| `npm run test:e2e` | 构建后运行 Playwright Electron 自动化 |
| `npm run rebuild:native` | 为锁定 Electron/架构准备 better-sqlite3 原生模块 |
| `npm run pack` | 输出 dist/win-unpacked |
| `npm run dist` | 输出 dist/PickUp Setup 0.1.0.exe |

禁止同时执行安装/重建和构建/打包，它们共享依赖目录。不要用开发 Node.js 直接加载已经按 Electron ABI 准备的原生库；数据库集成测试刻意在 Electron 中执行。

验证解包后的应用：

```powershell
$env:PICKUP_PACKAGED_EXE=(Resolve-Path 'dist/win-unpacked/PickUp.exe').Path
npx playwright test
Remove-Item Env:PICKUP_PACKAGED_EXE
```

上述设置仅用于当前 shell。测试启动器给应用传入临时测试目录，结束后清理；不会读取个人开发库。

## 4. 数据与隔离

开发数据：`%APPDATA%/PickUp-development/data/pickup.sqlite`。正式包使用 Electron userData/data，实际默认目录由应用名称决定，禁止随意改名导致用户数据路径漂移。

测试使用 `os.tmpdir()` 中 `pickup-integration-*` 或 `pickup-e2e-*` 独立目录。`PICKUP_E2E=1` 配合 `PICKUP_TEST_DATA` 仅用于受控自动化启动，并隐藏主窗口；正常使用不要设置这些变量。

renderer 禁止 Node 集成并开启 contextIsolation/sandbox；IPC 检查已登记窗口、主 frame 与来源，创建输入由 Zod 校验。生产资源通过固定 pickup://app 协议加载，拒绝路径越界、任意导航和弹出新窗口。当前类型配置已按进程分区；自动禁止所有跨目录导入的静态规则尚未添加，评审需检查此边界。

## 5. 修改规范

- 修改接口同时更新 shared 类型、schema、preload、main/worker 与对应测试。
- 数据库写入留在 worker，事务内不 await；确认提交后才呈现保存成功。
- 新增迁移使用新的顺序文件，禁止修改已发布数据库的历史迁移。当前只实现空库初始化和版本拒绝，未来升级保护副本流程待实现。
- 不在日志中输出任务正文或 IPC payload。
- 新增依赖先核对现有能力，精确锁定并验证；升级 Electron 后重新准备原生库并验证包内加载。
- 每次交付说明实际通过的命令、剩余范围及限制。`check` 通过不等同于完整 P0 验收通过。

## 6. 发布边界

NSIS 配置为用户级完整安装包、卸载保留数据，原生模块按需从 ASAR 解包。当前默认图标，Authenticode 检查为 NotSigned。安装包已生成，解包产物已验证，安装向导/卸载/升级/签名信誉尚未验收。

本地 Git 管理于 2026-09-11 初始化，默认分支为 `main`。源码、文档、配置、测试和依赖锁文件纳入版本控制；依赖目录、构建产物、测试结果、本地数据库和签名证书由 `.gitignore` 排除。文本换行由 `.gitattributes` 统一管理。远程仓库和远程 CI 尚未配置，构建、测试与诊断均在本机执行。
