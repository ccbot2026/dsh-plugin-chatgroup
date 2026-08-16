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
): Promise<SpeakOutcome> {
  if (signal.aborted) {
    return { text: '', status: 'cancelled', detail: 'speech aborted before start' }
  }

  let run: SubagentRun | undefined
  let streamedText = ''
  let disposeChunkListener: (() => boolean) | undefined

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
    if (run !== undefined) {
      await run.dispose()
    }
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
