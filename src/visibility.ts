import { SYSTEM_MEMBER_ID, USER_MEMBER_ID } from './types.js'
import type { ChatGroupMember, ChatGroupMessage, ChatGroupSnapshot } from './types.js'

/**
 * First-round blind filtering: every user message and the target member's own
 * history stay visible; other AI messages are visible only after round one.
 */
export function buildVisibleMessages(
  group: ChatGroupSnapshot,
  targetMemberId: string,
): readonly ChatGroupMessage[] {
  const blind = group.blindRoundActive
  const topicId = group.currentTopicId ?? 'topic-1'

  return group.messages.filter((message) => {
    // Topic boundary: legacy messages without topicId belong to topic-1.
    if (message.topicId !== undefined && message.topicId !== topicId) return false
    // The in-flight placeholder is never part of the transcript.
    if (message.status === 'speaking') return false
    // Withdrawn messages vanish from every prompt (V2.2).
    if (message.status === 'withdrawn') return false
    if (message.senderId === USER_MEMBER_ID || message.senderId === SYSTEM_MEMBER_ID) return true
    if (message.senderId === targetMemberId) return true
    return !blind
  })
}

/**
 * Static, template-safe child persona. Member-controlled text never enters the
 * persona template directly, so `{{...}}` interpolation cannot fail.
 */
export function buildMemberPersona(member: ChatGroupMember): string {
  return [
    `你是群聊成员“${member.name}”。`,
    '你正在一个由用户和多个 AI 组成的项目讨论群中发言。',
    '请保持成员身份，直接表达你自己的判断。',
  ].join(' ')
}

/** Build the full prompt delivered to one AI member's one-shot child agent. */
export function buildMemberPrompt(
  group: ChatGroupSnapshot,
  member: ChatGroupMember,
  maxPromptMessages = 0,
  options: { writeAccess?: boolean } = {},
): string {
  const lines: string[] = [
    `你是群聊成员“${member.name}”。`,
    '下面是你当前可见的群聊记录。',
    `你只允许使用只读工具：${member.ai?.tools.join('、') ?? ''}。不要尝试写入、编辑、执行 shell，或调用未列出的工具。`,
    group.cwd === undefined
      ? '注意：当前会话没有配置工作目录，只读文件工具可能不可用。'
      : `当前项目工作目录：${group.cwd}`,
    '请直接输出你要发到群里的回复内容，不要输出解释、标题、代码围栏或“作为AI”之类的开场白。',
    ...options.writeAccess === true
      ? ['本轮你被临时授予写权限：可以使用 write、edit 工具，在当前沙箱允许范围内写入文件。']
      : [],
  ]

  if (member.ai?.systemPrompt?.trim()) {
    lines.push('', '你额外的成员设定：', member.ai.systemPrompt.trim())
  }

  lines.push('', '=== 当前议题锚点（不会被截断） ===')
  const topicId = group.currentTopicId ?? 'topic-1'
  const topic = group.topics?.find(candidate => candidate.id === topicId)
  const topicTitle = topic?.title
  if (topicTitle !== undefined && topicTitle !== '默认话题' && topicTitle !== '历史话题') {
    lines.push(`议题：${topicTitle}`)
  }
  const anchorMessages = group.messages
    .filter(message =>
      (message.topicId === undefined ? 'topic-1' : message.topicId) === topicId
      && message.senderId === USER_MEMBER_ID
      && message.status === 'sent'
      && message.text.trim().length > 0)
    .slice(0, 2)
  for (const message of anchorMessages) {
    if (message.text.trim() === topicTitle) continue
    lines.push(`用户议题：${message.text}`)
  }

  lines.push('', '=== 可见群聊记录开始 ===')

  const previousRound = Math.max(0, group.round - 1)
  if (previousRound > 0) {
    const failedNames = group.messages
      .filter(message =>
        (message.topicId === undefined || message.topicId === group.currentTopicId)
        && message.round === previousRound
        && message.senderId !== USER_MEMBER_ID
        && (message.status === 'failed' || message.status === 'timeout'))
      .map(message => senderName(group, message.senderId))
    if (failedNames.length > 0) {
      lines.push(`[系统]: 上一轮 ${failedNames.join('、')} 发言未成功，本轮请酌情回应或补充。`)
    }
  }

  const visible = buildVisibleMessages(group, member.id)
  const transcript = maxPromptMessages > 0 && visible.length > maxPromptMessages
    ? visible.slice(-maxPromptMessages)
    : visible
  if (transcript.length !== visible.length) {
    lines.push(`[系统]: 更早的 ${visible.length - transcript.length} 条消息因长度限制已省略。`)
  }

  for (const message of transcript) {
    const sender = senderName(group, message.senderId)
    if (message.status === 'completed' || message.status === 'sent') {
      if (message.editedText !== undefined) {
        lines.push(`[${sender}]（已编辑）: ${message.editedText}`)
      } else {
        lines.push(`[${sender}]: ${message.text}`)
      }
      continue
    }
    if (message.senderId !== USER_MEMBER_ID) {
      const reason = message.status === 'timeout'
        ? '发言超时'
        : message.status === 'cancelled'
          ? '发言被取消'
          : '发言失败'
      lines.push(`[系统]: ${sender} ${reason}`)
    }
  }

  lines.push('=== 可见群聊记录结束 ===')
  lines.push('', '现在请给出你的发言。')
  return lines.join('\n')
}

function senderName(group: ChatGroupSnapshot, senderId: string): string {
  if (senderId === USER_MEMBER_ID) return '用户'
  if (senderId === SYSTEM_MEMBER_ID) return '系统'
  return group.members.find(member => member.id === senderId)?.name ?? '未知成员'
}
