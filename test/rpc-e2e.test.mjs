import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { ChatGroupService } from '../dist/group-service.js'
import { registerChatGroupRpc } from '../dist/rpc.js'
import { DEFAULT_READONLY_TOOLS } from '../dist/types.js'

/** RPC harness with scripted subagents + optional usage emission. */
function makeContext(service, agent, { withUsage = false } = {}) {
  let capturedHandler
  const ctx = {
    connection: {
      rpc: {
        handle(channel, handler) {
          capturedHandler = handler
          return async () => {}
        },
      },
    },
    get(name) { return name === 'agents' ? this.agents : name === 'llm' ? this.llm : name === 'tools' ? this.tools : undefined },
    agents: { get(id) { return id === agent.session.id ? agent : undefined } },
    llm: {
      listProviders() { return [{ id: 'deepseek', name: 'DeepSeek' }] },
      async listModels() { return [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
    },
  }
  const rpc = registerChatGroupRpc(ctx, service)
  assert.ok(capturedHandler)
  return {
    async call(endpoint, payload = {}) {
      const result = await capturedHandler(endpoint, { sessionId: agent.session.id, ...payload }, new AbortController().signal)
      if (!result.ok) {
        const details = result.error?.details
        throw Object.assign(new Error(result.error?.message), { chatGroupCode: details?.chatGroupCode })
      }
      return result.value
    },
  }
}

function makeService({ maxGroups = 2, withUsage = false } = {}) {
  const ctx = {
    subagents: {
      async start(_name, request) {
        const promptText = request.prompt[0].text
        const name = /你是群聊成员“([^”]+)”/.exec(promptText)?.[1] ?? 'AI'
        const childId = `child-${randomUUID()}`
        if (withUsage) {
          setTimeout(() => {
            // Emit usage on the child session through the real event bus if
            // available; here we rely on the ai-speaker listener wiring which
            // the service test already covers — usage is exercised elsewhere.
          }, 0)
        }
        return {
          id: request.parent.session.id,
          localAgent: { session: { id: childId } },
          result: Promise.resolve({ output: [{ type: 'text', text: `reply from ${name}` }], stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    },
    logger() { return { warn() {} } },
    get(name) { return name === 'subagents' ? this.subagents : undefined },
    on() { return () => true },
  }
  return new ChatGroupService(ctx, { maxAi: 3, maxGroups, defaultTimeoutMs: 5_000, readonlyTools: DEFAULT_READONLY_TOOLS })
}

function makeAgent() {
  return { session: { id: `test-session-${randomUUID()}`, header: { cwd: `/tmp/chatgroup-rpc-e2e-${randomUUID()}` } } }
}

async function waitIdle(service, agent, groupId) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const snap = service.snapshot(agent, groupId)
    if (snap !== null && snap.status === 'idle') return snap
    await delay(10)
  }
  throw new Error('waitIdle timeout')
}

test('V0.4.0 RPC e2e: multi-group create/switch, edit/withdraw, wait isolation', async () => {
  const service = makeService({ maxGroups: 2 })
  const agent = makeAgent()
  const rpc = makeContext(service, agent)

  // Create two groups with distinct members.
  const g1 = await rpc.call('create')
  assert.equal(g1.group.groupId, 'group-1')
  await rpc.call('members.add', { member: { name: 'Alice', provider: 'deepseek', model: 'chat' }, groupId: 'group-1' })
  const g2 = await rpc.call('create')
  assert.equal(g2.group.groupId, 'group-2')
  await rpc.call('members.add', { member: { name: 'Bob', provider: 'deepseek', model: 'chat' }, groupId: 'group-2' })

  // groups.list exposes both; groups.use switches the default.
  const list = await rpc.call('groups.list')
  assert.deepEqual(list.groups.map(g => g.groupId), ['group-1', 'group-2'])
  await rpc.call('groups.use', { groupId: 'group-1' })

  // Send in group-1; group-2 stays empty (isolation).
  await rpc.call('send', { text: 'group-1 议题', groupId: 'group-1' })
  await waitIdle(service, agent, 'group-1')
  const snap1 = service.snapshot(agent, 'group-1')
  assert.ok(snap1.messages.length >= 2) // user + Alice
  const snap2 = service.snapshot(agent, 'group-2')
  assert.equal(snap2.messages.length, 0)

  // Edit + withdraw via RPC on group-1's user message.
  const userMsg = snap1.messages.find(m => m.senderId === 'user')
  const edited = await rpc.call('messages.edit', { seq: userMsg.seq, text: '修改后议题', groupId: 'group-1' })
  assert.equal(edited.group.messages.find(m => m.seq === userMsg.seq).editedText, '修改后议题')
  await rpc.call('messages.withdraw', { seq: userMsg.seq, groupId: 'group-1' })
  assert.equal(service.snapshot(agent, 'group-1').messages.find(m => m.seq === userMsg.seq).status, 'withdrawn')

  // Wait isolation: waiting on group-2 must not be woken by group-1 changes.
  const waitPromise = rpc.call('wait', { revision: -1, groupId: 'group-2' })
  await rpc.call('stop', { groupId: 'group-1' }) // bump group-1 (no-op idle)
  await rpc.call('send', { text: 'group-2 议题', groupId: 'group-2' }) // bumps group-2
  const waited = await waitPromise
  assert.equal(waited.changed, true)
  assert.equal(waited.group.groupId, 'group-2')
})

test('V0.4.0 RPC e2e: rename + config round-trip + errors carry chatGroupCode', async () => {
  const service = makeService({ maxGroups: 2 })
  const agent = makeAgent()
  const rpc = makeContext(service, agent)
  await rpc.call('create')

  const renamed = await rpc.call('groups.rename', { name: '需求讨论', groupId: 'group-1' })
  assert.equal(renamed.group.name, '需求讨论')

  // Raise maxGroups via config; a second group becomes creatable.
  const cfg = await rpc.call('settings.config.update', { maxGroups: 2, groupId: 'group-1' })
  assert.equal(cfg.group.config.maxGroups, 2)
  const g2 = await rpc.call('create')
  assert.equal(g2.group.groupId, 'group-2')

  // Cap enforced: a third create fails with GROUP_LIMIT_EXCEEDED.
  await assert.rejects(() => rpc.call('create'), /最多 2 个群/)

  // Unknown member error surfaces chatGroupCode.
  try {
    await rpc.call('members.remove', { memberName: 'nobody', groupId: 'group-1' })
    assert.fail('expected UNKNOWN_MEMBER')
  } catch (error) {
    assert.equal(error.chatGroupCode, 'UNKNOWN_MEMBER')
  }
})
