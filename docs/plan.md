# dsh-plugin-chatgroup 实施计划

> 状态：**V2 已完成（v0.3.0 发布，2026-08-16）**；M1–M9 与 V2.1–V2.6 全部落地
> 日期：2026-08-15
> 范围：下一开发周期 V3（多人类成员 / 表情附件 / 移动端 等，见 backlog）
> 依据：docs/chatgroup-prd-tech-design.md（PRD）、docs/e2e-checklist.md、README.md

---

## 1. 当前基线（已完成，作为计划输入）

### 1.1 里程碑

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | Host 骨架 + 数据模型 + GroupService + 调度 + AiSpeaker + /group 命令族 | 完成 |
| M2 | /chatgroup RPC channel + Web 抽屉面板 + 长轮询 | 完成 |
| M3 | 盲发验证、超时/失败处理、测试、打包、冒烟 | 完成 |
| M5 | 会话级 JSONL 持久化（.dsh/chatgroup/<sessionId>.jsonl） | 完成 |
| M6 | AI 发言流式上屏、面板拖拽调宽、prompt 滑动窗口（40 条） | 完成 |
| M7 | RPC 边界测试、死错误码清理 | 完成 |
| M8 | 消息分页（100 条/页 + 向上加载）、失败成员提醒 | 完成 |
| M9 | 面板可编辑群配置、/group config、v0.2.0 发布物 | 完成 |

### 1.1b V2 里程碑（v0.3.0，2026-08-16 完成）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| V2.1 | 多群支持：groupId 化 API、maxGroups、持久化 v2 + v1 迁移、面板群选择器、/group list\|use | 完成 |
| V2.2 | 消息编辑/撤回：editMessage/withdrawMessage、RPC、面板行内编辑、错误码 | 完成 |
| V2.3 | AI 主动发言（aiProactive）+ AI 互 @（深度限制防循环） | 完成 |
| V2.4 | 首轮中断后系统摘要 | 完成 |
| V2.5 | 群重命名、只读工具活动提示 | 完成 |
| V2.6 | 测试补全（51/51）、文档同步、v0.3.0 发布 | 完成 |

### 1.2 运行配置（/group config 六项，src/types.ts DEFAULT_* 常量）

| 配置 | 默认值 | 说明 |
|---|---|---|
| maxAi | 5 | AI 成员上限 |
| defaultTimeoutMs | 300000 | 单次发言超时（可成员级覆盖） |
| readonlyTools | read, read_image, glob, grep | AI 只读工具白名单 |
| waitTimeoutMs | 25000 | RPC 长轮询上限 |
| maxPromptMessages | 40 | prompt 滑动窗口条数，0 = 全量 |
| messagePageSize | 100 | 快照尾页条数 |

### 1.3 文件地图（V2 主要改动点）

