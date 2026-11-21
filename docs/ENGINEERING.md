# PickUp 工程说明

状态：本地业务后端、正式产品界面与 Windows 桌面集成（托盘、全局快捷键、capture/widget、关闭到托盘、开机启动协调）已实现（2026-09-12）。产品架构以 [ARCHITECTURE.md](ARCHITECTURE.md) 为目标，接口语义见 [IPC-CONTRACT.md](IPC-CONTRACT.md)，验收见 [VALIDATION.md](VALIDATION.md) 与 [ACCEPTANCE-TRACKING.md](ACCEPTANCE-TRACKING.md)。

## 1. 环境及依赖锁定

验证环境：Windows 11 x64（系统 build 26200），开发 Node.js 24.12.0、npm 11.6.2。`.node-version`、package.json 的 engines/packageManager 记录开发基线；本机运行版本仍需实际检查，配置本身不会自动切换工具链。

Electron 42.11.3 携带 Node.js 24.19.0、Chromium 148.0.7778.280，原生模块 ABI 146。better-sqlite3 实际 SQLite 版本为 3.53.2；Electron `process.versions.sqlite` 的 3.53.3 属于运行时内置 SQLite，不是本项目数据库依赖版本。

| 直接依赖 | 精确版本 |
| --- | --- |
| `better-sqlite3` | `12.11.1` |
| `@noble/hashes` | `1.8.0` |
| `@sqlite.org/sqlite-wasm` | `3.50.4-build1` |
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

全部直接依赖使用精确版本；传递依赖由 package-lock.json 固定。`.npmrc` 设置 save-exact 和 npm 官方 registry。正式验证使用 `npm ci`，不采用 `--legacy-peer-deps` 或强行忽略相容性。驱动可移植层使用 `@noble/hashes` 同步计算兼容既有回执的 SHA-256，使用官方 `@sqlite.org/sqlite-wasm` 验证相同命令与查询；尚未接入移动宿主或 OPFS。

选取依据：electron-vite 5 的 peer 范围支持 Vite 7，故搭配 Vite 7.3.6 与 React 插件 5.2.0；TypeScript 5.9.3 和 Vitest 4.1.11 已通过实际类型/测试构建。Electron 42.11.3 与 better-sqlite3 12.11.1 有匹配 Windows x64 / ABI 146 预编译文件。更高版本尝试缺少对应预编译文件，触发本机未安装的 C++ 编译工具链，因此没有锁定该组合。当前选择是已验证组合，不宣称所有包均为最新版本。

`postinstall` 先调用官方 Electron 下载脚本，再使用 `electron-builder install-app-deps` 作为唯一原生模块准备入口。下载器在存在 HTTP_PROXY/HTTPS_PROXY 时通过子进程启用 Node 的环境代理支持；不写入代理地址、不关闭 TLS 校验、不修改系统设置。首次安装需要网络；缓存命中后可复用下载内容。

## 2. 实际工程结构

独立的自托管密文同步中继位于 `server/`，不依赖应用 worker 或 UI。部署、HTTPS、备份、升级与桌面启用步骤见 [SYNC-SERVER.md](SYNC-SERVER.md)；根目录 `npm run server:test` 包含服务端类型检查，`npm run server:build` 输出独立 Node 24 产物。桌面加密同步与配对二维码已接入；Android 配对与联网同步留待 PR9。

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
  - `sqlite.ts`、`sqlite-wasm-driver.ts`：最小同步驱动契约与 oo1 适配器；整数读取与 better-sqlite3 默认模式一致（number，大整数可能损失精度）。
  - `migrate.ts`：无 Node 依赖的版本守卫与事务迁移；桌面升级前备份仍由 `database.ts` 负责。
  - `errors.ts`：领域错误、schema/迁移/一致性/连接错误与启动诊断文案。
  - `hlc.ts`、`sync.ts`：可移植 HLC、事务 outbox、离线变更导出与合并；没有网络调用或 renderer API。
  - `migrations/`：`001.sql` 初始结构、`002.sql` 等待回看字段、`003.sql` 同步元数据、`004.sql` 本机同步配置与上传密文、`005.sql` 拉取连续性锚点 + `index.ts` 顺序迁移清单（当前 schema 版本 5）。
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

