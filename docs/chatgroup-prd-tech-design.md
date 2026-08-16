# chat-group 插件：需求与技术方案 v0.1

> 状态：M1–M9 及增量需求已实现。
> 增量需求详见：`需求增量记录-v0.2.0.md`
> 日期：2026-08-15
> 项目：dsh-plugin-chatgroup
> 依赖：deepseek-harness（不修改源码）

---

## 1. 已确认决策

| 编号 | 主题 | 决策 |
|---|---|---|
| D1 | 成员 | V1：1 个人类 + 最多 5 个 AI；人类为管理员，AI 为普通成员 |
| D2 | AI 能力 | AI 成员可只读探索项目文件，不可写入、不可委托子 Agent |
| D3 | 群范围 | 属于当前 dsh 会话；不跨会话；V1 一个会话只允许 1 个群 |
| D4 | 轮次 | 用户发言 → AI 按管理员设定顺序依次发言 → 全部发完为一轮；用户可中途插话，后续 AI 继续按顺序发言 |
| D5 | 结束 | Web UI 提供“结束”按钮；同时保留 `/group stop` 命令 |
| D6 | 盲发 | 仅群创建后的第一轮盲发；用户始终可见全部消息；记录完整、注入时裁剪 |
| D7 | @ | 用户 @ 某 AI 时，仅该 AI 单独回应一次，其他 AI 不参与 |
| D8 | 超时 | 单次 AI 发言超时默认 300 秒，可配置；不限 maxTokens |
| D9 | UI | 直接做 Web UI，独立群聊面板/抽屉 |
| D10 | 持久化 | M1 先内存态；M5 起使用项目内 `.dsh/chatgroup/<sessionId>.jsonl`，重启自动恢复，仍不写自定义 session 事件 |

---

## 2. 范围

### 2.1 V1 范围内

- 创建 / 解散群。
- 添加 / 移除 AI 成员（最多 5 个）。
- 为每个 AI 配置：显示名、provider、model、systemPrompt（可选）、单次发言超时。
- 管理员设定 AI 发言顺序。
- 用户发消息自动开启一轮；AI 依次发言。
- 用户插话；本轮剩余 AI 继续发言。
- 结束按钮 / `/group stop`。
- 第一轮盲发。
- 用户 @ 单个 AI，单独追加一次回应。
- @ 功能开关（管理员）。
- 独立 Web 群聊面板：消息流、成员列表、输入框、@ 选择、设置、结束按钮、状态提示。
- M5：群状态写入项目内 `.dsh/chatgroup/<sessionId>.jsonl`，dsh 重启后自动恢复。

### 2.2 V1 明确不做

- 多个群同时存在。
- 多人类用户、多人管理员。
- AI 成员当管理员。
- 跨会话恢复群聊。
- 群消息 token 级流式上屏（V1 完成整条上屏，V2 再做流式）。
- 写入 / 终端 / 代码执行等非只读工具。
- AI 主动发言或 AI 之间互相 @。
- 消息编辑、删除、撤回、表情、附件、图片。
- 移动端或 TUI。

---

## 3. 术语

| 术语 | 定义 |
|---|---|
| 群 | 当前 dsh 会话内一个逻辑聊天室：1 个人类 + 0~5 个 AI |
| 轮（round） | 从用户一条“普通发言”开始，到所有应发言 AI 依次发言结束 |
| 插话 | 一轮进行中用户再次发言；不改变发言顺序，不开始新轮 |
| 盲发 | 第一轮中 AI 看不到其他 AI 的第一轮回复 |
| 可见视图 | 给某 AI 构造 prompt 时，按可见性规则从完整消息记录中裁剪出的消息集合 |
| 单次发言 | 一个 AI 成员执行一次 one-shot 子 Agent，产出最终群消息 |
| 当前发言人 | 正在执行子 Agent 的 AI 成员 |

---

## 4. 功能需求

### FR-1 群生命周期

