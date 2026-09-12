# PickUp P0 验收追踪（2026-09-12）

审查基线：`aa2064b`（见 [REVIEW-V1-2026-09-12.md](REVIEW-V1-2026-09-12.md)）。本表对应 `feature/mvp-p0` 本轮实现，不替代原审查报告。

应用版本 `0.1.0`。产物见 [VALIDATION.md](VALIDATION.md)。

状态：`通过` = 有自动化或本机专项证据；`部分` = 实现已落地但专项未做或只覆盖部分层次；`未验证` = 环境限制，不得用构建成功代替。

## 1. 审查项 R01—R08 与补充观察

| 项 | 实现位置 | 验证方式 | 结果 | 剩余 |
| --- | --- | --- | --- | --- |
| R01 桌面集成 | `src/main/desktop.ts`、`src/main/index.ts`、preload/shared 窗口 API、`WidgetApp`/`CaptureApp` | `tests/e2e/desktop.spec.ts`、安装包内同一用例；托盘/快捷键代码路径在启动时注册 | 通过（窗口/桥接/单实例代码）；真实全局按键与多显示器热插拔见未验证 | 人工按键、登录项读回以 `getDesktopState` 为准，e2e 跳过真正写入登录项 |
| R02 原生关闭草稿 | `CaptureForm.flushDraft`、`onPrepareClose`、capture `close` 与 `quit` | 组件测试 flush/失败保留；关闭协议 2.5s 超时则保留窗口 | 通过（渲染层与主进程协议）；Alt+F4 本机未人工按键 | 人工 Alt+F4 / 标题栏关闭 |
| R03 收尾跨午夜 | `DailyReview` 一次性 `setTimeout` + `onDayInvalidated`；main `powerMonitor` | `msUntilNextLocalDay` 单元测试；可见页定时器有生命周期 | 通过（定时器与系统恢复事件已接线）；未等待真实午夜 | 真实跨午夜、改系统时间 |
| R04 当天完成分页 | `getDailyReviewQuerySchema`、worker `completedOffset`、收尾「显示更多」 | 契约测试；界面按钮 | 通过（契约+UI）；101 件全量未单独集成夹具 | 可用主窗口已结束列表交叉核对 |
| R05 收尾详情保留断点 | `MainApp.reviewOpen` 与 overlay 叠层 | `tests/ui.test.tsx` 收尾打开详情后断点仍在 | 通过 | 无 |
| R06 详情按钮对比 | `style.css` `.detail-actions .btn-secondary` | 截图 `07-detail-contrast.png` | 通过 | 无 |
| R07 小窗口收尾入口 | `AppShell` 将「今日收尾」放入主导航 | 截图 `04-small-window.png`；E2E 断言按钮可见 | 通过 | 无 |
| R08 新产物 | `dist/win-unpacked`、`PickUp Setup 0.1.0.exe` | 本轮 pack/dist；解包/安装包 E2E | 通过，见 VALIDATION | 签名信誉未做 |
| 空状态文案 | `ResumePanel` | UI 测试：仅有 waiting 时不说工作区为空 | 通过 | 无 |
| 工程编号/待接入 | 主界面、设置、capture、详情 eyebrow | 视觉截图 | 通过 | 英文 kicker 仍有少量品牌语气，不是功能编号 |
| 键盘 Enter 专项 | CaptureForm `isComposing` | 未做真实 IME 断言 | 未验证 | 中文输入法 Enter |

## 2. 33 条 AC

