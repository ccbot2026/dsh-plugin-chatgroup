import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { ChatGroupService } from '../dist/group-service.js'
import { DEFAULT_READONLY_TOOLS } from '../dist/types.js'

function speakerNameFromPrompt(text) {
  const match = /你是群聊成员“([^”]+)”/.exec(text)
  return match?.[1]
}

function createHarness({ autoComplete = true, autoText = '' } = {}) {
  const calls = []
  const subagents = {
    async start(_name, request) {
      calls.push(request)
      const promptText = request.prompt[0].text
      const name = speakerNameFromPrompt(promptText) ?? 'AI'

      if (autoComplete) {
        const text = autoText || `reply from ${name}`
        return {
          id: request.parent.session.id,
          localAgent: undefined,
          result: Promise.resolve({
            output: [{ type: 'text', text }],
            stopReason: 'completed',
          }),
          dispose: async () => {},
        }
      }

      let resolveResult
      const result = new Promise((resolve) => { resolveResult = resolve })
      const settle = (stopReason, text) => resolveResult({
        output: text === '' ? [] : [{ type: 'text', text }],
        stopReason,
      })
      const onAbort = () => settle('aborted', '')
      if (request.signal.aborted) onAbort()
      else request.signal.addEventListener('abort', onAbort, { once: true })
      return {
        id: request.parent.session.id,
        localAgent: undefined,
        result,
        dispose: async () => {},
      }
    },
  }
  const ctx = {
    subagents,
    logger() { return { warn() {} } },
    get(name) { return name === 'subagents' ? subagents : undefined },
  }
  const service = new ChatGroupService(ctx, {
    maxAi: 3,
    defaultTimeoutMs: 5_000,
    readonlyTools: DEFAULT_READONLY_TOOLS,
  })
  const agent = { session: { id: `test-session-${randomUUID()}`, header: { cwd: `/tmp/chatgroup-test-workspace-${randomUUID()}` } } }
  return { service, agent, calls }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await delay(10)
  }
  throw new Error('waitFor timeout')
}

test('M1: create -> add members -> ordered round -> first round blind prompts', async () => {
  const { service, agent, calls } = createHarness()

  assert.equal(service.snapshot(agent), null)
  const created = service.create(agent)
  assert.equal(created.status, 'idle')
  assert.equal(created.round, 0)

  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })
  service.addMember(agent, { name: 'Bob', provider: 'openai', model: 'gpt' })
  service.reorderMembers(agent, ['Bob', 'Alice'])

  service.send(agent, '请讨论方案')
  const done = await waitFor(() => {
    const snap = service.snapshot(agent)
    return snap.status === 'idle' ? snap : null
  })

  assert.equal(done.round, 1)
  assert.equal(done.messages.length, 3)
  assert.deepEqual(done.messages.map(m => m.senderId === 'user' ? 'user' : service.snapshot(agent).members.find(x => x.id === m.senderId)?.name), ['user', 'Bob', 'Alice'])
  assert.deepEqual(done.messages.slice(1).map(m => m.status), ['completed', 'completed'])
  assert.equal(done.blindRoundActive, false)

  // Blind round: Bob spoke second, so his prompt must not contain Alice's reply.
  const bobCall = calls.find(c => speakerNameFromPrompt(c.prompt[0].text) === 'Bob')
  const aliceCall = calls.find(c => speakerNameFromPrompt(c.prompt[0].text) === 'Alice')
  assert.ok(bobCall)
  assert.ok(aliceCall)
  assert.ok(bobCall.prompt[0].text.includes('[用户]: 请讨论方案'))
  assert.ok(!bobCall.prompt[0].text.includes('[Alice]:'))
  assert.ok(!bobCall.prompt[0].text.includes('发言失败'))
  assert.ok(aliceCall.prompt[0].text.includes('[用户]: 请讨论方案'))

  // Round two is no longer blind.
  service.send(agent, '第二轮')
  const round2 = await waitFor(() => {
    const snap = service.snapshot(agent)
    return snap.status === 'idle' && snap.round === 2 ? snap : null
  })
  assert.equal(round2.blindRoundActive, false)
  const round2Bob = calls.filter(c => speakerNameFromPrompt(c.prompt[0].text) === 'Bob').at(-1)?.prompt[0].text
  assert.ok(round2Bob.includes('[Alice]:'))
})

