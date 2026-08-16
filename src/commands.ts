import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { ChatGroupError } from './errors.js'
import type { ChatGroupService } from './group-service.js'
import type { ChatGroupSnapshot } from './types.js'

type Disposer = () => unknown

export function registerChatGroupCommands(ctx: Context, service: ChatGroupService): Disposer[] {
  const disposers: Disposer[] = []
  disposers.push(ctx.commands.register(command('group', '群聊管理：create / list / use / rename / add / remove / order / say / at / mention / edit / withdraw / status / stop / dissolve', 'create|list|use|rename|add|remove|order|say|at|mention|edit|withdraw|status|stop|dissolve', async (invocation) => {
    try {
      const [sub, rest] = splitSubcommand(invocation.rawInput)
      const agent = invocation.agent
      switch (sub) {
        case 'create':
          return success(formatSnapshot(service.create(agent)))
        case 'list':
          return success(formatGroupList(service.requireSnapshot(agent)))
        case 'use': {
          const groupId = rest.trim()
          if (groupId.length === 0) return error('用法: /group use <群ID>')
          return success(formatSnapshot(service.useGroup(agent, groupId)))
        }
        case 'rename': {
          const name = rest.trim()
          if (name.length === 0) return error('用法: /group rename <新名称>')
          return success(formatSnapshot(service.renameGroup(agent, name)))
        }
        case 'status':
          return success(formatSnapshot(service.requireSnapshot(agent)))
        case 'config':
          return success(formatConfig(service.configFor(agent)))
        case 'members':
          return success(formatMembers(service.requireSnapshot(agent)))
        case 'add': {
          const tokens = rest.split(/\s+/).filter(Boolean)
          if (tokens.length < 3) {
            return error('用法: /group add <名称> <provider> <model> [timeoutMs]')
          }
          const [name, provider, model, rawTimeout] = tokens
          const timeoutMs = rawTimeout === undefined ? undefined : Number(rawTimeout)
          if (rawTimeout !== undefined && !Number.isSafeInteger(timeoutMs)) {
            return error('timeoutMs 必须是正整数毫秒')
          }
          return success(formatSnapshot(service.addMember(agent, {
            name,
            provider,
            model,
            ...timeoutMs === undefined ? {} : { timeoutMs },
          })))
        }
        case 'remove': {
          const name = rest.trim()
          if (name.length === 0) return error('用法: /group remove <名称>')
          return success(formatSnapshot(service.removeMember(agent, name)))
        }
        case 'order': {
          const names = rest.trim().split(/\s+/).filter(Boolean)
          if (names.length === 0) return error('用法: /group order <AI1> <AI2> ...')
          return success(formatSnapshot(service.reorderMembers(agent, names)))
        }
        case 'say': {
          const text = rest.trim()
          if (text.length === 0) return error('用法: /group say <内容>')
          return success(formatSnapshot(service.send(agent, text)))
        }
        case 'topic': {
          const title = rest.trim()
          if (title.length === 0) return error('用法: /group topic <议题内容>')
          return success(formatSnapshot(service.startTopic(agent, title)))
        }
        case 'auto': {
          const tokens = rest.trim().split(/\s+/).filter(Boolean)
          const rawRounds = tokens[0]
          const rounds = rawRounds === undefined ? 3 : Number(rawRounds)
          if (!Number.isSafeInteger(rounds)) return error('用法: /group auto <轮数 1-10> [议题]')
          const topic = tokens.slice(1).join(' ').trim() || undefined
          return success(formatSnapshot(service.startAuto(agent, rounds, topic)))
        }
        case 'at': {
          const tokens = rest.trim().split(/\s+/).filter(Boolean)
          const name = tokens[0]
          const writeAccess = tokens[1] === '--write'
          const text = tokens.slice(writeAccess ? 2 : 1).join(' ')
          if (name === undefined || name.length === 0) return error('用法: /group at <AI名称> [--write] <内容>')
          return success(formatSnapshot(service.at(agent, name, text, { writeAccess })))
        }
        case 'mention': {
          const enabled = parseToggle(rest)
          if (enabled === undefined) return error('用法: /group mention on|off')
          return success(formatSnapshot(service.setMentionEnabled(agent, enabled)))
        }
        case 'edit': {
          const space = rest.search(/\s/)
          if (space < 0) return error('用法: /group edit <seq> <新内容>')
          const seq = Number(rest.slice(0, space).trim())
          const text = rest.slice(space + 1).trim()
          if (!Number.isSafeInteger(seq) || text.length === 0) return error('用法: /group edit <seq> <新内容>')
          return success(formatSnapshot(service.editMessage(agent, seq, text)))
        }
        case 'withdraw': {
          const seq = Number(rest.trim())
          if (!Number.isSafeInteger(seq)) return error('用法: /group withdraw <seq>')
          return success(formatSnapshot(service.withdrawMessage(agent, seq)))
        }
        case 'stop':
          return success(formatSnapshot(service.stop(agent)))
        case 'dissolve':
          service.dissolve(agent)
          return success('群聊已解散')
        default:
          return success(helpText())
      }
    } catch (cause) {
      if (cause instanceof ChatGroupError) return error(cause.message)
      return error(cause instanceof Error ? cause.message : String(cause))
    }
  })))

  return disposers
}

