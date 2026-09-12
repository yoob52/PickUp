# PickUp IPC 契约说明

| 项目 | 内容 |
| --- | --- |
| 版本 | v1.2 |
| 日期 | 2026-09-12 |
| 状态 | 与当前代码一致；精确类型以 `src/shared/contracts.ts`、`src/shared/worker-protocol.ts` 为准。已含窗口 API 与收尾完成清单分页 |
| 适用范围 | renderer → preload → main → worker → SQLite 的业务链路 |
| 需求依据 | [PRD](PRD.md) F01—F07、[架构设计](ARCHITECTURE.md) 第 6—10 节 |

本文件描述接口语义、示例、错误和重试行为。**任何类型以代码为准**：本文件不重复维护第二份类型定义，只说明“谁可以调用、什么时候会失败、失败后怎么办”。类型、schema 与错误码集中定义在：

- `src/shared/contracts.ts`：DTO、Zod 输入 schema、结果与错误码、`PickupAPI`。
- `src/shared/worker-protocol.ts`：main → worker 的固定请求集合。
- `src/shared/task.ts`：状态、状态转换表、排序与计数辅助。
- `src/shared/local-date.ts`：本地日期区间计算。

## 1. 调用链与边界

```text
React 页面 ──window.pickup（固定方法）──▶ preload ──pickup:<method>──▶ main
   main（来源校验 + Zod 校验 + 固定 allowlist） ──requestId──▶ worker（唯一 SQLite 连接）
   worker（领域校验 + 事务 + 回执） ──提交结果/revision──▶ main
   main ──pickup:changed（revision）──▶ 所有已登记窗口
```

| 边界 | 强制规则 |
| --- | --- |
| renderer | 只能调用 `window.pickup` 上的固定方法；不能访问文件系统、SQL、任意 channel 或 Node API |
| preload | 只转发下方 allowlist；不透传 `ipcRenderer`，不承载业务规则 |
| main | 校验已登记窗口、主 frame 与允许来源；用 shared schema 校验运行时参数；不执行同步数据库操作 |
| worker | 唯一数据库访问者；在事务内校验最新状态与版本；串行处理消息 |

main 侧 allowlist 与 preload 方法一一对应，多一个或少一个都会被 `tests/ipc-contract.test.ts` 判定失败。**不存在**执行任意 SQL、读取任意文件、设置任意状态或转发任意 channel 的方法。

## 2. 通用约定

### 2.1 结果形状

```ts
type Result<T> =
  | { ok: true; value: T; revision: number }
  | { ok: false; code: AppErrorCode; message: string; retryable: boolean };
```

- `message` 是可直接展示给用户的中文说明，不含任务正文、SQL 或文件路径。
- `retryable` 表示“刷新状态或确认回执后重试同一命令是否可能成功”，不代表可以换个内容盲目重发。
- `revision` 是产生该结果时的工作区版本；写命令返回提交后的版本，查询返回读取时的一致版本。重复已提交命令返回**原**版本，不伪造新修改。

### 2.2 四种标识各司其职

| 标识 | 生命周期 | 用途 |
| --- | --- | --- |
| `commandId`（UUID） | 用户首次提交时生成，重试保持不变 | 持久化幂等；命中回执直接返回原结果 |
| `requestId` | 单次 main → worker 消息 | 关联请求与应答，应答后立即移除；不持久化 |
| `revision`（`app_state.revision`） | 每次业务写事务 +1 | 快照顺序、多窗口刷新；不用于业务冲突判断 |
| `task.version` | 受影响任务在本次命令中实际变化时 +1 | `expectedVersion` 乐观并发检查 |
| `nextUpVersion` / `draftVersion` / `preferencesVersion` | 对应字段被写入时 +1 | 高频覆盖场景的版本条件更新 |

`commandId` 相同的重试必须保持**规范化后的 payload 完全一致**（包括 `expectedVersion`）。若内容不同，即使 `commandId` 相同也会返回 `COMMAND_ID_REUSED`，这是防止把一次提交误当成另一次提交的保护，不是可重试错误。

### 2.3 事务与校验顺序

每条写命令在同一个 SQLite 事务内按固定顺序执行：

