import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ChatGroupService } from '../dist/group-service.js'
import { DEFAULT_READONLY_TOOLS } from '../dist/types.js'

function makeAgent() {
  return {
    session: {
      id: `write-session-${randomUUID()}`,
      header: { cwd: `/tmp/chatgroup-write-${randomUUID()}` },
    },
  }
}

function makeCtx(sandboxMode, calls) {
  return {
    subagents: {
      async start(_name, request) {
        calls.push(request)
        return {
          id: request.parent.session.id,
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: '已写入' }], stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    },
    logger() { return { warn() {} } },
    get(name) {
      if (name === 'subagents') return this.subagents
      if (name === 'sandboxPolicy') {
        return { resolve() { return { mode: sandboxMode } } }
      }
      return undefined
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

test('write-access: @ with write grant uses write/edit tools and marks messages', async () => {
  const calls = []
  const service = new ChatGroupService(makeCtx('workspace-write', calls), {
    maxAi: 3,
    defaultTimeoutMs: 5000,
    readonlyTools: DEFAULT_READONLY_TOOLS,
  })
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })

  service.at(agent, 'Alice', '请总结并写入 docs/plan.md', { writeAccess: true })
  const done = await waitIdle(service, agent)

  const user = done.messages.find(m => m.senderId === 'user')
  const ai = done.messages.find(m => m.senderId !== 'user')
  assert.equal(user.writeAccess, true)
  assert.equal(ai.writeAccess, true)
  assert.equal(done.sandboxMode, 'workspace-write')

  const request = calls[0]
  assert.deepEqual([...request.toolFilter.allow].sort(), ['edit', 'glob', 'grep', 'read', 'read_image', 'write'].sort())
  assert.ok(request.prompt[0].text.includes('临时授予写权限'))
})

test('write-access: read-only sandbox blocks the write grant', () => {
  const calls = []
  const service = new ChatGroupService(makeCtx('read-only', calls), {
    maxAi: 3,
    defaultTimeoutMs: 5000,
    readonlyTools: DEFAULT_READONLY_TOOLS,
  })
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })

  assert.throws(
    () => service.at(agent, 'Alice', '写文件', { writeAccess: true }),
    /read-only 模式/,
  )
  assert.equal(calls.length, 0)
})
