import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { speakOnce } from './ai-speaker.js'
import {
  appendPersistedRecord,
  listPersistedGroupIds,
  readPersistedRecords,
  removeAllPersistedLogs,
  removePersistedLog,
  type PersistedRecord,
} from './persistence.js'
import { ChatGroupError } from './errors.js'
import {
  DEFAULT_AI_PROACTIVE,
  DEFAULT_MAX_AI,
  DEFAULT_MAX_AI_MENTION_DEPTH,
  DEFAULT_MAX_GROUPS,
  DEFAULT_MAX_PROACTIVE_PER_ROUND,
  DEFAULT_MAX_PROMPT_MESSAGES,
  DEFAULT_MESSAGE_PAGE_SIZE,
  DEFAULT_READONLY_TOOLS,
  DEFAULT_SPEECH_TIMEOUT_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  DEFAULT_MAX_EDITABLE_MESSAGES,
  SYSTEM_MEMBER_ID,
  USER_MEMBER_ID,
} from './types.js'
import type {
  AiMemberConfig,
  ChatGroupConfig,
  ChatGroupMember,
  ChatGroupMessage,
  ChatGroupSnapshot,
  ChatGroupSummary,
  ChatTopic,
  CreateAiMemberInput,
  GroupId,
  SoloRequest,
  GroupStatus,
  MessageStatus,
} from './types.js'
import { buildMemberPersona, buildMemberPrompt } from './visibility.js'

interface InternalGroup {
  readonly id: string
  /** V2.5: display name; undefined = falls back to the group id. */
  name?: string
  readonly sessionId: SessionId
  /** Parent-session cwd; refreshed before each speech from the live session header. */
  cwd?: string
  revision: number
  status: GroupStatus
  mode: 'idle' | 'round' | 'solo'
  round: number
  roundOneClosed: boolean
  mentionEnabled: boolean
  members: ChatGroupMember[]
  speakerOrder: string[]
  messages: ChatGroupMessage[]
  roundCursor: number
  soloQueue: SoloRequest[]
  currentSpeakerId?: string
  currentMessageId?: string
  currentController?: AbortController
  currentRun?: import('@deepseek-ai/dsh-subagent').SubagentRun
  currentTimer?: ReturnType<typeof setTimeout>
  loopRunning: boolean
  stopRequested: boolean
  destroyed: boolean
  autoActive: boolean
  autoStartRound: number
  autoTotalRounds: number
  settings: ChatGroupConfig
  currentTopicId: string
  topicCounter: number
  topics: ChatTopic[]
  sandboxMode: string
  /** V2.3: proactive phase state. */
  proactiveActive: boolean
  proactiveQueue: string[]
  proactiveRound: number
  proactiveCount: number
  /** V2.3: dedupe AI @ targets within one round to prevent loops. */
  mentionSeen: Set<string>
  /** V2.5: live tool activity of the current speaker (tool name + target). */
  toolActivity?: { memberId: string; tool: string; argsPreview: string; active: boolean }
}

export interface ChatGroupServiceConfig {
  readonly maxAi?: number
  readonly maxGroups?: number
  readonly defaultTimeoutMs?: number
  readonly readonlyTools?: readonly string[]
  readonly waitTimeoutMs?: number
  readonly maxPromptMessages?: number
  readonly messagePageSize?: number
  readonly maxEditableMessages?: number
  readonly aiProactive?: boolean
  readonly maxProactivePerRound?: number
  readonly maxAiMentionDepth?: number
}

interface RevisionWaiter {
  readonly revision: number
  readonly resolve: (value: { changed: boolean; snapshot: ChatGroupSnapshot | null }) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly onAbort: () => void
}

export class ChatGroupService {
  private readonly groups = new Map<SessionId, Map<GroupId, InternalGroup>>()
  private readonly waiters = new Map<string, Set<RevisionWaiter>>()
  private readonly currentGroupId = new Map<SessionId, GroupId>()
  private readonly config: ChatGroupConfig

  constructor(private readonly ctx: Context, config: ChatGroupServiceConfig = {}) {
    const maxAi = config.maxAi ?? DEFAULT_MAX_AI
    if (!Number.isSafeInteger(maxAi) || maxAi <= 0) {
      throw new Error('chatgroup: maxAi must be a positive integer')
    }
    const maxGroups = config.maxGroups ?? DEFAULT_MAX_GROUPS
    if (!Number.isSafeInteger(maxGroups) || maxGroups <= 0) {
      throw new Error('chatgroup: maxGroups must be a positive integer')
    }
    const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_SPEECH_TIMEOUT_MS
    if (!Number.isSafeInteger(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
      throw new Error('chatgroup: defaultTimeoutMs must be a positive integer')
    }
    const readonlyTools = config.readonlyTools ?? DEFAULT_READONLY_TOOLS
    if (readonlyTools.length === 0 || readonlyTools.some(tool => typeof tool !== 'string' || tool.length === 0)) {
      throw new Error('chatgroup: readonlyTools must be a non-empty string array')
    }
    const waitTimeoutMs = config.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs <= 0) {
      throw new Error('chatgroup: waitTimeoutMs must be a positive integer')
    }
    const maxPromptMessages = config.maxPromptMessages ?? DEFAULT_MAX_PROMPT_MESSAGES
    if (!Number.isSafeInteger(maxPromptMessages) || maxPromptMessages < 0) {
      throw new Error('chatgroup: maxPromptMessages must be a non-negative integer (0 = unlimited)')
    }
    const messagePageSize = config.messagePageSize ?? DEFAULT_MESSAGE_PAGE_SIZE
    if (!Number.isSafeInteger(messagePageSize) || messagePageSize <= 0) {
      throw new Error('chatgroup: messagePageSize must be a positive integer')
    }
    const maxEditableMessages = config.maxEditableMessages ?? DEFAULT_MAX_EDITABLE_MESSAGES
    if (!Number.isSafeInteger(maxEditableMessages) || maxEditableMessages < 0) {
      throw new Error('chatgroup: maxEditableMessages must be a non-negative integer (0 = no editing)')
    }
    this.config = {
      maxAi,
      maxGroups,
      defaultTimeoutMs,
      readonlyTools,
      waitTimeoutMs,
      maxPromptMessages,
      messagePageSize,
      maxEditableMessages,
      aiProactive: config.aiProactive ?? DEFAULT_AI_PROACTIVE,
      maxProactivePerRound: config.maxProactivePerRound ?? DEFAULT_MAX_PROACTIVE_PER_ROUND,
      maxAiMentionDepth: config.maxAiMentionDepth ?? DEFAULT_MAX_AI_MENTION_DEPTH,
    }
  }

  get defaultTimeoutMs(): number {
    return this.config.defaultTimeoutMs
  }

  get waitTimeoutMs(): number {
    return this.config.waitTimeoutMs
  }

  get maxPromptMessages(): number {
    return this.config.maxPromptMessages
  }

  get messagePageSize(): number {
    return this.config.messagePageSize
  }

  get maxGroups(): number {
    return this.config.maxGroups
  }

  configView(): ChatGroupConfig {
    return {
      maxAi: this.config.maxAi,
      maxGroups: this.config.maxGroups,
      defaultTimeoutMs: this.config.defaultTimeoutMs,
      readonlyTools: [...this.config.readonlyTools],
      waitTimeoutMs: this.config.waitTimeoutMs,
      maxPromptMessages: this.config.maxPromptMessages,
      messagePageSize: this.config.messagePageSize,
      maxEditableMessages: this.config.maxEditableMessages,
      aiProactive: this.config.aiProactive,
      maxProactivePerRound: this.config.maxProactivePerRound,
      maxAiMentionDepth: this.config.maxAiMentionDepth,
    }
  }

  topicMessages(sessionId: SessionId, topicId: string, groupId?: GroupId): ChatGroupMessage[] | null {
    const group = this.requireGroupById(sessionId, groupId)
    if (group === undefined) return null
    return group.messages.filter(message =>
      topicId === 'topic-1'
        ? message.topicId === undefined || message.topicId === 'topic-1'
        : message.topicId === topicId)
  }