1. Zod 解析并规范化输入（标题 trim、断点三字段 trim）。
2. **先查已提交回执**：命中同 `commandId`/同命令类型/同 payload hash 时直接返回原结果。
3. 再校验任务是否存在（`NOT_FOUND`）、`expectedVersion` 是否匹配（`STATE_CONFLICT`）、状态转换是否合法（`STATE_CONFLICT`）。
4. 修改任务/断点/历史/全局引用，递增 `app_state.revision`，写回执。
5. 提交；任一步骤抛错则整笔回滚（任务、断点、历史、引用、回执一起撤销）。

因此“提交成功但响应丢失”的重试一定命中回执，不会重复追加断点或重复创建任务。

### 2.4 版本语义

- 一次命令中，每个被修改的任务 `version` 只递增一次；`updated_at` 同步刷新。
- 状态变化同时写入 `status_changed_at = now` 与 `status_revision = 本次 revision`；多处状态在同一次命令中变化时共享同一 `status_revision`。
- 编辑标题、备注或追加断点**不修改** `status_changed_at` 与 `status_revision`，因此不改变暂停/等待排序。
- 空白断点（三字段 trim 后全空）不写库、不产生变更，返回 `saved: false`。

### 2.5 通知语义

- main 只在命令结果为 `ok: true` 时广播 `pickup:changed`，事件体是 `revision`。
- 通知发送失败只记录 `channel` 与 `revision`，**不会**把已提交事务描述成保存失败。
- renderer 先订阅 `onStateChanged`，再发起首次查询；窗口重新显示时应重新读取快照以补偿漏掉的事件。
- 草稿与偏好写入不广播（业务任务状态没有变化），只通过各自的版本号协调。

### 2.6 错误码

| 错误码 | 含义 | 典型触发 | retryable |
| --- | --- | --- | --- |
| `VALIDATION_ERROR` | 输入不符合 schema | 空标题、未知字段、`limit` 越界、缺版本 | 否 |
| `NOT_FOUND` | 任务不存在 | 其他窗口已结束并重新打开后仍用旧 id | 否 |
| `STATE_CONFLICT` | 状态或版本冲突 | `expectedVersion` 过期、非法状态转换、草稿/偏好/下次开工版本过期 | 是（刷新后重试） |
| `NEED_SWITCH` | 已有其他当前任务 | `startTask` 时另一件正在进行中 | 是（走切换流程） |
| `COMMAND_ID_REUSED` | 同 ID 不同内容 | 复用了已提交的提交标识 | 否 |
| `STORAGE_ERROR` | 数据库或写入失败 | 事务中断、磁盘错误、偏好数据损坏 | 是（保留输入后重试） |
| `DB_UNAVAILABLE` | 数据库不可用 | 初始化失败、worker 已退出 | 是（重启应用） |
| `OUTCOME_UNKNOWN` | 结果待确认 | 单次请求超时、worker 应答前退出 | 是（先查回执或原样重试） |
| `SHORTCUT_CONFLICT` | 系统快捷键注册失败 | 由 main/桌面集成产生 | 否 |
| `SYSTEM_SETTING_ERROR` | 系统设置应用失败 | 由 main/桌面集成产生 | 是 |

后两个错误码当前不由 worker 产生，保留给 main 协调系统设置时使用（见第 12 节）。

## 3. 方法与 channel

所有方法返回 `Promise<Result<...>>`。`广播` 列表示成功后会发出 `pickup:changed`。

### 3.1 查询

| 方法 | channel | 输入 | 结果 | 广播 |
| --- | --- | --- | --- | --- |
| `getWorkspaceSnapshot()` | `pickup:getWorkspaceSnapshot` | 无 | `WorkspaceSnapshot` | 否 |
| `listTasks(input)` | `pickup:listTasks` | `{ statuses, offset?, limit? }` | `Page<TaskSummary>` | 否 |
| `getTaskDetail(input)` | `pickup:getTaskDetail` | `{ taskId, breakpointOffset?, breakpointLimit?, transitionOffset?, transitionLimit? }` | `TaskDetail` | 否 |
| `getDailyReview(input?)` | `pickup:getDailyReview` | `{ completedOffset?, completedLimit? }`，不能传日期 | `DailyReview` | 否 |
| `getCommandResult(input)` | `pickup:getCommandResult` | `{ commandId }` | `CommandOutcome` | 否 |