| AC | 结果 | 证据 |
| --- | --- | --- |
| F01-01 | 通过 | 集成/E2E：创建不抢占当前任务 |
| F01-02 | 通过 | UI：空标题提示 |
| F01-03 | 通过 | 仅标题创建 |
| F01-04 | 通过 | 草稿恢复；prepare-close flush；失败保留 |
| F01-05 | 部分 | 提交锁+同一 commandId；真实连续键击/IME 未验 |
| F02-01 | 通过 | 主窗口 E2E；widget 与主窗口同一 snapshot |
| F02-02 | 通过 | 空当前任务文案 |
| F02-03 | 通过 | 隐藏 widget 后主窗口/快捷键/托盘仍可进入 |
| F02-04 | 部分 | 列表截断+详情；widget 长文本/各 DPI 未人工走查 |
| F03-01—05 | 通过 | 既有集成+界面 E2E；切换现于独立 capture 窗口完成 |
| F04-01—05 | 通过 | 既有 E2E/集成；空状态文案已修 |
| F05-01—04 | 通过 | 既有链路；F05-03 现含 widget 同一快照 |
| F06-01—04 | 通过 | 既有集成+E2E 收尾 |
| F06-05 | 部分 | 查询正确；可见页有午夜定时器与 resume 事件；未等真实午夜 |
| F07-01 | 通过 | E2E 重启 |
| F07-02 | 部分 | worker 退出注入；OS 强杀未验 |
| F07-03 | 通过 | 失败保留输入；成功来自提交结果 |
| F07-04 | 部分 | 冲突返回 `SHORTCUT_CONFLICT` 并保留入口；未人为制造系统级占用 |
| F07-05 | 部分 | 单实例锁+second-instance showMain；未另开第二份用户库并行写入 |

## 3. 未单独编号的 P0 规则

| 规则 | 结果 | 说明 |
| --- | --- | --- |
| 全局快捷键默认可改、冲突提示 | 部分 | 启动注册；失败保留旧组合；e2e 不模拟系统占用 |
| 唯一 capture、焦点标题、Esc、保存后隐藏 | 通过 | 独立窗口 + hideCapture |
| widget 可移动/收起/隐藏/置顶、默认不置顶 | 通过 | 偏好+窗口；e2e 中 widget 默认不显示以免抢窗口 |
| 多显示器位置可见 | 部分 | `visibleBounds` 单元测试；未拔插显示器 |
| 主窗口关闭到托盘、托盘完全退出 | 通过 | close 隐藏；quit 先 flush 再关 worker |
| 重复启动唤起已有窗口 | 部分 | second-instance → showMain；未做双击安装包专项 |
| 开机启动真正写 OS | 部分 | 非 e2e 调用 `setLoginItemSettings`；e2e 跳过以免污染本机 |
| 三个窗口同一已提交数据 | 通过 | 单一 worker + changed 广播 |
| 最多一件 doing / 切换一事务 / commandId 幂等 | 通过 | 既有 16 组集成 |
| renderer 不碰 DB/文件/原始 Electron | 通过 | 隔离 E2E |
| 系统设置失败 ≠ 业务失败 | 通过 | `SHORTCUT_CONFLICT` / `SYSTEM_SETTING_ERROR` |

## 4. 系统与性能

| 项 | 结果 | 样本 |
| --- | --- | --- |
| 1000 件任务 + 10 件×10 断点 | 通过 | `docs/verification/scale-results.json`；未结束计数 1000 |
| 创建 P50/P95/max | 22 / 44 / 422 ms | n=1000，Windows 11 x64 |
| 切换 P50/P95/max | 10 / 249 / 249 ms | n=20 |
| showCapture IPC P50/P95/max | 11 / 25 / 25 ms | n=20；**不是** OS 快捷键到标题可输入 |
| 热唤起 P95 ≤ 500 ms（含按键） | 未验证 | 需人工全局快捷键 |
| 安装/静默覆盖/卸载 | 通过 | 自定义目录静默安装、安装包内 E2E、覆盖安装、卸载后 exe 消失 |
| 卸载保留 userData | 部分 | NSIS `deleteAppDataOnUninstall: false`；未向正式 `%APPDATA%/PickUp` 写入 |
| 离线核心流程 | 通过 | 安装后的包内 E2E 不访问网络业务 |
| 签名信誉 | 未验证 | NotSigned |
| 真实 IME / DPI 切换 / 睡眠恢复 / 磁盘满 / SIGKILL | 未验证 | 见 VALIDATION |