- FR-1.1 一个会话最多一个群。
- FR-1.2 管理员可创建群；群创建后状态为 `idle`，轮数为 0。
- FR-1.3 管理员可解散群；解散时立即取消当前 AI 发言，释放子 Agent。
- FR-1.4 当前 dsh 会话关闭或 Host 进程退出时，群状态直接丢弃，不产生会话日志污染。

### FR-2 成员管理

- FR-2.1 群成员 = 1 个人类（admin）+ N 个 AI（member），0 ≤ N ≤ 5。
- FR-2.2 管理员可添加 AI：填写显示名、provider、model、systemPrompt（可选）、超时（可选，默认全局值）。
- FR-2.3 管理员可移除 AI。
- FR-2.4 管理员可调整 AI 发言顺序。
- FR-2.5 V1 中成员和顺序变更仅在群 `idle` 时允许；`running` 时 UI 置灰。
- FR-2.6 角色字段 `admin | member` 保留在数据模型中，为将来多人类成员做准备。

### FR-3 AI 成员能力

- FR-3.1 每次 AI 发言创建一个 one-shot 子 Agent。
- FR-3.2 子 Agent 工具白名单默认：
  - `read`
  - `read_image`
  - `glob`
  - `grep`
- FR-3.3 白名单外工具对子 Agent 完全不可见、不可执行；尤其是 `bash`、`edit`、`write`、`subagent`、`str_replace_editor`。
- FR-3.4 子 Agent 使用 `spawn` provider，不继承父会话对话历史；只看到调度器构造的可见视图。
- FR-3.5 子 Agent 可继承父会话 cwd，从而能探索当前项目文件。
- FR-3.6 子 Agent 可配置任意已注册的 provider/model。

### FR-4 发言顺序与轮次

- FR-4.1 管理员维护有序 AI 列表 `speakerOrder`。
- FR-4.2 用户普通发言时：
  - 若群 `idle`：开始新轮，按 `speakerOrder` 从第一个 AI 开始；
  - 若群 `running`：作为插话记录，不改变当前游标，剩余 AI 继续。
- FR-4.3 所有应发言 AI 完成后，本轮结束，群回到 `idle`。
- FR-4.4 被移除的 AI 从顺序中删除；已发言/未发言按当前轮快照处理（V1 变更仅 idle 时允许，避免歧义）。
- FR-4.5 用户普通发言内容对所有“尚未发言”的 AI 可见；对当前正在发言的 AI 本轮不可见（请求已发出），下一轮可见。

### FR-5 结束

- FR-5.1 “结束”按钮和 `/group stop` 等价。
- FR-5.2 结束动作：立即取消当前子 Agent、清空 @ 队列、本轮终止、群回到 `idle`。
- FR-5.3 已产生的 AI 消息保留在内存消息流中。
- FR-5.4 第一轮被中途结束后，盲发阶段随之结束；后续轮次全部可见。

### FR-6 第一轮盲发

- FR-6.1 盲发只对“群创建后的第一轮”生效。
- FR-6.2 第一轮中，给 AI 构造的 prompt 只包含：
  - 该 AI 身份/人设说明；
  - 用户开场消息；
  - 该 AI 发言前出现的用户插话；
  - 该 AI 自己已经产生的消息（例如第一轮中被 @ 再次回应时）。
- FR-6.3 第一轮中，其他 AI 的第一轮回复不进入该 AI 的 prompt。
- FR-6.4 用户界面始终显示全部消息。
- FR-6.5 完整消息保存在内存 `messages` 中；可见性过滤只发生在 prompt 构造阶段。
- FR-6.6 第一轮正常结束或中途结束后，盲发关闭；第二轮起全部消息按普通规则可见。

### FR-7 @ 发言

- FR-7.1 仅人类用户可 @；V1 一条消息只允许 @ 一个 AI。
- FR-7.2 群 `idle` 时 @A：只调度 A 单独回应一次；回应完成后群回到 `idle`；不增加轮数，不改变正常发言顺序。
- FR-7.3 群 `running` 时 @A：当前 AI 发言完成后，插入 A 的单独回应；A 回应完成后，继续原轮的下一顺位 AI。
- FR-7.4 @ 回应中目标 AI 的可见视图：按当前是否处于第一轮盲发应用 FR-6 规则；目标 AI 自己的历史消息始终可见。
- FR-7.5 管理员可开启/关闭 @；关闭时消息中的 `@name` 按普通文本处理。
- FR-7.6 AI 不能 @；@ 开关关闭时 UI 隐藏 @ 选择器。

