import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { ChatGroupService } from '../dist/group-service.js'
import { DEFAULT_READONLY_TOOLS } from '../dist/types.js'
import { chatGroupLogPath, chatGroupLogPathV1, listPersistedGroupIds } from '../dist/persistence.js'

function makeService(config = {}) {
  const ctx = {
    subagents: {
      async start(_name, request) {
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
  return new ChatGroupService(ctx, { maxAi: 3, maxGroups: 4, defaultTimeoutMs: 5_000, readonlyTools: DEFAULT_READONLY_TOOLS, ...config })
}

function makeAgent() {
  const id = `test-session-${randomUUID()}`
  return { session: { id, header: { cwd: mkdtempSync(join(tmpdir(), 'chatgroup-multi-')) } } }
}

function withWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'chatgroup-persist-'))
  return {
    dir,
    agent: { session: { id: `persist-session-${randomUUID()}`, header: { cwd: dir } } },
    cleanup() { rmSync(dir, { recursive: true, force: true }) },
  }
}

test('V2.1: maxGroups limits concurrent groups in one session', () => {
  const service = makeService({ maxGroups: 1 })
  const agent = makeAgent()
  const created = service.create(agent)
  assert.equal(created.groupId, 'group-1')
  assert.throws(() => service.create(agent), /最多 1 个群/)
})

test('V2.1: multiple groups coexist with isolated members/messages', async () => {
  const service = makeService({ maxGroups: 4 })
  const agent = makeAgent()

  const g1 = service.create(agent)
  assert.equal(g1.groupId, 'group-1')
  service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' }, 'group-1')

  const g2 = service.create(agent)
  assert.equal(g2.groupId, 'group-2')
  service.addMember(agent, { name: 'Bob', provider: 'deepseek', model: 'chat' }, 'group-2')

  // Groups are listed on every snapshot.
  const snap1 = service.snapshot(agent, 'group-1')
  assert.deepEqual(snap1.groups.map(g => g.groupId), ['group-1', 'group-2'])
  assert.deepEqual(snap1.members.filter(m => m.kind === 'ai').map(m => m.name), ['Alice'])
  const snap2 = service.snapshot(agent, 'group-2')
  assert.deepEqual(snap2.members.filter(m => m.kind === 'ai').map(m => m.name), ['Bob'])

  // A round in group-1 does not leak into group-2.
  service.send(agent, 'group-1 议题', 'group-1')
  // wait for idle
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (service.snapshot(agent, 'group-1')?.status === 'idle') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const g1After = service.snapshot(agent, 'group-1')
  assert.equal(g1After.status, 'idle')
  assert.equal(g1After.messages.length, 2) // user + Alice (single AI member)
  const g2After = service.snapshot(agent, 'group-2')
  assert.equal(g2After.messages.length, 0)
})

test('V2.1: current group defaults to newest created; useGroup switches', () => {
  const service = makeService({ maxGroups: 4 })
  const agent = makeAgent()
  service.create(agent)
  service.create(agent)

  // Default (no groupId) targets the newest created group.
  assert.equal(service.snapshot(agent).groupId, 'group-2')
  // useGroup switches the default target.
  service.useGroup(agent, 'group-1')
  assert.equal(service.snapshot(agent).groupId, 'group-1')
})

test('V2.1: dissolving one group leaves siblings intact', () => {
  const service = makeService({ maxGroups: 4 })
  const agent = makeAgent()
  service.create(agent)
  service.create(agent)
  service.dissolve(agent, 'group-1')
  const remaining = service.snapshot(agent)
  assert.equal(remaining.groupId, 'group-2')
  assert.deepEqual(remaining.groups.map(g => g.groupId), ['group-2'])
})

test('V2.1: v2 persistence writes per-group files and restores all groups', () => {
  const { dir, agent, cleanup } = withWorkspace()
  try {
    const service = makeService({ maxGroups: 4 })
    service.create(agent)
    service.addMember(agent, { name: 'Alice', provider: 'deepseek', model: 'chat' }, 'group-1')
    service.create(agent)
    service.addMember(agent, { name: 'Bob', provider: 'deepseek', model: 'chat' }, 'group-2')
    service.send(agent, '讨论一下', 'group-1')

    // Two per-group log files exist. group-1 reuses the v1 filename for
    // seamless migration; group-2 gets the suffixed v2 name.
    const files = readdirSync(join(dir, '.dsh', 'chatgroup'))
    assert.ok(files.includes(`${agent.session.id}.jsonl`))
    assert.ok(files.includes(`${agent.session.id}-group-2.jsonl`))

    // A fresh service (simulating restart) restores BOTH groups from disk.
    const revived = makeService({ maxGroups: 4 })
    const snap = revived.snapshot(agent)
    assert.equal(snap.groupId, 'group-1')
    assert.deepEqual(snap.groups.map(g => g.groupId), ['group-1', 'group-2'])
    assert.deepEqual(snap.members.filter(m => m.kind === 'ai').map(m => m.name), ['Alice'])
    const snap2 = revived.snapshot(agent, 'group-2')
    assert.deepEqual(snap2.members.filter(m => m.kind === 'ai').map(m => m.name), ['Bob'])
    assert.equal(snap2.totalMessages, 0)
  } finally {
    cleanup()
  }
})

test('V2.1: v1 single-group log migrates to group-1', () => {
  const { dir, agent, cleanup } = withWorkspace()
  try {
    // Write a v1 log (old filename, snapshot without groups field).
    const v1Path = chatGroupLogPathV1(dir, agent.session.id)
    mkdirSync(join(dir, '.dsh', 'chatgroup'), { recursive: true })
    writeFileSync(v1Path, JSON.stringify({
      kind: 'state',
      revision: 3,
      snapshot: {
        groupId: 'chatgroup-legacy-id',
        sessionId: agent.session.id,
        revision: 3,
        status: 'idle',
        round: 2,
        blindRoundActive: false,
        mentionEnabled: true,
        speakerOrder: [],
        members: [{ id: 'user', kind: 'user', role: 'admin', name: '用户' }],
        messages: [],
        totalMessages: 0,
        hasMoreMessages: false,
        autoActive: false,
        currentTopicId: 'topic-1',
        topics: [{ id: 'topic-1', title: '历史话题', round: 2, messageCount: 0, createdAt: Date.now() }],
        config: { maxAi: 3, defaultTimeoutMs: 5000, readonlyTools: ['read'], waitTimeoutMs: 25000, maxPromptMessages: 40, messagePageSize: 100 },
      },
    }) + '\n', 'utf8')

    // listPersistedGroupIds sees the v1 log as group-1.
    assert.deepEqual(listPersistedGroupIds(dir, agent.session.id), ['group-1'])
    assert.equal(chatGroupLogPath(dir, agent.session.id, 'group-1'), v1Path)

    // Restoring maps it onto group-1 and keeps the old file name as its store.
    const service = makeService({ maxGroups: 4 })
    const snap = service.snapshot(agent)
    assert.equal(snap.groupId, 'group-1')
    assert.equal(snap.round, 2)
    assert.equal(readFileSync(v1Path, 'utf8').split('\n').length, 2) // still the same file
  } finally {
    cleanup()
  }
})
