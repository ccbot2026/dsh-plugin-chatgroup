import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { ChatGroupService } from '../dist/group-service.js'
import { DEFAULT_READONLY_TOOLS } from '../dist/types.js'

/**
 * Harness: round replies are plain `reply from <name>`; proactive consults
 * return `<name>:proactive-<text>` (or a decline for the given name).
 */
function makeService(config = {}, { proactive = {}, round = {} } = {}) {
  const calls = []
  const ctx = {
    subagents: {
      async start(_name, request) {
        calls.push(request)
        const promptText = request.prompt[0].text
        const name = /你是群聊成员“([^”]+)”/.exec(promptText)?.[1] ?? 'AI'
        const isProactive = promptText.includes('本轮讨论已经结束')
        const text = isProactive
          ? (proactive[name] ?? '无需补充')
          : (round[name] ?? `reply from ${name}`)
        return {
          id: request.parent.session.id,
          localAgent: undefined,
          result: Promise.resolve({
            output: [{ type: 'text', text }],
            stopReason: 'completed',
          }),
          dispose: async () => {},
        }
      },
    },
    logger() { return { warn() {} } },
    get(name) { return name === 'subagents' ? this.subagents : undefined },
  }
  return { service: new ChatGroupService(ctx, { maxAi: 3, maxGroups: 1, defaultTimeoutMs: 5_000, readonlyTools: DEFAULT_READONLY_TOOLS, aiProactive: true, maxProactivePerRound: 2, maxAiMentionDepth: 1, ...config }), calls }
}

function makeAgent() {
  return { session: { id: `test-session-${randomUUID()}`, header: { cwd: `/tmp/chatgroup-proactive-workspace-${randomUUID()}` } } }
}

async function waitIdle(service, agent) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const snap = service.snapshot(agent)
    if (snap !== null && snap.status === 'idle') return snap
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitIdle timeout; last: ' + JSON.stringify(service.snapshot(agent)?.status))
}

test('V2.3: proactive disabled by default -> no extra AI remarks', async () => {
  const { service } = makeService({ aiProactive: false }, { proactive: { Alice: 'Alice:proactive-A', Bob: 'Bob:proactive-B' } })
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })
  service.addMember(agent, { name: 'Bob', provider: 'deepseek', model: 'chat' })
  service.send(agent, '议题')
  const idle = await waitIdle(service, agent)
  const aiMessages = idle.messages.filter(m => m.senderId !== 'user')
  assert.equal(aiMessages.length, 2) // only the round replies
  assert.ok(!idle.messages.some(m => m.text.includes('proactive')))
})

test('V2.3: proactive adds one remark per AI after a clean round', async () => {
  const { service, calls } = makeService({ aiProactive: true, maxProactivePerRound: 2 }, {
    proactive: { Alice: 'Alice:proactive-A', Bob: 'Bob:proactive-B' },
  })
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })
  service.addMember(agent, { name: 'Bob', provider: 'deepseek', model: 'chat' })
  service.send(agent, '议题')
  const idle = await waitIdle(service, agent)

  // Round replies (2) + proactive remarks (2).
  const proactiveTexts = idle.messages.filter(m => m.text.includes('proactive')).map(m => m.text)
  assert.deepEqual(proactiveTexts.sort(), ['Alice:proactive-A', 'Bob:proactive-B'])
  // The proactive consult prompts explicitly ask for a remark.
  const proactivePrompt = calls.find(c => /本轮讨论已经结束/.test(c.prompt[0].text))
  assert.ok(proactivePrompt)
})

test('V2.3: proactive declines produce no remark', async () => {
  const { service } = makeService({ aiProactive: true }, {
    proactive: { Alice: '无需补充', Bob: 'Bob:proactive-B' },
  })
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })
  service.addMember(agent, { name: 'Bob', provider: 'deepseek', model: 'chat' })
  service.send(agent, '议题')
  const idle = await waitIdle(service, agent)
  assert.ok(!idle.messages.some(m => m.text === '无需补充'))
  assert.ok(idle.messages.some(m => m.text === 'Bob:proactive-B'))
})

test('V2.3: maxProactivePerRound caps the number of remarks', async () => {
  const { service } = makeService({ aiProactive: true, maxProactivePerRound: 1 }, {
    proactive: { Alice: 'Alice:proactive-A', Bob: 'Bob:proactive-B' },
  })
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })
  service.addMember(agent, { name: 'Bob', provider: 'deepseek', model: 'chat' })
  service.send(agent, '议题')
  const idle = await waitIdle(service, agent)
  const proactive = idle.messages.filter(m => m.text.includes('proactive'))
  assert.equal(proactive.length, 1)
})

test('V2.3: AI message mentioning another AI enqueues a single-depth reply', async () => {
  const { service, calls } = makeService({ aiProactive: false, maxAiMentionDepth: 1 }, {
    round: { Alice: 'Bob 你说说 @Bob' },
    proactive: {},
  })
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })
  service.addMember(agent, { name: 'Bob', provider: 'deepseek', model: 'chat' })
  service.send(agent, '议题')
  const idle = await waitIdle(service, agent)

  // Alice's @Bob triggers one extra Bob reply (Bob's round reply is the
  // default `reply from Bob`; the mention-triggered one is also that default,
  // so count Bob's total AI messages: round reply + mention reply = 2).
  const bobMessages = idle.messages.filter(m => m.senderId === idle.members.find(x => x.name === 'Bob').id)
  assert.equal(bobMessages.length, 2)
  // The mention-triggered reply lands inside the same round (mode stays 'round').
  const mentionMessage = idle.messages.filter(m => m.senderId === idle.members.find(x => x.name === 'Bob').id).at(-1)
  assert.equal(mentionMessage.round, 1)
})

test('V2.3: AI @ depth limit stops chains (no infinite loop)', async () => {
  const { service } = makeService({ aiProactive: false, maxAiMentionDepth: 1 }, {
    round: { Alice: 'Bob 请回应 @Bob', Bob: 'Alice 请回应 @Alice' },
  })
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })
  service.addMember(agent, { name: 'Bob', provider: 'deepseek', model: 'chat' })
  service.send(agent, '议题')
  const idle = await waitIdle(service, agent)

  // Round: Alice -> Bob(d1), Bob -> Alice(d1). Each depth-1 reply mentions the
  // other at depth 2, which the limit drops. AI messages: 2 round + 2 depth-1.
  const aiMessages = idle.messages.filter(m => m.senderId !== 'user' && m.senderId !== 'system')
  assert.equal(aiMessages.length, 4)
  // System notes record the dropped mentions.
  const dropped = idle.messages.filter(m => m.senderId === 'system' && m.text.includes('深度已达上限'))
  assert.equal(dropped.length, 2)
})
