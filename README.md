# dsh-plugin-chatgroup

DeepSeek Harness (dsh) 群聊插件：在当前 dsh 会话中创建由 1 个人类用户和多个 AI 成员组成的讨论群（v0.4.1，支持多群）。

详细需求与技术方案见 [`dev-docs/chatgroup-prd-tech-design.md`](dev-docs/chatgroup-prd-tech-design.md)。

## 当前进度

- [x] V2.6：v0.3.0 发布
- [x] V0.4.0：体验与稳定性（配置一致性 / prompt 调优 / 性能 / RPC 集成测试）
- [x] V0.4.1：面板 UI（两栏布局 / 可调设置面板 / 群管理 / 自定义输入框）（多群 / 消息编辑撤回 / AI 主动发言 / 首轮中断摘要 / 群重命名 / 工具活动提示，51/51 测试通过）。
- [x] V2.1：多群支持（`maxGroups` 默认 1 兼容旧行为；`/group list|use`；持久化 v2 + v1 迁移；面板群选择器）。
- [x] V2.2：消息编辑/撤回（`/group edit|withdraw`、行内编辑、撤回不进 prompt、原文审计）。
- [x] V2.3：AI 主动发言（`aiProactive`）与 AI 互 @（深度限制防循环）。
- [x] V2.4：首轮中断后系统摘要。
- [x] V2.5：群重命名、只读工具活动实时提示。
- [x] M1：Host 侧插件骨架、内存数据模型、轮次调度、@、结束、第一轮盲发、one-shot 只读子 Agent、`/group` 命令族。
- [x] M2：`/chatgroup` RPC channel + Web UI 独立面板（header 按钮 + `shell.overlay` 抽屉）+ 长轮询。
- [x] M3：单元/RPC/bundle 测试、`npm pack`、真实 dsh web profile 冒烟验证。

## 开发

```sh
npm install
npm run build
npm test
```

## 安装使用

> 注意：用 `dsh plugin --profile <name> add ...` 新建的自定义 profile 只包含
> `@deepseek-ai/dsh-base`，**不包含 Web 服务**。浏览器访问需要把
> `@deepseek-ai/dsh-web-app` 加到 `dsh.profile.bundles`（不要用 pnpm 安装它）。

推荐直接装进内置 `web` profile：

```sh
dsh plugin --profile web add /path/to/project/dsh-plugin-chatgroup
dsh web --port 3081
```

如果使用自定义 profile，**不要把 `@deepseek-ai/dsh-web-app` 用 pnpm/npm
装进 profile**：那会在 profile 内形成第二份 dsh 核心包树，导致 AI 子 Agent
代码模式调度失败。正确做法是只安装本插件，然后把 web-app 加到
`dsh.profile.bundles`：

```sh
dsh plugin --profile dsh-chatgroup add /path/to/project/dsh-plugin-chatgroup
```

编辑 `~/.dsh/profiles/dsh-chatgroup/package.json` 为：

```json
{
  "name": "dsh-profile-dsh-chatgroup",
  "private": true,
  "dependencies": {
    "dsh-plugin-chatgroup": "link:/path/to/project/dsh-plugin-chatgroup"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-plugin-chatgroup",
        "@deepseek-ai/dsh-web-app"
      ]
    }
  }
}
```

然后：

```sh
dsh plugin --profile dsh-chatgroup install
dsh --profile dsh-chatgroup --port 3081
```

首次安装会由 pnpm 下载依赖，可能持续几分钟且看起来像卡住；请等到出现
`Done in ... using pnpm` 或命令提示符再执行下一条命令。
pnpm 输出的大量 `missing peer` 警告可以忽略：dsh 运行时通过安装目录的
fallback 解析这些 peer，Web 和插件仍会正常工作。
若 pnpm store 不可写，可在 `add` 末尾追加 `--store-dir /tmp/pnpm-store`。

AI 发言失败会自动重试一次，仍失败才标记为 `failed`。

M6 起：AI 发言流式上屏；面板宽度可在左边缘拖拽（宽度记忆在浏览器）；每个 AI 的 prompt 默认只带最近 40 条可见消息，超过部分会插入省略提示。

M7：补充 RPC 边界测试（remove/reorder/mention/dissolve、catalog 降级、wait 超时与并发唤醒），清理死错误码。

