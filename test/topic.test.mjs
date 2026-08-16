import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ChatGroupService } from '../dist/group-service.js'
import { DEFAULT_READONLY_TOOLS } from '../dist/types.js'

function makeAgent() {
  return {
    session: {
      id: `topic-session-${randomUUID()}`,
      header: { cwd: `/tmp/chatgroup-topic-${randomUUID()}` },
    },
  }
}

function autoCompleteSubagents() {
  const calls = []
  return {
    calls,
    async start(_name, request) {
      calls.push(request)
      return {
        id: request.parent.session.id,
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'reply' }], stopReason: 'completed' }),
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

test('topic: new topic resets round, re-blinds, and excludes old topic from AI prompts', async () => {
  const subagents = autoCompleteSubagents()
  const service = makeService(subagents)
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })

  service.send(agent, '旧议题')
  await waitIdle(service, agent)
  const oldCall = subagents.calls.at(-1)
  assert.ok(oldCall.prompt[0].text.includes('旧议题'))

  const started = service.startTopic(agent, '全新议题')
  assert.equal(started.currentTopicId, 'topic-2')
  assert.equal(started.round, 1)
  assert.equal(started.blindRoundActive, true)
  assert.equal(started.topics.length, 2)

  await waitIdle(service, agent)
  const newCall = subagents.calls.at(-1)
  assert.ok(newCall.prompt[0].text.includes('全新议题'))
  assert.ok(!newCall.prompt[0].text.includes('旧议题'))

  const snap = service.snapshot(agent)
  assert.equal(snap.currentTopicId, 'topic-2')
  assert.equal(snap.messages.filter(m => m.topicId === 'topic-2').length >= 3, true)
})

test('topic: starting a new topic while running cancels the current speaker and continues', async () => {
  let calls = 0
  const subagents = {
    async start(_name, request) {
      calls += 1
      if (calls === 1) {
        let resolveResult
        const result = new Promise(resolve => { resolveResult = resolve })
        const onAbort = () => resolveResult({ output: [], stopReason: 'aborted' })
        if (request.signal.aborted) onAbort()
        else request.signal.addEventListener('abort', onAbort, { once: true })
        return { id: request.parent.session.id, localAgent: undefined, result, dispose: async () => {} }
      }
      return {
        id: request.parent.session.id,
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'new reply' }], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  }
  const service = makeService(subagents)
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })

  service.send(agent, '运行中的旧议题')
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && service.snapshot(agent).currentSpeakerId === undefined) await delay(5)

  service.startTopic(agent, '运行中切换新议题')
  const done = await waitIdle(service, agent)
  assert.equal(done.currentTopicId, 'topic-2')
  assert.equal(calls, 2)
  const oldMessage = done.messages.find(m => m.topicId === 'topic-1' && m.senderId !== 'user' && m.senderId !== 'system')
  assert.equal(oldMessage.status, 'cancelled')
  const newMessage = done.messages.find(m => m.topicId === 'topic-2' && m.status === 'completed')
  assert.equal(newMessage.text, 'new reply')
})

test('export: transcript includes topic headers and all topic messages', async () => {
  const subagents = autoCompleteSubagents()
  const service = makeService(subagents)
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })

  service.send(agent, '旧议题内容')
  await waitIdle(service, agent)
  service.startTopic(agent, '新议题内容')
  await waitIdle(service, agent)

  const markdown = service.exportTranscript(agent)
  assert.ok(markdown.includes('# 群聊记录'))
  assert.ok(markdown.includes('## 话题：默认话题'))
  assert.ok(markdown.includes('## 话题：新议题内容'))
  assert.ok(markdown.includes('旧议题内容'))
  assert.ok(markdown.includes('新议题内容'))
  assert.ok(markdown.includes('### 用户'))
  assert.ok(markdown.includes('### Alice'))
})

test('topic.messages: returns one topic full history', async () => {
  const subagents = autoCompleteSubagents()
  const service = makeService(subagents)
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })
  service.send(agent, '旧话题')
  await waitIdle(service, agent)
  service.startTopic(agent, '新话题')
  await waitIdle(service, agent)

  const old = service.topicMessages(agent.session.id, 'topic-1')
  const current = service.topicMessages(agent.session.id, 'topic-2')
  assert.ok(old.length >= 2)
  assert.ok(current.length >= 3)
  assert.equal(old.every(message => message.topicId === 'topic-1'), true)
  assert.equal(current.every(message => message.topicId === 'topic-2'), true)
})
