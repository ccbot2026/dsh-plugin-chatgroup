# 项目状态压缩版

> 完整阶段总结：`docs/阶段总结-v0.2.0.md`
> 需求增量记录：`docs/需求增量记录-v0.2.0.md`

- 项目：dsh-plugin-chatgroup v0.2.0
- 测试：28/28 通过
- 持久化：`<项目>/.dsh/chatgroup/<sessionId>.jsonl`
- 安装：`dsh plugin --profile web add /path/to/dsh-plugin-chatgroup`
- 启动：`dsh --profile dsh-chatgroup --port 3081`

## 已实现

- 1 人 + ≤5 AI，轮次顺序、@、首轮盲发、自动多轮、新议题隔离
- 只读工具子 Agent；@ 可临时授予 `write/edit`（read-only 时禁用）
- 流式输出、消息分页/话题浏览、议题锚点、拖拽宽度、复制单条、导出 Markdown
- 面板配置可编辑（群级）、失败重试一次、失败成员提醒
- 会话切换跟随、cwd 实时读取、JSONL 恢复、旧数据兼容

## 关键约束

- `/group` 命令在主聊天输入框执行，不在群聊面板
- 每次改动后需重启 dsh 并强刷浏览器
- 写权限是工具级，不限制具体文件
- 浏览器 E2E 已搁置

## 下一步

- 无大项；日常使用反馈驱动迭代