### FR-8 失败与超时

- FR-8.1 超时针对单个 AI 的单次发言；默认 300000 ms，可配置全局默认值或单成员值。
- FR-8.2 超时或子 Agent 失败时：
  - 取消/释放该子 Agent；
  - 消息标记为 `timeout` / `failed` 并上屏；
  - 调度器继续下一位，不阻塞整轮。
- FR-8.3 失败成员后续轮次仍按顺序正常参与。
- FR-8.4 AI 发言失败自动重试一次；仍失败后用户可用 @ 手动让该 AI 重新回应。

### FR-9 权限模型

- FR-9.1 V1 唯一人类 = 初始管理员，不可移除、不可降级。
- FR-9.2 AI 一律为 `member`，不注册任何群管理命令/工具。
- FR-9.3 所有群管理操作通过 Host 内存服务执行；浏览器请求通过 Connection 信任栅栏（同源/loopback/trusted-host）。
- FR-9.4 管理员角色字段在数据模型中保留，但不实现“指定 AI 或其他用户为管理员”。

### FR-10 Web UI

- FR-10.1 当前会话头部提供“群聊”入口按钮。
- FR-10.2 点击后打开独立群聊面板/抽屉：
  - 未创建群：创建表单；
  - 已创建群：消息流 + 成员/设置区 + 输入区。
- FR-10.3 消息流展示：发送者头像/名称、文本、发送时间、状态（发言中/成功/超时/失败/已取消）、当前轮次。
- FR-10.4 输入区支持普通发言和 @ 选择器；群 `running` 时仍可输入。
- FR-10.5 运行中显示当前发言人、顺位进度、“结束”按钮。
- FR-10.6 成员区支持添加、移除、排序、设置 provider/model/systemPrompt/超时。
- FR-10.7 设置区提供 @ 开关；盲发为第一轮固定策略，提供状态提示，不需要开关。
- FR-10.8 UI 按钮操作走 Host 自定义 RPC，不在主聊天区产生 command 卡片；斜杠命令仍可用于键盘操作。

---

## 5. 非功能需求

- 使用 TypeScript 开发。
- 插件按 dsh bundle 形式打包，包含 Host 半和 Client 半。
- 不修改 deepseek-harness 源码。
- 单群单调度器：同一时间最多一个子 Agent 在执行。
- 所有 Host 内存状态必须是可 JSON 序列化的普通数据，便于快照和测试。
- RPC 通道的 payload 在 Host 侧校验，不信任浏览器输入。
- 插件卸载 / 会话销毁时：取消当前子 Agent、清空定时器、移除 RPC route、删除内存状态。

---

## 6. 总体技术架构

```text
┌────────────────────────────  dsh Web UI  ────────────────────────────┐
│                                                                      │
│  conversation.session.header.actions ── “群聊”按钮                   │
│  shell.overlay ── ChatGroupPanel（抽屉）                             │
│       │                                                              │
│       │ ctx.connection.rpc.call('/chatgroup', ...)                   │
│       │ snapshot / wait / send / stop / members.update ...           │
└───────┼──────────────────────────────────────────────────────────────┘
        │ HTTP /api 信任栅栏（dsh-client-connection）
┌───────▼──────────────────────── Host ───────────────────────────────┐
│                                                                      │
│  ChatGroupRpcChannel                                                 │
│    └─ ChatGroupService（Map<sessionId, ChatGroupController>）        │
│         ├─ ChatGroupStore   内存态群/消息/成员/顺序/设置              │
│         ├─ RoundScheduler   轮次、插话、@、结束、超时                 │
│         ├─ VisibilityFilter 盲发/可见视图构造                         │
│         └─ AiSpeaker         ctx.subagents.start('spawn', ...)       │
│                                  │                                   │
│                              one-shot 子 Agent                       │
│                              provider/model 可配                     │
│                              toolFilter = ReadOnly 白名单            │
│                              cwd = 父会话项目目录                     │
│                                                                      │
│  ChatGroupCommands   /group ... （斜杠命令，同一 Service 入口）       │
└──────────────────────────────────────────────────────────────────────┘
```

