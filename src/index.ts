import type { Context } from '@deepseek-ai/cordis'
import { registerChatGroupCommands } from './commands.js'
import { ChatGroupService } from './group-service.js'
import { registerChatGroupRpc } from './rpc.js'
import { DEFAULT_MAX_AI, DEFAULT_MAX_GROUPS, DEFAULT_MAX_PROMPT_MESSAGES, DEFAULT_MESSAGE_PAGE_SIZE, DEFAULT_READONLY_TOOLS, DEFAULT_SPEECH_TIMEOUT_MS, DEFAULT_WAIT_TIMEOUT_MS } from './types.js'
import type { ChatGroupConfig } from './types.js'

export const name = 'chatgroup'
export const inject = ['subagents', 'commands']

export function apply(ctx: Context, config: Partial<ChatGroupConfig> = {}): void {
  const service = new ChatGroupService(ctx, {
    maxAi: config.maxAi ?? DEFAULT_MAX_AI,
    maxGroups: config.maxGroups ?? DEFAULT_MAX_GROUPS,
    defaultTimeoutMs: config.defaultTimeoutMs ?? DEFAULT_SPEECH_TIMEOUT_MS,
    readonlyTools: config.readonlyTools ?? DEFAULT_READONLY_TOOLS,
    waitTimeoutMs: config.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
    maxPromptMessages: config.maxPromptMessages ?? DEFAULT_MAX_PROMPT_MESSAGES,
    messagePageSize: config.messagePageSize ?? DEFAULT_MESSAGE_PAGE_SIZE,
  })

  const commandDisposers = registerChatGroupCommands(ctx, service)
  const disposeSessionListener = ctx.on('session/disposed', (session) => {
    service.disposeSession(session.id)
  })

  // The Web RPC channel is optional at the Host composition level. It mounts
  // automatically whenever connection/agents/llm are available (dsh Web UI).
  ctx.inject(['connection', 'agents', 'llm'], (rpcCtx) => {
    rpcCtx.effect(() => {
      const disposeRpc = registerChatGroupRpc(rpcCtx, service)
      return () => disposeRpc()
    }, 'chatgroup: /chatgroup RPC channel')
  })

  ctx.effect(() => () => {
    disposeSessionListener()
    for (const dispose of commandDisposers) dispose()
    service.disposeAll()
  })
}

export type {
  AiMemberConfig,
  ChatGroupConfig,
  ChatGroupMember,
  ChatGroupMessage,
  ChatGroupSnapshot,
  ChatGroupSummary,
  CreateAiMemberInput,
  GroupId,
  GroupStatus,
  MemberKind,
  MemberRole,
  MessageStatus,
} from './types.js'
export { DEFAULT_MAX_AI, DEFAULT_MAX_GROUPS, DEFAULT_READONLY_TOOLS, DEFAULT_SPEECH_TIMEOUT_MS, USER_MEMBER_ID } from './types.js'
