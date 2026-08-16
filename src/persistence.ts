import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChatGroupMessage, ChatGroupSnapshot } from './types.js'

export type PersistedRecord =
  | { kind: 'state'; revision: number; snapshot: ChatGroupSnapshot }
  | { kind: 'message'; revision: number; message: ChatGroupMessage }

/** One group's log file under the project the dsh session belongs to. */
export function chatGroupLogPath(cwd: string, sessionId: string): string {
  return join(cwd, '.dsh', 'chatgroup', `${sessionId}.jsonl`)
}

export function appendPersistedRecord(cwd: string, sessionId: string, record: PersistedRecord): void {
  const path = chatGroupLogPath(cwd, sessionId)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
}

export function readPersistedRecords(cwd: string, sessionId: string): PersistedRecord[] {
  const path = chatGroupLogPath(cwd, sessionId)
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

export function removePersistedLog(cwd: string, sessionId: string): void {
  rmSync(chatGroupLogPath(cwd, sessionId), { force: true })
}