设计要点：

1. **不写自定义 session 事件**。群消息/状态只存在进程内存，避免外部插件自定义事件在重启加载时被 session persistence 拒绝的问题。
2. **Host 与 Client 用自定义 RPC channel 通信**，不依赖 Typert Remote 生成，也不需要修改 `api-remotes`。
3. **斜杠命令与 RPC 共用同一 `ChatGroupService`**，保证按钮和键盘行为一致。
4. **每次 AI 发言是一个短生命周期子 Agent**，结束后立即释放；V1 不需要长期存活的 AI 子会话。

---

## 6.1 群聊与 dsh 会话的关系（实测结论）

- **对话历史**：不继承。AI 成员通过 `spawn` 只看到 `buildMemberPrompt` 构造的群聊可见视图。
- **cwd**：继承当前 dsh 会话 cwd；每次发言前实时读取 `agent.session.header.cwd`，不依赖建群快照。
- **工作模式/agent preset**：provider/model/persona/toolFilter/maxDepth 由群成员配置覆盖；但父 preset 附加的 system prompt 段落可能进入成员上下文（“半继承”）。群成员始终只拥有只读工具白名单能力。
- **沙箱/审批**：沿用 dsh-subagent 的委托策略；子 Agent 审批固定拒绝，沙箱继承父策略。
- **会话切换**：群状态按 sessionId 隔离；Web 面板跟随当前会话。同一 dsh 会话的 cwd 由 session header 决定，切换项目请切换会话。

## 7. 内存数据模型

```ts
type MemberRole = 'admin' | 'member'
type MemberKind = 'user' | 'ai'

type GroupStatus = 'idle' | 'running'

type MessageStatus =
  | 'sent'          // 用户消息，已记录
  | 'speaking'      // AI 正在执行子 Agent
  | 'completed'     // AI 发言成功
  | 'failed'        // 子 Agent 失败
  | 'timeout'       // 超时
  | 'cancelled'     // 被结束按钮取消

interface ChatGroupMember {
  readonly id: string
  readonly kind: MemberKind
  readonly role: MemberRole
  readonly name: string
  // 仅 AI：
  readonly ai?: {
    readonly provider: string
    readonly model: string
    readonly systemPrompt?: string
    readonly timeoutMs: number
    readonly tools: readonly string[]
  }
}

interface ChatGroupMessage {
  readonly id: string
  readonly seq: number
  readonly round: number        // 0 = @ 单独回应；>=1 = 普通轮次
  readonly senderId: string
  readonly text: string
  readonly mentionIds: string[] // 解析出的 @ 目标，V1 最多 1 个
  readonly status: MessageStatus
  readonly error?: string
  readonly createdAt: number
  readonly completedAt?: number
}

interface ChatGroupSnapshot {
  readonly groupId: string
  readonly sessionId: string
  readonly revision: number
  readonly status: GroupStatus
  readonly round: number
  readonly blindRoundActive: boolean
  readonly mentionEnabled: boolean
  readonly speakerOrder: readonly string[]
  readonly members: readonly ChatGroupMember[]
  readonly messages: readonly ChatGroupMessage[]
  readonly currentSpeakerId?: string
  readonly nextSpeakerIds: readonly string[]
  readonly soloQueue: readonly string[]   // @ 队列
}

interface GroupController {
  // 内存权威状态
  group: ChatGroupSnapshot
  // 当前运行
  currentRun?: {
    memberId: string
    messageId: string
    run: SubagentRun
    timer: NodeJS.Timeout
    controller: AbortController
  }
  // 操作串行链
  chain: Promise<void>
}
```

### 状态约束

