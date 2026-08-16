import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { ChatGroupService } from '../dist/group-service.js'
import { DEFAULT_READONLY_TOOLS } from '../dist/types.js'

test('M8: RPC snapshot returns a tail page and messagesBefore pages backward', async () => {
  const subagents = {
    async start(_name, request) {
      let resolveResult
      const result = new Promise(resolve => { resolveResult = resolve })
      const onAbort = () => resolveResult({ output: [], stopReason: 'aborted' })
      if (request.signal.aborted) onAbort()
      else request.signal.addEventListener('abort', onAbort, { once: true })
      return { id: request.parent.session.id, localAgent: undefined, result, dispose: async () => {} }
    },
  }
  const ctx = {
    subagents,
    logger() { return { warn() {} } },
    get(name) { return name === 'subagents' ? subagents : undefined },
  }
  const agent = {
    session: {
      id: `page-session-${randomUUID()}`,
      header: { cwd: `/tmp/chatgroup-page-${randomUUID()}` },
    },
  }
  const service = new ChatGroupService(ctx, {
    maxAi: 3,
    defaultTimeoutMs: 5000,
    readonlyTools: DEFAULT_READONLY_TOOLS,
    messagePageSize: 10,
  })

  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })
  service.send(agent, 'first')
  for (let i = 0; i < 24; i += 1) service.send(agent, `interjection ${i}`)

  const tail = service.snapshot(agent)
  assert.equal(tail.totalMessages, 26) // 1 initial + 24 interjections + 1 AI placeholder
  assert.equal(tail.messages.length, 10)
  assert.equal(tail.hasMoreMessages, true)
  assert.equal(tail.oldestLoadedSeq, tail.messages[0].seq)

  const before = service.messagesBefore(agent.session.id, tail.oldestLoadedSeq, 10)
  assert.ok(before)
  assert.equal(before.messages.length, 10)
  assert.equal(before.messages[before.messages.length - 1].seq, tail.oldestLoadedSeq - 1)
  assert.equal(before.hasMore, true)

  const firstPage = service.messagesBefore(agent.session.id, before.messages[0].seq, 10)
  assert.ok(firstPage)
  assert.equal(firstPage.messages.length, 6)
  assert.equal(firstPage.hasMore, false)

  service.stop(agent)
})