- Host：src/index.ts（装配）、src/types.ts（模型/常量）、src/group-service.ts（1255 行核心服务）、src/persistence.ts（jsonl）、src/visibility.ts（盲发/prompt）、src/ai-speaker.ts（spawn 子 Agent）、src/rpc.ts、src/commands.ts、src/errors.ts
- Client：src/client/index.ts、rpc-client.ts、ChatGroupPanel.tsx、panel-controller.ts、HeaderButton.ts
- 测试：test/*.test.mjs（m1 / rpc / rpc-edge / persistence-retry / pagination / streaming / auto / topic / write-access / client-bundle，共 10 个文件）

---

## 2. V2 目标与范围决策

### 2.1 目标

1. 一个会话支持多个群（数据模型已预留 groupId），群间消息/成员/配置完全隔离。
2. 消息可编辑/撤回（仅管理员），弥补"发错、表述不清只能重发"的体验缺口。
3. 受限的 AI 主动发言：轮结束后 AI 可主动补充一次（可开关、防死循环），支持 AI 之间有限 @。
4. 面板增强：AI 只读工具活动提示、群重命名、首轮中断后系统摘要（PRD 19 待讨论项落地）。
5. 持久化 schema v2 + 迁移，稳定性测试补全。

### 2.2 做 / 不做

| 做 | 不做（backlog） |
|---|---|
| 多群（同会话） | 跨会话群、群共享 |
| 消息编辑/撤回（管理员） | 消息删除的级联审计、表情/附件/图片 |
| AI 主动发言（每轮 ≤1 次，可配置） | 无限制的 AI 自由发言、AI 当管理员 |
| AI 互相 @（深度 ≤1，防循环） | 多人类成员、多人管理员 |
| 首轮中断后系统摘要 | 移动端 / TUI |
| 群重命名、只读活动提示 | token 级流式（当前已是文本增量流式，够用） |

---

## 3. 里程碑分解

### V2.1 多群支持（P0）

任务
1. src/types.ts：GroupId 类型；快照增加 groupId（已有）；Service API 全部加 groupId 参数；ChatGroupConfig 增加 maxGroups（默认 4，可配）。
2. src/group-service.ts：Map<sessionId, Map<groupId, InternalGroup>>；create 检查群数上限；disposeSession 清理全部群。
3. src/persistence.ts：schema v2 —— 记录增加 groupId 字段；日志文件改为 <sessionId>-<groupId>.jsonl；提供 v1→v2 迁移（读到旧文件按 groupId='group-1' 载入）。
4. src/rpc.ts：snapshot/wait/send/stop/... payload 增加可选 groupId（缺省 = 当前唯一群，保持向后兼容）。
5. Client：面板顶部群选择器（tab 或下拉）；新建群按钮；panel-controller.ts 按群维护 wait 循环。
6. src/commands.ts：/group list、/group use <id>（切换默认群）。

验收
- 同一会话可创建多个群，各自成员/顺序/消息/配置独立，互不可见。
- 重启 dsh 后多群全部恢复，v1 单群日志可自动迁移。
- RPC 不传 groupId 时行为与 v0.2 完全一致（向后兼容）。

### V2.2 消息编辑 / 撤回（P0）

任务
1. src/types.ts：ChatGroupMessage 增加 editedAt?、editedText?（保留原文供审计）；MessageStatus 增加 'withdrawn'。
2. src/group-service.ts：editMessage(...)、withdrawMessage(...)；仅管理员、仅 completed/sent 消息、仅最近 N 条（maxEditableMessages 默认 20）；变更 revision++ 并追加持久化记录。
3. src/visibility.ts：撤回消息不进任何 prompt；编辑消息在 prompt 中显示 editedText（标注已编辑）。
4. src/rpc.ts：新增 messages.edit、messages.withdraw endpoint + 错误码 NOT_ADMIN、MESSAGE_NOT_EDITABLE、MESSAGE_NOT_FOUND。
5. Client：消息气泡 hover 出现编辑/撤回菜单；编辑态输入框；撤回后显示"（已撤回）"占位。
6. src/commands.ts：/group edit <seq> <text>、/group withdraw <seq>。

验收
- 管理员可编辑/撤回群内任意 AI 发言与用户消息（按权限规则）；非管理员被拒。
- 撤回消息不出现在任何后续 AI prompt；编辑消息以新文本进入 prompt。
- 重启恢复后编辑/撤回状态保持。

### V2.3 AI 主动发言与 AI 互相 @（P1，可配置）

任务
1. src/types.ts：ChatGroupConfig 增加 aiProactive（默认 false）、maxProactivePerRound（默认 1）、maxAiMentionDepth（默认 1）；ChatGroupMessage.mentionIds 语义扩展为允许 AI 发出 @。
2. src/group-service.ts：
   - 轮次结束后（idle）若 aiProactive 开启，调度 AI 按顺序检查"是否需要主动补充"（prompt 中显式询问），最多 maxProactivePerRound 条；用 round 计数防循环。
   - AI 消息中解析 @ 其他 AI：入 soloQueue，深度计数，超 maxAiMentionDepth 丢弃并提示。
3. src/visibility.ts：AI 主动发言的可见视图 = 当前轮完整视图（不再盲发，盲发仅第一轮用户发起时）。
4. src/ai-speaker.ts：speakOnce 增加 intent 参数（reply | proactive | mention）用于 prompt 提示差异。
5. src/rpc.ts + 面板：设置区暴露 aiProactive 开关与深度限制。

验收
- 开启后每轮 AI 主动补充不超过 1 条；AI @ AI 链路深度不超过 1，无死循环。
- 默认 aiProactive=false，行为与 v0.2 完全一致。

### V2.4 首轮中断后的系统摘要（P1，PRD 19.1）

任务
1. src/group-service.ts：首轮被 stop 且仍有未发言 AI 时，生成 SYSTEM_MEMBER_ID 系统消息："首轮已由用户中断，以下为已产生的发言摘要…"（用已发言消息的前 N 字拼接，N=200/条）。
2. src/visibility.ts：摘要消息 senderId=system，恒可见；第二轮起正常全可见。
3. 面板：系统消息特殊样式（居中灰色小字）。

验收
- 首轮中断后第二轮 AI 能看到摘要；无中断时不产生摘要。

### V2.5 面板增强（P2，PRD 19.2/19.3）

任务
1. 群重命名：ChatGroupSnapshot 增加 name；/group rename <新名> + 面板设置区输入框。
2. 只读工具活动提示：ai-speaker.ts 通过子 Agent 事件流（tool call 开始/结束）回调 onToolActivity，面板显示"成员 X 正在读取文件…"；V1 至少显示工具名与目标路径。
3. 面板拖拽宽度记忆已实现，V2 增加折叠/展开动画与记住上次群 tab。

验收
- 群名可在面板与命令双向修改并持久化；发言中面板可看到当前 AI 的工具活动。

### V2.6 稳定性与测试补全（贯穿）

任务
1. 新测试文件：test/multigroup.test.mjs、test/message-edit.test.mjs、test/proactive.test.mjs、test/persistence-v2-migration.test.mjs。
2. 既有测试适配：RPC payload 增加 groupId 后的边界；rpc-edge 补 NOT_ADMIN / MESSAGE_NOT_EDITABLE。
3. 压力场景：多群并发 wait 长轮询；消息编辑 + 分页组合；npm test 全绿。
4. 文档同步：PRD 状态行、README 进度、e2e-checklist 增加多群/编辑/主动发言用例。

---

## 4. 里程碑顺序与依赖

V2.1（多群）→ V2.2（编辑/撤回，依赖 V2.1 的 groupId 化 API）→ V2.3（主动发言）→ V2.4（摘要）→ V2.5（面板）→ V2.6（测试/发布）

- V2.1 是地基：所有 Service/RPC API 先 groupId 化，V2.2–V2.5 全部在其上开发。
- V2.2 与 V2.3 可并行（不同模块：消息操作 vs 调度器），但需先合入 V2.1。
- 每阶段合并前必须 npm run build && npm test 通过。

## 5. 发布计划

- V0.3.0（breaking：持久化 schema v2、RPC payload 增加 groupId，但保持缺省兼容）：
  - CHANGELOG 记录迁移说明；README 更新"一个会话一个群"的表述。
  - 冒烟：按 docs/smoke-test.md 流程跑一轮，补多群场景。

## 6. 风险与开放问题

| 风险/问题 | 影响 | 应对/待确认 |
|---|---|---|
| 多群持久化文件拆分导致旧日志变多 | 磁盘占用 | v1→v2 迁移后旧文件删除或归档，待确认 |
| AI 主动发言可能引入低质量插话 | 体验 | 默认关闭 + 每轮 ≤1 条 + 可在面板逐条撤回 |
| AI @ AI 有循环风险 | 死循环/费用 | 深度限制 1 + 同轮同目标去重 |
| 消息编辑影响历史可见视图一致性 | 语义混乱 | 编辑只在 prompt 用新文本并标注；完整审计保留原文 |
| 撤回消息是否计入 maxPromptMessages 窗口 | 计数口径 | 待确认：建议不计入（撤回即消失） |
| maxGroups 默认值 | 产品决策 | 待确认：默认 4 还是 1（1 = 与 v0.2 行为一致） |

---

## 7. 待群内确认（本轮讨论后需要拍板）

1. maxGroups 默认值：1（保守，与现状一致）还是 4（放开）？
2. 消息编辑/撤回的时限与条数限制：最近 20 条 / 不限制？
3. aiProactive 默认开关：false（保守）还是 true（更热闹）？
4. 首轮中断摘要的长度与格式是否需要可配置？
