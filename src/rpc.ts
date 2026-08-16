import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import type { RpcError, RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ChatGroupError } from './errors.js'
import type { ChatGroupService } from './group-service.js'
import type { ChatGroupSnapshot, GroupId } from './types.js'

const CHANNEL = '/chatgroup'
const CATALOG_TTL_MS = 30_000

function ok<T>(value: T): RpcResult<unknown> {
  return { ok: true, value }
}

function fail(chatGroupCode: string, message: string, details?: unknown): RpcResult<unknown> {
  return {
    ok: false,
    error: {
      code: 'internal',
      message,
      details: { chatGroupCode, ...details === undefined ? {} : { detail: details } },
    } as RpcError,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') return undefined
  return value
}

/** Optional per-group target; absent = the session's current/only group. */
function groupIdField(payload: Record<string, unknown>): GroupId | undefined {
  const value = stringField(payload, 'groupId')
  return value === undefined || value.length === 0 ? undefined : value as GroupId
}

interface SnapshotResponse {
  revision: number
  group: ChatGroupSnapshot | null
}

interface WaitResponse {
  changed: boolean
  revision: number
  group: ChatGroupSnapshot | null
}

/** Mount the `/chatgroup` generic Connection RPC channel. */
export function registerChatGroupRpc(ctx: Context, service: ChatGroupService): () => Promise<void> {
  const handler: ConnectionRpcHandler = async (endpoint, rawPayload, signal) => {
    try {
      if (!isRecord(rawPayload)) {
        return fail('BAD_REQUEST', 'payload must be a JSON object')
      }

      // These endpoints are session-independent.
      if (endpoint === 'catalog') {
        const catalog = await readCatalog(ctx, service)
        return ok(catalog)
      }
      if (endpoint === 'config.get') {
        return ok(service.configView())
      }

      const sessionIdRaw = stringField(rawPayload, 'sessionId')
      if (sessionIdRaw === undefined || sessionIdRaw.length === 0) {
        return fail('BAD_REQUEST', 'sessionId is required')
      }
      const sessionId = sessionIdRaw as SessionId
      const agent = resolveAgent(ctx, sessionId)
      if (agent === undefined) {
        return fail('SESSION_NOT_LIVE', `session "${sessionIdRaw}" is not live`)
      }

      switch (endpoint) {
        case 'export': {
          const content = service.exportTranscript(agent, groupIdField(rawPayload))
          const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19)
          return ok({ content, filename: `chatgroup-${String(sessionId)}-${stamp}.md` })
        }

        case 'snapshot': {
          const snapshot = service.snapshot(agent, groupIdField(rawPayload))
          return ok<SnapshotResponse>({
            revision: snapshot?.revision ?? -1,
            group: snapshot,
          })
        }

        case 'wait': {
          const revisionRaw = rawPayload.revision
          if (typeof revisionRaw !== 'number' || !Number.isSafeInteger(revisionRaw) || revisionRaw < -1) {
            return fail('BAD_REQUEST', 'revision must be a non-negative integer or -1')
          }
          const current = service.snapshot(agent, groupIdField(rawPayload))
          const waited = await service.waitForRevision(
            sessionId,
            revisionRaw,
            service.waitTimeoutMs,
            signal,
            groupIdField(rawPayload),
          )
          return ok<WaitResponse>({
            changed: waited.changed,
            revision: waited.snapshot?.revision ?? current?.revision ?? -1,
            group: waited.snapshot ?? current,
          })
        }

        case 'create': {
          const snapshot = service.create(agent)
          return ok<SnapshotResponse>({ revision: snapshot.revision, group: snapshot })
        }

        case 'dissolve': {
          service.dissolve(agent, groupIdField(rawPayload))
          return ok<null>(null)
        }

        case 'send': {
          const text = stringField(rawPayload, 'text') ?? ''
          const snapshot = service.send(agent, text, groupIdField(rawPayload))
          return ok<SnapshotResponse>({ revision: snapshot.revision, group: snapshot })
        }

        case 'at': {
          const memberName = stringField(rawPayload, 'memberName') ?? ''
          const text = stringField(rawPayload, 'text') ?? ''
          const snapshot = service.at(agent, memberName, text, {
            writeAccess: rawPayload.writeAccess === true,
          }, groupIdField(rawPayload))
          return ok<SnapshotResponse>({ revision: snapshot.revision, group: snapshot })
        }

        case 'stop': {
          const snapshot = service.stop(agent, groupIdField(rawPayload))
          return ok<SnapshotResponse>({ revision: snapshot.revision, group: snapshot })
        }

        case 'messages.edit': {
          const seq = rawPayload.seq
          const text = stringField(rawPayload, 'text') ?? ''
          if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
            return fail('BAD_REQUEST', 'seq must be a non-negative integer')
          }
          const snapshot = service.editMessage(agent, seq, text, groupIdField(rawPayload))
          return ok<SnapshotResponse>({ revision: snapshot.revision, group: snapshot })
        }

        case 'messages.withdraw': {
          const seq = rawPayload.seq
          if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
            return fail('BAD_REQUEST', 'seq must be a non-negative integer')
          }
          const snapshot = service.withdrawMessage(agent, seq, groupIdField(rawPayload))
          return ok<SnapshotResponse>({ revision: snapshot.revision, group: snapshot })
        }

        case 'groups.list': {
          const snapshot = service.requireSnapshot(agent)
          return ok({ groups: snapshot.groups })
        }

        case 'groups.use': {
          const groupId = stringField(rawPayload, 'groupId') ?? ''
          if (groupId.length === 0) return fail('BAD_REQUEST', 'groupId is required')
          const snapshot = service.useGroup(agent, groupId as GroupId)
          return ok<SnapshotResponse>({ revision: snapshot.revision, group: snapshot })
        }

        case 'groups.rename': {
          const name = stringField(rawPayload, 'name') ?? ''
          const snapshot = service.renameGroup(agent, name, groupIdField(rawPayload))
          return ok<SnapshotResponse>({ revision: snapshot.revision, group: snapshot })
        }

        case 'topic.messages': {
          const topicId = stringField(rawPayload, 'topicId') ?? ''
          if (topicId.length === 0) return fail('BAD_REQUEST', 'topicId is required')
          const messages = service.topicMessages(sessionId, topicId, groupIdField(rawPayload))
          if (messages === null) return fail('NO_GROUP', '当前会话还没有群聊')
          return ok({ messages })
        }

        case 'messages.before': {
          const beforeSeq = rawPayload.beforeSeq
          if (typeof beforeSeq !== 'number' || !Number.isSafeInteger(beforeSeq) || beforeSeq < 0) {
            return fail('BAD_REQUEST', 'beforeSeq must be a non-negative integer')
          }
          const limit = rawPayload.limit
          if (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0)) {
            return fail('BAD_REQUEST', 'limit must be a positive integer')
          }
          const page = service.messagesBefore(sessionId, beforeSeq, limit, groupIdField(rawPayload))
          if (page === null) return fail('NO_GROUP', '当前会话还没有群聊')
          return ok(page)
        }

        case 'topic.start': {
          const title = stringField(rawPayload, 'title') ?? ''
          const snapshot = service.startTopic(agent, title, groupIdField(rawPayload))
          return ok<SnapshotResponse>({ revision: snapshot.revision, group: snapshot })
        }

        case 'auto.start': {
          const maxRounds = rawPayload.maxRounds
          if (typeof maxRounds !== 'number' || !Number.isSafeInteger(maxRounds)) {
            return fail('BAD_REQUEST', 'maxRounds must be an integer')
          }
          const topic = stringField(rawPayload, 'topic') ?? ''
          const snapshot = service.startAuto(agent, maxRounds, topic, groupIdField(rawPayload))
          return ok<SnapshotResponse>({ revision: snapshot.revision, group: snapshot })
        }

        case 'members.add': {
          const member = isRecord(rawPayload.member) ? rawPayload.member : undefined
          if (member === undefined) return fail('BAD_REQUEST', 'member is required')
          const snapshot = service.addMember(agent, {
            name: stringField(member, 'name') ?? '',
            provider: stringField(member, 'provider') ?? '',
            model: stringField(member, 'model') ?? '',
            ...stringField(member, 'systemPrompt') === undefined
              ? {}
              : { systemPrompt: stringField(member, 'systemPrompt') },
            ...typeof member.timeoutMs === 'number' ? { timeoutMs: member.timeoutMs } : {},
          }, groupIdField(rawPayload))
          return ok<SnapshotResponse>({ revision: snapshot.revision, group: snapshot })
        }

        case 'members.remove': {
          const memberName = stringField(rawPayload, 'memberName') ?? ''
          const snapshot = service.removeMember(agent, memberName, groupIdField(rawPayload))
          return ok<SnapshotResponse>({ revision: snapshot.revision, group: snapshot })
        }

        case 'members.reorder': {
          const names = Array.isArray(rawPayload.names)
            ? rawPayload.names.filter((name): name is string => typeof name === 'string')
            : undefined
          if (names === undefined) return fail('BAD_REQUEST', 'names must be a string array')
          const snapshot = service.reorderMembers(agent, names, groupIdField(rawPayload))
          return ok<SnapshotResponse>({ revision: snapshot.revision, group: snapshot })
        }

        case 'settings.config.update': {
          const patch: Record<string, unknown> = {}
          if (typeof rawPayload.maxAi === 'number') patch.maxAi = rawPayload.maxAi
          if (typeof rawPayload.maxGroups === 'number') patch.maxGroups = rawPayload.maxGroups
          if (typeof rawPayload.defaultTimeoutMs === 'number') patch.defaultTimeoutMs = rawPayload.defaultTimeoutMs
          if (Array.isArray(rawPayload.readonlyTools) && rawPayload.readonlyTools.every(tool => typeof tool === 'string')) {
            patch.readonlyTools = rawPayload.readonlyTools
          }
          if (typeof rawPayload.waitTimeoutMs === 'number') patch.waitTimeoutMs = rawPayload.waitTimeoutMs
          if (typeof rawPayload.maxPromptMessages === 'number') patch.maxPromptMessages = rawPayload.maxPromptMessages
          if (typeof rawPayload.messagePageSize === 'number') patch.messagePageSize = rawPayload.messagePageSize
          if (typeof rawPayload.maxEditableMessages === 'number') patch.maxEditableMessages = rawPayload.maxEditableMessages
          if (typeof rawPayload.aiProactive === 'boolean') patch.aiProactive = rawPayload.aiProactive
          if (typeof rawPayload.maxProactivePerRound === 'number') patch.maxProactivePerRound = rawPayload.maxProactivePerRound
          if (typeof rawPayload.maxAiMentionDepth === 'number') patch.maxAiMentionDepth = rawPayload.maxAiMentionDepth
          const snapshot = service.updateConfig(agent, patch, groupIdField(rawPayload))
          return ok<SnapshotResponse>({ revision: snapshot.revision, group: snapshot })
        }

        case 'settings.update': {
          const mentionEnabled = rawPayload.mentionEnabled
          if (typeof mentionEnabled !== 'boolean') {
            return fail('BAD_REQUEST', 'mentionEnabled must be a boolean')
          }
          const snapshot = service.setMentionEnabled(agent, mentionEnabled, groupIdField(rawPayload))
          return ok<SnapshotResponse>({ revision: snapshot.revision, group: snapshot })
        }

        default:
          return fail('UNKNOWN_ENDPOINT', `unknown chatgroup endpoint "${endpoint}"`)
      }
    } catch (error: unknown) {
      if (error instanceof ChatGroupError) return fail(error.code, error.message)
      return fail('INTERNAL', error instanceof Error ? error.message : String(error))
    }
  }

  return ctx.connection.rpc.handle(CHANNEL, handler, { authority: 'trusted-host' })
}

