import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { ChatGroupService } from '../dist/group-service.js'
import { registerChatGroupRpc } from '../dist/rpc.js'
import { DEFAULT_READONLY_TOOLS } from '../dist/types.js'

function makeContext(service, agent) {
  let capturedHandler
  let capturedChannel
  let capturedOptions
  const connection = {
    rpc: {
      handle(channel, handler, options) {
        capturedChannel = channel
        capturedHandler = handler
        capturedOptions = options
        return async () => {}
      },
    },
  }
  const ctx = {
    connection,
    get(name) { return name === 'agents' ? this.agents : name === 'llm' ? this.llm : name === 'tools' ? this.tools : undefined },
    agents: {
      get(id) { return id === agent.session.id ? agent : undefined },
    },
    llm: {
      listProviders() { return [{ id: 'deepseek', name: 'DeepSeek' }] },
      async listModels() { return [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
    },
  }

  const rpc = registerChatGroupRpc(ctx, service)
  assert.equal(capturedChannel, '/chatgroup')
  assert.equal(capturedOptions.authority, 'trusted-host')
  assert.ok(capturedHandler)
  return {
    async call(endpoint, payload = {}) {
      const result = await capturedHandler(endpoint, { sessionId: agent.session.id, ...payload }, new AbortController().signal)
      assert.equal(result.ok, true, JSON.stringify(result))
      return result.value
    },
  }
}

test('M2 RPC: snapshot / create / member add / send / wait / catalog', async () => {
  const subagents = {
    async start(_name, request) {
      return {
        id: request.parent.session.id,
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'AI reply' }], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  }
  const service = new ChatGroupService({ subagents, logger() { return { warn() {} } }, get() { return undefined } }, {
    maxAi: 3,
    defaultTimeoutMs: 5000,
    readonlyTools: DEFAULT_READONLY_TOOLS,
  })
  const agent = { session: { id: `rpc-session-${randomUUID()}`, header: { cwd: `/tmp/chatgroup-rpc-workspace-${randomUUID()}` } } }
  const { call } = makeContext(service, agent)

  const empty = await call('snapshot')
  assert.equal(empty.group, null)
  assert.equal(empty.revision, -1)

  const created = await call('create')
  assert.equal(created.group.status, 'idle')

  const added = await call('members.add', {
    member: { name: 'Alice', provider: 'deepseek', model: 'deepseek-chat' },
  })
  assert.equal(added.group.speakerOrder.length, 1)

  const sent = await call('send', { text: '讨论一下' })
  assert.equal(sent.group.status, 'running')

  let waited = await call('wait', { revision: sent.revision })
  for (let i = 0; i < 20 && waited.group.status === 'running'; i += 1) {
    waited = await call('wait', { revision: waited.revision })
  }
  assert.equal(waited.changed, true)
  assert.equal(waited.group.status, 'idle')
  assert.equal(waited.group.messages.length, 2)

  const catalog = await call('catalog')
  assert.equal(catalog.providers[0].id, 'deepseek')
  assert.deepEqual(catalog.providers[0].models, ['deepseek-chat'])
})

test('M2 RPC: errors carry chatGroupCode in details', async () => {
  const service = new ChatGroupService({ subagents: {}, logger() { return { warn() {} } } }, {
    maxAi: 3,
    defaultTimeoutMs: 5000,
    readonlyTools: DEFAULT_READONLY_TOOLS,
  })
  const agent = { session: { id: `rpc-session-errors-${randomUUID()}`, header: { cwd: `/tmp/chatgroup-rpc-workspace-${randomUUID()}` } } }
  const ctx = {
    connection: { rpc: { handle(_channel, handler) { globalThis.__chatgroupHandler = handler; return async () => {} } } },
    get(name) { return name === 'agents' ? this.agents : name === 'llm' ? this.llm : name === 'tools' ? this.tools : undefined },
    agents: { get(id) { return id === agent.session.id ? agent : undefined } },
    llm: { listProviders() { return [] } },
  }
  registerChatGroupRpc(ctx, service)
  const result = await globalThis.__chatgroupHandler('send', { sessionId: agent.session.id, text: 'x' }, new AbortController().signal)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'internal')
  assert.equal(result.error.details.chatGroupCode, 'NO_GROUP')
})
