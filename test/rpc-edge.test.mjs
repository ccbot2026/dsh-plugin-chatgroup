import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ChatGroupService } from '../dist/group-service.js'
import { registerChatGroupRpc } from '../dist/rpc.js'
import { DEFAULT_READONLY_TOOLS } from '../dist/types.js'

function makeService(subagents, config = {}) {
  return new ChatGroupService({
    subagents,
    logger() { return { warn() {} } },
    get(name) { return name === 'subagents' ? subagents : undefined },
  }, { maxAi: 3, defaultTimeoutMs: 5000, readonlyTools: DEFAULT_READONLY_TOOLS, ...config })
}

function makeRpc(service, agent, llm) {
  let handler
  const ctx = {
    connection: {
      rpc: { handle(_channel, h) { handler = h; return async () => {} } },
    },
    get(name) { return name === 'agents' ? this.agents : name === 'llm' ? this.llm : name === 'tools' ? this.tools : undefined },
    agents: { get(id) { return id === agent.session.id ? agent : undefined } },
    llm: llm ?? { listProviders() { return [] } },
  }
  registerChatGroupRpc(ctx, service)
  return {
    async call(endpoint, payload = {}) {
      const result = await handler(endpoint, { sessionId: agent.session.id, ...payload }, new AbortController().signal)
      assert.equal(result.ok, true, JSON.stringify(result))
      return result.value
    },
  }
}

function makeAgent() {
  return {
    session: {
      id: `rpc-edge-${randomUUID()}`,
      header: { cwd: `/tmp/chatgroup-rpc-edge-${randomUUID()}` },
    },
  }
}

test('M7 RPC: remove / reorder / mention / dissolve endpoints', async () => {
  const subagents = {
    async start(_name, request) {
      return {
        id: request.parent.session.id,
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  }
  const service = makeService(subagents)
  const agent = makeAgent()
  const rpc = makeRpc(service, agent)

  await rpc.call('create')
  await rpc.call('members.add', { member: { name: 'Alice', provider: 'deepseek', model: 'chat' } })
  await rpc.call('members.add', { member: { name: 'Bob', provider: 'deepseek', model: 'chat' } })
  let group = await rpc.call('members.reorder', { names: ['Bob', 'Alice'] })
  assert.deepEqual(group.group.speakerOrder.map(id => group.group.members.find(m => m.id === id).name), ['Bob', 'Alice'])

  group = await rpc.call('settings.update', { mentionEnabled: false })
  assert.equal(group.group.mentionEnabled, false)

  group = await rpc.call('members.remove', { memberName: 'Alice' })
  assert.equal(group.group.speakerOrder.length, 1)

  const dissolved = await rpc.call('dissolve')
  assert.equal(dissolved, null)
  assert.equal(service.snapshot(agent), null)
})

test('M9 RPC: config.get exposes effective runtime config', async () => {
  const service = makeService({}, { waitTimeoutMs: 1234, messagePageSize: 7, maxPromptMessages: 9 })
  const agent = makeAgent()
  const rpc = makeRpc(service, agent)
  const config = await rpc.call('config.get')
  assert.equal(config.waitTimeoutMs, 1234)
  assert.equal(config.messagePageSize, 7)
  assert.equal(config.maxPromptMessages, 9)
  assert.deepEqual(config.readonlyTools, DEFAULT_READONLY_TOOLS)
})

test('M9.1 RPC: settings.config.update edits group-level config', async () => {
  const service = makeService({})
  const agent = makeAgent()
  const rpc = makeRpc(service, agent)

  await rpc.call('create')
  await rpc.call('members.add', { member: { name: 'Alice', provider: 'deepseek', model: 'chat' } })
  const updated = await rpc.call('settings.config.update', {
    maxAi: 4,
    defaultTimeoutMs: 120000,
    readonlyTools: ['read', 'glob'],
    waitTimeoutMs: 18000,
    maxPromptMessages: 12,
    messagePageSize: 50,
  })
  assert.equal(updated.group.config.maxAi, 4)
  assert.equal(updated.group.config.defaultTimeoutMs, 120000)
  assert.deepEqual(updated.group.config.readonlyTools, ['read', 'glob'])
  assert.deepEqual(updated.group.members.find(m => m.name === 'Alice').ai.tools, ['read', 'glob'])
  assert.equal(service.configFor(agent).messagePageSize, 50)

  const snap = service.snapshot(agent)
  assert.equal(snap.config.maxPromptMessages, 12)
})

test('M7 RPC: catalog drops providers whose model listing fails', async () => {
  const service = makeService({})
  const agent = makeAgent()
  const rpc = makeRpc(service, agent, {
    listProviders() {
      return [
        { id: 'good', name: 'Good' },
        { id: 'bad', name: 'Bad' },
      ]
    },
    async listModels(provider) {
      if (provider === 'bad') throw new Error('boom')
      return [{ id: 'good-model', name: 'Good Model' }]
    },
  })
  const catalog = await rpc.call('catalog')
  assert.deepEqual(catalog.providers, [{ id: 'good', name: 'Good', models: ['good-model'] }])
})

test('M7: wait timeout returns changed=false; concurrent waits wake on create', async () => {
  const service = makeService({}, { waitTimeoutMs: 20 })
  const agent = makeAgent()

  const snapshotBefore = service.snapshot(agent)
  assert.equal(snapshotBefore, null)
  const timed = await service.waitForRevision(agent.session.id, -1, 20, new AbortController().signal)
  assert.equal(timed.changed, false)
  assert.equal(timed.snapshot, null)

  const first = service.waitForRevision(agent.session.id, -1, 5000, new AbortController().signal)
  const second = service.waitForRevision(agent.session.id, -1, 5000, new AbortController().signal)
  service.create(agent)
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.changed, true)
  assert.equal(b.changed, true)
  assert.equal(a.snapshot.status, 'idle')
})
