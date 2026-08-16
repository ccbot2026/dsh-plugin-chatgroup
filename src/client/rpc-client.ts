import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ChatGroupConfig, ChatGroupMessage, ChatGroupSnapshot, ChatGroupSummary, CreateAiMemberInput, GroupId } from '../types.js'

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

  snapshot(sessionId: string, groupId?: GroupId, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'snapshot', { sessionId, ...groupId === undefined ? {} : { groupId } }, signal)
  }

  wait(sessionId: string, revision: number, groupId?: GroupId, signal?: AbortSignal): Promise<WaitEnvelope> {
    return call(this.rpc, 'wait', { sessionId, revision, ...groupId === undefined ? {} : { groupId } }, signal)
  }

  messagesBefore(sessionId: string, beforeSeq: number, limit?: number, groupId?: GroupId, signal?: AbortSignal): Promise<MessagesPage> {
    return call(this.rpc, 'messages.before', { sessionId, beforeSeq, ...groupId === undefined ? {} : { groupId }, ...limit === undefined ? {} : { limit } }, signal)
  }

  topicMessages(sessionId: string, topicId: string, groupId?: GroupId, signal?: AbortSignal): Promise<{ messages: ChatGroupMessage[] }> {
    return call(this.rpc, 'topic.messages', { sessionId, topicId, ...groupId === undefined ? {} : { groupId } }, signal)
  }

  create(sessionId: string, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'create', { sessionId }, signal)
  }

  dissolve(sessionId: string, groupId?: GroupId, signal?: AbortSignal): Promise<null> {
    return call(this.rpc, 'dissolve', { sessionId, ...groupId === undefined ? {} : { groupId } }, signal)
  }

  send(sessionId: string, text: string, groupId?: GroupId, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'send', { sessionId, text, ...groupId === undefined ? {} : { groupId } }, signal)
  }

  at(sessionId: string, memberName: string, text: string, options: { writeAccess?: boolean } = {}, groupId?: GroupId, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'at', { sessionId, memberName, text, writeAccess: options.writeAccess === true, ...groupId === undefined ? {} : { groupId } }, signal)
  }

  startAuto(sessionId: string, maxRounds: number, topic?: string, groupId?: GroupId, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'auto.start', { sessionId, maxRounds, topic, ...groupId === undefined ? {} : { groupId } }, signal)
  }

  startTopic(sessionId: string, title: string, groupId?: GroupId, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'topic.start', { sessionId, title, ...groupId === undefined ? {} : { groupId } }, signal)
  }

  stop(sessionId: string, groupId?: GroupId, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'stop', { sessionId, ...groupId === undefined ? {} : { groupId } }, signal)
  }

  listGroups(sessionId: string, signal?: AbortSignal): Promise<{ groups: ChatGroupSummary[] }> {
    return call(this.rpc, 'groups.list', { sessionId }, signal)
  }

  useGroup(sessionId: string, groupId: GroupId, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'groups.use', { sessionId, groupId }, signal)
  }

  addMember(sessionId: string, member: CreateAiMemberInput, groupId?: GroupId, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'members.add', { sessionId, member, ...groupId === undefined ? {} : { groupId } }, signal)
  }

  removeMember(sessionId: string, memberName: string, groupId?: GroupId, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'members.remove', { sessionId, memberName, ...groupId === undefined ? {} : { groupId } }, signal)
  }

  reorderMembers(sessionId: string, names: string[], groupId?: GroupId, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'members.reorder', { sessionId, names, ...groupId === undefined ? {} : { groupId } }, signal)
  }

  setMentionEnabled(sessionId: string, enabled: boolean, groupId?: GroupId, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'settings.update', { sessionId, mentionEnabled: enabled, ...groupId === undefined ? {} : { groupId } }, signal)
  }

  updateConfig(sessionId: string, patch: Partial<ChatGroupConfig>, groupId?: GroupId, signal?: AbortSignal): Promise<SnapshotEnvelope> {
    return call(this.rpc, 'settings.config.update', { sessionId, ...patch, ...groupId === undefined ? {} : { groupId } }, signal)
  }

  catalog(signal?: AbortSignal): Promise<ModelCatalog> {
    return call(this.rpc, 'catalog', { sessionId: '' }, signal)
  }

  getConfig(signal?: AbortSignal): Promise<ChatGroupConfig> {
    return call(this.rpc, 'config.get', { sessionId: '' }, signal)
  }

  exportTranscript(sessionId: string, groupId?: GroupId, signal?: AbortSignal): Promise<{ content: string; filename: string }> {
    return call(this.rpc, 'export', { sessionId, ...groupId === undefined ? {} : { groupId } }, signal)
  }
}