M8：消息分页（RPC 默认返回最近 100 条，面板向上滚动自动加载更早消息）+ 话题浏览下拉 + 长期议题锚点（不被滑动窗口截断）。`messagePageSize` 可配置。

自动多轮讨论：`/group auto <轮数 1-10> [议题]`，默认 3 轮，可中途启动；Web 面板设置区也有“启动自动讨论”。第一轮盲发规则不变；`/group stop` 会同时终止自动模式。

复制/导出：每条成员发言右上角有“复制”按钮；面板右上角“导出”按钮将完整群聊导出为 Markdown 文件。

临时写权限：`/group at <AI> --write <内容>` 或面板 @ 时勾选“允许本次写入”。仅当次 @ 生效，白名单为只读工具 + `write/edit`；`read-only` 沙箱下复选框禁用。

新议题：`/group topic <议题内容>` 或面板“开启新议题”。新议题第 1 轮重新盲发，旧话题消息只在 UI 历史中显示，不进入新议题 AI 的 prompt。

M9：群聊面板支持**编辑当前群的配置**（maxAi/defaultTimeoutMs/readonlyTools/waitTimeoutMs/maxPromptMessages/messagePageSize，idle 时保存）；`/group config` 查看当前群配置；v0.2.0 版本/CHANGELOG/LICENSE；E2E 清单（浏览器自动化暂缓）。

启动 Web 后，请先在左侧会话列表中选择/打开一个会话；“群聊”按钮在会话
头部，选中会话后右下角也会出现浮动入口。修改插件并重新构建后，刷新页面
或重启 dsh 以加载新 client bundle。

若 AI 发言失败并出现 `Cannot read properties of undefined (reading
'prepare')`，通常是旧版插件清单把 dsh 核心包装成了生产依赖，导致 profile
内出现两份 `@deepseek-ai/dsh-tools`。执行一次依赖同步并重启即可：

```sh
dsh plugin --profile dsh-chatgroup install
```

Web UI：选中会话后，当前会话头部会显示“群聊”按钮；右下角也有浮动“群聊”入口。点击打开独立群聊抽屉，支持建群、成员管理、发言、@、结束按钮。

工作目录：群聊 AI 成员的只读工具继承**当前 dsh 会话**的 cwd；面板会显示该目录。如需讨论其他项目，请切换到对应工作目录的会话。

面板关系：群聊抽屉与主聊天界面互相独立。群聊消息不会进入主 Agent 上下文，主 Agent 也不会自动参与群聊；两边只是共享同一个 dsh 会话身份和项目目录。

Host 命令版仍可用：

```text
/group create
/group add <名称> <provider> <model> [timeoutMs]
/group order <AI1> <AI2> ...
/group say <内容>
/group at <AI名称> <内容>
/group auto <轮数 1-10> [议题]
/group topic <议题内容>
/group mention on|off
/group status
/group members
/group stop
/group dissolve
```

持久化：M5 起群聊状态写入项目目录 `.dsh/chatgroup/<sessionId>.jsonl`；dsh 重启后自动恢复，解散群时删除日志。仍不修改 deepseek-harness 源码，也不写自定义 session 事件。

## 插件配置

以下 patch 配置是**新群的默认值**；每个群创建后可在群聊面板“群配置”区域单独修改。

在 profile 的 `cordis.patch.yml` 中覆盖默认值：

```yaml
- override:
    id: chatgroup
    config:
      maxAi: 5
      defaultTimeoutMs: 300000
      readonlyTools: [read, read_image, glob, grep]
      waitTimeoutMs: 25000
      maxPromptMessages: 40
      messagePageSize: 100
```

## 与 dsh 会话的关系

- 群聊不继承主会话对话历史；AI 成员通过 one-shot `spawn` 只看到群聊可见视图。
- AI 成员的 provider/model、persona、只读工具白名单、超时由群成员配置决定。
- 父会话 agent preset 附加的 system prompt 段落可能进入成员上下文；成员的 toolFilter 仍会把可执行能力限制为只读白名单。
- cwd 每次发言前从当前 dsh 会话实时读取；面板会跟随当前会话切换。
- 群状态按 sessionId 隔离；切换会话不会破坏数据，重启后从 `.dsh/chatgroup` 恢复。

