import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { AiMemberConfig, MessageStatus } from './types.js'

export interface SpeakOutcome {
  readonly text: string
  readonly status: Exclude<MessageStatus, 'sent'>
  readonly detail?: string
}

/** Run one AI member utterance through the `spawn` one-shot subagent provider. */
export async function speakOnce(
  ctx: Context,
  parent: Agent,
  label: string,
  config: AiMemberConfig,
  persona: string,
  prompt: string,
  signal: AbortSignal,
  onTextDelta?: (delta: string) => void,
  onToolActivity?: (activity: { tool: string; argsPreview: string; active: boolean }) => void,
): Promise<SpeakOutcome> {
  if (signal.aborted) {
    return { text: '', status: 'cancelled', detail: 'speech aborted before start' }
  }

  let run: SubagentRun | undefined
  let streamedText = ''
  let disposeChunkListener: (() => boolean) | undefined
  let disposeToolListener: (() => boolean) | undefined

  try {
    run = await ctx.subagents.start('spawn', {
      parent,
      label,
      prompt: [{ type: 'text', text: prompt }],
      agentOptions: {
        provider: config.provider,
        model: config.model,
      },
      persona,
      toolFilter: { allow: config.tools },
      maxDepth: 1,
      signal,
    })

    const childSessionId = run.localAgent?.session.id
    if (childSessionId !== undefined && onTextDelta !== undefined) {
      disposeChunkListener = ctx.on('session/event', (session, event) => {
        if (session.id !== childSessionId || event.type !== 'assistant/chunk') return
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
          streamedText += chunk.text
          onTextDelta(chunk.text)
        }
      })
    }

    // V2.5: surface read-only tool activity (call start/result) for the panel.
    if (childSessionId !== undefined && onToolActivity !== undefined) {
      disposeToolListener = ctx.on('session/event', (session, event) => {
        if (session.id !== childSessionId) return
        if (event.type === 'tool/call') {
          const data = event.data as { name?: string; arguments?: string }
          onToolActivity({ tool: data.name ?? 'tool', argsPreview: previewArgs(data.arguments), active: true })
        } else if (event.type === 'tool/result') {
          const data = event.data as { name?: string }
          onToolActivity({ tool: data.name ?? 'tool', argsPreview: '', active: false })
        }
      })
    }

    const result: SubagentResult = await run.result
    if (signal.aborted) {
      return { text: streamedText, status: 'cancelled', detail: 'speech aborted' }
    }
    if (result.stopReason === 'completed') {
      const text = streamedText.trim().length > 0 ? streamedText.trim() : extractText(result.output)
      return text.length > 0
        ? { text, status: 'completed' }
        : { text: '', status: 'failed', detail: 'subagent produced no text' }
    }
    return {
      text: streamedText,
      status: result.stopReason === 'aborted' ? 'cancelled' : 'failed',
      detail: describeSubagentFailure(run, result),
    }
  } catch (error: unknown) {
    return {
      text: streamedText,
      status: signal.aborted ? 'cancelled' : 'failed',
      detail: error instanceof Error ? error.message : String(error),
    }
  } finally {
    disposeChunkListener?.()
    disposeToolListener?.()
    if (run !== undefined) {
      await run.dispose()
    }
  }
}

function previewArgs(raw: string | undefined): string {
  if (raw === undefined || raw.length === 0) return ''
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const path = typeof parsed.path === 'string'
      ? parsed.path
      : typeof parsed.filespec === 'string'
        ? parsed.filespec
        : typeof parsed.target === 'string'
          ? parsed.target
          : undefined
    return path ?? raw.slice(0, 60)
  } catch {
    return raw.slice(0, 60)
  }
}

/** Surface the child session's final turn/end failure instead of a bare stop reason. */
function describeSubagentFailure(run: SubagentRun, result: SubagentResult): string {
  const events: readonly SessionEvent[] = run.localAgent?.session.events ?? []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'turn/end') continue
    const reason = (event.data as { reason?: { kind?: string; error?: { code?: string; message?: string } } }).reason
    if (reason?.kind === 'error' && reason.error !== undefined) {
      return `${reason.error.code ?? 'UNKNOWN'}: ${reason.error.message ?? 'subagent failed'}`
    }
    if (reason?.kind !== undefined) return `subagent stop reason: ${String(reason.kind)}`
  }
  return `subagent stop reason: ${result.stopReason}`
}

function extractText(blocks: readonly ContentBlock[]): string {
  let text = ''
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text
    }
  }
  return text.trim()
}