test('M1: @ targets one AI only and does not advance the normal order', async () => {
  const { service, agent } = createHarness()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })
  service.addMember(agent, { name: 'Bob', provider: 'deepseek', model: 'chat' })

  service.send(agent, '开始')
  await waitFor(() => service.snapshot(agent).status === 'idle')
  const before = service.snapshot(agent)

  service.at(agent, 'Alice', '请解释一下')
  const afterAt = await waitFor(() => {
    const snap = service.snapshot(agent)
    return snap.status === 'idle' ? snap : null
  })

  assert.equal(afterAt.messages.length, before.messages.length + 2) // user @ message + one AI reply
  assert.equal(afterAt.round, 1)
  assert.deepEqual(afterAt.speakerOrder, before.speakerOrder)
  assert.equal(afterAt.messages.at(-1).round, 0)
  assert.equal(afterAt.messages.at(-1).senderId, service.snapshot(agent).members.find(m => m.name === 'Alice').id)
})

test('M1: stop cancels the active speech and clears pending work', async () => {
  const { service, agent } = createHarness({ autoComplete: false })
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })

  service.send(agent, '长任务')
  await waitFor(() => service.snapshot(agent).currentSpeakerId !== undefined)
  service.stop(agent)
  const idle = await waitFor(() => {
    const snap = service.snapshot(agent)
    return snap.status === 'idle' ? snap : null
  })

  const alice = idle.messages.find(m => m.senderId === idle.members.find(x => x.name === 'Alice').id)
  assert.equal(alice.status, 'cancelled')
})

test('M1: speech timeout marks the message and the round continues', async () => {
  // Alice never settles except on abort; Bob auto-completes. The timeout test
  // therefore needs a harness where only the first call blocks and later calls
  // complete. createHarness returns one behavior for all calls, so drive a
  // custom service here.
  let callCount = 0
  const calls = []
  const ctx = {
    subagents: {
      async start(_name, request) {
        calls.push(request)
        callCount += 1
        if (callCount === 1) {
          let resolveResult
          const result = new Promise((resolve) => { resolveResult = resolve })
          const onAbort = () => resolveResult({ output: [], stopReason: 'aborted' })
          if (request.signal.aborted) onAbort()
          else request.signal.addEventListener('abort', onAbort, { once: true })
          return { id: request.parent.session.id, localAgent: undefined, result, dispose: async () => {} }
        }
        return {
          id: request.parent.session.id,
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: 'Bob reply' }], stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    },
    logger() { return { warn() {} } },
    get() { return undefined },
  }
  const service = new ChatGroupService(ctx, {
    maxAi: 3,
    defaultTimeoutMs: 5_000,
    readonlyTools: DEFAULT_READONLY_TOOLS,
  })
  const agent = { session: { id: `test-session-timeout-${randomUUID()}`, header: { cwd: `/tmp/chatgroup-test-workspace-${randomUUID()}` } } }
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat', timeoutMs: 20 })
  service.addMember(agent, { name: 'Bob', provider: 'deepseek', model: 'chat' })

  service.send(agent, '超时测试')
  const idle = await waitFor(() => {
    const snap = service.snapshot(agent)
    return snap.status === 'idle' ? snap : null
  })

  const alice = idle.messages.find(m => m.senderId === idle.members.find(x => x.name === 'Alice').id)
  const bob = idle.messages.find(m => m.senderId === idle.members.find(x => x.name === 'Bob').id)
  assert.equal(alice.status, 'timeout')
  assert.equal(bob.status, 'completed')
})

test('M1: member changes require idle group', () => {
  const { service, agent } = createHarness({ autoComplete: false })
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })
  service.send(agent, '运行中')

  assert.throws(() => service.addMember(agent, { name: 'Bob', provider: 'deepseek', model: 'chat' }), /空闲/)
  service.stop(agent)
})

test('M1: /group command registration and basic dispatch', async () => {
  const { service, agent } = createHarness()
  const definitions = []
  const commands = {
    register(definition) {
      definitions.push(definition)
      return () => {}
    },
  }
  const ctx = { commands }
  const { registerChatGroupCommands } = await import('../dist/commands.js')
  registerChatGroupCommands(ctx, service)

  assert.equal(definitions.length, 1)
  const definition = definitions[0]
  assert.equal(definition.name, 'group')

  const create = await definition.handler({ agent, rawInput: ' create', signal: new AbortController().signal })
  assert.equal(create.kind, 'success')
  assert.match(create.text, /空闲/)

  const bad = await definition.handler({ agent, rawInput: ' add Alice', signal: new AbortController().signal })
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /用法/)

  const add = await definition.handler({ agent, rawInput: ' add Alice deepseek deepseek-chat', signal: new AbortController().signal })
  assert.equal(add.kind, 'success')
  assert.match(add.text, /Alice/)
})