- `speakerOrder` 只包含 AI 成员且无重复。
- 一个会话最多一个 `GroupController`。
- `revision` 任何状态变化时单调递增；`wait` 长轮询据此返回。
- 成员/顺序变更仅允许 `status === 'idle'`。
- 第一轮结束后 `blindRoundActive` 永久为 `false`。
- 进程内不做持久化。

---

## 8. RoundScheduler 状态机

```text
idle
  │ 用户普通发言
  ▼
round-running
  │ 游标 = speakerOrder[0]
  │
  ├─ 当前 AI 完成 ──► 发布消息
  │      ├─ 还有下一位 ──► 游标 +1，继续
  │      └─ 已是最后一位 ──► round-complete ──► idle
  │
  ├─ 用户插话 ──► 记录消息，游标不变，后续 AI 继续
  │
  ├─ 用户 @A ──► soloQueue.push(A)
  │      └─ 当前 AI 完成后先消费 soloQueue，再继续原顺位
  │
  ├─ 结束按钮 / /group stop ──► abort current ──► idle（清空 soloQueue）
  │
  └─ 当前 AI 超时/失败 ──► 标记消息状态，视作该位发言完成，继续
```

`idle` 状态下用户 @A：

```text
idle ──► solo-running(A) ──► 发布 A 的回应 ──► idle
```

### 插话的可见性

| 听者 | 当前轮插话可见性 |
|---|---|
| 当前正在发言的 AI | 不可见（prompt 已发出） |
| 尚未发言的 AI | 可见 |
| 已经发言的 AI | 本轮不可见，下一轮可见 |
| 用户 | 始终可见 |

---

## 9. VisibilityFilter：第一轮盲发

```ts
buildVisibleTranscript(group, targetMemberId): Message[] {
  const blind = group.blindRoundActive && group.round === 1

  return group.messages.filter(msg => {
    if (msg.senderId === USER_ID) return true
    if (msg.senderId === targetMemberId) return true
    if (!blind) return true
    return false
  })
}
```

规则：

1. 用户消息永远可见。
2. 目标 AI 自己的历史消息永远可见。
3. 非第一轮：所有 AI 消息可见。
4. 第一轮：其他 AI 消息全部过滤。
5. 过滤只作用于子 Agent prompt；UI 快照始终返回完整 `messages`。

### Prompt 构造

每次 AI 发言的 one-shot 子 Agent 接收：

1. `persona`：仅包含由插件生成的静态群成员身份说明；不把用户配置文本直接塞进 persona 模板，避免 `{{...}}` 插值问题。
2. `prompt`：
   - 任务说明：你现在是群聊成员 X，请直接给出要在群里发送的回复；
   - 成员的 `systemPrompt`（如果配置了）；
   - 按时间顺序排列的 `visibleTranscript`；
   - 明确提示：可只读查看项目文件后再回答；回答只包含要发到群里的内容。

---

## 10. AiSpeaker：one-shot 子 Agent

### 10.1 调用流程

```ts
async function speak(member: AiMember): Promise<SpeakResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(TIMEOUT), member.timeoutMs)

  const run = await ctx.subagents.start('spawn', {
    parent: currentAgent,
    label: `chatgroup:${group.id}:${member.id}:r${group.round}`,
    prompt: [{ type: 'text', text: buildPrompt(group, member) }],
    agentOptions: {
      provider: member.ai.provider,
      model: member.ai.model,
      // 不设置 maxTokens：使用 provider/模型默认值
    },
    persona: buildMemberPersona(member),
    toolFilter: { allow: member.ai.tools },
    maxDepth: 1,
    signal: controller.signal,
  })

  try {
    const result = await run.result
    return {
      status: result.stopReason === 'completed' ? 'completed' : mapStopReason(result),
      text: extractText(result.output),
    }
  } finally {
    clearTimeout(timer)
    await run.dispose()
  }
}
```

### 10.2 关键决策

