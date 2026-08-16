import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { ChatGroupService } from '../dist/group-service.js'
import { DEFAULT_READONLY_TOOLS } from '../dist/types.js'

/**
 * Harness: Alice's first call completes immediately with a real reply; every
 * later call (Bob, or Alice again) blocks until aborted. This models a first
 * round where Alice already produced a remark while Bob is still pending.
 */
/**
 * Harness: Alice's calls complete immediately with a real reply that echoes
 * the topic title; Bob (and every other member) blocks until aborted. This
 * models a first round where Alice already produced a remark while Bob is
 * still pending, and works across topics.
 */
function makeInterruptHarness() {
  const ctx = {
    subagents: {
      async start(_name, request) {
        const promptText = request.prompt[0].text
        const name = /你是群聊成员“([^”]+)”/.exec(promptText)?.[1] ?? 'AI'
        if (name === 'Alice') {
          // V0.4.1: the summarizer pass answers with a REAL summary, distinct
          // from a normal round reply.
          const isSummary = promptText.includes('首轮讨论被用户中断')
          const text = isSummary ? '真摘要：Alice 与 Bob 就议题存在分歧，Alice 主张方案 A。' : 'Alice 的关键观点'
          return {
            id: request.parent.session.id,
            localAgent: undefined,
            result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
            dispose: async () => {},
          }
        }
        let resolveResult
        const result = new Promise((resolve) => { resolveResult = resolve })
        const onAbort = () => resolveResult({ output: [], stopReason: 'aborted' })
        if (request.signal.aborted) onAbort()
        else request.signal.addEventListener('abort', onAbort, { once: true })
        return { id: request.parent.session.id, localAgent: undefined, result, dispose: async () => {} }
      },
    },
    logger() { return { warn() {} } },
    get(name) { return name === 'subagents' ? this.subagents : undefined },
  }
  return new ChatGroupService(ctx, { maxAi: 3, maxGroups: 1, defaultTimeoutMs: 5_000, readonlyTools: DEFAULT_READONLY_TOOLS })
}

function makeAgent() {
  return { session: { id: `test-session-${randomUUID()}`, header: { cwd: `/tmp/chatgroup-summary-workspace-${randomUUID()}` } } }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timeout')
}

test('V2.4: interrupted first round emits a system summary of produced remarks', async () => {
  const service = makeInterruptHarness()
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })
  service.addMember(agent, { name: 'Bob', provider: 'deepseek', model: 'chat' })

  // Alice completes; Bob starts (blocks); stop interrupts with Bob pending.
  service.send(agent, '议题')
  await waitFor(() => {
    const snap = service.snapshot(agent)
    const alice = snap.messages.find(m => m.senderId === snap.members.find(x => x.name === 'Alice')?.id)
    return alice !== undefined && alice.status === 'completed' && snap.currentSpeakerId !== undefined
  })
  service.stop(agent)

  const idle = await waitFor(() => {
    const snap = service.snapshot(agent)
    return snap.status === 'idle' ? snap : null
  })
  assert.equal(idle.round, 1)

  const summary = idle.messages.find(m => m.senderId === 'system' && m.text.includes('首轮已由用户中断'))
  assert.ok(summary, 'expected an interrupt summary')
  // V0.4.1: the summary is a REAL summarization (distinct text from the reply).
  assert.ok(summary.text.includes('真摘要'))
  assert.ok(!summary.text.includes('Alice 的关键观点'))
})

test('V2.4: clean (non-interrupted) first round produces no summary', async () => {
  const ctx = {
    subagents: {
      async start(_name, request) {
        const promptText = request.prompt[0].text
        const name = /你是群聊成员“([^”]+)”/.exec(promptText)?.[1] ?? 'AI'
        return {
          id: request.parent.session.id,
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: `${name} 回复` }], stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    },
    logger() { return { warn() {} } },
    get(name) { return name === 'subagents' ? this.subagents : undefined },
  }
  const service = new ChatGroupService(ctx, { maxAi: 3, maxGroups: 1, defaultTimeoutMs: 5_000, readonlyTools: DEFAULT_READONLY_TOOLS })
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })
  service.addMember(agent, { name: 'Bob', provider: 'deepseek', model: 'chat' })
  service.send(agent, '议题')
  const idle = await waitFor(() => {
    const snap = service.snapshot(agent)
    return snap.status === 'idle' ? snap : null
  })
  assert.ok(!idle.messages.some(m => m.senderId === 'system' && m.text.includes('首轮已由用户中断')))
})

test('V2.4: interrupt summary only includes current-topic messages (no cross-topic leak)', async () => {
  const service = makeInterruptHarness()
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })

  // Round 1 in topic-1: only Alice, completes cleanly without interruption.
  service.send(agent, 'topic-1 议题')
  const idle1 = await waitFor(() => {
    const snap = service.snapshot(agent)
    return snap.status === 'idle' && snap.round === 1 ? snap : null
  })
  assert.ok(!idle1.messages.some(m => m.senderId === 'system' && m.text.includes('首轮已由用户中断')))

  // Add Bob (blocks), then start topic-2: Alice completes, Bob pending, stop.
  service.addMember(agent, { name: 'Bob', provider: 'deepseek', model: 'chat' })
  service.startTopic(agent, 'topic-2 议题')
  await waitFor(() => {
    const snap = service.snapshot(agent)
    const alice = snap.messages.find(m => m.senderId === snap.members.find(x => x.name === 'Alice')?.id && m.topicId === 'topic-2')
    return alice !== undefined && alice.status === 'completed' && snap.currentSpeakerId !== undefined
  })
  service.stop(agent)
  const idle2 = await waitFor(() => {
    const snap = service.snapshot(agent)
    return snap.status === 'idle' ? snap : null
  })

  const summary = idle2.messages.find(m => m.senderId === 'system' && m.text.includes('首轮已由用户中断'))
  assert.ok(summary, 'expected an interrupt summary for topic-2')
  // V0.4.1: real summary text (topic-2 only, no topic-1 leak).
  assert.ok(summary.text.includes('真摘要'))
  assert.ok(!summary.text.includes('topic-1 议题'))
})