业务五表（tasks / breakpoints / task_transitions / app_state / command_receipts）保留；schema 3 新增 sync_device / sync_changes / sync_dirty。业务命令、HLC 和 outbox 在同一事务中提交或回滚；草稿、偏好和回执不参与同步。

## 3. 命令及产物

| 命令 | 作用 |
| --- | --- |
| `npm ci` | 按锁文件安装，下载官方运行时并准备原生依赖 |
| `npm run dev` | 启动 Vite 开发服务和 Electron 主窗口 |
| `npm run start` | 运行已有 out 构建；首次需先 build |
| `npm run typecheck` | 分别检查 Node/Electron 与 Web 配置，strict、未使用声明检查 |
| `npm run format` / `format:check` | 格式化 / 检查源码、测试和配置 |
| `npm test` | 以 Electron 的 Node 模式运行 Vitest，匹配 better-sqlite3 ABI；覆盖契约、组件及两驱动的共享 store 场景 |
| `npm run check` | 类型 + 格式 + 单元/组件测试 |
| `npm run build` | 输出 main/preload/worker/renderer 到 out |
| `npm run build:mobile` | 独立 Vite 构建，共享 React UI + 移动 API + Web Worker + SQLite WASM 到 out/mobile；不修改桌面构建 |
| `npm run test:mobile` | 构建桌面与移动产物，Chromium 验证 OPFS、移动交互和真实 relay + Electron 桌面库配对收敛；Linux 需 DISPLAY |
| `npm run ios:sync` | 构建移动产物并同步到 `ios/`（Capacitor SPM 工程，无需 CocoaPods） |
| `npm run ios:ipa` | macOS + Xcode 构建未签名 Release IPA 到 `out/ios/PickUp-<version>-unsigned.ipa`，供免费 Apple ID 侧载 |
| `npm run test:integration` | 构建后通过 Electron 运行真实 worker/SQLite 的 16 组集成场景 |
| `npm run test:e2e` | 构建后运行 Playwright Electron 自动化（桥接、独立 capture、界面闭环、视觉、规模） |
| `npm run rebuild:native` | 为锁定 Electron/架构准备 better-sqlite3 原生模块 |
| `npm run pack` | 输出 dist/win-unpacked |
| `npm run dist` | 输出 dist/PickUp Setup 0.3.0.exe（版本读取 package.json） |

移动 Web 可运行 `npx vite preview --config vite.mobile.config.ts` 后访问 `http://127.0.0.1:4174`。需要安全上下文（localhost 或 HTTPS）及支持 OPFS 同步访问句柄的浏览器；不需要 COOP/COEP。首次运行浏览器测试需 `npx playwright install chromium`。存储位置固定为当前 origin 的 `/pickup-sahpool`，池内主文件 `/pickup.sqlite`；不同端口、协议或域名的数据相互隔离。不得清空该目录作为启动恢复手段。

移动 API / 存储宿主不调用原生插件；只有 Android 同步 sheet 的扫码操作调用官方条码插件，见下节。只读 `PickupAPI.host` 区分 `desktop` / `mobile`，不检测 user agent。移动宿主的“记一件事”在当前页面打开共享记录表单，“现在处理”或“稍后处理”提交后回到主界面；关闭或返回先保存草稿，失败保留输入。窗口控制、桌面入口、设置与退出操作不在移动 UI 显示；直接调用桌面专用 API 仍返回 `VALIDATION_ERROR`，不伪造系统设置成功。一次仅一个页面持有存储池；并发打开会明确报错，关闭占用页后重新加载。页面隐藏不停止已接收事务；离开页面时释放 worker，BFCache 恢复时重新加载连接。

移动布局由 `data-host="mobile"` 限定：单列、44px 触控目标、中文长文本换行、安全区留白；通过 Visual Viewport 调整键盘打开时的表单可见高度。共享 Modal 使用浏览器 history 管理移动覆盖层，Android 返回键先关闭详情/表单（键盘显示时系统先收起键盘）；不新增返回键或键盘插件。桌面仍使用独立记录窗口和原窗口布局。`npm run test:mobile` 在 Chromium 的 393×851 触屏项目中覆盖空状态、记录/开始、详情/返回、暂停/完成、稍后处理、草稿、失败保留输入和横向溢出，同时保留 OPFS 持久化/不可用/并发页用例。