### 3.2 写命令

| 方法 | channel | 输入要点 | 结果 `value.type` | 广播 |
| --- | --- | --- | --- | --- |
| `createTask` | `pickup:createTask` | `commandId, title, note, draftVersion?` | `createTask` | 是 |
| `updateTask` | `pickup:updateTask` | `commandId, taskId, expectedVersion, title, note?` | `updateTask` | 是 |
| `startTask` | `pickup:startTask` | `commandId, task{taskId, expectedVersion}` | `startTask` | 是 |
| `switchTask` | `pickup:switchTask` | `commandId, from, to, breakpoint?` | `switchTask` | 是 |
| `pauseTask` | `pickup:pauseTask` | `commandId, task, breakpoint?` | `pauseTask` | 是 |
| `markWaiting` | `pickup:markWaiting` | `commandId, task, reason` | `markWaiting` | 是 |
| `resolveWaiting` | `pickup:resolveWaiting` | `commandId, task` | `resolveWaiting` | 是 |
| `completeTask` | `pickup:completeTask` | `commandId, task` | `completeTask` | 是 |
| `cancelTask` | `pickup:cancelTask` | `commandId, task` | `cancelTask` | 是 |
| `reopenTask` | `pickup:reopenTask` | `commandId, task` | `reopenTask` | 是 |
| `saveBreakpoint` | `pickup:saveBreakpoint` | `commandId, task, breakpoint` | `saveBreakpoint` | 是 |
| `setNextUp` | `pickup:setNextUp` | `commandId, taskId\|null, expectedNextUpVersion` | `setNextUp` | 是 |
| `finishDailyReview` | `pickup:finishDailyReview` | `commandId, outcome, currentTask\|null, breakpoint?` | `finishDailyReview` | 是 |
| `saveDraft` | `pickup:saveDraft` | `title, note, expectedDraftVersion` | `saveDraft` | 否 |
| `clearDraft` | `pickup:clearDraft` | `expectedDraftVersion` | `clearDraft` | 否 |
| `updatePreference` | `pickup:updatePreference` | `patch, expectedVersion` | `updatePreference` | 否 |

### 3.3 直接返回状态的方法

| 方法 | channel | 结果 |
| --- | --- | --- |
| `getDraft()` | `pickup:getDraft` | `Draft`（`{ title, note, version }`） |
| `getPreferences()` | `pickup:getPreferences` | `PreferenceState`（`{ values, version }`） |
| `onStateChanged(listener)` | 事件 `pickup:changed` | 返回取消订阅函数 |
| `showMain()` | `pickup:showMain` | `{ type: "window", action: "showMain" }` |
| `showCapture()` | `pickup:showCapture` | 显示唯一记录窗口并聚焦标题 |
| `hideCapture()` | `pickup:hideCapture` | 隐藏记录窗口，尽量把焦点交还系统 |
| `hideWidget()` | `pickup:hideWidget` | 隐藏入口并写入 `widgetEnabled: false` |
| `quit()` | `pickup:quit` | 先 flush 草稿再关 worker；失败则留下记录窗口 |
| `getDesktopState()` | `pickup:getDesktopState` | 快捷键是否注册、登录项是否与偏好一致 |
| `onDayInvalidated` | 事件 `pickup:day-invalidated` | 系统恢复等，收尾页重算日期 |
| `onCaptureShown` | 事件 `pickup:capture-shown` | 焦点回到标题 |
| `onPrepareClose` | 事件 `pickup:prepare-close` | handler 返回是否已落盘草稿 |

## 4. 命令语义

### 4.1 createTask

- 只创建 `todo`，**不改变**当前任务；同名标题允许重复存在。
- 标题首尾空白被移除后必须非空；备注保留原文（包括换行与前后空白）。
- `draftVersion` 提供时，若与当前草稿版本一致，则同事务清空草稿并递增 `draftVersion`，返回值 `draftCleared` 为 `true`；版本不一致时**不清空**新输入，`draftCleared` 为 `false`（这不是错误）。

