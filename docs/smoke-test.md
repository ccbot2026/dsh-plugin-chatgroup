# chat-group M2/M3 冒烟验证记录

日期：2026-08-15

## 环境

- 插件源码：`dsh-plugin-chatgroup`
- dsh CLI：`@deepseek-ai/dsh@0.1.0-rc.6`
- web bundle：`@deepseek-ai/dsh-web-app@0.1.0-rc.6`
- 临时 profile：`chatgroup-smoke`
- 临时 `DSH_HOME` 与 pnpm store 均指向 `/tmp`，避免污染真实 `~/.dsh`

## 步骤

1. 创建临时工程并安装 dsh CLI。
2. 安装本插件到 profile：

   ```sh
   dsh plugin --profile chatgroup-smoke add /path/to/dsh-plugin-chatgroup --store-dir /tmp/pnpm-store
   dsh plugin --profile chatgroup-smoke add @deepseek-ai/dsh-web-app@0.1.0-rc.6 --store-dir /tmp/pnpm-store
   ```

3. 检查组合配置：

   ```sh
   dsh --profile chatgroup-smoke --dump-config
   ```

   结果：出现 `# == dsh-plugin-chatgroup` 层，`chatgroup` 行正常插入。

4. 启动 Web：

   ```sh
   dsh --profile chatgroup-smoke --host 127.0.0.1 --port 3099
   ```

5. 抓取首页 boot manifest：

   - `window.__DSH_BOOT__` 中出现本插件 client 行：

     ```json
     {
       "id": "dsh-plugin-chatgroup",
       "url": "/plugins/dsh-plugin-chatgroup/client.js?rev=...",
       "inject": [
         "@deepseek-ai/dsh-client-connection",
         "@deepseek-ai/dsh-client-runtime",
         "@deepseek-ai/dsh-client-ui-layout",
         "@deepseek-ai/dsh-client-ui-conversation"
       ]
     }
     ```

6. 下载并检查 client bundle：

   - 以 `window.__ModuleLoader__.load({ id: "dsh-plugin-chatgroup", factory })` 形式注册；
   - factory 为 CJS，导出 `inject = ["connection","slots"]` 与 `apply`。

7. 创建真实 dsh session：

   ```http
   POST /api/session.create
   {"sessionId":"chatgroup-smoke-session","cwd":"/home/sll/projects/dsh-plugin-chatgroup"}
   ```

   结果：`{ ok: true, value: { sessionId: ..., agentPreset: "standard" } }`。

8. 通过自定义 RPC channel 操作群聊：

   - `POST /chatgroup/create` → 群创建成功，revision 1；
   - `POST /chatgroup/members.add` → Alice 成员加入，携带只读工具白名单；
   - `POST /chatgroup/snapshot` → 返回完整群快照；
   - `POST /chatgroup/catalog` → 返回已注册 provider 与模型列表。

## 结论

- Host 插件在真实 dsh profile 中加载成功。
- `dsh.client` 声明被 client-modules 正确扫描，client bundle 进入 boot graph 并可从 `/plugins/dsh-plugin-chatgroup/client.js` 下载。
- 自定义 `/chatgroup` RPC channel 注册成功，并通过真实 HTTP trust fence 调用。
- 群服务可在真实 live Agent/Session 上创建群、添加 AI 成员、读取快照。

## 附加：npm 包产物验证

- `npm pack --pack-destination /tmp` 生成 `dsh-plugin-chatgroup-0.1.0.tgz`（20 个文件，含 host dist 与 client bundle）。
- 新建 profile 并从 tarball 安装：

  ```sh
  dsh plugin --profile chatgroup-tar add /tmp/dsh-plugin-chatgroup-0.1.0.tgz --store-dir /tmp/pnpm-store
  dsh plugin --profile chatgroup-tar add @deepseek-ai/dsh-web-app@0.1.0-rc.6 --store-dir /tmp/pnpm-store
  ```

- `dsh --profile chatgroup-tar --dump-config` 正常出现插件层。
- 启动 Web 后首页 boot graph 同样包含 `dsh-plugin-chatgroup` client bundle 行。

## 附加：真实 one-shot 子 Agent 发言路径

在真实 profile 中创建 session、群和 Alice 成员后调用 `send`：

- 群进入 `running`，当前发言人 Alice，消息状态 `speaking`，第一轮 `blindRoundActive: true`；
- 实际走了 `ctx.subagents.start('spawn')` 路径（无模型凭证时子 Agent 以 `error` 结束）；
- 调度器将消息标记为 `failed`、本轮结束、`blindRoundActive` 置 `false`，没有阻塞或崩溃；
- 这验证了 Host 调度器与真实 dsh Agent/Subagent 服务的集成。
