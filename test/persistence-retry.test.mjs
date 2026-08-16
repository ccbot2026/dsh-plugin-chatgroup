import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ChatGroupService } from '../dist/group-service.js'
import { DEFAULT_READONLY_TOOLS } from '../dist/types.js'

function makeCtx(subagents) {
  return {
    subagents,
    logger() { return { warn() {} } },
    get(name) { return name === 'subagents' ? subagents : undefined },
  }
}

function makeAgent() {
  return {
    session: {
      id: `persist-session-${randomUUID()}`,
      header: { cwd: `/tmp/chatgroup-persist-workspace-${randomUUID()}` },
    },
  }
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

test('M5: group state restores from project .dsh/chatgroup JSONL', async () => {
  const subagents = {
    async start(_name, request) {
      return {
        id: request.parent.session.id,
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: '持久化回复' }], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  }
  const agent = makeAgent()
  const ctx = makeCtx(subagents)
  const first = new ChatGroupService(ctx, { maxAi: 3, defaultTimeoutMs: 5000, readonlyTools: DEFAULT_READONLY_TOOLS })

  first.create(agent)
  first.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })
  first.send(agent, '持久化测试')
  const done = await waitIdle(first, agent)
  assert.equal(done.messages.length, 2)

  const logPath = `${agent.session.header.cwd}/.dsh/chatgroup/${agent.session.id}.jsonl`
  assert.equal(existsSync(logPath), true)
  const lines = readFileSync(logPath, 'utf8').trim().split('\n')
  assert.ok(lines.some(line => JSON.parse(line).kind === 'state'))
  assert.ok(lines.some(line => JSON.parse(line).kind === 'message'))

  const second = new ChatGroupService(ctx, { maxAi: 3, defaultTimeoutMs: 5000, readonlyTools: DEFAULT_READONLY_TOOLS })
  const restored = second.snapshot(agent)
  assert.ok(restored)
  assert.equal(restored.status, 'idle')
  assert.equal(restored.round, 1)
  assert.equal(restored.messages.length, 2)
  assert.equal(restored.messages[1].text, '持久化回复')

  second.dissolve(agent)
  assert.equal(existsSync(logPath), false)
})

test('M5: failed AI speech retries once and succeeds', async () => {
  let calls = 0
  const subagents = {
    async start(_name, request) {
      calls += 1
      if (calls === 1) {
        return {
          id: request.parent.session.id,
          localAgent: undefined,
          result: Promise.resolve({ output: [], stopReason: 'error' }),
          dispose: async () => {},
        }
      }
      return {
        id: request.parent.session.id,
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: '重试成功' }], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  }
  const agent = makeAgent()
  const service = new ChatGroupService(makeCtx(subagents), { maxAi: 3, defaultTimeoutMs: 5000, readonlyTools: DEFAULT_READONLY_TOOLS })

  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })
  service.send(agent, '触发重试')
  const done = await waitIdle(service, agent)

  assert.equal(calls, 2)
  assert.equal(done.messages[1].status, 'completed')
  assert.equal(done.messages[1].text, '重试成功')
})
