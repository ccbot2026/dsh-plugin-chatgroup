# Changelog

## 0.4.1

### 面板 UI 优化（测试反馈驱动）

- 左右两栏布局；右侧设置面板宽度可拖拽调整（240–460px，记忆），顶部折叠图标收起（替代原"关闭"按钮）。
- 发言框"收起设置"按钮移除；"解散"移入右侧新增"群管理"区（新建群/解散群/群消息导出/重命名）。
- 点击群面板外部自动隐藏面板（右下角 launcher 豁免）。
- 自定义输入框：textarea 调高（72px）+ 内嵌工具栏（左 @ 选择/允许写入，右发送），参考主对话框布局。
- 输入框聚焦改为外层胶囊边框高亮（圆角统一），内层 textarea 无独立边框。

## 0.4.0

### 体验与稳定性（V3 首阶段）

- 配置一致性：面板设置 maxGroups 现在对 create 上限生效（per-session 覆盖）。
- maxGroups 默认值定稿为 1（与 v0.2 行为一致；面板可调大）。
- AI 发言质量：prompt 增加聚焦约束、盲发说明、@ 格式提示、被点名回应/主动补充的差异化引导。
- 长会话性能：成员 token 用量改为增量维护（原每次快照全量扫描 O(n)）。
- 测试补强：RPC 全链路集成测试（多群/编辑撤回/wait 隔离/重命名/配置/错误码）；prompt 调优断言。

## 0.3.0

### 多群（V2.1）

- 一个会话支持多个群（`maxGroups`，默认 1 保持兼容；群 ID `group-1..group-N`）。
- 全部 Service/RPC API groupId 化；`/group list`、`/group use <群ID>`、`groups.list` / `groups.use`。
- 持久化 v2：`<sessionId>-<groupId>.jsonl`；v1 单群日志自动迁移为 `group-1`（文件名不变）。
- 面板群选择器 + 新建群按钮；waiters 按群隔离。

### 消息编辑 / 撤回（V2.2）

- `editMessage` / `withdrawMessage`：仅管理员、仅最近 `maxEditableMessages` 条（默认 20）、不可编辑发言中/已撤回。
- 撤回消息从所有后续 AI prompt 消失；编辑消息以新文本 +（已编辑）标注进入 prompt，原文保留供审计。
- RPC `messages.edit` / `messages.withdraw`；命令 `/group edit <seq> <text>`、`/group withdraw <seq>`。
- 面板消息气泡 hover 出现编辑/撤回，行内编辑框。

### AI 主动发言与 AI 互 @（V2.3）

- `aiProactive`（默认 false）/ `maxProactivePerRound`（默认 1）/ `maxAiMentionDepth`（默认 1）。
- 轮次正常结束后逐个咨询 AI 是否补充，最多 `maxProactivePerRound` 条；"无需补充"被识别为放弃。
- AI 消息中 `@成员名` 触发单深度回应；深度超限与同轮重复目标自动丢弃并记录系统提示。

### 首轮中断摘要（V2.4）

- 首轮被用户中断且仍有未发言 AI 时，生成系统摘要（已发言内容 200 字/条）。

### 面板增强（V2.5）

- 群重命名：`/group rename <新名称>` + 面板输入框，持久化。
- 只读工具活动提示：发言中显示"成员 X 正在 read …"，由子 Agent 会话事件驱动。

### 兼容与迁移

- RPC 不传 `groupId` 时行为与 v0.2 完全一致（单群场景）。
- v1 持久化文件无需手工迁移，首次读取自动作为 `group-1`。

## 0.2.0

- @ 临时写权限：`--write`，仅当次发言可调用 `write/edit`；read-only 模式禁用。
- 发言复制到剪贴板；完整群聊导出为 Markdown 文件。
- 新议题：`/group topic <议题内容>`；旧话题不进新议题 AI 上下文，新议题第 1 轮重新盲发。

- 自动多轮讨论：`/group auto <轮数 1-10> [议题]`，支持中途启动。
- 消息分页：RPC 快照尾页 + `messages.before`，面板滚动加载更早消息。
- AI 发言流式上屏。
- 面板拖拽调宽并记忆。
- Prompt 滑动窗口，默认最近 40 条可见消息。
- 会话级 JSONL 持久化：`<项目>/.dsh/chatgroup/<sessionId>.jsonl`。
- AI 发言失败自动重试一次。
- 上一轮失败成员提醒。
- 群聊面板运行配置可编辑（群级覆盖）；`/group config` 查看当前群配置。
- 补齐 RPC 边界测试。

## 0.1.0

- 群聊核心：1 个人类 + 最多 5 个 AI。
- 轮次调度、@、结束、第一轮盲发、只读工具子 Agent。
- Web 独立抽屉面板 + `/chatgroup` RPC。
- 内存态第一版。
