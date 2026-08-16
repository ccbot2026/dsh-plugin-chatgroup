# Changelog

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
