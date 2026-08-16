import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ChatGroupService } from '../dist/group-service.js'
import { DEFAULT_READONLY_TOOLS } from '../dist/types.js'

function makeAgent() {
  return {
    session: {
      id: `auto-session-${randomUUID()}`,
      header: { cwd: `/tmp/chatgroup-auto-${randomUUID()}` },
    },
  }
}

function autoCompleteSubagents() {
  return {
    async start(_name, request) {
      return {
        id: request.parent.session.id,
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'auto reply' }], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  }
}

function makeService(subagents) {
  return new ChatGroupService({
    subagents,
    logger() { return { warn() {} } },
    get(name) { return name === 'subagents' ? subagents : undefined },
  }, { maxAi: 3, defaultTimeoutMs: 5000, readonlyTools: DEFAULT_READONLY_TOOLS })
}

async function waitIdle(service, agent) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const snap = service.snapshot(agent)
    if (snap?.status === 'idle') return snap
    await delay(10)
  }
  throw new Error('waitIdle timeout')
}

test('M8 auto: fixed two-round discussion from idle, first auto round blind', async () => {
  const service = makeService(autoCompleteSubagents())
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })

  const started = service.startAuto(agent, 2, '自动讨论议题')
  assert.equal(started.autoActive, true)
  assert.equal(started.autoTotalRounds, 2)
  assert.equal(started.autoCurrentRound, 1)
  assert.equal(started.blindRoundActive, true)

  const done = await waitIdle(service, agent)
  assert.equal(done.autoActive, false)
  assert.equal(done.round, 2)
  const systemTexts = done.messages.filter(m => m.senderId === 'system').map(m => m.text)
  assert.deepEqual(systemTexts, [
    '自动讨论开始，共 2 轮。',
    '自动进入第 2 轮讨论。',
    '自动讨论完成，共 2 轮。',
  ])
  assert.equal(done.messages.filter(m => m.senderId !== 'system' && m.status === 'completed').length, 2)
})

test('M8 auto: can start mid-discussion without a topic', async () => {
  const service = makeService(autoCompleteSubagents())
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })
  service.send(agent, '普通第一轮')
  await waitIdle(service, agent)

  const started = service.startAuto(agent, 2)
  assert.equal(started.round, 2)
  assert.equal(started.blindRoundActive, false)

  const done = await waitIdle(service, agent)
  assert.equal(done.round, 3)
  assert.equal(done.messages.filter(m => m.senderId === 'system').length, 3)
})

test('M8 auto: stop terminates auto mode and prevents next round', async () => {
  let calls = 0
  const subagents = {
    async start(_name, request) {
      calls += 1
      let resolveResult
      const result = new Promise(resolve => { resolveResult = resolve })
      const onAbort = () => resolveResult({ output: [], stopReason: 'aborted' })
      if (request.signal.aborted) onAbort()
      else request.signal.addEventListener('abort', onAbort, { once: true })
      return { id: request.parent.session.id, localAgent: undefined, result, dispose: async () => {} }
    },
  }
  const service = makeService(subagents)
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })

  service.startAuto(agent, 3)
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && service.snapshot(agent).currentSpeakerId === undefined) await delay(5)
  service.stop(agent)
  const done = await waitIdle(service, agent)
  assert.equal(done.autoActive, false)
  assert.equal(calls, 1)
})