Android `MainActivity` 仅桥接系统 UI：使用已有 AndroidX 的返回键回调调用 WebView `goBack`（无历史时交回系统），通过 `WindowInsetsCompat` 为状态栏、导航栏、刘海与输入法预留原生边距。键盘边距随系统 IME 更新，使 Visual Viewport 与输入滚动同步；状态栏/导航栏使用深色图标匹配浅色界面。无需新增插件或依赖，任务规则仍完全在共享 TypeScript 层。

手机采用独立 shell，不渲染桌面 `.topbar`、侧栏或窗口按钮。顶部保留紧凑品牌标识与同步云图标；底部安全区导航包含“工作台 / 今日收尾”和居中的“记一件事”主操作，始终位于拇指可达区域。当前任务卡保持主视觉；恢复信息采用轻量无卡片样式，移除手机上的重复捕获条、统计面板和收尾宣传卡，避免桌面导航缩小后直接搬到手机。

### 离线同步基础（PR6）

`src/worker/sync.ts` 导出 `listChangesSince(db, cursor = 0, limit = 200)` → `{changes, cursor}` 与 `applyRemoteChanges(db, changes)` → `{applied, revision}`。上传游标是本库单调追加序号，不是 HLC；晚到的旧时钟变更也会被导出。接收的原始变更保留原 ID 并可再次导出，以变更 ID 去重；本轮没有确认、清理、网络传输、服务端、账号或 UI/IPC 同步入口。

迁移在原升级保护事务内生成一次设备 UUID，回填断点/历史 UUID，为旧业务数据生成初始 outbox。空库不生成业务事件。HLC 采用 `16位 wallMs:10位 counter:设备UUID`，固定宽度、按字符串排序，tick/receive 持久化于设备行，可处理时钟回拨与计数溢出。任务内容（标题/备注）与状态（状态/等待原因/回看时间/结束时间等）独立 LWW；断点和历史按 UUID 追加合并。历史/最新断点按 HLC、UUID 排序，原 seq 仅保留本地 DTO/回执兼容，不用于跨设备比较。任务 version、工作区 revision、next-up version 是各库的乐观并发标记，不参与跨库收敛比较。

未先收到父任务的事件保留在 outbox，等内容与状态寄存器齐备后再建立任务和外键子记录。输入、不可变 ID 重用或事务失败会整批回滚。每次合并和本地命令提交均从原始事件重算状态：开始事件按 HLC、任务 ID 排序。每批本地写入只读取一次最大已观察 HLC 和设备时钟，在内存中 receive/tick，并在批末持久化一次；升级回填不为每行重复扫描 outbox。时钟落后的明确 start/switch 仍可成为最新开始。

`materializeTasks` 是有效状态的唯一派生位置：若原始状态寄存器仍为 doing，且其他任务有更高顺序的开始，则物化为 paused；暂停时间取第一个 displacer 的 HLC.wallMs，恢复推荐沿用该时间排序。status/status_changed_at 是寄存器的查询投影，物化不生成 outbox 或历史，原始状态 HLC 不变。胜者完成、取消或暂停不会自动恢复被取代的开始；该任务自己的后续真实完成、暂停、重新打开等状态写入仍按 LWW 生效，明确再次 start 才能成为当前任务。状态历史始终仅保留真实用户转换的追加并集，不生成 synthetic pause 的 UUID、HLC 或历史行，因此迟到的更早 displacer 不会重复历史，推断暂停也不会排在真实完成之前。

next-up 按选择 HLC 合并，并检查目标任务的全部结束/等待事件：选择之后（或同 HLC）的 done/cancelled/waiting 使该选择永久失效，后续 reopen 不复活旧引用，哪怕结束设备从未收到该选择。选择比结束事件更新时，若父任务或 reopen 尚未到达则暂时隐藏，补齐后恢复有效选择；用户在结束/reopen 之后重新选择可以正常生效。不生成拥有新 HLC 的自动清空事件。用户明确清空、结束或等待命令产生的清空仍是正常 LWW 事件。合并只保留收到的原始事件，不生成修复事件。单 doing 唯一索引在物化事务内重建，提交前恢复；任何中间错误连同索引变化一起回滚。