  messagesBefore(
    sessionId: SessionId,
    beforeSeq: number,
    limit = this.config.messagePageSize,
    groupId?: GroupId,
  ): { messages: readonly ChatGroupMessage[]; hasMore: boolean; oldestLoadedSeq?: number } | null {
    const group = this.requireGroupById(sessionId, groupId)
    if (group === undefined) return null
    const pageSize = Math.max(1, Math.min(limit, group.settings.messagePageSize * 4))
    const end = Math.min(beforeSeq, group.messages.length)
    const start = Math.max(0, end - pageSize)
    const messages = group.messages.slice(start, end)
    return {
      messages,
      hasMore: start > 0,
      ...messages[0] === undefined ? {} : { oldestLoadedSeq: messages[0].seq },
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  create(agent: Agent): ChatGroupSnapshot {
    const sessionId = agent.session.id
    this.ensureLoaded(agent)
    const sessionGroups = this.groups.get(sessionId)
    const groupCount = sessionGroups?.size ?? 0
    if (groupCount >= this.config.maxGroups) {
      throw new ChatGroupError(
        'GROUP_LIMIT_EXCEEDED',
        `当前会话最多 ${String(this.config.maxGroups)} 个群（maxGroups 可配置）`,
      )
    }

    const group: InternalGroup = {
      id: `group-${String(groupCount + 1)}`,
      sessionId,
      ...agent.session.header?.cwd === undefined ? {} : { cwd: agent.session.header?.cwd },
      revision: 0,
      status: 'idle',
      mode: 'idle',
      round: 0,
      roundOneClosed: false,
      mentionEnabled: true,
      members: [{
        id: USER_MEMBER_ID,
        kind: 'user',
        role: 'admin',
        name: '用户',
      }],
      speakerOrder: [],
      messages: [],
      roundCursor: 0,
      soloQueue: [],
      loopRunning: false,
      stopRequested: false,
      destroyed: false,
      autoActive: false,
      autoStartRound: 0,
      autoTotalRounds: 0,
      currentTopicId: 'topic-1',
      topicCounter: 1,
      sandboxMode: this.readSandboxMode(agent),
      proactiveActive: false,
      proactiveQueue: [],
      proactiveRound: 0,
      proactiveCount: 0,
      mentionSeen: new Set(),
      topics: [{
        id: 'topic-1',
        title: '默认话题',
        round: 0,
        messageCount: 0,
        createdAt: Date.now(),
      }],
      settings: {
        maxAi: this.config.maxAi,
        maxGroups: this.config.maxGroups,
        defaultTimeoutMs: this.config.defaultTimeoutMs,
        readonlyTools: [...this.config.readonlyTools],
        waitTimeoutMs: this.config.waitTimeoutMs,
        maxPromptMessages: this.config.maxPromptMessages,
        messagePageSize: this.config.messagePageSize,
        maxEditableMessages: this.config.maxEditableMessages,
        aiProactive: this.config.aiProactive,
        maxProactivePerRound: this.config.maxProactivePerRound,
        maxAiMentionDepth: this.config.maxAiMentionDepth,
      },
    }

    let sessionGroupsMap = this.groups.get(sessionId)
    if (sessionGroupsMap === undefined) this.groups.set(sessionId, sessionGroupsMap = new Map())
    sessionGroupsMap.set(group.id, group)
    this.currentGroupId.set(sessionId, group.id)
    this.bump(group)
    this.persistState(group)
    return this.snapshotOf(group)
  }

  dissolve(agent: Agent, groupId?: GroupId): void {
    const sessionId = agent.session.id
    const group = this.requireGroup(agent, groupId)
    if (group === undefined) {
      throw new ChatGroupError('NO_GROUP', '当前会话还没有群聊')
    }

    group.destroyed = true
    group.stopRequested = true
    group.soloQueue = []
    group.currentController?.abort(new Error('group dissolved'))
    if (group.currentTimer !== undefined) clearTimeout(group.currentTimer)
    this.groups.get(sessionId)?.delete(group.id)
    this.cancelWaiters(sessionId, group.id, true)
    if (this.currentGroupId.get(sessionId) === group.id) {
      const remaining = [...this.groups.get(sessionId)?.keys() ?? []]
      this.currentGroupId.set(sessionId, remaining[0])
    }
    if (group.cwd !== undefined) {
      try {
        removePersistedLog(group.cwd, String(group.sessionId), group.id)
      } catch (error: unknown) {
        this.ctx.logger('chatgroup').warn(
          `failed to remove persisted group log: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  disposeSession(sessionId: SessionId): void {
    const sessionGroups = this.groups.get(sessionId)
    if (sessionGroups === undefined) return
    for (const group of sessionGroups.values()) {
      this.cancelWaiters(sessionId, group.id, false)
      group.destroyed = true
      group.stopRequested = true
      group.soloQueue = []
      group.currentController?.abort(new Error('session disposed'))
      if (group.currentTimer !== undefined) clearTimeout(group.currentTimer)
    }
    this.groups.delete(sessionId)
    this.currentGroupId.delete(sessionId)
  }

  disposeAll(): void {
    for (const sessionId of [...this.groups.keys()]) {
      this.disposeSession(sessionId)
    }
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  snapshot(agent: Agent, groupId?: GroupId): ChatGroupSnapshot | null {
    this.ensureLoaded(agent)
    const group = this.requireGroupById(agent.session.id, groupId)
    if (group === undefined || group.destroyed) return null
    this.syncSandboxMode(agent, group)
    return this.snapshotOf(group)
  }

  requireSnapshot(agent: Agent, groupId?: GroupId): ChatGroupSnapshot {
    const snapshot = this.snapshot(agent, groupId)
    if (snapshot === null) {
      throw new ChatGroupError('NO_GROUP', '当前会话还没有群聊，请先 /group create')
    }
    return snapshot
  }

  /** Resolve and remember the group that commands/panel operate on by default. */
  useGroup(agent: Agent, groupId: GroupId): ChatGroupSnapshot {
    const group = this.requireGroup(agent, groupId)
    this.currentGroupId.set(agent.session.id, group.id)
    return this.snapshotOf(group)
  }

  /** V2.5: rename a group for display. */
  renameGroup(agent: Agent, name: string, groupId?: GroupId): ChatGroupSnapshot {
    const group = this.requireGroup(agent, groupId)
    const normalized = name.trim()
    if (normalized.length === 0 || normalized.length > 40) {
      throw new ChatGroupError('INVALID_NAME', '群名称必须是 1–40 个字符')
    }
    group.name = normalized
    this.bump(group)
    this.persistState(group)
    return this.snapshotOf(group)
  }

  // ── member management ─────────────────────────────────────────────────────

  addMember(agent: Agent, input: CreateAiMemberInput, groupId?: GroupId): ChatGroupSnapshot {
    const group = this.requireGroup(agent, groupId)
    this.assertIdle(group)

    const name = input.name.trim()
    if (name.length === 0) {
      throw new ChatGroupError('INVALID_NAME', 'AI 成员名称不能为空')
    }
    if (group.members.some(member => member.name === name)) {
      throw new ChatGroupError('DUPLICATE_MEMBER', `成员名称 "${name}" 已存在`)
    }

    const provider = input.provider.trim()
    const model = input.model.trim()
    if (provider.length === 0 || model.length === 0) {
      throw new ChatGroupError('INVALID_NAME', 'provider 和 model 不能为空')
    }

    const llm = this.ctx.get('llm') as { listProviders(): Array<{ id: string }> } | undefined
    if (llm !== undefined && !llm.listProviders().some(candidate => candidate.id === provider)) {
      throw new ChatGroupError('UNKNOWN_PROVIDER', `provider "${provider}" 未注册；可用 provider 见群聊面板目录`)
    }

    const tools = this.ctx.get('tools') as {
      schemas(scope?: object): Array<{ name: string }>
    } | undefined
    if (tools !== undefined) {
      const visible = new Set(tools.schemas(agent).map(schema => schema.name))
      for (const toolName of this.config.readonlyTools) {
        if (!visible.has(toolName)) {
          throw new ChatGroupError('UNKNOWN_TOOL', `只读工具 "${toolName}" 未组合进当前 profile，无法创建可读文件的 AI 成员`)
        }
      }
    }

    const timeoutMs = input.timeoutMs ?? group.settings.defaultTimeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new ChatGroupError('INVALID_TIMEOUT', `超时必须是正整数毫秒，收到 ${String(timeoutMs)}`)
    }

    const aiCount = group.members.filter(member => member.kind === 'ai').length
    if (aiCount >= group.settings.maxAi) {
      throw new ChatGroupError('AI_LIMIT_EXCEEDED', `群聊最多 ${String(group.settings.maxAi)} 个 AI 成员`)
    }

    const id = `ai-${randomUUID()}`
    const member: ChatGroupMember = {
      id,
      kind: 'ai',
      role: 'member',
      name,
      ai: {
        provider,
        model,
        ...input.systemPrompt?.trim() ? { systemPrompt: input.systemPrompt.trim() } : {},
        timeoutMs,
        tools: [...group.settings.readonlyTools],
      },
    }

    group.members = [...group.members, member]
    group.speakerOrder = [...group.speakerOrder, id]
    this.bump(group)
    this.persistState(group)
    return this.snapshotOf(group)
  }

  removeMember(agent: Agent, memberName: string, groupId?: GroupId): ChatGroupSnapshot {
    const group = this.requireGroup(agent, groupId)
    this.assertIdle(group)
    const member = this.findAiMember(group, memberName)
    group.members = group.members.filter(candidate => candidate.id !== member.id)
    group.speakerOrder = group.speakerOrder.filter(id => id !== member.id)
    group.soloQueue = group.soloQueue.filter(request => request.memberId !== member.id)
    this.bump(group)
    this.persistState(group)
    return this.snapshotOf(group)
  }

  reorderMembers(agent: Agent, names: readonly string[], groupId?: GroupId): ChatGroupSnapshot {
    const group = this.requireGroup(agent, groupId)
    this.assertIdle(group)

    const resolved: string[] = []
    for (const name of names) {
      const member = this.findAiMember(group, name)
      if (resolved.includes(member.id)) {
        throw new ChatGroupError('INVALID_ORDER', `成员名称 "${name}" 重复`)
      }
      resolved.push(member.id)
    }

    const currentIds = new Set(group.speakerOrder)
    if (resolved.length !== currentIds.size || resolved.some(id => !currentIds.has(id))) {
      throw new ChatGroupError('INVALID_ORDER', '发言顺序必须恰好包含所有 AI 成员')
    }

    group.speakerOrder = resolved
    this.bump(group)
    this.persistState(group)
    return this.snapshotOf(group)
  }

  setMentionEnabled(agent: Agent, enabled: boolean, groupId?: GroupId): ChatGroupSnapshot {
    const group = this.requireGroup(agent, groupId)
    group.mentionEnabled = enabled
    this.bump(group)
    this.persistState(group)
    return this.snapshotOf(group)
  }

  configFor(agent: Agent, groupId?: GroupId): ChatGroupConfig {
    const group = this.requireGroup(agent, groupId)
    if (group === undefined) return this.configView()
    return {
      maxAi: group.settings.maxAi,
      maxGroups: group.settings.maxGroups,
      defaultTimeoutMs: group.settings.defaultTimeoutMs,
      readonlyTools: [...group.settings.readonlyTools],
      waitTimeoutMs: group.settings.waitTimeoutMs,
      maxPromptMessages: group.settings.maxPromptMessages,
      messagePageSize: group.settings.messagePageSize,
      maxEditableMessages: group.settings.maxEditableMessages,
      aiProactive: group.settings.aiProactive,
      maxProactivePerRound: group.settings.maxProactivePerRound,
      maxAiMentionDepth: group.settings.maxAiMentionDepth,
    }
  }

  updateConfig(agent: Agent, patch: Partial<ChatGroupConfig>, groupId?: GroupId): ChatGroupSnapshot {
    const group = this.requireGroup(agent, groupId)
    this.assertIdle(group)

    const next: ChatGroupConfig = {
      maxAi: patch.maxAi ?? group.settings.maxAi,
      maxGroups: patch.maxGroups ?? group.settings.maxGroups,
      defaultTimeoutMs: patch.defaultTimeoutMs ?? group.settings.defaultTimeoutMs,
      readonlyTools: patch.readonlyTools === undefined
        ? [...group.settings.readonlyTools]
        : [...patch.readonlyTools],
      waitTimeoutMs: patch.waitTimeoutMs ?? group.settings.waitTimeoutMs,
      maxPromptMessages: patch.maxPromptMessages ?? group.settings.maxPromptMessages,
      messagePageSize: patch.messagePageSize ?? group.settings.messagePageSize,
      maxEditableMessages: patch.maxEditableMessages ?? group.settings.maxEditableMessages,
      aiProactive: patch.aiProactive ?? group.settings.aiProactive,
      maxProactivePerRound: patch.maxProactivePerRound ?? group.settings.maxProactivePerRound,
      maxAiMentionDepth: patch.maxAiMentionDepth ?? group.settings.maxAiMentionDepth,
    }

    if (!Number.isSafeInteger(next.maxAi) || next.maxAi < 1 || next.maxAi > 5) {
      throw new ChatGroupError('INVALID_ROUNDS', 'maxAi 必须是 1–5 的整数')
    }
    const aiCount = group.members.filter(member => member.kind === 'ai').length
    if (next.maxAi < aiCount) {
      throw new ChatGroupError('AI_LIMIT_EXCEEDED', `maxAi 不能小于当前 AI 成员数 ${String(aiCount)}`)
    }
    if (!Number.isSafeInteger(next.maxGroups) || next.maxGroups < 1) {
      throw new ChatGroupError('INVALID_ROUNDS', 'maxGroups 必须是正整数')
    }
    if (!Number.isSafeInteger(next.defaultTimeoutMs) || next.defaultTimeoutMs <= 0) {
      throw new ChatGroupError('INVALID_TIMEOUT', 'defaultTimeoutMs 必须是正整数毫秒')
    }
    if (next.readonlyTools.length === 0 || next.readonlyTools.some(tool => typeof tool !== 'string' || tool.length === 0)) {
      throw new ChatGroupError('INVALID_NAME', 'readonlyTools 必须是非空工具名列表')
    }
    if (!Number.isSafeInteger(next.waitTimeoutMs) || next.waitTimeoutMs <= 0) {
      throw new ChatGroupError('INVALID_TIMEOUT', 'waitTimeoutMs 必须是正整数毫秒')
    }
    if (!Number.isSafeInteger(next.maxPromptMessages) || next.maxPromptMessages < 0) {
      throw new ChatGroupError('INVALID_ROUNDS', 'maxPromptMessages 必须是非负整数')
    }
    if (!Number.isSafeInteger(next.messagePageSize) || next.messagePageSize <= 0) {
      throw new ChatGroupError('INVALID_ROUNDS', 'messagePageSize 必须是正整数')
    }
    if (!Number.isSafeInteger(next.maxEditableMessages) || next.maxEditableMessages < 0) {
      throw new ChatGroupError('INVALID_ROUNDS', 'maxEditableMessages 必须是非负整数')
    }
    if (!Number.isSafeInteger(next.maxProactivePerRound) || next.maxProactivePerRound < 0) {
      throw new ChatGroupError('INVALID_ROUNDS', 'maxProactivePerRound 必须是非负整数')
    }
    if (!Number.isSafeInteger(next.maxAiMentionDepth) || next.maxAiMentionDepth < 0) {
      throw new ChatGroupError('INVALID_ROUNDS', 'maxAiMentionDepth 必须是非负整数')
    }

    group.settings = next
    group.members = group.members.map(member => member.kind === 'ai' && member.ai !== undefined
      ? { ...member, ai: { ...member.ai, tools: [...next.readonlyTools] } }
      : member)
    this.bump(group)
    this.persistState(group)
    return this.snapshotOf(group)
  }

  exportTranscript(agent: Agent, groupId?: GroupId): string {
    const group = this.requireGroup(agent, groupId)
    const lines: string[] = [
      '# 群聊记录',
      '',
      `- 会话：${String(group.sessionId)}`,
      `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
      `- 话题数：${String(group.topics.length)}`,
    ]

    for (const topic of group.topics) {
      lines.push('', `## 话题：${topic.title}`, '')
      const messages = group.messages.filter(message =>
        message.topicId === undefined
          ? topic.id === 'topic-1'
          : message.topicId === topic.id)
      if (messages.length === 0) {
        lines.push('（无消息）')
        continue
      }
      for (const message of messages) {
        const sender = message.senderId === USER_MEMBER_ID
          ? '用户'
          : message.senderId === SYSTEM_MEMBER_ID
            ? '系统'
            : group.members.find(member => member.id === message.senderId)?.name ?? message.senderId
        const time = new Date(message.createdAt).toLocaleString('zh-CN')
        lines.push(`### ${sender} · ${time}${message.writeAccess === true ? ' · 临时写权限' : ''}`, '')
        if (message.text.length > 0) {
          lines.push(message.text)
        } else if (message.status === 'speaking') {
          lines.push('（正在输入…）')
        } else {
          lines.push(`（${message.status === 'timeout' ? '超时' : message.status === 'cancelled' ? '已取消' : '失败'}）`)
        }
        if (message.error !== undefined) lines.push('', `> ${message.error}`)
        lines.push('')
      }
    }

    return lines.join('\n').trim()
  }

  // ── conversation actions ──────────────────────────────────────────────────

  send(agent: Agent, text: string, groupId?: GroupId): ChatGroupSnapshot {
    const group = this.requireGroup(agent, groupId)
    const normalized = text.trim()
    if (normalized.length === 0) {
      throw new ChatGroupError('INVALID_TEXT', '发言内容不能为空')
    }

    if (group.status === 'idle') {
      if (group.speakerOrder.length === 0) {
        throw new ChatGroupError('NO_AI_MEMBERS', '请先添加至少一个 AI 成员')
      }
      group.round += 1
      group.mode = 'round'
      group.status = 'running'
      group.roundCursor = 0
      group.soloQueue = []
      group.stopRequested = false
    }

    const round = group.mode === 'round' ? group.round : 0
    this.appendUserMessage(group, normalized, [], round)
    this.kick(agent, group)
    return this.snapshotOf(group)
  }

  at(agent: Agent, memberName: string, text: string, options: { writeAccess?: boolean } = {}, groupId?: GroupId): ChatGroupSnapshot {
    const group = this.requireGroup(agent, groupId)
    if (!group.mentionEnabled) {
      throw new ChatGroupError('MENTION_DISABLED', '@ 功能当前已关闭')
    }
    if (options.writeAccess === true && group.sandboxMode === 'read-only') {
      throw new ChatGroupError('WRITE_BLOCKED', '当前为 read-only 模式，无法授予临时写权限')
    }
    const target = this.findAiMember(group, memberName)
    const normalized = text.trim()
    if (normalized.length === 0) {
      throw new ChatGroupError('INVALID_TEXT', '@ 发言内容不能为空')
    }

    if (group.status === 'idle') {
      group.mode = 'solo'
      group.status = 'running'
      group.roundCursor = 0
      group.soloQueue = []
      group.stopRequested = false
    }

    const round = group.mode === 'round' ? group.round : 0
    const writeAccess = options.writeAccess === true
    this.appendUserMessage(group, normalized, [target.id], round, writeAccess)
    group.soloQueue.push({ memberId: target.id, writeAccess, depth: 0 })
    this.kick(agent, group)
    return this.snapshotOf(group)
  }

  startAuto(agent: Agent, maxRounds: number, topic?: string, groupId?: GroupId): ChatGroupSnapshot {
    const group = this.requireGroup(agent, groupId)
    this.assertIdle(group)
    if (group.speakerOrder.length === 0) {
      throw new ChatGroupError('NO_AI_MEMBERS', '请先添加至少一个 AI 成员')
    }
    if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 10) {
      throw new ChatGroupError('INVALID_ROUNDS', '自动讨论轮数必须是 1–10 的整数')
    }

    group.round += 1
    group.mode = 'round'
    group.status = 'running'
    group.roundCursor = 0
    group.soloQueue = []
    group.stopRequested = false
    group.autoActive = true
    group.autoStartRound = group.round
    group.autoTotalRounds = maxRounds

    this.appendSystemMessage(group, `自动讨论开始，共 ${String(maxRounds)} 轮。`, group.round)
    const normalizedTopic = topic?.trim()
    if (normalizedTopic !== undefined && normalizedTopic.length > 0) {
      this.appendUserMessage(group, normalizedTopic, [], group.round)
    }

    this.bump(group)
    this.persistState(group)
    this.kick(agent, group)
    return this.snapshotOf(group)
  }

  stop(agent: Agent, groupId?: GroupId): ChatGroupSnapshot {
    const group = this.requireGroup(agent, groupId)
    if (group.status === 'idle') return this.snapshotOf(group)

    group.stopRequested = true
    group.autoActive = false
    group.soloQueue = []
    group.roundCursor = group.speakerOrder.length
    group.currentController?.abort(new Error('group round stopped'))
    this.bump(group)
    return this.snapshotOf(group)
  }

  // ── message edit / withdraw (V2.2) ───────────────────────────────────────

  /**
   * Edit one message's visible text. Only the human admin may edit, only
   * non-speech messages that are not withdrawn, and only within the newest
   * `maxEditableMessages` by seq. The original text is preserved for audit.
   */
  editMessage(agent: Agent, seq: number, text: string, groupId?: GroupId): ChatGroupSnapshot {
    const group = this.requireGroup(agent, groupId)
    const normalized = text.trim()
    if (normalized.length === 0) {
      throw new ChatGroupError('INVALID_TEXT', '编辑内容不能为空')
    }
    const target = this.findEditableMessage(group, seq, '编辑')
    group.messages = group.messages.map(candidate => candidate.id === target.id
      ? {
        ...candidate,
        editedText: normalized,
        editedAt: Date.now(),
      }
      : candidate)
    this.bump(group)
    this.persistState(group)
    return this.snapshotOf(group)
  }

  /** Withdraw one message: it vanishes from every future AI prompt. */
  withdrawMessage(agent: Agent, seq: number, groupId?: GroupId): ChatGroupSnapshot {
    const group = this.requireGroup(agent, groupId)
    const target = this.findEditableMessage(group, seq, '撤回')
    group.messages = group.messages.map(candidate => candidate.id === target.id
      ? { ...candidate, status: 'withdrawn' as const }
      : candidate)
    this.bump(group)
    this.persistState(group)
    return this.snapshotOf(group)
  }

  /** Resolve an editable message: exists, not speaking, not withdrawn, within the editable window. */
  private findEditableMessage(group: InternalGroup, seq: number, verb: string): ChatGroupMessage {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new ChatGroupError('INVALID_TEXT', `${verb}目标 seq 必须是正整数`)
    }
    const target = group.messages.find(message => message.seq === seq)
    if (target === undefined) {
      throw new ChatGroupError('MESSAGE_NOT_FOUND', `找不到 seq=${String(seq)} 的消息`)
    }
    if (target.status === 'speaking') {
      throw new ChatGroupError('MESSAGE_NOT_EDITABLE', '发言中的消息不能编辑或撤回')
    }
    if (target.status === 'withdrawn') {
      throw new ChatGroupError('MESSAGE_NOT_EDITABLE', '已撤回的消息不能再次编辑或撤回')
    }
    const windowSize = group.settings.maxEditableMessages
    if (windowSize > 0) {
      const newestSeq = group.messages.reduce((max, message) => Math.max(max, message.seq), -1)
      if (seq < newestSeq - windowSize + 1) {
        throw new ChatGroupError(
          'MESSAGE_NOT_EDITABLE',
          `只能${verb}最近 ${String(windowSize)} 条消息（seq > ${String(newestSeq - windowSize)}）`,
        )
      }
    }
    return target
  }

  /** Resolve when the group state changes past `revision`, or after `timeoutMs`. */
  waitForRevision(
    sessionId: SessionId,
    revision: number,
    timeoutMs: number,
    signal: AbortSignal,
    groupId?: GroupId,
  ): Promise<{ changed: boolean; snapshot: ChatGroupSnapshot | null }> {
    const group = this.requireGroupById(sessionId, groupId)
    if (group !== undefined && group.revision > revision) {
      return Promise.resolve({ changed: true, snapshot: this.snapshotOf(group) })
    }

    return new Promise((resolve) => {
      const waiterKey = this.waiterKey(sessionId, groupId)
      let settled = false
      const settle = (changed: boolean): void => {
        if (settled) return
        settled = true
        const set = this.waiters.get(waiterKey)
        if (set !== undefined) {
          set.delete(waiter)
          if (set.size === 0) this.waiters.delete(waiterKey)
        }
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        const latest = this.requireGroupById(sessionId, groupId)
        resolve({
          changed,
          snapshot: latest === undefined ? null : this.snapshotOf(latest),
        })
      }

      const timer = setTimeout(() => settle(false), timeoutMs)
      timer.unref?.()
      const onAbort = (): void => settle(false)
      const waiter: RevisionWaiter = {
        revision,
        resolve: value => { settle(value.changed) },
        timer,
        onAbort,
      }

      if (signal.aborted) {
        onAbort()
        return
      }

      let set = this.waiters.get(waiterKey)
      if (set === undefined) this.waiters.set(waiterKey, set = new Set())
      set.add(waiter)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  // ── persistence ───────────────────────────────────────────────────────────

  private ensureLoaded(agent: Agent): void {
    const sessionId = agent.session.id
    if (this.groups.has(sessionId)) return

    const cwd = agent.session.header?.cwd
    if (cwd === undefined) return

    let persistedIds: string[]
    try {
      persistedIds = listPersistedGroupIds(cwd, String(sessionId))
    } catch (error: unknown) {
      this.ctx.logger('chatgroup').warn(
        `failed to list persisted group logs: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }

    if (persistedIds.length === 0) return

    let sessionGroups = this.groups.get(sessionId)
    if (sessionGroups === undefined) this.groups.set(sessionId, sessionGroups = new Map())
    for (const groupId of persistedIds) {
      if (sessionGroups.has(groupId)) continue
      const restored = this.restoreGroup(agent, groupId as GroupId, cwd)
      if (restored !== undefined) {
        sessionGroups.set(groupId as GroupId, restored)
        if (!this.currentGroupId.has(sessionId)) {
          this.currentGroupId.set(sessionId, groupId as GroupId)
        }
      }
    }
    if (sessionGroups.size === 0) this.groups.delete(sessionId)
  }

  private restoreGroup(agent: Agent, groupId: GroupId, cwd: string): InternalGroup | undefined {
    let records: PersistedRecord[]
    try {
      records = readPersistedRecords(cwd, String(agent.session.id), groupId)
    } catch (error: unknown) {
      this.ctx.logger('chatgroup').warn(
        `failed to read persisted group log: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }

    const state = [...records].reverse().find(record => record.kind === 'state')
    if (state?.kind !== 'state') return undefined

    const snapshot = state.snapshot
    const currentTopicId = snapshot.currentTopicId ?? 'topic-1'
    const topics: ChatTopic[] = snapshot.topics === undefined
      ? [{
        id: currentTopicId,
        title: '历史话题',
        round: snapshot.round,
        messageCount: snapshot.messages.length,
        createdAt: Date.now(),
      }]
      : [...snapshot.topics]
    const topicCounter = topics.length
    const messages = new Map(snapshot.messages.map(message => [message.seq, message]))
    let revision = state.revision

    for (const record of records) {
      if (record.revision <= state.revision) continue
      if (record.revision > revision) revision = record.revision
      if (record.kind === 'message') {
        messages.set(record.message.seq, record.message)
      }
    }

    let restoredMessages = [...messages.values()]
      .sort((left, right) => left.seq - right.seq)
      .map(message => message.status === 'speaking'
        ? { ...message, status: 'cancelled' as const, error: '进程重启，发言中断' }
        : message)
      .map(message => message.topicId === undefined ? { ...message, topicId: currentTopicId } : message)

    const wasAutoActive = snapshot.autoActive === true
    if (wasAutoActive) {
      restoredMessages = [...restoredMessages, {
        id: `msg-${randomUUID()}`,
        seq: restoredMessages.length,
        round: restoredMessages.reduce((round, message) => Math.max(round, message.round), snapshot.round),
        senderId: SYSTEM_MEMBER_ID,
        text: '自动讨论因进程重启而终止。',
        mentionIds: [],
        status: 'sent',
        createdAt: Date.now(),
      }]
    }

    const restoredRound = restoredMessages.reduce(
      (round, message) => Math.max(round, message.round),
      snapshot.round,
    )

    const group: InternalGroup = {
      id: groupId,
      ...snapshot.name === undefined ? {} : { name: snapshot.name },
      sessionId: snapshot.sessionId,
      ...snapshot.cwd === undefined ? {} : { cwd: snapshot.cwd },
      revision,
      status: 'idle',
      mode: 'idle',
      round: restoredRound,
      roundOneClosed: snapshot.round !== 1 || !snapshot.blindRoundActive,
      mentionEnabled: snapshot.mentionEnabled,
      members: [...snapshot.members],
      speakerOrder: [...snapshot.speakerOrder],
      messages: restoredMessages,
      roundCursor: 0,
      soloQueue: [],
      loopRunning: false,
      stopRequested: false,
      destroyed: false,
      autoActive: false,
      autoStartRound: 0,
      autoTotalRounds: 0,
      currentTopicId: 'topic-1',
      topicCounter: 1,
      sandboxMode: 'read-only',
      proactiveActive: false,
      proactiveQueue: [],
      proactiveRound: 0,
      proactiveCount: 0,
      mentionSeen: new Set(),
      topics: [{
        id: 'topic-1',
        title: '默认话题',
        round: 0,
        messageCount: 0,
        createdAt: Date.now(),
      }],
      settings: {
        maxAi: this.config.maxAi,
        maxGroups: this.config.maxGroups,
        defaultTimeoutMs: this.config.defaultTimeoutMs,
        readonlyTools: [...this.config.readonlyTools],
        waitTimeoutMs: this.config.waitTimeoutMs,
        maxPromptMessages: this.config.maxPromptMessages,
        messagePageSize: this.config.messagePageSize,
        maxEditableMessages: this.config.maxEditableMessages,
        aiProactive: this.config.aiProactive,
        maxProactivePerRound: this.config.maxProactivePerRound,
        maxAiMentionDepth: this.config.maxAiMentionDepth,
      },
    }

    this.syncSandboxMode(agent, group)
    if (wasAutoActive) this.persistState(group)
    return group
  }

  private persistState(group: InternalGroup): void {
    if (group.cwd === undefined) return
    this.persist(group, {
      kind: 'state',
      revision: group.revision,
      snapshot: this.snapshotOf(group, { fullMessages: true }),
    })
  }

  private persistMessage(group: InternalGroup, message: ChatGroupMessage): void {
    if (group.cwd === undefined) return
    this.persist(group, { kind: 'message', revision: group.revision, message })
  }

  private persist(group: InternalGroup, record: PersistedRecord): void {
    try {
      appendPersistedRecord(group.cwd!, String(group.sessionId), group.id, record)
    } catch (error: unknown) {
      this.ctx.logger('chatgroup').warn(
        `failed to persist chat group record: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  startTopic(agent: Agent, title: string, groupId?: GroupId): ChatGroupSnapshot {
    const group = this.requireGroup(agent, groupId)
    const normalized = title.trim()
    if (normalized.length === 0) {
      throw new ChatGroupError('INVALID_TEXT', '新议题内容不能为空')
    }

    this.closeCurrentTopicRecord(group)

    if (group.status !== 'idle') {
      group.stopRequested = true
      group.autoActive = false
      group.currentController?.abort(new Error('new topic requested'))
      group.currentSpeakerId = undefined
      group.currentMessageId = undefined
    }

    group.topicCounter += 1
    group.currentTopicId = `topic-${String(group.topicCounter)}`
    group.topics = [...group.topics, {
      id: group.currentTopicId,
      title: normalized,
      round: 0,
      messageCount: 0,
      createdAt: Date.now(),
    }]
    group.round = 1
    group.roundOneClosed = false
    group.status = 'running'
    group.mode = 'round'
    group.roundCursor = 0
    group.soloQueue = []
    group.stopRequested = false

    this.appendSystemMessage(group, `新议题开始，第 1 轮盲发：${normalized}`, group.round)
    this.appendUserMessage(group, normalized, [], group.round)
    this.bump(group)
    this.persistState(group)
    this.kick(agent, group)
    return this.snapshotOf(group)
  }

  private closeCurrentTopicRecord(group: InternalGroup): void {
    const current = group.topics.find(topic => topic.id === group.currentTopicId)
    if (current === undefined) return
    const messageCount = group.messages.filter(message =>
      message.topicId === undefined || message.topicId === group.currentTopicId).length
    group.topics = group.topics.map(topic => topic.id === current.id
      ? { ...topic, round: group.round, messageCount }
      : topic)
  }

  // ── scheduler internals ───────────────────────────────────────────────────

  /**
   * Resolve the group a request targets. An explicit groupId wins; otherwise
   * the session's remembered current group (first restored / last used) is
   * used, matching v0.2 single-group behavior when only one group exists.
   * Throws NO_GROUP when no group exists.
   */
  private requireGroup(agent: Agent, groupId?: GroupId): InternalGroup {
    this.ensureLoaded(agent)
    const group = this.requireGroupById(agent.session.id, groupId)
    if (group === undefined || group.destroyed) {
      throw new ChatGroupError('NO_GROUP', '当前会话还没有群聊，请先 /group create')
    }
    this.syncSandboxMode(agent, group)
    return group
  }

  private requireGroupById(sessionId: SessionId, groupId?: GroupId): InternalGroup | undefined {
    const sessionGroups = this.groups.get(sessionId)
    if (sessionGroups === undefined || sessionGroups.size === 0) return undefined
    if (groupId !== undefined) return sessionGroups.get(groupId)
    const current = this.currentGroupId.get(sessionId)
    if (current !== undefined && sessionGroups.has(current)) return sessionGroups.get(current)
    return sessionGroups.values().next().value as InternalGroup | undefined
  }

  private waiterKey(sessionId: SessionId, groupId?: GroupId): string {
    const group = this.requireGroupById(sessionId, groupId)
    return `${String(sessionId)}:${group?.id ?? 'none'}`
  }

  private assertIdle(group: InternalGroup): void {
    if (group.status !== 'idle') {
      throw new ChatGroupError('GROUP_IDLE_REQUIRED', '该操作仅在群聊空闲时可用，请先结束当前发言')
    }
  }

  private readSandboxMode(agent: Agent): string {
    const policy = this.ctx.get('sandboxPolicy') as
      | { resolve(request: { session: unknown }): { mode: string } }
      | undefined
    return policy?.resolve({ session: agent.session }).mode ?? 'read-only'
  }

  private syncSandboxMode(agent: Agent, group: InternalGroup): void {
    const mode = this.readSandboxMode(agent)
    if (mode !== group.sandboxMode) {
      group.sandboxMode = mode
      this.bump(group)
      this.persistState(group)
    }
  }

  private findAiMember(group: InternalGroup, nameOrId: string): ChatGroupMember {
    const token = nameOrId.trim()
    const member = group.members.find(candidate =>
      candidate.kind === 'ai' && (candidate.name === token || candidate.id === token))
    if (member === undefined) {
      throw new ChatGroupError('UNKNOWN_MEMBER', `找不到 AI 成员 "${token}"`)
    }
    return member
  }

  private appendSystemMessage(group: InternalGroup, text: string, round: number): ChatGroupMessage {
    const message: ChatGroupMessage = {
      id: `msg-${randomUUID()}`,
      seq: group.messages.length,
      topicId: group.currentTopicId,
      round,
      senderId: SYSTEM_MEMBER_ID,
      text,
      mentionIds: [],
      status: 'sent',
      createdAt: Date.now(),
    }
    group.messages = [...group.messages, message]
    this.bump(group)
    this.persistMessage(group, message)
    return message
  }

  /**
   * V2.4: when the first round is interrupted before every AI spoke, emit a
   * system summary of what was already produced so later rounds stay oriented.
   */
  private appendFirstRoundInterruptSummary(group: InternalGroup): void {
    const spoke = group.messages.filter(message =>
      message.round === 1
      && (message.topicId === undefined ? 'topic-1' : message.topicId) === group.currentTopicId
      && message.senderId !== USER_MEMBER_ID
      && message.senderId !== SYSTEM_MEMBER_ID
      && message.status === 'completed'
      && message.text.trim().length > 0)
    if (spoke.length === 0) return

    const lines = spoke.map(message => {
      const sender = group.members.find(member => member.id === message.senderId)?.name ?? message.senderId
      const excerpt = message.text.trim().slice(0, 200)
      return `${sender}：${excerpt}`
    })
    this.appendSystemMessage(
      group,
      `首轮已由用户中断，以下为已产生的发言摘要：\n${lines.join('\n')}`,
      group.round,
    )
  }

  private appendUserMessage(
    group: InternalGroup,
    text: string,
    mentionIds: readonly string[],
    round: number,
    writeAccess = false,
  ): ChatGroupMessage {
    const message: ChatGroupMessage = {
      id: `msg-${randomUUID()}`,
      seq: group.messages.length,
      topicId: group.currentTopicId,
      round,
      senderId: USER_MEMBER_ID,
      text,
      mentionIds: [...mentionIds],
      ...writeAccess ? { writeAccess: true } : {},
      status: 'sent',
      createdAt: Date.now(),
    }
    group.messages = [...group.messages, message]
    this.bump(group)
    this.persistMessage(group, message)
    return message
  }

  private kick(agent: Agent, group: InternalGroup): void {
    if (group.loopRunning || group.status !== 'running' || group.stopRequested) return
    group.loopRunning = true
    void this.loop(agent, group)
  }

  private async loop(agent: Agent, group: InternalGroup): Promise<void> {
    try {
      while (this.isLive(group) && !group.destroyed) {
        if (group.stopRequested || group.status !== 'running') {
          this.finishGroup(group)
          return
        }

        const nextRequest = this.pickNext(group)
        if (nextRequest === undefined) {
          if (this.finishGroup(group, agent)) continue
          return
        }

        await this.speakOne(
          agent,
          group,
          nextRequest.memberId,
          nextRequest.writeAccess,
          nextRequest.proactive === true ? 'proactive' : nextRequest.depth > 0 ? 'mention' : 'reply',
          nextRequest.depth,
        )
      }
    } catch (error: unknown) {
      this.ctx.logger('chatgroup').warn(
        `scheduler loop failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      if (this.isLive(group) && !group.destroyed) {
        this.finishGroup(group, agent)
      }
    } finally {
      group.loopRunning = false
    }
  }

  private pickNext(group: InternalGroup): SoloRequest | undefined {
    const solo = group.soloQueue.shift()
    if (solo !== undefined) {
      this.bump(group)
      return solo
    }
    // V2.3 proactive phase: consult each AI in order for an optional remark.
    if (group.proactiveActive && group.proactiveQueue.length > 0) {
      const memberId = group.proactiveQueue.shift()!
      this.bump(group)
      return { memberId, writeAccess: false, depth: 0, proactive: true }
    }
    if (group.mode !== 'round') return undefined
    const next = group.speakerOrder[group.roundCursor]
    if (next === undefined) return undefined
    group.roundCursor += 1
    this.bump(group)
    return { memberId: next, writeAccess: false, depth: 0 }
  }

  private async speakOne(
    agent: Agent,
    group: InternalGroup,
    memberId: string,
    writeAccess = false,
    intent: 'reply' | 'proactive' | 'mention' = 'reply',
    depth = 0,
  ): Promise<void> {
    const member = group.members.find(candidate => candidate.id === memberId && candidate.kind === 'ai')
    if (member?.ai === undefined) return
    const writeTools = ['write', 'edit']
    const ai: AiMemberConfig = writeAccess
      ? {
        ...member.ai,
        tools: [...new Set([...member.ai.tools, ...writeTools])],
      }
      : member.ai

    // V2.3 proactive consult: do NOT create a durable message yet. The AI's
    // reply either yields one remark (appended after) or is a decline.
    const proactive = intent === 'proactive'
    const message: ChatGroupMessage | undefined = proactive ? undefined : {
      id: `msg-${randomUUID()}`,
      seq: group.messages.length,
      topicId: group.currentTopicId,
      round: group.mode === 'round' ? group.round : 0,
      senderId: member.id,
      text: '',
      mentionIds: [],
      ...writeAccess ? { writeAccess: true } : {},
      status: 'speaking',
      createdAt: Date.now(),
    }
    if (message !== undefined) {
      group.messages = [...group.messages, message]
      group.currentSpeakerId = member.id
      group.currentMessageId = message.id
      this.bump(group)
      this.persistMessage(group, message)
    }

    const liveCwd = agent.session.header?.cwd
    if (liveCwd !== undefined && liveCwd !== group.cwd) {
      group.cwd = liveCwd
      this.bump(group)
      this.persistState(group)
    }

    if (liveCwd === undefined) {
      if (message !== undefined) {
        group.messages = group.messages.map(candidate => candidate.id === message.id
          ? {
            ...candidate,
            status: 'failed' as const,
            error: '当前 dsh 会话没有工作目录，无法创建只读子 Agent；请使用带项目目录的会话',
            completedAt: Date.now(),
          }
          : candidate)
        group.currentSpeakerId = undefined
        group.currentMessageId = undefined
        this.bump(group)
        this.persistMessage(group, group.messages.find(candidate => candidate.id === message.id)!)
      }
      return
    }

    let outcome: Awaited<ReturnType<typeof speakOnce>> | undefined
    let timedOut = false

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController()
      timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort(new Error(`speech timeout after ${String(ai.timeoutMs)}ms`))
      }, ai.timeoutMs)
      group.currentController = controller
      group.currentTimer = timer

      const snapshot = this.snapshotOf(group, { fullMessages: true })
      const persona = buildMemberPersona(member)
      const prompt = intent === 'proactive'
        ? this.buildProactivePrompt(snapshot, member, group.settings.maxPromptMessages)
        : buildMemberPrompt(snapshot, member, group.settings.maxPromptMessages, { writeAccess })

      outcome = await speakOnce(
        this.ctx,
        agent,
        `chatgroup:${group.id}:${member.id}:${intent}${writeAccess ? ':w' : ''}`,
        ai,
        persona,
        prompt,
        controller.signal,
        message === undefined
          ? undefined
          : (delta) => {
            if (group.destroyed || !this.isLive(group)) return
            const current = group.messages.find(candidate => candidate.id === message.id)
            if (current === undefined) return
            group.messages = group.messages.map(candidate => candidate.id === message.id
              ? { ...candidate, text: `${current.text}${delta}` }
              : candidate)
            this.bump(group)
          },
        (activity) => {
          if (group.destroyed || !this.isLive(group)) return
          group.toolActivity = {
            memberId: member.id,
            tool: activity.tool,
            argsPreview: activity.argsPreview,
            active: activity.active,
          }
          this.bump(group)
        },
        (usage) => {
          if (group.destroyed || !this.isLive(group) || message === undefined) return
          group.messages = group.messages.map(candidate => candidate.id === message.id
            ? { ...candidate, usage: { ...usage } }
            : candidate)
          this.bump(group)
        },
      )

      clearTimeout(timer)
      group.currentTimer = undefined
      group.currentController = undefined

      const failed = timedOut
        ? false
        : outcome.status === 'failed'
      if (!failed || attempt === 1 || group.stopRequested || group.destroyed) break

      if (message !== undefined) {
        group.messages = group.messages.map(candidate => candidate.id === message.id
          ? { ...candidate, text: '', error: `${outcome?.detail ?? 'subagent failed'}；正在自动重试一次…` }
          : candidate)
        this.bump(group)
        this.persistMessage(group, group.messages.find(candidate => candidate.id === message.id)!)
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }

    if (outcome === undefined) return

    if (message !== undefined && group.currentMessageId === message.id) {
      group.currentSpeakerId = undefined
      group.currentMessageId = undefined
      if (group.toolActivity?.memberId === member.id) {
        group.toolActivity = undefined
      }
    }

    if (group.destroyed || !this.isLive(group)) return

    if (proactive) {
      this.settleProactive(group, member, outcome, depth)
      return
    }

    if (message === undefined) return
    const updated = group.messages.find(candidate => candidate.id === message.id)
    const finalMessage: ChatGroupMessage | undefined = updated === undefined ? undefined : {
      ...updated,
      text: outcome.text,
      status: timedOut && !(outcome.status === 'completed' && outcome.text.length > 0)
        ? 'timeout'
        : outcome.status,
      ...outcome.detail ? { error: outcome.detail } : {},
      completedAt: Date.now(),
    }
    if (finalMessage !== undefined) {
      group.messages = group.messages.map(candidate => candidate.id === finalMessage.id ? finalMessage : candidate)
      this.bump(group)
      this.persistMessage(group, finalMessage)
      this.resolveAiMentions(group, finalMessage, depth)
    }
  }

  /** V2.3: proactive consult prompt — the AI may add one remark or decline. */
  private buildProactivePrompt(
    group: ChatGroupSnapshot,
    member: ChatGroupMember,
    maxPromptMessages: number,
  ): string {
    const base = buildMemberPrompt(group, member, maxPromptMessages)
    return [
      base,
      '',
      '本轮讨论已经结束。如果你认为有必须补充的关键信息或不同观点，请直接输出补充内容；',
      '如果无需补充，请只输出“无需补充”四个字。',
      '如果你要 @ 其他成员，请用 @成员名 的形式写在补充内容中。',
    ].join('\n')
  }

  /** V2.3: handle a proactive consult result — append a remark or record a decline. */
  private settleProactive(
    group: InternalGroup,
    member: ChatGroupMember,
    outcome: Awaited<ReturnType<typeof speakOnce>>,
    depth: number,
  ): void {
    const text = outcome.text.trim()
    const declined = text.length === 0
      || text === '无需补充'
      || /^无需补充[。.!！]?$/.test(text)
      || /^(不需要|不用|no need|skip)$/i.test(text)
    if (declined) return

    if (group.proactiveCount >= group.settings.maxProactivePerRound) return

    const message: ChatGroupMessage = {
      id: `msg-${randomUUID()}`,
      seq: group.messages.length,
      topicId: group.currentTopicId,
      round: group.mode === 'round' ? group.round : 0,
      senderId: member.id,
      text,
      mentionIds: [],
      status: 'completed',
      completedAt: Date.now(),
      createdAt: Date.now(),
    }
    group.messages = [...group.messages, message]
    group.proactiveCount += 1
    this.bump(group)
    this.persistMessage(group, message)
    this.resolveAiMentions(group, message, depth)
  }

  /** V2.3: parse @mentions inside an AI message; enqueue solo replies with depth limits. */
  private resolveAiMentions(group: InternalGroup, message: ChatGroupMessage, depth: number): void {
    if (group.settings.maxAiMentionDepth <= 0) return
    const targets = new Set<string>()
    for (const candidate of group.members) {
      if (candidate.kind !== 'ai' || candidate.id === message.senderId) continue
      const name = candidate.name
      const pattern = new RegExp(`@${escapeRegExp(name)}\\b`)
      if (pattern.test(message.text)) targets.add(candidate.id)
    }
    // Backfill the matched member ids onto the message metadata (V2.3).
    if (targets.size > 0 && message.mentionIds.length === 0) {
      const enriched = { ...message, mentionIds: [...targets] }
      group.messages = group.messages.map(candidate => candidate.id === message.id ? enriched : candidate)
      this.bump(group)
      this.persistMessage(group, enriched)
    }
    for (const targetId of targets) {
      const nextDepth = depth + 1
      if (nextDepth > group.settings.maxAiMentionDepth) {
        this.appendSystemMessage(group, `@${group.members.find(member => member.id === targetId)?.name ?? targetId}：AI 互 @ 深度已达上限，已忽略。`, message.round)
        continue
      }
      const seenKey = `${message.round}:${targetId}`
      if (group.mentionSeen.has(seenKey)) continue
      group.mentionSeen.add(seenKey)
      group.soloQueue.push({ memberId: targetId, writeAccess: false, depth: nextDepth })
      this.bump(group)
    }
  }

  private finishGroup(group: InternalGroup, agent?: Agent): boolean {
    if (group.status === 'idle') return false

    if (group.round === 1) {
      group.roundOneClosed = true
    }
    this.closeCurrentTopicRecord(group)

    // V2.4: first round interrupted with AI members still pending — summarize
    // what was produced so the next round's AI can stay oriented.
    if (group.round === 1 && group.stopRequested) {
      this.appendFirstRoundInterruptSummary(group)
    }

    let autoContinue = false
    if (!group.stopRequested && group.autoActive) {
      const roundsDone = group.round - group.autoStartRound + 1
      if (roundsDone >= group.autoTotalRounds) {
        this.appendSystemMessage(group, `自动讨论完成，共 ${String(group.autoTotalRounds)} 轮。`, group.round)
        group.autoActive = false
      } else {
        const nextRound = group.round + 1
        this.appendSystemMessage(group, `自动进入第 ${String(nextRound)} 轮讨论。`, group.round)
        group.round = nextRound
        autoContinue = true
      }
    }

    if (group.currentTimer !== undefined) clearTimeout(group.currentTimer)
    if (group.currentSpeakerId !== undefined) {
      group.currentController?.abort(new Error('round finished'))
      group.currentController = undefined
      group.currentTimer = undefined
      group.currentSpeakerId = undefined
      group.currentMessageId = undefined
    }

    if (autoContinue) {
      group.status = 'running'
      group.mode = 'round'
      group.stopRequested = false
      group.soloQueue = []
      group.roundCursor = 0
      this.bump(group)
      this.persistState(group)
      return true
    }

    // V2.3 proactive phase: after a clean round, let each AI offer one remark.
    if (!group.stopRequested && group.settings.aiProactive && group.speakerOrder.length > 0) {
      const proactiveRound = group.mode === 'round' ? group.round : group.round
      if (group.proactiveRound !== proactiveRound && group.proactiveCount < group.settings.maxProactivePerRound) {
        group.proactiveActive = true
        group.proactiveRound = proactiveRound
        group.proactiveQueue = [...group.speakerOrder]
        group.status = 'running'
        group.stopRequested = false
        this.bump(group)
        this.persistState(group)
        return true
      }
    }
    group.proactiveActive = false
    group.proactiveQueue = []
    group.mentionSeen.clear()
    group.status = 'idle'
    group.mode = 'idle'
    group.stopRequested = false
    group.soloQueue = []
    group.roundCursor = 0
    this.bump(group)
    this.persistState(group)
    return false
  }

  // ── snapshot / formatting ─────────────────────────────────────────────────

  private snapshotOf(
    group: InternalGroup,
    options: { fullMessages?: boolean } = {},
  ): ChatGroupSnapshot {
    const nextSpeakerIds = group.mode === 'round'
      ? group.speakerOrder.slice(group.roundCursor)
      : group.soloQueue.map(request => request.memberId)

    const pageSize = group.settings.messagePageSize
    const pageMessages = options.fullMessages === true
      ? group.messages
      : group.messages.slice(-pageSize)
    const hasMore = options.fullMessages !== true && group.messages.length > pageMessages.length
    const oldestLoadedSeq = pageMessages[0]?.seq

    return {
      groupId: group.id,
      ...group.name === undefined ? {} : { name: group.name },
      sessionId: group.sessionId,
      ...group.cwd === undefined ? {} : { cwd: group.cwd },
      revision: group.revision,
      status: group.status,
      round: group.round,
      blindRoundActive: group.round === 1 && !group.roundOneClosed,
      mentionEnabled: group.mentionEnabled,
      speakerOrder: [...group.speakerOrder],
      members: group.members,
      messages: pageMessages,
      totalMessages: group.messages.length,
      hasMoreMessages: hasMore,
      ...oldestLoadedSeq === undefined ? {} : { oldestLoadedSeq },
      autoActive: group.autoActive,
      currentTopicId: group.currentTopicId,
      topics: [...group.topics],
      sandboxMode: group.sandboxMode,
      config: {
        maxAi: group.settings.maxAi,
        maxGroups: group.settings.maxGroups,
        defaultTimeoutMs: group.settings.defaultTimeoutMs,
        readonlyTools: [...group.settings.readonlyTools],
        waitTimeoutMs: group.settings.waitTimeoutMs,
        maxPromptMessages: group.settings.maxPromptMessages,
        messagePageSize: group.settings.messagePageSize,
        maxEditableMessages: group.settings.maxEditableMessages,
      aiProactive: group.settings.aiProactive,
      maxProactivePerRound: group.settings.maxProactivePerRound,
      maxAiMentionDepth: group.settings.maxAiMentionDepth,
      },
      ...group.autoActive ? {
        autoTotalRounds: group.autoTotalRounds,
        autoCurrentRound: group.round - group.autoStartRound + 1,
      } : {},
      ...group.currentSpeakerId === undefined ? {} : { currentSpeakerId: group.currentSpeakerId },
      ...group.toolActivity === undefined ? {} : { toolActivity: { ...group.toolActivity } },
      memberUsage: this.memberUsageOf(group),
      nextSpeakerIds,
      soloQueue: [...group.soloQueue],
      groups: this.groupSummaries(group.sessionId),
    }
  }

  private groupSummaries(sessionId: SessionId): ChatGroupSummary[] {
    const sessionGroups = this.groups.get(sessionId)
    if (sessionGroups === undefined) return []
    return [...sessionGroups.values()]
      .filter(group => !group.destroyed)
      .map(group => {
        const topic = group.topics.find(candidate => candidate.id === group.currentTopicId)
        return {
          groupId: group.id,
          ...group.name === undefined ? {} : { name: group.name },
          status: group.status,
          round: group.round,
          totalMessages: group.messages.length,
          currentTopicTitle: topic?.title ?? '默认话题',
        }
      })
  }

  /** V2.6: cumulative token usage per AI member across the group's messages. */
  private memberUsageOf(group: InternalGroup): Record<string, import('./types.js').MessageUsage> {
    const usage: Record<string, import('./types.js').MessageUsage> = {}
    for (const message of group.messages) {
      if (message.usage === undefined || message.senderId === USER_MEMBER_ID || message.senderId === SYSTEM_MEMBER_ID) continue
      const current = usage[message.senderId]
      usage[message.senderId] = {
        inputTokens: (current?.inputTokens ?? 0) + message.usage.inputTokens,
        outputTokens: (current?.outputTokens ?? 0) + message.usage.outputTokens,
        ...message.usage.cacheReadTokens !== undefined || current?.cacheReadTokens !== undefined
          ? { cacheReadTokens: (current?.cacheReadTokens ?? 0) + (message.usage.cacheReadTokens ?? 0) }
          : {},
        ...message.usage.cacheWriteTokens !== undefined || current?.cacheWriteTokens !== undefined
          ? { cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + (message.usage.cacheWriteTokens ?? 0) }
          : {},
        ...message.usage.reasoningTokens !== undefined || current?.reasoningTokens !== undefined
          ? { reasoningTokens: (current?.reasoningTokens ?? 0) + (message.usage.reasoningTokens ?? 0) }
          : {},
      }
    }
    return usage
  }

  private cancelWaiters(sessionId: SessionId, groupId: GroupId, changed: boolean): void {
    const key = `${String(sessionId)}:${groupId}`
    const set = this.waiters.get(key)
    if (set === undefined) return
    this.waiters.delete(key)
    const group = this.groups.get(sessionId)?.get(groupId)
    for (const waiter of set) {
      clearTimeout(waiter.timer)
      waiter.resolve({ changed, snapshot: group === undefined ? null : this.snapshotOf(group) })
    }
  }

  private bump(group: InternalGroup): void {
    group.revision += 1
    const key = `${String(group.sessionId)}:${group.id}`
    const noneKey = `${String(group.sessionId)}:none`
    for (const targetKey of [key, noneKey]) {
      const set = this.waiters.get(targetKey)
      if (set === undefined || set.size === 0) continue
      for (const waiter of [...set]) {
        if (waiter.revision < group.revision) {
          set.delete(waiter)
          clearTimeout(waiter.timer)
          waiter.resolve({
            changed: true,
            snapshot: this.snapshotOf(group, { fullMessages: true }),
          })
        }
      }
      if (set.size === 0) this.waiters.delete(targetKey)
    }
  }

  private isLive(group: InternalGroup): boolean {
    return this.groups.get(group.sessionId)?.get(group.id) === group
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
