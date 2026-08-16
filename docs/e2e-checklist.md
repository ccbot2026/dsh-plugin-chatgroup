# chat-group E2E 检查清单

## 准备

```sh
cd /home/sll/projects/dsh-plugin-chatgroup
npm test
npm pack --dry-run
dsh plugin --profile web add /home/sll/projects/dsh-plugin-chatgroup
dsh web --port 3081
```

浏览器打开 `http://127.0.0.1:3081/`，选择一个项目会话。

## 手工用例

| # | 步骤 | 预期 |
|---|---|---|
| 1 | 会话头部/浮动按钮打开群聊 | 抽屉打开 |
| 2 | 创建群聊，添加 2-3 个 AI，设置顺序 | 成员和顺序正确显示 |
| 3 | 发送议题 | AI 按顺序发言，流式上屏 |
| 4 | 第一轮查看 prompt/观察 | 首轮盲发；用户始终可见 |
| 5 | 第二轮发言 | 全部成员看到第一轮历史 |
| 6 | 运行中插话 | 后续 AI 可见，顺序不变 |
| 7 | @ 某个 AI | 仅目标 AI 单独回应 |
| 8 | 结束本轮 | 当前发言取消，群 idle |
| 9 | 拖拽面板宽度并刷新 | 宽度保持 |
| 10 | `/group auto 3 议题` | 连续 3 轮，系统消息轮次提示 |
| 11 | 自动讨论中 `/group stop` | 自动模式终止 |
| 12 | 重启 dsh | 群从 `.dsh/chatgroup/*.jsonl` 恢复 |
| 13 | 切换会话 | 面板跟随新会话 |
| 14 | 移除成员/解散群 | 状态与持久化正确 |
| 15 | 消息超过 100 条 | 顶部显示计数，滚动加载更早消息 |

## API 冒烟

```sh
# 创建 session、群、成员、自动讨论、快照
# 详见 docs/smoke-test.md
```
