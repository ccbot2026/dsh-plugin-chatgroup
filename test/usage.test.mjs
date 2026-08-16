import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { ChatGroupService } from '../dist/group-service.js'
import { DEFAULT_READONLY_TOOLS } from '../dist/types.js'

/**
 * Harness that emits a usage chunk + tool activity on the child session so
 * the ai-speaker listeners can observe them.
 */
function makeService() {
  const listeners = new Set()
  const ctx = {
    subagents: {
      async start(_name, request) {
        const childSessionId = `child-${request.parent.session.id}`
        // Emit usage + tool events asynchronously (macro task so listeners are registered).
        setTimeout(() => {
          for (const listener of listeners) {
            listener({ id: childSessionId }, {
              type: 'assistant/chunk',
              data: {
                turn: 1, step: 1,
                chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200 } },
              },
            })
          }
        }, 20)
        return {
          id: request.parent.session.id,
          localAgent: { session: { id: childSessionId } },
          // Delay result so the usage event lands while listeners are live.
          result: new Promise((resolve) => setTimeout(() => resolve({
            output: [{ type: 'text', text: 'reply' }],
            stopReason: 'completed',
          }), 50)),
          dispose: async () => {},
        }
      },
    },
    logger() { return { warn() {} } },
    get(name) { return name === 'subagents' ? this.subagents : undefined },
    on(_type, listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return new ChatGroupService(ctx, { maxAi: 3, maxGroups: 1, defaultTimeoutMs: 5_000, readonlyTools: DEFAULT_READONLY_TOOLS })
}

function makeAgent() {
  return { session: { id: `test-session-${randomUUID()}`, header: { cwd: `/tmp/chatgroup-usage-workspace-${randomUUID()}` } } }
}

async function waitIdle(service, agent) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const snap = service.snapshot(agent)
    if (snap !== null && snap.status === 'idle') return snap
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitIdle timeout')
}

test('V2.6: AI message carries usage; memberUsage aggregates per member', async () => {
  const service = makeService()
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })
  service.addMember(agent, { name: 'Bob', provider: 'deepseek', model: 'chat' })

  service.send(agent, '议题')
  const idle = await waitIdle(service, agent)

  const aliceId = idle.members.find(m => m.name === 'Alice').id
  const bobId = idle.members.find(m => m.name === 'Bob').id
  const aliceMsg = idle.messages.find(m => m.senderId === aliceId)
  const bobMsg = idle.messages.find(m => m.senderId === bobId)

  // Each AI message records the observed usage.
  assert.equal(aliceMsg.usage.inputTokens, 100)
  assert.equal(aliceMsg.usage.outputTokens, 50)
  assert.equal(aliceMsg.usage.cacheReadTokens, 200)
  assert.equal(bobMsg.usage.inputTokens, 100)

  // Snapshot aggregates per member.
  assert.equal(idle.memberUsage[aliceId].inputTokens, 100)
  assert.equal(idle.memberUsage[aliceId].outputTokens, 50)
  assert.equal(idle.memberUsage[aliceId].cacheReadTokens, 200)
  assert.equal(idle.memberUsage[bobId].inputTokens, 100)
})