```ts
const result = await window.pickup.createTask({
  commandId: crypto.randomUUID(),
  title: "  查询昨日订单数据  ",
  note: "先看近 7 天",
  draftVersion: 3,
});
// ok: true → { type: "createTask", taskId, draftCleared: true }
```

### 4.2 updateTask

- 只修改 `title` / `note`，不修改状态、状态进入时间与排序。
- 省略 `note` 表示不修改备注；传空字符串表示清空备注。
- 已结束（`done`/`cancelled`）任务返回 `STATE_CONFLICT`，需先 `reopenTask`。
- 内容没有实际变化时返回 `changed: false`，不递增 `revision`，但同样写入回执以保证幂等。

### 4.3 startTask

| 前置 | 行为 |
| --- | --- |
| 目标任务已是 `doing` | 成功返回 `started: false`，不产生重复开始、不追加历史 |
| 目标任务状态为 `done`/`cancelled` | `STATE_CONFLICT`（提示先重新打开） |
| 已有其他任务 `doing` | `NEED_SWITCH`，**不修改任何任务**；renderer 应进入切换流程 |
| 无当前任务且目标为 `todo`/`paused`/`waiting` | 目标变为 `doing`，`started: true` |

### 4.4 switchTask

- `from` 必须是当前 `doing` 任务，`to` 必须是 `todo`/`paused`/`waiting`；`from.taskId === to.taskId` 时返回 `switched: false`（自我切换不暂停、不重复开始、不写断点）。
- 一次事务内提交：可选断点 → 原任务 `paused` → 目标任务 `doing` → 两条状态历史 → 全局 `revision` → 回执。
- `from` 已不是当前任务、`to` 已结束、任一 `expectedVersion` 过期都返回 `STATE_CONFLICT`，且整笔回滚，不会出现两件 `doing`。
- 数据层还有条件唯一索引 `ux_one_doing` 作为第二层保障。

```ts
const result = await window.pickup.switchTask({
  commandId: crypto.randomUUID(),
  from: { taskId: taskA.id, expectedVersion: taskA.version },
  to: { taskId: taskB.id, expectedVersion: taskB.version },
  breakpoint: {
    progress: "已排除数据库慢查询",
    nextStep: "检查下游重试配置",
    referenceText: "日志 #12",
  },
});
// ok: true → { type: "switchTask", fromTaskId, toTaskId, breakpointSeq: 12, switched: true }
```

### 4.5 pauseTask

- 只接受当前 `doing` 任务；其他状态返回 `STATE_CONFLICT`。
- 断点可选；跳过断点时原有断点保持不变。
- 不要求选择下一件任务（“暂不开始”表现为不再调用其他命令）。

### 4.6 markWaiting / resolveWaiting

- `markWaiting`：`todo`/`doing`/`paused`/`waiting` 均可标记等待；`reason` 选填。原本是当前任务时，状态变化自然释放当前位。
- 已处于 `waiting` 时再次标记：`reason` 相同返回 `reasonUpdated: false` 且不递增 `revision`；不同则更新等待原因（只递增任务 `version`，不改变 `status_changed_at`/`status_revision`）。
- `resolveWaiting`：**仅接受 `waiting`** 作为来源状态 → `todo`，保留断点与等待原因。需要立即继续时由 renderer 再调用 `startTask`；若此时已有其他当前任务会得到 `NEED_SWITCH`。
- 其他来源状态（`todo`/`doing`/`paused`/`done`/`cancelled`）在**领域校验阶段**返回 `STATE_CONFLICT`：不依赖数据库 `CHECK` 约束报错，也不会把 `done`/`cancelled` 误当作“重新打开”。

### 4.7 completeTask / cancelTask / reopenTask

- `completeTask`：任意未结束状态 → `done`，写 `ended_at`；返回 `wasCurrent`（是否结束了当前任务）与 `nextUpCleared`（是否清除了命中的下次开工引用）。
- `cancelTask`：同上 → `cancelled`，与完成分开统计，不计入“今天完成”。
- 已结束任务再次结束返回 `STATE_CONFLICT`。
- `reopenTask`：**仅接受 `done`/`cancelled`** 作为来源状态 → `todo`，清空有效 `ended_at`，保留断点与状态历史，**不抢占**当前任务；未结束状态（`todo`/`doing`/`paused`/`waiting`）在领域校验阶段返回 `STATE_CONFLICT`。共享转换表中的 `waiting → todo`（条件满足回到待处理）只能由 `resolveWaiting` 使用。