function command(
  name: string,
  description: string,
  hint: string,
  handler: CommandDefinition['handler'],
): CommandDefinition {
  return {
    name,
    description,
    input: { hint },
    handler,
  }
}

function splitSubcommand(rawInput: string): [string, string] {
  const trimmed = rawInput.trim()
  const space = trimmed.search(/\s/)
  if (space < 0) return [trimmed.toLowerCase(), '']
  return [trimmed.slice(0, space).toLowerCase(), trimmed.slice(space + 1)]
}

function parseToggle(rest: string): boolean | undefined {
  const value = rest.trim().toLowerCase()
  if (value === 'on') return true
  if (value === 'off') return false
  return undefined
}

function success(text: string): { kind: 'success'; text: string } {
  return { kind: 'success', text }
}

function error(text: string): { kind: 'error'; text: string } {
  return { kind: 'error', text }
}

function formatSnapshot(snapshot: ChatGroupSnapshot): string {
  const members = snapshot.members
    .filter(member => member.kind === 'ai')
    .map(member => `${member.name}(${member.ai?.provider}/${member.ai?.model})`)
    .join(', ')
  return [
    `群聊状态: ${snapshot.status === 'running' ? '发言中' : '空闲'}`,
    `群 ID: ${snapshot.groupId}`,
    `工作目录: ${snapshot.cwd ?? '（未设置）'}`,
    `轮次: ${String(snapshot.round)}`,
    `盲发: ${snapshot.blindRoundActive ? '进行中' : '未激活'}`,
    `@: ${snapshot.mentionEnabled ? '开' : '关'}`,
    `顺序: ${snapshot.speakerOrder.length > 0
      ? snapshot.speakerOrder.map(id => snapshot.members.find(m => m.id === id)?.name ?? id).join(' -> ')
      : '（空）'}`,
    `成员: ${members.length > 0 ? members : '（暂无 AI）'}`,
    ...snapshot.currentSpeakerId === undefined ? [] : [
      `当前发言人: ${snapshot.members.find(m => m.id === snapshot.currentSpeakerId)?.name ?? snapshot.currentSpeakerId}`,
    ],
    `消息数: ${String(snapshot.messages.length)}`,
  ].join('\n')
}

function formatGroupList(snapshot: ChatGroupSnapshot): string {
  if (snapshot.groups.length === 0) return '当前会话还没有群聊'
  return [
    `当前群: ${snapshot.groupId}`,
    ...snapshot.groups.map(group =>
      `  ${group.groupId}${group.groupId === snapshot.groupId ? ' *' : ''}  ${group.status === 'running' ? '发言中' : '空闲'}  R${String(group.round)}  ${String(group.totalMessages)} 条  话题: ${group.currentTopicTitle}`),
  ].join('\n')
}

function formatConfig(config: import('./types.js').ChatGroupConfig): string {
  return [
    `maxAi: ${String(config.maxAi)}`,
    `defaultTimeoutMs: ${String(config.defaultTimeoutMs)}`,
    `readonlyTools: ${config.readonlyTools.join(', ')}`,
    `waitTimeoutMs: ${String(config.waitTimeoutMs)}`,
    `maxPromptMessages: ${String(config.maxPromptMessages)}`,
    `messagePageSize: ${String(config.messagePageSize)}`,
  ].join('\n')
}

function formatMembers(snapshot: ChatGroupSnapshot): string {
  return snapshot.members
    .map(member => member.kind === 'user'
      ? `${member.name} (用户/管理员)`
      : `${member.name} (AI, ${member.ai?.provider}/${member.ai?.model})`)
    .join('\n')
}

function helpText(): string {
  return [
    'chat-group 群聊命令:',
    '  /group create                        创建群聊',
    '  /group list                          列出会话内所有群',
    '  /group use <群ID>                    切换默认群',
    '  /group rename <新名称>               重命名当前群',
    '  /group status                        查看状态',
    '  /group config                        查看运行配置',
    '  /group members                       查看成员',
    '  /group add <名称> <provider> <model> [timeoutMs]',
    '  /group remove <名称>                 移除 AI',
    '  /group order <AI1> <AI2> ...         设置发言顺序',
    '  /group say <内容>                    普通发言',
    '  /group at <AI名称> [--write] <内容> @ 单个 AI 单独回应',
    '  /group edit <seq> <新内容>          编辑消息（仅最近可编辑窗口）',
    '  /group withdraw <seq>               撤回消息',
    '  /group auto <轮数 1-10> [议题]      自动多轮讨论',
    '  /group topic <议题内容>             结束当前讨论并开启新议题',
    '  /group mention on|off                开关 @ 功能',
    '  /group stop                          结束当前发言',
    '  /group dissolve                      解散群聊',
  ].join('\n')
}