function resolveAgent(ctx: Context, sessionId: SessionId): Agent | undefined {
  return ctx.agents.get(sessionId)
}

let cachedCatalog: {
  at: number
  value: {
    providers: Array<{ id: string; name: string; models: string[] }>
    defaultTimeoutMs: number
  }
} | undefined

async function readCatalog(ctx: Context, service: ChatGroupService): Promise<{
  providers: Array<{ id: string; name: string; models: string[] }>
  defaultTimeoutMs: number
}> {
  if (cachedCatalog !== undefined && Date.now() - cachedCatalog.at < CATALOG_TTL_MS) {
    return { ...cachedCatalog.value, providers: cachedCatalog.value.providers.map(provider => ({ ...provider, models: [...provider.models] })) }
  }

  const providers = ctx.llm.listProviders()
  const settled = await Promise.allSettled(providers.map(async provider => {
    const models = await ctx.llm.listModels(provider.id)
    return {
      id: provider.id,
      name: provider.name,
      models: models.map(model => model.id),
    }
  }))
  const value = {
    providers: settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : []),
    defaultTimeoutMs: service.defaultTimeoutMs,
  }
  cachedCatalog = { at: Date.now(), value }
  return { ...value, providers: value.providers.map(provider => ({ ...provider, models: [...provider.models] })) }
}
