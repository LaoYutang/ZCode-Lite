# 辅助对话（selection side chat）

## 背景

从会话时间线、文件预览或计划 tab 选中文字后，`SelectionActionMenu` 的「在辅助对话中提问」会在侧栏创建独立会话（`SelectionSideChatPane`）：`createSelectionSideSession` 命令在父会话的稳定落盘边界上 fork 出一份 child 会话（`packages/core` 的 `createSelectionSideConversation`），选区引用随后写进 child 的输入区。

2026-09-23 实测暴露一个缺陷：计划待确认时从计划 tab 提问，辅助对话不回答提问，而是继续产出并提交计划（`EnterPlanMode` → `ExitPlanMode`）。根因是 fork 同时带进了父会话本轮的「去做计划」指令与父会话的计划模式。本 spec 收敛辅助对话的创建语义。

## 规则

### 一、历史边界：只复制到上一轮结束

- fork 只复制父会话**已完成**的消息。父会话正在进行的本轮（active turn）整轮不复制：本轮 real-user input 与其后的 assistant/tool 增量都不进子会话。
- 父会话空闲（无 active turn）时复制全部已完成历史；**结尾没有 assistant 回应的 user 消息不算已完成**，连同其后内容一并丢弃。两种常见来源：指令刚发出、回复还没落盘；应用重启丢掉了下半轮。
- 已完整结束的最后一轮仍会复制（含父会话最近一条指令与它的 assistant 回复）：这条取舍保留了「基于上一轮对话提问」的能力。计划类上下文由引用携带（见 `specs/selection-comment` 第八节的 `plan` 快照），因此即使最后一轮不进历史，辅助对话也不会缺失正在讨论的文档。
- 依据：本轮用户输入通常是「让父会话去做某事」的指令（例如「进入计划模式并提交计划」）。带进子会话后，子会话会把它当成自己的任务，于是辅助对话变成父任务的续写。
- 既有边界不变：复制时去掉 goal boundary，goal / queue / 权限 grant / verifier entry 都不复制。

### 二、执行状态：不继承计划模式

- 子会话的 `mode`（权限模式）保持父会话当前值，`planEnabled` 强制为 `false`。
- 依据：辅助对话是问答用途，不接手父会话的计划流程。父会话处于计划模式（计划待确认是最常见形态）时，继承 `planEnabled = true` 会让子会话进入计划流程并尝试提交计划。
- 子会话里计划工具不再被继承状态激活；子会话内部自己 `EnterPlanMode` 仍然可用（用户明确要求时）。

### 三、边界提示（既有，保留）

- fork 之后注入一条 synthetic 提示：继承来的历史仅供参考、不要自动继续父任务、只回答本会话的新问题、除非用户明确要求否则不修改工作区。
- 这条提示是兜底，不替代第一、二条：实测中模型会读到它，但仍可能被父会话指令带走。

### 四、命令与写入边界（既有）

- 子会话禁止执行 `sendGoalCommand` / `pauseGoal` / `resumeGoal` / `editUserQuery` / `retryTurn` / `forkAssistant` / `discardSharedContext`。
- 选区引用写入子会话自己的 scope（`targetSessionId = childSessionId`），不进父会话 composer，因此不影响父会话的待发引用与计划确认答复。

### 五、UI 投影：继承历史不产出任何行

- fork 复制进子会话的消息只作模型上下文，判据是三个事实同时成立：`metadata.forkOrigin`、`visibility: model-only`、`semantics.uiVisibility` 与 `transcriptVisibility` 均为 `hidden`。这类消息由 `getConversationMessageProjectionPolicy` 判为 `inheritedHistoryOnly`，hydration 整条跳过，不合成任何事件。
- 覆盖四类衍生行，它们都不是从消息本身画的，而是从 part / turn 事实派生：压缩分隔线（`compaction` 与 `timeline.context_compaction` part）、goal 校验线、模型切换线、后台结果标题行（`background_task` 唤醒轮的 `turnHeader.originMeta.title`）。
- 依据：2026-09-29 实测（父会话「通知返回渲染问题」的副屏「辅助对话 1」）：副屏显示「上下文已压缩」分隔线和两条父会话后台命令标题（`Read getAppConfigDir implementation`、`Watch for the dev notification click`）。落盘证据：子会话 compact part 与父会话 `operationId` 相同（`cmp_8bb20904-…`），是复制来的事实而非子会话自己压缩；它的宿主 assistant 消息 `semantics.kind = timeline_event`，旧 policy 在可见性分支之前就返回 `timelineOnly`，于是 hydration 既没跳过宿主，还把 compact 事实合成了分隔线；后台唤醒载体保留 `source = background_task`，旧 policy 虽判 `providerContextOnly`，仍算 model-only 唤醒触发，而投影只对 `userInput` 行做可见性门控，带 `originMeta` 的 `turnHeader` 行是无条件追加的。
- 只隐藏消息不够：可见性门控挡住了用户气泡，挡不住从 part / turn 事实派生的行，所以判据必须落在投影 policy 上。
- 不删复制过来的压缩事实：compact boundary 决定子会话模型从哪开始读 provider context，删掉会改变模型语义；收口只在 UI 投影层。
- 普通会话不受影响：判据要求 `metadata.forkOrigin` 同时成立。legacy / stable fork 复制来的可见历史不满足 UI 双隐藏，照常渲染。

