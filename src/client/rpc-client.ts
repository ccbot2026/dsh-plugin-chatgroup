import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ChatGroupConfig, ChatGroupMessage, ChatGroupSnapshot, CreateAiMemberInput } from '../types.js'

const CHANNEL = '/chatgroup'

export interface SnapshotEnvelope {
  revision: number
  group: ChatGroupSnapshot | null
}

export interface WaitEnvelope {
  changed: boolean
  revision: number
  group: ChatGroupSnapshot | null
}

export interface MessagesPage {
  messages: ChatGroupSnapshot['messages']
  hasMore: boolean
  oldestLoadedSeq?: number
}

export interface ModelCatalog {
  providers: Array<{ id: string; name: string; models: string[] }>
  defaultTimeoutMs: number
}

export class ChatGroupRpcError extends Error {
  readonly chatGroupCode?: string

  constructor(message: string, chatGroupCode?: string) {
    super(message)
    this.name = 'ChatGroupRpcError'
    this.chatGroupCode = chatGroupCode
  }
}

async function call<T>(rpc: ClientConnectionRpc, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  const response: RpcResult<unknown> = await rpc.call(CHANNEL, endpoint, payload, signal)
  if (!response.ok) {
    const details = response.error.details as { chatGroupCode?: string } | undefined
    throw new ChatGroupRpcError(response.error.message, details?.chatGroupCode)
  }
  return response.value as T
}

export class ChatGroupRpcClient {
  constructor(private readonly rpc: ClientConnectionRpc) {}

  snapshot(sessionId: string, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'snapshot', { sessionId }, signal)
  }

  wait(sessionId: string, revision: number, signal?: AbortSignal): Promise<WaitEnvelope> {
    return call(this.rpc, 'wait', { sessionId, revision }, signal)
  }

  messagesBefore(sessionId: string, beforeSeq: number, limit?: number, signal?: AbortSignal): Promise<MessagesPage> {
    return call(this.rpc, 'messages.before', { sessionId, beforeSeq, ...limit === undefined ? {} : { limit } }, signal)
  }

  topicMessages(sessionId: string, topicId: string, signal?: AbortSignal): Promise<{ messages: ChatGroupMessage[] }> {
    return call(this.rpc, 'topic.messages', { sessionId, topicId }, signal)
  }

  create(sessionId: string, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'create', { sessionId }, signal)
  }

  dissolve(sessionId: string, signal?: AbortSignal): Promise<null> {
    return call(this.rpc, 'dissolve', { sessionId }, signal)
  }

  send(sessionId: string, text: string, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'send', { sessionId, text }, signal)
  }

  at(sessionId: string, memberName: string, text: string, options: { writeAccess?: boolean } = {}, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'at', { sessionId, memberName, text, writeAccess: options.writeAccess === true }, signal)
  }

  startAuto(sessionId: string, maxRounds: number, topic?: string, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'auto.start', { sessionId, maxRounds, topic }, signal)
  }

  startTopic(sessionId: string, title: string, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'topic.start', { sessionId, title }, signal)
  }

  stop(sessionId: string, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'stop', { sessionId }, signal)
  }

  addMember(sessionId: string, member: CreateAiMemberInput, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'members.add', { sessionId, member }, signal)
  }

  removeMember(sessionId: string, memberName: string, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'members.remove', { sessionId, memberName }, signal)
  }

  reorderMembers(sessionId: string, names: string[], signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'members.reorder', { sessionId, names }, signal)
  }

  setMentionEnabled(sessionId: string, enabled: boolean, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'settings.update', { sessionId, mentionEnabled: enabled }, signal)
  }

  updateConfig(sessionId: string, patch: Partial<ChatGroupConfig>, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'settings.config.update', { sessionId, ...patch }, signal)
  }

  catalog(signal?: AbortSignal): Promise<ModelCatalog> {
    return call(this.rpc, 'catalog', { sessionId: '' }, signal)
  }

  getConfig(signal?: AbortSignal): Promise<ChatGroupConfig> {
    return call(this.rpc, 'config.get', { sessionId: '' }, signal)
  }

  exportTranscript(sessionId: string, signal?: AbortSignal): Promise<{ content: string; filename: string }> {
    return call(this.rpc, 'export', { sessionId }, signal)
  }
}
