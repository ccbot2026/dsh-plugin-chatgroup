# 项目状态压缩版

> V2 阶段总结：`docs/阶段总结-v0.3.0.md`
> V1 阶段总结：`docs/阶段总结-v0.2.0.md`
> V2 变更：`CHANGELOG.md`（0.3.0 章节）
> V2 计划外增量：`docs/v0.3增量需求记录.md`
> 实施计划：`docs/plan.md`

- 项目：dsh-plugin-chatgroup v0.3.0
- 测试：51/51 通过
- 持久化：`<项目>/.dsh/chatgroup/<sessionId>-<groupId>.jsonl`（v2；v1 自动迁移为 `group-1`）
- 安装：`dsh plugin --profile web add /path/to/dsh-plugin-chatgroup`
- 启动：`dsh --profile dsh-chatgroup --port 3081`

## 已实现

### V1（0.2.0 基线）

- 1 人 + ≤5 AI，轮次顺序、@、首轮盲发、自动多轮、新议题隔离
- 只读工具子 Agent；@ 可临时授予 `write/edit`（read-only 时禁用）
- 流式输出、消息分页/话题浏览、议题锚点、拖拽宽度、复制单条、导出 Markdown
- 面板配置可编辑（群级）、失败重试一次、失败成员提醒
- 会话切换跟随、cwd 实时读取、JSONL 恢复、旧数据兼容

### V2（0.3.0）

- **多群**：一会话多群（maxGroups 默认 1，面板可调且对 create 生效）、`/group list|use`、面板群选择器、v1→v2 迁移
- **消息编辑/撤回**：`/group edit|withdraw`、面板行内编辑、撤回不进 prompt、原文审计保留
- **AI 主动发言**：`aiProactive` + 每轮上限；AI 互 @（深度限制 + 防循环）
- **首轮中断摘要**：系统消息汇总已产生发言
- **面板增强**：群重命名、只读工具活动实时提示

## 关键约束

- `/group` 命令在主聊天输入框执行，不在群聊面板
- 每次改动后需重启 dsh 并强刷浏览器
- 写权限是工具级，不限制具体文件
- 浏览器 E2E 已搁置
- **避免多开同一会话**（3080/3081 同时打开同一 session 会损坏日志）

## 下一步

- 日常使用反馈驱动迭代