### 4.8 saveBreakpoint

- 三字段全部 trim 后为空 → `{ saved: false, breakpointSeq: null }`，不写库、不覆盖历史、不递增 `revision`。
- 有内容时追加一条断点记录（保留历史），递增任务 `version` 与全局 `revision`。
- 已结束任务返回 `STATE_CONFLICT`（收尾补断点请使用暂停或 `finishDailyReview`）。

### 4.9 setNextUp

- `taskId: null` 表示清空；`expectedNextUpVersion` 必须与当前 `nextUpVersion` 一致，否则 `STATE_CONFLICT`。
- 目标必须是未结束任务；已结束返回 `STATE_CONFLICT`。
- 只保存全局引用，**不开始**任务；与当前一致时返回 `changed: false` 且不递增版本。

### 4.10 finishDailyReview

| `outcome` | 行为 |
| --- | --- |
| `keep` | 保留当前状态；不修改任何任务。若 `currentTask` 与实际当前任务不一致（收尾期间发生变化）返回 `STATE_CONFLICT` |
| `pause` | 有当前任务时：校验 `currentTask` 版本 → 可选断点 → 当前任务转 `paused`（复用暂停语义，一次事务）。仅在**收尾时与实际提交时都没有当前任务**时无操作成功并返回 `pausedTaskId: null`（此时请求中的 `breakpoint` 无处可写，被忽略） |

`pause` 分支的当前任务校验（`src/worker/commands.ts` 的 `finishDailyReviewTx`）：

- `currentTask` 非 `null` 而实际已没有当前任务（该任务已被其他调用暂停、完成、标记等待或切换到别的任务）：返回 `STATE_CONFLICT`，不写断点、不写状态历史、不递增 `revision`、不写成功回执，整笔回滚。
- `currentTask` 为 `null` 而实际存在当前任务：同样返回 `STATE_CONFLICT`。
- 只有收尾时与实际提交时都没有当前任务，才允许无操作成功；该成功结果同样写回执，重复提交返回原结果。
- **已提交回执优先于当前状态/版本校验**：同一 `commandId` 与同一规范化 payload 的重试命中回执即返回原结果，不受提交之后状态变化影响，成功命令的幂等重试不会被破坏。

收尾页面内的编辑、完成、取消、补断点都复用上面的命令，不存在批量隐式修改，也不创建每日任务副本。

### 4.11 草稿

- `saveDraft` / `clearDraft` 使用 `expectedDraftVersion` 做版本条件更新；版本过期返回 `STATE_CONFLICT`（其他窗口或本窗口更新过草稿）。
- 内容未变化时不递增 `draftVersion`，也不写回执（高频覆盖场景不逐键写命令回执）。
- 建议 renderer 去抖约 300 ms 写入，并在关闭输入框前 flush；写入失败时保留输入。

### 4.12 偏好

- `getPreferences` 返回 `{ values, version }`；`values` 是“默认值 + 已保存字段”的合并结果，未知字段被忽略。
- `updatePreference` 按字段合并，`patch` 至少包含一个字段且必须是已知字段；值未变化时不递增版本。
- 偏好写入**不**递增工作区 `revision`（任务状态未变化），因此不会触发其他窗口的业务刷新。

## 5. 查询语义

### 5.1 getWorkspaceSnapshot

一次一致读取内计算：

| 字段 | 内容 |
| --- | --- |
| `revision` | 当前工作区版本 |
| `currentTask` | `status = 'doing'` 的任务；没有则为 `null`（不保留“上一次当前任务”） |
| `counts` | 六种状态计数 + `unfinished`（todo+doing+paused+waiting） |
| `unfinished` | 全部未结束任务，按第 5.4 节排序规则稳定排列（不含断点正文，只含最新断点摘要） |
| `resume` | 最近进入 `paused` 的任务及其暂停时间；`waiting` 不参与默认推荐 |
| `nextUp` / `nextUpVersion` | 下次开工引用；引用已失效（指向已结束任务）时返回 `null`，不做隐式修复 |