- 使用 `spawn`，不使用 `fork`：子 Agent 不继承主会话历史，可见视图完全由插件控制。
- `toolFilter.allow` 是白名单；未列出的工具从 prompt 和执行路径同时移除。
- `maxDepth: 1` 防止 AI 成员再创建子 Agent（虽然白名单已排除 subagent 工具）。
- provider/model 由成员配置决定；必须来自 `ctx.llm.listProviders()` 中已注册的 provider。
- 超时使用 AbortController；`run.dispose()` 负责取消和释放子 Agent。
- 子 Agent 只返回最终 assistant 文本；V1 不流式转发中间 chunk。

### 10.3 结果映射

| 子 Agent 结束 | 群消息状态 |
|---|---|
| `completed` 且有文本 | `completed` |
| `completed` 但无有效文本 | `failed` |
| 超时触发 abort | `timeout` |
| `aborted`（非超时，如结束按钮） | `cancelled` |
| `error` / `max-tokens` / `refusal` 等 | `failed`（记录原因） |

---

## 11. Host 自定义 RPC channel

### 11.1 通道注册

```ts
ctx.connection.rpc.handle(
  '/chatgroup',
  chatGroupRpcHandler,
  { authority: 'trusted-host' },
)
```

- 通道名 `/chatgroup`。
- `authority: 'trusted-host'` 同时接受 loopback 和配置的 trusted hosts，通过 dsh-client-connection 的信任栅栏。
- 返回标准 `RpcResult<T>`：
  ```ts
  { ok: true, value: T } | { ok: false, error: { code, message, details? } }
  ```

### 11.2 Endpoint

| Endpoint | Payload | 返回 |
|---|---|---|
| `snapshot` | `{ sessionId }` | `{ revision, group: ChatGroupSnapshot \| null }` |
| `wait` | `{ sessionId, revision }` | 当 revision 变化时返回新 snapshot；否则挂起最长 25s 后返回 `{ unchanged: true }` |
| `create` | `{ sessionId, config }` | 创建后的 snapshot |
| `dissolve` | `{ sessionId }` | `{ ok: true }` |
| `send` | `{ sessionId, text, mentionId? }` | 入队后的 snapshot |
| `at` | `{ sessionId, memberId, text }` | 入队后的 snapshot |
| `stop` | `{ sessionId }` | `{ ok: true }`；取消是异步生效 |
| `members.add` | `{ sessionId, member }` | 更新后的 snapshot |
| `members.remove` | `{ sessionId, memberId }` | 更新后的 snapshot |
| `members.reorder` | `{ sessionId, order }` | 更新后的 snapshot |
| `settings.update` | `{ sessionId, mentionEnabled? }` | 更新后的 snapshot |
| `catalog` | `{ sessionId }` | `{ providers: [{provider, models}], defaultTimeoutMs }` |

错误码示例：

- `NO_GROUP`
- `GROUP_EXISTS`
- `GROUP_RUNNING`
- `AI_LIMIT_EXCEEDED`
- `UNKNOWN_MEMBER`
- `UNKNOWN_PROVIDER`
- `INVALID_MEMBER`
- `MENTION_DISABLED`
- `MENTION_NOT_ALLOWED`
- `TIMEOUT_INVALID`

### 11.3 长轮询

- Client 打开面板后循环调用 `wait`：
  ```text
  snapshot ──► wait(revision) ──► 变化/25s 超时 ──► snapshot ──► ...
  ```
- 每次状态变化 `revision++`，Host resolve 所有等待中的 `wait`。
- 面板关闭时 abort 当前 `wait` 请求。
- 轮询/长轮询是 V1 的实时机制；不新增 SSE/WebSocket frame 类型。

---

## 12. 斜杠命令

命令是 Host 侧注册的普通 dsh commands；它们与 RPC 调用同一 `ChatGroupService`。

| 命令 | 参数 | 行为 |
|---|---|---|
| `/group create` | — | 创建群 |
| `/group status` | — | 当前群状态 |
| `/group add` | `<name> <provider> <model> [timeoutMs]` | 添加 AI |
| `/group remove` | `<name>` | 移除 AI |
| `/group members` | — | 列出成员和顺序 |
| `/group order` | `<name1> <name2> ...` | 设置发言顺序 |
| `/group say` | `<text>` | 用户普通发言 |
| `/group at` | `<name> <text>` | @ 单个 AI |
| `/group mention` | `on\|off` | @ 开关 |
| `/group stop` | — | 结束当前轮 |
| `/group dissolve` | — | 解散群 |

