import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChatGroupMessage, ChatGroupSnapshot, GroupId } from './types.js'

export type PersistedRecord =
  | { kind: 'state'; revision: number; snapshot: ChatGroupSnapshot }
  | { kind: 'message'; revision: number; message: ChatGroupMessage }

/** V1 (single-group) log file: `<sessionId>.jsonl`. */
export function chatGroupLogPathV1(cwd: string, sessionId: string): string {
  return join(cwd, '.dsh', 'chatgroup', `${sessionId}.jsonl`)
}

/** V2 log file: `<sessionId>-<groupId>.jsonl`; `group-1` keeps the v1 name when no v2 file exists yet. */
export function chatGroupLogPath(cwd: string, sessionId: string, groupId: GroupId): string {
  if (groupId === 'group-1') return chatGroupLogPathV1(cwd, sessionId)
  return join(cwd, '.dsh', 'chatgroup', `${sessionId}-${groupId}.jsonl`)
}

/**
 * Enumerate the persisted group ids for one session. A v1 single-group log
 * contributes `group-1`; v2 logs contribute their suffix. `group-1` never
 * appears twice even if both the v1 name and a v2 `group-1` file exist (the
 * v1 name IS group-1's file).
 */
export function listPersistedGroupIds(cwd: string, sessionId: string): GroupId[] {
  const dir = join(cwd, '.dsh', 'chatgroup')
  if (!existsSync(dir)) return []
  const prefix = `${sessionId}-`
  const ids = new Set<GroupId>()
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.jsonl')) continue
    if (entry === `${sessionId}.jsonl`) {
      ids.add('group-1')
      continue
    }
    if (entry.startsWith(prefix)) {
      const groupId = entry.slice(prefix.length, -'.jsonl'.length)
      if (groupId.length > 0) ids.add(groupId as GroupId)
    }
  }
  // Deterministic restore order: group-1 first, then numeric suffixes.
  return [...ids].sort((left, right) => {
    const num = (id: string): number => /^group-(\d+)$/.exec(id)?.[1] === undefined ? 0 : Number(/^group-(\d+)$/.exec(id)![1]!)
    const a = num(left)
    const b = num(right)
    if (a === 0 && b === 0) return left < right ? -1 : left > right ? 1 : 0
    if (a === 0) return -1
    if (b === 0) return 1
    return a - b
  })
}

export function appendPersistedRecord(cwd: string, sessionId: string, groupId: GroupId, record: PersistedRecord): void {
  const path = chatGroupLogPath(cwd, sessionId, groupId)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
}

export function readPersistedRecords(cwd: string, sessionId: string, groupId: GroupId): PersistedRecord[] {
  const path = chatGroupLogPath(cwd, sessionId, groupId)
  if (!existsSync(path)) return []

  const records: PersistedRecord[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const record = JSON.parse(trimmed) as PersistedRecord
      if (
        (record.kind === 'state' && typeof record.revision === 'number' && record.snapshot !== null)
        || (record.kind === 'message' && typeof record.revision === 'number' && record.message !== null)
      ) {
        records.push(record)
      }
    } catch {
      // Skip torn/corrupt trailing lines; the previous state record remains authoritative.
    }
  }
  return records
}

export function removePersistedLog(cwd: string, sessionId: string, groupId: GroupId): void {
  rmSync(chatGroupLogPath(cwd, sessionId, groupId), { force: true })
}

/** Remove every persisted log for one session (all groups), used when dissolving per session teardown. */
export function removeAllPersistedLogs(cwd: string, sessionId: string): void {
  for (const groupId of listPersistedGroupIds(cwd, sessionId)) {
    removePersistedLog(cwd, sessionId, groupId)
  }
}