已结束明细请用 `listTasks` 分页查询，避免快照携带全部历史。

### 5.2 listTasks

- `statuses` 至少一个；`offset` 默认 0，`limit` 默认 50、上限 100。
- 返回 `{ items, total, offset, limit, hasMore }`；同一查询重复执行结果一致。

### 5.3 getTaskDetail

- 返回任务摘要 + 最新断点 + 断点历史（`seq DESC`，最新在前）+ 状态历史（`seq DESC`，最新在前），两者独立分页并各自带 `total`/`hasMore`。
- 任务不存在返回 `NOT_FOUND`。

### 5.4 排序规则

| 分组 | 排序键 |
| --- | --- |
| `todo` | `created_at ASC`, `id ASC` |
| `doing` / `paused` / `waiting` | `status_changed_at DESC`, `status_revision DESC`, `id ASC` |
| `done` / `cancelled` | `ended_at DESC`, `status_revision DESC`, `id ASC` |

混合状态查询（如 `done` + `cancelled`）使用同一表达式求值：第一键为 `todo` 取 `created_at`、其他状态取 `-COALESCE(ended_at, status_changed_at)`，第二键对非 `todo` 取 `status_revision DESC`。因此 `done`+`cancelled` 组合的分页顺序仍是“结束时间从近到远”，而把语义不同的分组（如 `todo` 与 `paused`）混在一次查询里只会得到一个确定但无业务含义的交错顺序——需要分组展示时请按状态分别查询。

### 5.5 getDailyReview

- `getDailyReview(input?)` **不能指定日期**：本地日期边界仍由 main 计算。renderer 只能传当天完成清单的 `completedOffset` / `completedLimit`（默认 0/50，上限 100）。
- 返回 `{ dayKey, startUtc, endUtc, currentTask, completedToday, unfinished, counts, nextUp, nextUpVersion }`。
- 本地日历日与本地零点交给平台原生的本地时区能力解释，不按固定 24 小时相加，也不自行迭代推断时区偏移：本地零点不存在（时钟前跳）时当天从跳变后的第一个时刻开始；本地零点出现两次（时钟回拨）时取较早的实例。因此当天区间长度可能是 23、24 或 25 小时（夏令时当天），区间始终覆盖该本地日的全部时刻。
- 区间为左闭右开：`ended_at === startUtc` 计入当天，`ended_at === endUtc` 属于次日；相邻本地日的区间首尾相接，不重叠也不留空隙。
- `completedToday` 只统计“当前仍为 `done` 且 `ended_at` 落在区间内”的任务：取消不计入，重新打开后自动移出；分页字段 `offset`/`limit`/`total`/`hasMore`。
- `unfinished` 覆盖全部跨日遗留事项（含暂停与等待），`currentTask` 单独突出显示。
- 查询本身不修改任何任务状态；设备日期或时区变化不改变任务状态。

```ts
const review = await window.pickup.getDailyReview();
// review.value.dayKey === "2026-09-11"
// review.value.completedToday.items  → 今天完成且仍未重新打开的任务
// review.value.unfinished            → 全部暂停/等待/待处理/进行中
```

### 5.6 getCommandResult

结果不确定时（`OUTCOME_UNKNOWN`）用它确认已提交命令：

```ts
const outcome = await window.pickup.getCommandResult({ commandId });
// { status: "committed", commandType, committedAt, revision, value } | { status: "unknown" }
```

`status: "unknown"` 只说明没有该命令的回执，不代表一定失败——应先确认数据库可用，再用**原样的 `commandId` 与 payload** 重试。

## 6. 状态转换与非法转换

状态转换表的唯一来源是 `src/shared/task.ts` 的 `TASK_TRANSITIONS`，worker 在事务内据此校验；数据库 `CHECK` 约束与 `ux_one_doing` 唯一索引是第二层保障。

