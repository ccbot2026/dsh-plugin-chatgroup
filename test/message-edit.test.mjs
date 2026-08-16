import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { ChatGroupService } from '../dist/group-service.js'
import { DEFAULT_READONLY_TOOLS } from '../dist/types.js'
import { buildVisibleMessages, buildMemberPrompt } from '../dist/visibility.js'

function makeService(config = {}) {
  const calls = []
  const ctx = {
    subagents: {
      async start(_name, request) {
        calls.push(request)
        const promptText = request.prompt[0].text
        const name = /你是群聊成员“([^”]+)”/.exec(promptText)?.[1] ?? 'AI'
        return {
          id: request.parent.session.id,
          localAgent: undefined,
          result: Promise.resolve({
            output: [{ type: 'text', text: `reply from ${name}` }],
            stopReason: 'completed',
          }),
          dispose: async () => {},
        }
      },
    },
    logger() { return { warn() {} } },
    get(name) { return name === 'subagents' ? this.subagents : undefined },
  }
  return { service: new ChatGroupService(ctx, { maxAi: 3, maxGroups: 1, defaultTimeoutMs: 5_000, readonlyTools: DEFAULT_READONLY_TOOLS, ...config }), calls }
}

function makeAgent() {
  return { session: { id: `test-session-${randomUUID()}`, header: { cwd: `/tmp/chatgroup-edit-workspace-${randomUUID()}` } } }
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

test('V2.2: edit rewrites visible text and keeps original for audit', async () => {
  const { service, calls } = makeService()
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })
  service.send(agent, '原始议题')
  const idle = await waitIdle(service, agent)

  const userMessage = idle.messages.find(m => m.senderId === 'user')
  const edited = service.editMessage(agent, userMessage.seq, '修改后的议题')
  const editedMsg = edited.messages.find(m => m.seq === userMessage.seq)
  assert.equal(editedMsg.editedText, '修改后的议题')
  assert.equal(editedMsg.text, '原始议题') // original preserved
  assert.equal(typeof editedMsg.editedAt, 'number')

  // Next round's prompt shows the edited text with a marker.
  service.send(agent, '继续')
  const idle2 = await waitIdle(service, agent)
  const nextPrompt = calls.at(-1).prompt[0].text
  assert.ok(nextPrompt.includes('[用户]（已编辑）: 修改后的议题'))
  assert.ok(!nextPrompt.includes('[用户]: 原始议题'))
})

test('V2.2: withdraw removes the message from every future prompt', async () => {
  const { service, calls } = makeService()
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })
  service.send(agent, '这条将被撤回')
  await waitIdle(service, agent)

  const userMessage = service.snapshot(agent).messages.find(m => m.senderId === 'user')
  service.withdrawMessage(agent, userMessage.seq)
  const after = service.snapshot(agent)
  const withdrawnMsg = after.messages.find(m => m.seq === userMessage.seq)
  assert.equal(withdrawnMsg.status, 'withdrawn')

  // buildVisibleMessages excludes it; prompt must not contain the text.
  const visible = buildVisibleMessages(after, after.members.find(m => m.kind === 'ai').id)
  assert.ok(!visible.some(m => m.seq === userMessage.seq))

  service.send(agent, '第二轮')
  await waitIdle(service, agent)
  const prompt = calls.at(-1).prompt[0].text
  assert.ok(!prompt.includes('这条将被撤回'))
})

test('V2.2: edit/withdraw reject speaking, already-withdrawn, and out-of-window messages', async () => {
  const { service } = makeService({ maxEditableMessages: 2 })
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })

  // Out-of-window: push 4 messages, edit the oldest (seq 0) -> rejected.
  service.send(agent, 'm1')
  await waitIdle(service, agent)
  service.send(agent, 'm2')
  await waitIdle(service, agent)
  service.send(agent, 'm3')
  await waitIdle(service, agent)
  service.send(agent, 'm4')
  await waitIdle(service, agent)

  const oldest = service.snapshot(agent).messages[0]
  assert.throws(() => service.editMessage(agent, oldest.seq, 'x'), /最近 2 条/)
  const newest = service.snapshot(agent).messages.at(-1)
  assert.doesNotThrow(() => service.editMessage(agent, newest.seq, 'edited'))

  // Withdraw then re-edit rejected.
  const withdrawn = service.snapshot(agent).messages.at(-1)
  service.withdrawMessage(agent, withdrawn.seq)
  assert.throws(() => service.editMessage(agent, withdrawn.seq, 'again'), /已撤回/)
})

test('V2.2: unknown seq rejected', () => {
  const { service } = makeService()
  const agent = makeAgent()
  service.create(agent)
  assert.throws(() => service.editMessage(agent, 999, 'x'), /找不到 seq/)
  assert.throws(() => service.withdrawMessage(agent, 999), /找不到 seq/)
})

test('V2.2: editing an AI message works for the admin and feeds the next prompt', async () => {
  const { service, calls } = makeService()
  const agent = makeAgent()
  service.create(agent)
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' })
  service.send(agent, '议题')
  const idle = await waitIdle(service, agent)

  const alice = idle.messages.find(m => m.senderId !== 'user')
  assert.ok(alice)
  service.editMessage(agent, alice.seq, 'Alice 修正后的观点')
  const edited = service.snapshot(agent).messages.find(m => m.seq === alice.seq)
  assert.equal(edited.editedText, 'Alice 修正后的观点')

  service.send(agent, '第二轮')
  await waitIdle(service, agent)
  const prompt = calls.at(-1).prompt[0].text
  assert.ok(prompt.includes('[Alice]（已编辑）: Alice 修正后的观点'))
})