`tests/sync.test.ts` 在 better-sqlite3 / SQLite WASM 两驱动运行同组迁移、LWW、乱序/重复、冲突、原子失败和 12 个种子的双设备随机交错收敛测试。运行 `npm run check` 或 `npm test -- tests/sync.test.ts`；现有桌面 worker 场景另由 `DISPLAY=:0 npm run test:integration` 验证。

### 桌面加密同步（PR8）

`sync-client.ts` 使用 fetch/WebCrypto，不依赖 Electron 或 Node 模块；桌面 Node worker 与移动 Web Worker 共用。`sync-crypto.ts` 实现随机 32 字节 rootKey、HKDF-SHA256、AES-256-GCM 和版本化配对载荷。注册 token 只用于旧版桌面的一次空间注册请求，不进入数据库、状态 DTO 或日志；手机可登录账户或通过配对加入。同步配置里的 rootKey 与数据库一样需要保护，升级保护副本也可能包含它；这里未引入系统钥匙串。

PR9b 增加固定 `account(input)` API，动作通过 Zod 判别联合 allowlist（注册/登录/退出、恢复、临时扫码请求/确认）进入同一 worker。`account-crypto.ts` 仅使用 WebCrypto：600k PBKDF2-SHA256、域分离 HKDF、AES-GCM 包装，ECDH P-256 加密手机到桌面的单次授权。默认服务是 `shared/account-contracts.ts` 的构建常量，定制服务只在“高级”。schema 7 在本机配置增加 session/email，暂存未确认保存的恢复码，均不参与同步；确认后删除暂存。账户登录验证包装根密钥后复用 `saveConfig` 路径，空间加密协议不变。服务只持有 scrypt 认证摘要和包装密钥。桌面私钥/轮询凭据仅在 worker 内存，UI 只持有公开二维码；2 分钟过期，隐藏时停止轮询。服务器配置、限流、恢复与部署约束见 [SYNC-SERVER.md](SYNC-SERVER.md)。

schema 4 的 `sync_config` 保存本机服务器、根密钥、推/拉游标、上次成功/错误和退避状态，`sync_uploads` 保留已加密上传条目。schema 8 把网络 `sync_outbox` 与 CRDT `sync_changes` 分开；本地提交和明确的快照分别标记 `local` / `snapshot`，普通远端合并不入队。迁移保留旧本地条目的序号和密文，过滤历史误入队的远端记录。首次加入或切换空间时，事务创建新上传身份与紧凑快照：当前内容寄存器及最大更新时间证据、所有状态寄存器、最新 next-up、全部断点与转换历史，保留领域 ID/HLC。完整状态历史防止遗忘 doing 压制和 next-up 的失效证据。旧原始 outbox 不发送到新空间。`sync_destination` 仅保存上次空间 ID、上传身份及游标；停止后不保留密钥/会话，但保留 outbox/密文和这些非密钥元数据，使同空间重登复用原上传身份、游标及完全相同的 nonce/密文，不重复上传。切换空间时清除旧网络缓存。这些表均不导出。确认上传后事务推进 outbox 序号；拉取整页先全部验证解密，再在一个事务中合并并推进 serverSeq，失败不应用部分页面。schema 5 的 deviceId/clientSeq 锚点与拉取游标在同一事务保存：N>0 从 after=N−1 请求，首条必须为相同身份的 seq N，验证后丢弃重叠行；缺失或不匹配则事务清零推拉游标与锚点，只重传当前空间 outbox 的保留密文，并记录连续性重建。N=0 不验证锚点；旧配置没有锚点时也安全重建，不依赖高水位下降。