| 当前状态 | 允许到达 |
| --- | --- |
| `todo` | `doing`（开始）、`waiting`、`done`、`cancelled` |
| `doing` | `paused`（暂停/切换）、`waiting`、`done`、`cancelled` |
| `paused` | `doing`（开始）、`waiting`、`done`、`cancelled` |
| `waiting` | `todo`（条件满足）、`doing`、`done`、`cancelled` |
| `done` | `todo`（重新打开） |
| `cancelled` | `todo`（重新打开） |

不在表中的转换返回 `STATE_CONFLICT`，界面应刷新后展示最新状态，而不是重试同一命令。`paused → todo` 不被允许：暂停任务通过 `startTask` 继续。创建、查看、编辑、选择下次开工都不自动开始任务。

各命令还有**来源状态前置条件**，严于上表：`reopenTask` 只接受 `done`/`cancelled`，`resolveWaiting` 只接受 `waiting`。通用转换表不能替代命令来源校验（例如 `waiting → todo` 只能由 `resolveWaiting` 使用），非法来源同样在领域校验阶段返回 `STATE_CONFLICT`，并且不产生任务、历史、`revision` 或回执副作用。

## 7. 失败与重试流程

| 场景 | 处理方式 |
| --- | --- |
| 校验失败（`VALIDATION_ERROR`） | 在输入处提示，修正后可用**新的** `commandId` 提交 |
| 版本/状态冲突（`STATE_CONFLICT`） | 重新读取快照或详情，保留用户输入，用最新 `expectedVersion` 重新提交 |
| 需要切换（`NEED_SWITCH`） | 展示原任务及其断点，走 `switchTask`（或“暂不开始”）。不要换 `commandId` 重试 `startTask` |
| 提交标识复用（`COMMAND_ID_REUSED`） | 这是新内容误用了旧标识，生成新的 `commandId` 重新提交 |
| 保存失败（`STORAGE_ERROR`） | 保留输入，明确告知未保存；可直接用原 `commandId`/原 payload 重试 |
| 结果待确认（`OUTCOME_UNKNOWN`） | 先用 `getCommandResult(commandId)` 查回执：有回执按成功处理；无回执且数据库已恢复时用原请求重试 |
| 数据库不可用（`DB_UNAVAILABLE`） | 展示恢复错误页与真实原因；不要用空状态或示例数据替代 |

**超时不代表回滚**：`OUTCOME_UNKNOWN` 是“可能已提交”，必须以回执为准。任何重试都不得改变 `commandId` 或 payload 内容。

```ts
async function submitWithRetry(commandId: string, payload: SwitchTaskInput) {
  const result = await window.pickup.switchTask(payload);
  if (result.ok) return result;
  if (result.code === "OUTCOME_UNKNOWN") {
    const outcome = await window.pickup.getCommandResult({ commandId });
    if (outcome.ok && outcome.value.status === "committed")
      return { ok: true as const, value: outcome.value.value };
    if (result.retryable) return window.pickup.switchTask(payload); // 同一 commandId、同一 payload
  }
  return result;
}
```

## 8. worker 生命周期与诊断

| 情况 | 行为 |
| --- | --- |
| 初始化成功 | 发送 `{ ready: true, sqliteVersion, schemaVersion, backupPath }`；`backupPath` 仅在本次启动执行了迁移时非空 |
| 初始化失败 | 发送 `{ fatal: true, code: "DB_UNAVAILABLE", message }` 后关闭端口；`message` 来自 `src/worker/errors.ts` 的 `describeBootFailure`，区分“较新 schema / 迁移失败 / 一致性检查失败 / 连接不可用” |
| ready 之前退出（无 `fatal`/`error` 事件） | 初始化 Promise 明确失败（`ready` 进入 rejected），`failure` 为 `DB_UNAVAILABLE`；已在等待 `ready` 的 `send()` 返回可处理错误而不是永久挂起；后续请求同样返回 `DB_UNAVAILABLE`，不自动无限重启或轮询 |
| 单次请求超时（默认 10 s） | 该请求返回 `OUTCOME_UNKNOWN`，worker 继续可用；迟到应答被丢弃 |
| worker 就绪后异常退出 | 未完成请求返回 `OUTCOME_UNKNOWN`；后续请求返回 `DB_UNAVAILABLE`（不自动无限重启） |
| 正常退出 | main 发送 `{ kind: "close" }`，等待已接收命令完成并关闭连接；worker 未在 5 s 内退出时终止线程，避免阻塞退出。启动阶段被关闭时同样结束未结算的初始化等待 |
| 未知请求类型 | 返回 `VALIDATION_ERROR`，不抛异常、不静默丢弃 |

