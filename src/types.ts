/** chat-group plugin shared types. */

import type { SessionId } from '@deepseek-ai/dsh-session'

export const USER_MEMBER_ID = 'user'
export const SYSTEM_MEMBER_ID = 'system'
export const DEFAULT_MAX_AI = 5
export const DEFAULT_MAX_GROUPS = 1
export const DEFAULT_SPEECH_TIMEOUT_MS = 300_000
export const DEFAULT_WAIT_TIMEOUT_MS = 25_000
export const DEFAULT_MAX_PROMPT_MESSAGES = 40
export const DEFAULT_MESSAGE_PAGE_SIZE = 100
export const DEFAULT_MAX_EDITABLE_MESSAGES = 20
export const DEFAULT_READONLY_TOOLS = ['read', 'read_image', 'glob', 'grep'] as const

export type GroupId = string
export type MemberRole = 'admin' | 'member'
export type MemberKind = 'user' | 'ai'
export type GroupStatus = 'idle' | 'running'

export type MessageStatus =
  | 'sent'
  | 'speaking'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'withdrawn'

export interface AiMemberConfig {
  readonly provider: string
  readonly model: string
  readonly systemPrompt?: string
  readonly timeoutMs: number
  readonly tools: readonly string[]
}

export interface ChatGroupMember {
  readonly id: string
  readonly kind: MemberKind
  readonly role: MemberRole
  readonly name: string
  readonly ai?: AiMemberConfig
}

export interface SoloRequest {
  readonly memberId: string
  readonly writeAccess: boolean
}

export interface ChatTopic {
  readonly id: string
  readonly title: string
  readonly round: number
  readonly messageCount: number
  readonly createdAt: number
}

export interface ChatGroupMessage {
  readonly id: string
  readonly seq: number
  /** Topic this message belongs to; legacy messages may be missing it. */
  readonly topicId?: string
  /** True when this @ request granted one-shot write access. */
  readonly writeAccess?: boolean
  /** 0 means a solo @ reply; >= 1 is a normal round. */
  readonly round: number
  readonly senderId: string
  readonly text: string
  readonly mentionIds: string[]
  readonly status: MessageStatus
  readonly error?: string
  readonly createdAt: number
  readonly completedAt?: number
  /** Set when the message was edited; keeps the original text for audit. */
  readonly editedAt?: number
  /** The text as last edited; `text` keeps the original. */
  readonly editedText?: string
}

export interface ChatGroupSnapshot {
  readonly groupId: GroupId
  readonly sessionId: SessionId
  /** Working directory inherited from the owning dsh session, if configured. */
  readonly cwd?: string
  readonly revision: number
  readonly status: GroupStatus
  readonly round: number
  readonly blindRoundActive: boolean
  readonly mentionEnabled: boolean
  readonly speakerOrder: readonly string[]
  readonly members: readonly ChatGroupMember[]
  /** Tail page delivered to clients; `totalMessages` is the complete count. */
  readonly messages: readonly ChatGroupMessage[]
  readonly totalMessages: number
  readonly hasMoreMessages: boolean
  readonly oldestLoadedSeq?: number
  readonly currentSpeakerId?: string
  readonly nextSpeakerIds: readonly string[]
  readonly soloQueue: readonly SoloRequest[]
  readonly autoActive: boolean
  readonly autoTotalRounds?: number
  readonly autoCurrentRound?: number
  /** Effective per-group runtime config. */
  readonly config: ChatGroupConfig
  readonly currentTopicId: string
  readonly topics: readonly ChatTopic[]
  readonly sandboxMode?: string
  /** All groups in the session (V2.1 multi-group). */
  readonly groups: readonly ChatGroupSummary[]
}

/** Lightweight cross-group navigation row (V2.1). */
export interface ChatGroupSummary {
  readonly groupId: GroupId
  readonly status: GroupStatus
  readonly round: number
  readonly totalMessages: number
  readonly currentTopicTitle: string
}

export interface CreateAiMemberInput {
  readonly name: string
  readonly provider: string
  readonly model: string
  readonly systemPrompt?: string
  readonly timeoutMs?: number
}

export interface ChatGroupConfig {
  readonly maxAi: number
  readonly maxGroups: number
  readonly defaultTimeoutMs: number
  readonly readonlyTools: readonly string[]
  readonly waitTimeoutMs: number
  /** 0 means include the whole visible transcript. */
  readonly maxPromptMessages: number
  /** Number of tail messages returned in each RPC snapshot page. */
  readonly messagePageSize: number
  /** Newest N messages (by seq) may be edited/withdrawn by the admin. */
  readonly maxEditableMessages: number
}