本地业务提交后按新增 outbox 序号防抖 2 秒；worker 每 60 秒和启动时补同步，也可手动“立即同步”。同一时刻只运行一个循环，网络等待不占 SQLite 事务、不阻塞本地记录。每轮先上传，再拉取，慢拉取或拉取超时不阻塞该轮的本地上传。拉取每页 50 条（含连续性重叠行，最大密文页约 4.2 MiB）；响应流累计超过 48 MiB 则中止，不信任 Content-Length。每次请求 20 秒超时（含读取正文），禁止跟随重定向以避免凭据泄露。失败以 5 秒倍增至 5 分钟，成功重置；401/403 持久停止并显示“需要重新配对”。上传每批最多 500 条，另按 UTF-8 JSON 请求体的 1 MiB 和单密文 64 KiB 拆包。收到远程数据后通过 worker → main → 全窗口广播刷新；同步状态也复用该通知。

固定 API 是 `enableSync({serverUrl,registrationToken})`、`disableSync()`、`getSyncStatus()`、`syncNow()`、`getPairingPayload()`，经过 Zod IPC allowlist。桌面另有无参数 `copyPairingPayload()`：main 向 worker 读取当前载荷后写入系统剪贴板，只返回确认，不开放任意剪贴板读写，也不放宽 renderer 权限。停止保留任务与 outbox，再次启用创建新空间；不撤销旧二维码或其他设备。配对二维码仅 desktop settings 渲染，使用精确锁定的 qrcode 包；不修改 Electron CSP。

验证：`npm run check` 包含密钥/篡改/载荷、原子游标、断线重推、401/403、定时/防抖/退避与真实 HTTP relay + native/WASM 两库收敛。`DISPLAY=:0 npm run test:e2e -- tests/e2e/sync.spec.ts` 覆盖设置启用、立即同步、二维码和复制配对码；服务端另运行 `npm run server:test`。

### 手机前台同步与配对（PR9）

移动 Web Worker 在同一 WASM/OPFS 连接上创建 `SyncClient`。`pairWithPayload(payload)` 在 API registry 校验输入、在 worker 用既有版本化 parser 校验 URL/rootKey，经单一 `saveConfig` 路径保存同一 `sync_config`，立即运行首次同步。没有注册请求或 token；首次配对把已有完整状态写成快照上传。移动端开放状态/立即同步/停止；`enableSync` 与 `getPairingPayload` 仍为 desktop-only。401/403 持久停止后可重新扫码或粘贴，已启用时须先停止再换空间。停止清本机密钥/会话配置，不清任务/outbox 或同空间重试密文、不撤销其他设备。

schema 6 增加本机 `upload_device_id`；schema 8 只在首次加入或切换空间时生成新身份，同空间重连、持续重试和连续性重建复用它。旧配置为空时继续沿用原 store deviceId 和已有密文，不改变已发布会话。领域事件 ID/HLC 与持久 store deviceId 不变，事件按 ID 合并去重；上传身份和 outbox 序号不再从 HLC 作者推断，也不进入领域事件流。

页面以 `visibilitychange` 转发前台状态，worker 启动时默认 inactive；可见时启动 60 秒周期、2 秒本地提交防抖、回到可见时触发同步，隐藏时清计时器并中止请求，不把主动取消记作网络失败。**没有后台服务、后台同步或保活。** 本地数据库事务不依赖网络。远程应用/状态通过 worker `changed` → `MobileWorkerClient` → `onStateChanged` 刷新，订阅和页面计时器在释放时清理。

`MobileSyncSheet` 复用 Modal/history 返回处理，紧凑顶栏用 Lucide 云图标进入；状态、上次同步、重试错误与停止在同一 sheet 展示。仅 Android 使用精确锁定的官方 `@capacitor/barcode-scanner@2.2.6`（2.x 为 Capacitor 7 兼容线）；扫码启动原生相机权限提示，拒绝/取消时保留可用的“粘贴配对码”。浏览器不调用原生扫码。插件最低 Android SDK 26，因此壳的最低版本升至 Android 8.0；Manifest 声明 CAMERA、可选相机硬件和 INTERNET。