说明：

- 面板按钮走 RPC，不在主会话日志产生 `command/run`/`command/done` 卡片。
- 键盘使用斜杠命令时，按 dsh 标准行为在主聊天区出现 command 卡片。
- `/group stop` 与“结束”按钮完全等价。

---

## 13. Client 结构与 UI

### 13.1 插件结构

```text
dsh-plugin-chatgroup/
├── package.json
├── cordis.patch.yml
├── tsconfig.json
├── src/
│   ├── index.ts              # Host 入口：装配 Service / RPC / Commands
│   ├── types.ts              # 群数据模型、RPC 请求/响应类型
│   ├── group-service.ts      # 内存 Map、创建/变更、revision
│   ├── scheduler.ts          # 轮次 / @ / 结束 / 失败推进
│   ├── visibility.ts         # 盲发裁剪与 prompt 构造
│   ├── ai-speaker.ts         # one-shot 子 Agent 封装
│   ├── rpc.ts                # /chatgroup channel
│   └── commands.ts           # /group 命令族
├── src/client/
│   ├── index.ts              # Client 入口：注册 slots
│   ├── rpc-client.ts         # connection.rpc.call 封装 + wait 循环
│   ├── chat-group-store.ts   # 面板快照 store
│   ├── ChatGroupPanel.tsx    # shell.overlay 抽屉
│   ├── MessageList.tsx
│   ├── Composer.tsx          # 输入框 + @ 选择器
│   ├── MemberSettings.tsx
│   └── CreateGroup.tsx
└── tests/
    ├── scheduler.test.ts
    ├── visibility.test.ts
    ├── ai-speaker.test.ts
    └── client/*
```

### 13.2 使用的 dsh UI slots

| Slot | 用途 |
|---|---|
| `conversation.session.header.actions` | 当前会话头部“群聊”按钮 |
| `shell.overlay` | 独立群聊抽屉（list slot，新增 `id: 'chatgroup-panel'`） |

不占用 `conversation`、`details`、`sidebar` 单席位 slot，避免替换现有 UI。

### 13.3 面板状态

- `no-group`：创建表单。
- `idle`：完整消息流 + 输入区 + 成员/设置。
- `running`：当前发言人 + 进度 + 输入区 + 结束按钮；成员/顺序操作置灰。
- `solo`：显示“@ 回应中：X”。

### 13.4 Client 依赖

- `connection`（generic RPC channel）。
- `slots`、`sessions`（scope/sessionId）、`locale`（可选文案）。
- 类型注入 ui-layout / ui-conversation 的 slot 声明。

---

## 14. 配置

Host 插件 config schema：

```ts
interface ChatGroupConfig {
  /** 群内 AI 成员上限；V1 固定为 5。 */
  maxAi: number // default 5
  /** 单次 AI 发言超时，可被成员配置覆盖。 */
  defaultTimeoutMs: number // default 300000
  /** 只读工具白名单；变更会影响新发言。 */
  readonlyTools: string[] // default ['read', 'read_image', 'glob', 'grep']
  /** 长轮询最长时间。 */
  waitTimeoutMs: number // default 25000
}
```

成员级配置：

```ts
{
  name: string
  provider: string
  model: string
  systemPrompt?: string
  timeoutMs?: number  // 缺省用 defaultTimeoutMs
}
```

---

## 15. 错误与边界处理

| 场景 | 行为 |
|---|---|
| provider 未注册 | 成员创建/发言前校验，返回 `UNKNOWN_PROVIDER` |
| 只读工具未组合进 profile | 创建 AI 成员时校验工具名，缺失则明确报错 |
| 子 Agent start 失败 | 消息标记 `failed`，继续下一位 |
| 子 Agent 超时 | `timeout`，继续下一位 |
| 当前发言人结束后群已解散 | 丢弃结果，不发布消息 |
| 会话销毁 / 插件卸载 | 取消当前 run、清空定时器、删除内存状态、移除 RPC route |
| 连续快速发送 | Service 内部串行链 + 快照 revision，保证 UI 收敛 |
| 第一轮结束后用户重开话题 | 不重新进入盲发；盲发是群生命周期一次性行为 |