## 唯一所有者

| 事实                     | 所有者                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------- |
| fork 历史边界            | `apps/zcode-cli/packages/core` 的 `selectionSideChatHistoryMessages`（纯函数）          |
| 子会话执行状态           | 同上模块的 `resolveSelectionSideChatExecutionState`（纯函数）                           |
| 边界提示文案             | 同上包的 `SELECTION_SIDE_CHAT_BOUNDARY`（`session-fork.ts`）                            |
| 子会话命令白名单         | `apps/zcode-cli/packages/bootstrap` 的 `SELECTION_SIDE_CHAT_RESTRICTED_COMMANDS`        |
| 选区引用落点             | `packages/ui` 的 `SessionPane`（写 `childSessionId` scope）                             |
| 选区入口的父会话阻塞判定 | `packages/ui/src/lib/planApproval.ts`（见 `specs/selection-comment` 第十节）            |
| 继承历史的 UI 投影       | `packages/shared` 的 `getConversationMessageProjectionPolicy`（`inheritedHistoryOnly`） |

## 失败语义

| 情况                             | 表现                                                   |
| -------------------------------- | ------------------------------------------------------ |
| 父会话第一轮进行中就创建辅助对话 | 历史为空，只有边界提示；子会话不承担父会话本轮任务     |
| 父会话空闲时创建                 | 复制完整对话历史，子会话可基于历史回答                 |
| 父会话处于计划模式时创建         | 子会话 `planEnabled=false`，不进入计划流程             |
| 子会话里模型仍尝试继续父任务     | 只受边界提示约束，不再有父指令与计划模式叠加放大该倾向 |
| 父会话已压缩时创建               | 副屏不出现压缩分隔线，仍继承压缩摘要与压缩后的历史     |
| 父会话有后台任务唤醒轮时创建     | 副屏不出现后台任务标题行                               |

## 非目标

- 不改「评论」路径与计划确认流程（见 `specs/selection-comment`）。
- 不新增会话类型、不新增持久化格式、不改协议字段。
- 不改桌面/移动/远程的创建入口差异：三者共用同一 fork 实现。

## 验收场景

1. 计划待确认时从计划 tab 提问：辅助对话直接回答提问，不再调用 `EnterPlanMode` / `ExitPlanMode`，不产出新计划。
2. 子会话的 `runtime/execution_state` 为 `{ mode: <父 mode>, planEnabled: false }`。
3. 父会话正在生成时创建：子会话历史不含本轮任何消息。
4. 父会话空闲时创建：历史到最后一轮 assistant 为止，子会话能基于历史回答。
5. 回归：goal / queue 不复制；子会话命令白名单不变；引用仍写入子会话 scope。
6. 父会话已压缩、且含后台任务唤醒轮时创建：副屏首屏为空（只有边界提示），不出现「上下文已压缩」、goal 校验线、模型切换线或后台任务标题行。
7. 回归：普通会话（含 legacy / stable fork 的可见继承历史）的压缩分隔线、模型切换线与后台结果标题行照常渲染。

## 测试

- 纯函数（`resolveSelectionSideChatExecutionState`、`selectionSideChatHistoryMessages`）跑在 dist 产物上：`apps/zcode-cli/packages/core/test/*.test.mjs`，与 `packages/adapters` 的 `node --test test/*.test.mjs` 约定一致（先 `tsc` 再跑）。
- 投影判据（`getConversationMessageProjectionPolicy`、`getConversationModelOnlyTurnTriggerSource`）跑在源码上：`packages/shared/test/conversationMessageProjectionPolicy.test.mjs`（`tsx --test`）。
- 真实 fork 表现与交互按验收场景 1–7 在 `pnpm dev:desktop` 下人工核对：辅助对话的回答内容、`runtime/execution_state` 记录、副屏首屏内容、以及计划 tab / 会话 / 预览三个入口。
- 必须执行 `pnpm typecheck`、`pnpm lint`、`pnpm fmt:check`、`pnpm architecture:check --changed`，并如实报告结果。