日志只记录命令类别、错误码、`channel`、`revision` 等元信息，不记录任务正文、断点正文或完整请求内容。

## 9. 数据可靠性与迁移

- 业务库位于 `userData/data/pickup.sqlite`；升级前的保护副本位于同级 `backups/` 目录，使用 SQLite `VACUUM INTO` 生成一致副本（不是复制正在写入的文件），校验可读且版本一致后才执行迁移，轮换只保留最近 2 份。
- 版本处理：新库（`user_version = 0` 且无表）直接初始化；已有库执行待应用的迁移；`user_version` 高于应用支持范围时停止写入；`user_version = 0` 但已有数据表时停止初始化（避免把错误数据库当成新库）；迁移失败回滚并保留原库与副本。
- 任何失败路径都**不**创建空库、不写入示例数据、不删除原文件。

## 10. 长度与规模限制（工程值，非产品硬上限）

| 字段 | 限制 |
| --- | --- |
| 标题 | 300 字符（trim 后非空） |
| 备注 | 10 000 字符 |
| 断点单字段（进展/下一步/参考） | 2 000 字符 |
| 等待原因 | 1 000 字符 |
| 列表分页 `limit` | 1—100，默认 50 |
| 详情历史分页 | 断点 1—50（默认 10），状态历史 1—50（默认 20） |
| 收尾当天完成列表 | 每页 1—100，默认 50；用 offset 继续取 |

## 11. 前端接入清单

1. 启动时先 `onStateChanged` 订阅，再 `getWorkspaceSnapshot()`；组件卸载时取消订阅。
2. 用 `<TaskRef>`（`taskId` + `expectedVersion`）提交编辑、开始、暂停、完成、取消、重新打开、保存断点，避免覆盖其他窗口的新状态。
3. 保存按钮在提交期间禁用并复用同一个 `commandId`；失败时保留输入，成功后才清空。
4. `NEED_SWITCH` 是流程信号，不是错误文案：进入切换界面并展示原任务断点。
5. 只有拿到 `ok: true` 才展示成功；`OUTCOME_UNKNOWN` 走第 7 节流程。
6. 状态文案与计数直接使用 `TASK_STATUS_LABEL` 与 `counts`，不要在前端另写一套状态推断。
7. 列表按状态分别分页查询；已结束用 `statuses: ["done", "cancelled"]`。

## 12. 桌面集成接入清单

桌面集成（托盘、快捷键、开机启动、窗口布局）所需的偏好接口已经就绪：

- 读取：`getPreferences()` → `{ values: { widgetEnabled, widgetPinned, widgetCollapsed, widgetBounds, launchAtLogin, accelerator }, version }`。
- 写入：`updatePreference({ patch, expectedVersion })`，按字段合并；成功后用返回的 `values`/`version` 更新本地视图。

OS 状态与数据库偏好的协调边界（由 main 负责，不在 worker 内）：

1. 数据库是“用户期望值”的唯一来源；`launchAtLogin` 等系统设置由 main 调用 Electron API 应用。
2. 顺序为“读取实际系统状态 → 应用目标设置 → 保存偏好 → 失败时尝试恢复原设置”。系统设置与数据库不是同一事务。
3. 应用或回滚失败时展示真实状态与 `SYSTEM_SETTING_ERROR`，不伪造成功；下次启动重新读回系统状态进行协调。
4. 快捷键冲突使用 `SHORTCUT_CONFLICT`；注册失败时保留原可用快捷键与主窗口入口。
5. 窗口位置写入使用 `updatePreference({ patch: { widgetBounds } })`，由桌面侧去抖，避免高频写库。

窗口方法由 main 实现：`showMain` / `showCapture` / `hideCapture` / `hideWidget` / `quit` / `getDesktopState`。不接受任意窗口脚本或文件路径。`PICKUP_E2E=1` 时不写入系统登录项。`quit` 先让 capture 落盘草稿，失败则重新显示记录窗口。