---

## 16. 测试计划

### 16.1 单元测试

- `scheduler`：轮次推进、插话不重置游标、@ 插入、结束清空队列、失败继续。
- `visibility`：第一轮盲发过滤、用户/自身消息保留、第二轮全可见。
- `ai-speaker`：mock subagent provider 成功/失败/超时/取消。
- `group-service`：成员增删排序、上限、revision 单调递增。
- `rpc`：payload 校验、错误码、wait 长轮询。

### 16.2 集成测试

- Host 测试环境挂载 mock subagent provider 和只读工具。
- 验证命令与 RPC 行为一致。
- 验证 `/group stop` 能取消运行中的子 Agent。
- 验证第一轮盲发时 mock provider 收到的 prompt 不包含其他 AI 回复。

### 16.3 浏览器测试

- Client slot 注册：header 按钮 + shell.overlay 面板。
- 面板快照刷新、wait 长轮询重连、发送/结束按钮。
- 成员设置表单与 @ 选择器。

### 16.4 手工验收

1. 创建群，添加 3 个 AI，指定顺序。
2. 用户发送议题；确认 3 个 AI 依次回复，用户全程可见。
3. 在第一轮插入插话；确认未发言 AI 能看到插话。
4. 检查 mock 层：第一轮 AI 的 prompt 互不包含彼此回复。
5. 第二轮发送消息；确认所有 AI 都看到第一轮完整记录。
6. 运行中 @ 某个 AI；确认仅它回应，且不打断后续顺序。
7. 点击“结束”；确认当前发言取消、本轮结束。
8. 重启 dsh；确认会话可正常打开、群聊已消失且无加载错误。

---

## 17. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 | 插件骨架 + 数据模型 + GroupService + Scheduler + AiSpeaker + `/group` 命令 | ✅ 命令行可完成一轮 AI 顺序发言 |
| M2 | Host RPC channel + Client 面板 + 长轮询 + 成员/设置 UI | ✅ Web UI 可完成建群、发言、@、结束 |
| M3 | 盲发验证、超时/失败处理、测试补全、打包文档 | ✅ 9 项测试通过 + `npm pack` + 真实 dsh web 冒烟验证 |

---

## 18. 风险与已知限制

| 风险/限制 | 影响 | 应对 |
|---|---|---|
| 内存态，重启即丢 | 群聊不可恢复 | 已确认选 A；文档和 UI 中明示 |
| 不写 session 事件 | 无法用会话日志审计群消息 | V1 接受；V2 可评估上游 `ignorable` 事件注册 |
| V1 不流式输出 | AI 回复完成后整条上屏 | 面板显示“正在输入”；V2 可基于子会话 chunk 流式 |
| 外部双面插件构建复杂 | Host/Client 打包路径需要打通 | M1 先只做 Host，M2 再引入 Client 构建 |
| 只读工具依赖 profile | 若 dsh-base 未组合 fs 工具则 AI 无法读文件 | 创建成员时校验并给出明确错误 |
| 多模型依赖已注册 adapter | 不同 provider 需配置好凭证和 adapter | 创建成员前用 `ctx.llm.listProviders()` 校验 |
| 单群单会话 | 多群场景暂不支持 | 数据模型保留 groupId，Service 按 sessionId 隔离 |

---

## 19. 待后续讨论

1. 第一轮被“结束”时，是否需要在第二轮开头自动补一条系统摘要给未发言 AI（V1 当前方案：不补，直接全可见）。
2. AI 发言是否需要在面板显示其只读工具活动（如“正在读文件”）；V1 当前方案只显示“发言中”。
3. 群创建后是否允许重命名、修改用户昵称；V1 当前方案不允许。