移动 CSP 的 connect-src 仅同源、HTTPS 和 `http://localhost:*`。Android 网络安全配置默认禁止明文，只允许 `localhost` 开发地址；`https://localhost` 来源需在 relay CORS allowlist。打包不依赖外部 Web 资源，离线记录照常。手机配对/模拟器 `adb reverse` 步骤见 [SYNC-SERVER.md](SYNC-SERVER.md#手机加入已有空间)。`npm run test:mobile` 增加真实 relay + Electron better-sqlite3 桌面库与浏览器 WASM 库的粘贴配对、双向收敛、错误与返回验证。

### Android 壳（Capacitor 7）

`capacitor.config.ts` 固定应用 ID `com.yoob52.pickup`、名称 `PickUp`、资源目录 `out/mobile`。提交的 `android/` 是 Capacitor 生成的原生工程；同步产生的 Web 资源、机器本地配置、Gradle 缓存和 APK 按生成工程的 `.gitignore` 排除。仅增加官方条码插件用于扫码，沿用移动 `PickupAPI` 与 WebView history 返回/默认生命周期行为。

需要 Node/npm（同本工程）、JDK 21、Android SDK platform 35 和 build-tools 35.0.0。Linux VM 示例：

```bash
source "$HOME/.nvm/nvm.sh"
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
npm ci
npm run android:sync
npm run android:apk
adb -s emulator-5554 install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5554 shell am start -n com.yoob52.pickup/.MainActivity
```

`android:sync` 每次先构建共享 Web 产物再同步；修改 Web 代码后需重新同步和构建 APK。`android:apk` 使用工程 Gradle wrapper 生成 debug APK（Windows 可在 `android` 下运行 `gradlew.bat assembleDebug`）。Gradle/SDK 首次构建需要下载依赖；所有脚本、图片、WASM 随 APK 打包，本地操作无需联网。Manifest 的 INTERNET 只为用户主动配置的同步，未配对时不访问中继。

### iOS 壳（Capacitor 7，免费 Apple ID 侧载）

`ios/` 是 `cap add ios --packagemanager SPM` 生成的 Xcode 工程，与 Android 共用 `capacitor.config.ts`、移动 `PickupAPI` 和 SQLite WASM/OPFS 存储；没有 App Store 分发和付费开发者签名。最低 iOS 16.4（OPFS 同步访问句柄）。Info.plist 声明扫码用的相机说明。WebView 来源是 `capacitor://localhost`（WKWebView 不能使用 https 自定义协议），同步服务器 `PICKUP_ALLOWED_ORIGINS` 需要包含它，默认值已包含。

本地需要 macOS、Xcode 16 以上和本工程 Node 版本：`npm ci && npm run ios:sync && npm run ios:ipa`。模拟器调试可 `xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator build` 后 `xcrun simctl install`。

[ios.yml](../.github/workflows/ios.yml) 在 main 推送、相关 PR、`v*` 标签和手动触发时于 `macos-15` 运行 `npm ci`、`ios:sync`、`ios:ipa`，上传 `pickup-ios-ipa` artifact（14 天）；标签构建先校验标签等于 package.json 版本，再等待 Windows 工作流创建 Release 后上传 IPA。IPA 未签名，`CFBundleShortVersionString` 取 package.json 版本，`CFBundleVersion` 与 Android versionCode 同规则。安装与 7 天续签步骤见 [IOS-INSTALL.md](IOS-INSTALL.md)。

#### Android CI 与发布签名

[android.yml](../.github/workflows/android.yml) 在 main 推送、涉及应用/Android/移动构建配置的 PR、`v*` 标签和手动触发时运行。使用 `.node-version` 的 Node 24.12.0、Temurin JDK 21、SDK 35，依次 `npm ci`、`npm run android:sync`、Gradle `:app:assembleRelease`，用 build-tools 的 `apksigner verify --verbose --print-certs` 验证并输出证书 SHA-256。APK 作为 `pickup-android-apk` artifact 保留 14 天。

在 GitHub 仓库的 Actions secrets 中一起设置以下四项，不要提交 keystore 或密码：

- `ANDROID_KEYSTORE_BASE64`：正式 keystore 文件的 base64，例如 `base64 -w 0 pickup-release.keystore`（macOS 可用 `base64 < pickup-release.keystore | tr -d '\n'`），输出只写入 secret，不贴到日志或聊天。
- `ANDROID_KEYSTORE_PASSWORD`：keystore 密码。
- `ANDROID_KEY_PASSWORD`：签名私钥密码。
- `ANDROID_KEY_ALIAS`：签名条目的 alias。

生产签名 secrets 仅在 push 到 main、push `v*` 标签、或从 main 手动触发时注入受 step 条件保护的构建步骤；所有 PR（包括同仓库分支）以及其他来源的手动触发都跳过该步骤，使用独立的无 secrets 环境进行 debug 签名构建。继续使用仓库 secrets，不需要创建 GitHub Environment 或移动现有 secrets。可信步骤在四项完整时将 keystore 解码到 `$RUNNER_TEMP`，以环境变量 `ANDROID_KEYSTORE_FILE` 加三个密码/alias 变量交给 Gradle，构建结束即删除临时 keystore。缺少全部 secrets 时，release variant 同样使用 Android debug keystore 签名（不是未签名 APK）；job summary 明确显示 `release-signed` 或 `debug-signed: secrets missing`，并附证书 SHA-256。可信步骤只设置部分 secrets 时明确失败，不会悄悄降级。

本地 `assembleRelease` 使用相同规则：同时设置 `ANDROID_KEYSTORE_FILE`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_PASSWORD`、`ANDROID_KEY_ALIAS` 即为正式签名；全部不设置则 debug 签名；部分设置立即报错。不要在命令行传密码或打开 shell tracing。debug 签名只用于测试，runner 的 debug key 不保证跨次构建一致，不能用于长期分发或升级。

标签必须为 `vX.Y.Z`；CI 仅传入 `-PpickupVersionName=X.Y.Z`，非标签构建默认读取根 package.json 的 version。Gradle 统一按 `major*10000 + minor*100 + patch` 计算 versionCode，不接受独立的 versionCode 覆盖，也不使用 run number：`1.0.0 → 10000`、`1.0.1 → 10001`、`1.1.0 → 10100`、`2.0.0 → 20000`。同一版本的本地和标签构建代码相同。只接受无前导零的三段数字版本，minor / patch 必须在 0..99，结果必须在 Android 的 1..2100000000 范围内；越界直接失败，保证受支持版本的顺序严格递增。标签成功构建后，仅 publish job 获取 `contents: write`，通过 gh CLI 上传 `app-release.apk` 到同名 GitHub Release。现有 Windows 工作流负责创建共享 Release，标签仍须匹配根 package.json 版本；Android 最多等待 30 分钟，避免并发创建冲突。若 Windows 发版失败，修复其 Release 后仅重跑 Android publish job。同名 APK 已存在时上传失败，不覆盖已发布产物；下载前务必检查该 run summary 的签名模式，标签本身不保证已设置正式密钥。

正式分发前创建并妥善备份唯一的长期私钥：keystore 加密保存到至少两个独立离线/受控位置，密码与 alias 存入单独的密码管理器，限制 Actions secrets 管理权限，并记录公开证书 SHA-256。不要依赖 GitHub secret 导出作为备份，不要用测试生成的临时 key 发正式版本。丢失或更换密钥通常不能覆盖安装旧版本；debug 与 release 证书不同也不能直接覆盖安装，卸载会删除应用私有数据，应先保护已有数据。轮换需要单独规划 Android 签名继承策略，本工作流不提供密钥找回。

WebView 固定加载 `https://localhost`，这是 OPFS 所需安全上下文；不要更改 scheme/hostname，否则相当于更换数据 origin。Capacitor 本地资源处理器将 `.wasm` 返回为 `application/wasm`，不需要 COOP/COEP。需要支持 OPFS 同步句柄的 WebView；不支持时沿用 `DB_UNAVAILABLE` 明确失败。OPFS 数据位于应用的 WebView 私有存储；force-stop 不清除它，卸载/清除应用数据会清除。直接点击主界面的“记一件事”完成记录与开始，无需调试导航。

持久性验收：记录并开始任务后执行 `adb shell am force-stop com.yoob52.pickup`，再用上述 `am start` 重启，确认标题及进行中状态保留。用 `adb exec-out screencap -p > before.png` / `after.png` 保存屏幕，`adb logcat -d` 检查 Capacitor/Chromium/JS 错误；仅 debug APK 开启 WebView 远程调试。不要用 `pm clear` 或卸载重装模拟重启。

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

NSIS 配置为用户级完整安装包、卸载保留数据，原生模块按需从 ASAR 解包。品牌原图为 `docs/logo.png`：主窗口、桌面入口、原生窗口和托盘统一引用，electron-vite 将运行时图片打入 out；Windows EXE、安装器及快捷方式使用 `resources/icon.ico`（16 / 24 / 32 / 48 / 64 / 128 / 256 像素）。替换原图时同步重建 ICO 后重新打包。ICO 可在有 Pillow 的维护环境中生成，不增加应用运行依赖：

```powershell
python -c "from PIL import Image; Image.open('docs/logo.png').convert('RGBA').save('resources/icon.ico', sizes=[(n,n) for n in (16,24,32,48,64,128,256)])"
```

Authenticode 为 NotSigned。历史版本已静默安装到临时目录、对安装后的 exe 跑桌面 E2E、覆盖安装并卸载；本次品牌更新的验证范围见 [VALIDATION.md](VALIDATION.md)。签名信誉与向正式 `%APPDATA%/PickUp` 路径的手工试用未做。e2e 环境不调用 `setLoginItemSettings`，避免污染开发机启动项。

本地 Git 管理于 2026-09-11 初始化，默认分支为 `main`。源码、文档、配置、测试和依赖锁文件纳入版本控制；依赖目录、构建产物、测试结果、本地数据库和签名证书由 `.gitignore` 排除。文本换行由 `.gitattributes` 统一管理。已配置 GitHub origin；远程自动打包与发版由 [release.yml](../.github/workflows/release.yml) 定义，首次 GitHub 执行结果以 Actions 页面为准。

### GitHub Actions 打包与发版

- 手动试打包：先将工作流推送到默认分支，在 GitHub 的 **Actions → Build and release Windows → Run workflow** 选择分支运行。成功后下载 `pickup-windows-x64` artifact，其中包含 NSIS 安装器和 `SHA256SUMS.txt`；手动触发仅生成 artifact，不创建 Release。
- 标签发版：推送 `v<package.json version>` 标签，检查及包内冒烟全部通过后，自动创建 GitHub Release，上传安装器和 SHA-256 校验文件并生成发布说明（开头附 README 的 Code signing policy 链接，满足 SignPath Foundation 对发布页的要求）。标签与包版本必须完全一致；例如 `v0.2.0-beta.1` 对应包版本 `0.2.0-beta.1`，含预发布标识的版本创建为 prerelease，且不设为 latest。
- 后续发布示例（以 `0.3.1` 为例，先确认工作区、发布内容和版本）：

  ```powershell
  npm version 0.3.1 --no-git-tag-version
  git add package.json package-lock.json
  git commit -m "chore: release v0.3.1"
  git tag -a v0.3.1 -m "Release v0.3.1"
  git push origin main
  git push origin v0.3.1
  ```

- Runner 使用 Windows 2022 x64，Node.js 读取 `.node-version`，npm 沿用工程锁定版本。依次执行 `npm ci`（包含 Electron 下载和原生模块准备）、`npm run check`、工作流格式检查、Electron SQLite 集成测试、`npm run dist -- --publish never` 和包内冒烟。安装、原生重建和打包顺序执行，electron-builder 不自行发布。
- 包内冒烟覆盖品牌资源及桌面入口展开/收起、独立 capture 桥接、完整业务链路和重启持久化。未将全量视觉 E2E 设为发布门禁：既有旧标题断言和透明窗口截图超时见 [VALIDATION.md](VALIDATION.md)，本工作流不代表这些项目已通过。
- 构建 job 只读仓库；仅发布 job 获得 `contents: write`，使用 GitHub 自动提供的 `GITHUB_TOKEN`，无需额外 PAT。仓库需启用 Actions，并允许工作流获得发布所需写权限。第三方执行入口使用官方 Actions 并锁定提交 SHA。
- 成功产物保留 14 天，失败诊断保留 7 天。发布 job 失败时可在 Actions 中仅重跑失败 job；已存在同名 Release 时创建操作会报错，不覆盖已发布文件。
- 当前仍为未签名的 Windows x64 安装器；工作流没有配置代码签名、自动更新或 macOS/Linux 产物。上线前仍需安装/升级/卸载及 Windows 专项验收。
