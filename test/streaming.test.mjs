import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ChatGroupService } from '../dist/group-service.js'
import { buildMemberPrompt } from '../dist/visibility.js'
import { DEFAULT_READONLY_TOOLS } from '../dist/types.js'

test('M6: AI text deltas stream into the group message', async () => {
  const sessionListeners = []
  let resolveResult
  const result = new Promise(resolve => { resolveResult = resolve })

  const subagents = {
    async start(_name, request) {
      return {
        id: request.parent.session.id,
        localAgent: { session: { id: 'stream-child' } },
        result,
        dispose: async () => {},
      }
    },
  }
  const ctx = {
    subagents,
    logger() { return { warn() {} } },
    get(name) { return name === 'subagents' ? subagents : undefined },
    on(name, listener) {
      if (name === 'session/event') sessionListeners.push(listener)
      return () => {}
    },
  }
  const agent = {
    session: {
      id: `stream-session-${randomUUID()}`,
      header: { cwd: `/tmp/chatgroup-stream-workspace-${randomUUID()}` },
    },
  }
  const service = new ChatGroupService(ctx, { maxAi: 3, defaultTimeoutMs: 5000, readonlyTools: DEFAULT_READONLY_TOOLS })

  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })
  service.send(agent, '开始流式发言')

  const deadline = Date.now() + 2000
  while (Date.now() < deadline && sessionListeners.length === 0) await delay(5)
  assert.ok(sessionListeners.length > 0)

  const child = { id: 'stream-child' }
  sessionListeners[0](child, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '流式' } } })
  sessionListeners[0](child, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '输出' } } })

  let speaking = service.snapshot(agent)
  assert.equal(speaking.messages[1].status, 'speaking')
  assert.equal(speaking.messages[1].text, '流式输出')

  resolveResult({ output: [], stopReason: 'completed' })
  const deadline2 = Date.now() + 2000
  while (Date.now() < deadline2 && service.snapshot(agent).status !== 'idle') await delay(5)
  const done = service.snapshot(agent)
  assert.equal(done.status, 'idle')
  assert.equal(done.messages[1].status, 'completed')
  assert.equal(done.messages[1].text, '流式输出')
})

test('M6: prompt sliding window omits oldest visible messages', () => {
  const snapshot = {
    groupId: 'g1',
    sessionId: 's1',
    revision: 1,
    status: 'idle',
    round: 2,
    blindRoundActive: false,
    mentionEnabled: true,
    speakerOrder: ['a1'],
    members: [
      { id: 'user', kind: 'user', role: 'admin', name: '用户' },
      { id: 'a1', kind: 'ai', role: 'member', name: 'Alice', ai: { provider: 'p', model: 'm', timeoutMs: 1000, tools: ['read'] } },
    ],
    messages: [
      { id: 'm1', seq: 0, round: 1, senderId: 'user', text: 'first', mentionIds: [], status: 'sent', createdAt: 1 },
      { id: 'm2', seq: 1, round: 1, senderId: 'a1', text: 'second', mentionIds: [], status: 'completed', createdAt: 2 },
      { id: 'm3', seq: 2, round: 2, senderId: 'user', text: 'third', mentionIds: [], status: 'sent', createdAt: 3 },
    ],
    nextSpeakerIds: [],
    soloQueue: [],
  }
  const member = snapshot.members[1]
  const prompt = buildMemberPrompt(snapshot, member, 2)
  assert.ok(prompt.includes('1 条消息因长度限制已省略'))
  assert.ok(!prompt.includes('[用户]: first'))
  assert.ok(prompt.includes('[Alice]: second'))
  assert.ok(prompt.includes('[用户]: third'))
})

test('M8: prompt reminds about failed members from the previous round', () => {
  const snapshot = {
    groupId: 'g1',
    sessionId: 's1',
    revision: 1,
    status: 'idle',
    round: 2,
    blindRoundActive: false,
    mentionEnabled: true,
    speakerOrder: ['a1'],
    members: [
      { id: 'user', kind: 'user', role: 'admin', name: '用户' },
      { id: 'a1', kind: 'ai', role: 'member', name: 'Alice', ai: { provider: 'p', model: 'm', timeoutMs: 1000, tools: ['read'] } },
    ],
    messages: [
      { id: 'm1', seq: 0, round: 1, senderId: 'a1', text: '', mentionIds: [], status: 'failed', createdAt: 1 },
      { id: 'm2', seq: 1, round: 2, senderId: 'user', text: '继续', mentionIds: [], status: 'sent', createdAt: 2 },
    ],
    totalMessages: 2,
    hasMoreMessages: false,
    nextSpeakerIds: [],
    soloQueue: [],
  }
  const prompt = buildMemberPrompt(snapshot, snapshot.members[1], 0)
  assert.ok(prompt.includes('上一轮 Alice 发言未成功'))
})

test('M8.1: topic anchor survives a tiny sliding window', () => {
  const snapshot = {
    groupId: 'g1',
    sessionId: 's1',
    revision: 1,
    status: 'idle',
    round: 3,
    blindRoundActive: false,
    mentionEnabled: true,
    speakerOrder: ['a1'],
    currentTopicId: 'topic-2',
    topics: [
      { id: 'topic-1', title: '旧话题', round: 2, messageCount: 2, createdAt: 1 },
      { id: 'topic-2', title: '新议题标题', round: 3, messageCount: 3, createdAt: 2 },
    ],
    members: [
      { id: 'user', kind: 'user', role: 'admin', name: '用户' },
      { id: 'a1', kind: 'ai', role: 'member', name: 'Alice', ai: { provider: 'p', model: 'm', timeoutMs: 1000, tools: ['read'] } },
    ],
    messages: [
      { id: 'm1', seq: 0, topicId: 'topic-2', round: 1, senderId: 'user', text: '新议题标题', mentionIds: [], status: 'sent', createdAt: 1 },
      { id: 'm2', seq: 1, topicId: 'topic-2', round: 1, senderId: 'a1', text: 'old reply', mentionIds: [], status: 'completed', createdAt: 2 },
      { id: 'm3', seq: 2, topicId: 'topic-2', round: 2, senderId: 'user', text: 'recent question', mentionIds: [], status: 'sent', createdAt: 3 },
    ],
    totalMessages: 3,
    hasMoreMessages: false,
    nextSpeakerIds: [],
    soloQueue: [],
    config: { maxAi: 3, defaultTimeoutMs: 5000, readonlyTools: ['read'], waitTimeoutMs: 25000, maxPromptMessages: 1, messagePageSize: 100 },
    autoActive: false,
    sandboxMode: 'workspace-write',
  }
  const prompt = buildMemberPrompt(snapshot, snapshot.members[1], 1)
  assert.ok(prompt.includes('=== 当前议题锚点（不会被截断） ==='))
  assert.ok(prompt.includes('议题：新议题标题'))
  assert.ok(!prompt.includes('old reply') || prompt.includes('更早的'))
})
