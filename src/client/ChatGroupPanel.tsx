import { createElement, Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent as ReactChangeEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, UIEvent as ReactUIEvent } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatGroupConfig, ChatGroupMessage, ChatGroupSnapshot, ChatGroupSummary, GroupId } from '../types.js'
import type { ChatGroupPanelController } from './panel-controller.js'
import type { ChatGroupRpcClient, ModelCatalog } from './rpc-client.js'

export interface ChatGroupPanelProps extends PropsRuntime<'shell.overlay'> {
  readonly controller: ChatGroupPanelController
  readonly rpc: ChatGroupRpcClient
}

const drawerStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  right: 0,
  bottom: 0,
  width: 'min(980px, 96vw)',
  background: '#ffffff',
  borderLeft: '1px solid #e2e5ea',
  boxShadow: '-12px 0 32px rgba(15, 23, 42, 0.16)',
  display: 'flex',
  flexDirection: 'column',
  zIndex: 2000,
  pointerEvents: 'auto',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  color: '#111827',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 12px',
  borderBottom: '1px solid #e2e5ea',
  background: '#f8fafc',
}

const titleStyle: React.CSSProperties = { fontSize: 15, fontWeight: 600, flex: 1 }

const bodyStyle: React.CSSProperties = { flex: 1, minHeight: 0, display: 'flex' }

const mainColumnStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
}

const messageListStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const sidebarStyle: React.CSSProperties = {
  width: 320,
  minWidth: 260,
  borderLeft: '1px solid #e2e5ea',
  background: '#f8fafc',
  overflowY: 'auto',
  padding: 10,
}

const resizeHandleStyle: React.CSSProperties = {
  position: 'absolute',
  left: -3,
  top: 0,
  bottom: 0,
  width: 6,
  cursor: 'col-resize',
  zIndex: 2,
}

const launcherStyle: React.CSSProperties = {
  position: 'fixed',
  right: 18,
  bottom: 18,
  zIndex: 1900,
  pointerEvents: 'auto',
  padding: '10px 14px',
  borderRadius: 999,
  border: '1px solid #2563eb',
  background: '#2563eb',
  color: '#ffffff',
  boxShadow: '0 8px 20px rgba(37, 99, 235, 0.28)',
  cursor: 'pointer',
  fontSize: 14,
  fontWeight: 600,
}

const buttonStyle: React.CSSProperties = {
  padding: '5px 10px',
  borderRadius: 6,
  border: '1px solid #d1d5db',
  background: '#ffffff',
  cursor: 'pointer',
  fontSize: 13,
}

const primaryButtonStyle: React.CSSProperties = { ...buttonStyle, background: '#2563eb', borderColor: '#2563eb', color: '#ffffff' }
const dangerButtonStyle: React.CSSProperties = { ...buttonStyle, background: '#dc2626', borderColor: '#dc2626', color: '#ffffff' }

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '7px 9px',
  borderRadius: 6,
  border: '1px solid #d1d5db',
  fontSize: 13,
}

const labelStyle: React.CSSProperties = { fontSize: 12, color: '#4b5563', margin: '8px 0 3px' }

function memberName(snapshot: ChatGroupSnapshot, memberId: string): string {
  if (memberId === 'user') return '用户'
  if (memberId === 'system') return '系统'
  return snapshot.members.find(member => member.id === memberId)?.name ?? memberId
}

function statusLabel(status: string, statusOnly = false): string {
  switch (status) {
    case 'sent': return statusOnly ? '已发送' : '用户'
    case 'speaking': return '发言中…'
    case 'completed': return '完成'
    case 'failed': return '失败'
    case 'timeout': return '超时'
    case 'cancelled': return '已取消'
    case 'withdrawn': return '已撤回'
    default: return status
  }
}

export function ChatGroupPanel({ controller, rpc, useSessions }: ChatGroupPanelProps) {
  const sessionId = useSyncExternalStore(controller.subscribe, controller.getSessionId)
  const currentSessionId = useSessions(state => state.current)
  const [groupId, setGroupId] = useState<GroupId | ''>('')
  const [group, setGroup] = useState<ChatGroupSnapshot | null>(null)
  const [revision, setRevision] = useState(-1)
  const revisionRef = useRef(-1)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [text, setText] = useState('')
  const [mentionId, setMentionId] = useState('')
  const [allowWrite, setAllowWrite] = useState(false)
  const [orderText, setOrderText] = useState('')
  const [memberForm, setMemberForm] = useState({ name: '', provider: '', model: '', systemPrompt: '', timeout: '' })
  const [autoForm, setAutoForm] = useState({ rounds: '3', topic: '' })
  const [topicTitle, setTopicTitle] = useState('')
  const [topicFilter, setTopicFilter] = useState<string>('all')
  const [filteredTopicMessages, setFilteredTopicMessages] = useState<ChatGroupMessage[]>([])
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [editingSeq, setEditingSeq] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [configForm, setConfigForm] = useState({
    maxAi: '5',
    defaultTimeoutMs: '300000',
    readonlyTools: 'read, read_image, glob, grep',
    waitTimeoutMs: '25000',
    maxPromptMessages: '40',
    messagePageSize: '100',
    maxEditableMessages: '20',
    aiProactive: 'false',
    maxProactivePerRound: '1',
    maxAiMentionDepth: '1',
  })
  const configKeyRef = useRef('')
  const [showSettings, setShowSettings] = useState(true)
  const [renameValue, setRenameValue] = useState('')
  const [olderMessages, setOlderMessages] = useState<ChatGroupMessage[]>([])
  const [hasMoreOlder, setHasMoreOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const loadedGroupIdRef = useRef<string | null>(null)
  const oldestLoadedSeqRef = useRef<number | undefined>(undefined)
  const stickToBottomRef = useRef(true)
  const [drawerWidth, setDrawerWidth] = useState(() => {
    if (typeof window === 'undefined') return 980
    const stored = Number(window.localStorage.getItem('chatgroup.drawerWidth'))
    const maxWidth = Math.max(520, Math.floor(window.innerWidth * 0.96))
    if (Number.isFinite(stored) && stored >= 520) return Math.min(stored, maxWidth)
    return Math.min(980, maxWidth)
  })
  const drawerWidthRef = useRef(drawerWidth)
  const scrollRef = useRef<HTMLDivElement>(null)

  function beginResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)

    const move = (moveEvent: PointerEvent): void => {
      if (typeof window === 'undefined') return
      const width = Math.max(520, Math.min(window.innerWidth - moveEvent.clientX, Math.floor(window.innerWidth * 0.96)))
      drawerWidthRef.current = width
      setDrawerWidth(width)
    }

    const up = (): void => {
      target.releasePointerCapture(event.pointerId)
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
      try {
        window.localStorage.setItem('chatgroup.drawerWidth', String(drawerWidthRef.current))
      } catch {
        // Ignore storage failures (private mode / disabled localStorage).
      }
    }

    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }

  useEffect(() => {
    if (sessionId === null) {
      setGroupId('')
      setGroup(null)
      setRevision(-1)
      revisionRef.current = -1
      setError(null)
      setText('')
      setMentionId('')
      return
    }

    const controllerAbort = new AbortController()
    let disposed = false

    async function refresh(): Promise<void> {
      const next = await rpc.snapshot(sessionId!, groupId === '' ? undefined : groupId, controllerAbort.signal)
      if (disposed) return
      if (next.group !== null && groupId === '') {
        setGroupId(next.group.groupId)
      }
      setGroup(next.group)
      setRevision(next.revision)
      revisionRef.current = next.revision
    }

    async function watch(): Promise<void> {
      while (!disposed && !controllerAbort.signal.aborted) {
        try {
          const waited = await rpc.wait(sessionId!, revisionRef.current, groupId === '' ? undefined : groupId, controllerAbort.signal)
          if (disposed || controllerAbort.signal.aborted) return
          if (waited.changed) {
            if (waited.group !== null && groupId === '') {
              setGroupId(waited.group.groupId)
            }
            setGroup(waited.group)
            setRevision(waited.revision)
            revisionRef.current = waited.revision
          } else {
            await refresh()
          }
        } catch (cause) {
          if (controllerAbort.signal.aborted || disposed) return
          setError(cause instanceof Error ? cause.message : String(cause))
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }
    }

    async function boot(): Promise<void> {
      try {
        await refresh()
        await watch()
      } catch (cause) {
        if (!controllerAbort.signal.aborted && !disposed) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }
    }

    void boot()
    return () => {
      disposed = true
      controllerAbort.abort()
    }
  }, [sessionId, groupId])

  useEffect(() => {
    if (group !== null) setOrderText(group.speakerOrder.map(id => memberName(group, id)).join(', '))
  }, [group?.speakerOrder, group?.members])

  useEffect(() => {
    if (group?.config === undefined) return
    const key = JSON.stringify(group.config)
    if (configKeyRef.current === key) return
    configKeyRef.current = key
    setConfigForm({
      maxAi: String(group.config.maxAi),
      defaultTimeoutMs: String(group.config.defaultTimeoutMs),
      readonlyTools: group.config.readonlyTools.join(', '),
      waitTimeoutMs: String(group.config.waitTimeoutMs),
      maxPromptMessages: String(group.config.maxPromptMessages),
      messagePageSize: String(group.config.messagePageSize),
      maxEditableMessages: String(group.config.maxEditableMessages ?? 20),
      aiProactive: String(group.config.aiProactive ?? false),
      maxProactivePerRound: String(group.config.maxProactivePerRound ?? 1),
      maxAiMentionDepth: String(group.config.maxAiMentionDepth ?? 1),
    })
  }, [group?.config])

  useEffect(() => {
    if (group === null) {
      loadedGroupIdRef.current = null
      oldestLoadedSeqRef.current = undefined
      setOlderMessages([])
      setHasMoreOlder(false)
      setTopicFilter('all')
      setFilteredTopicMessages([])
      return
    }
    if (loadedGroupIdRef.current === group.groupId) {
      if (olderMessages.length === 0) {
        setHasMoreOlder(group.hasMoreMessages)
        if (group.oldestLoadedSeq !== undefined) oldestLoadedSeqRef.current = group.oldestLoadedSeq
      }
      return
    }
    loadedGroupIdRef.current = group.groupId
    oldestLoadedSeqRef.current = group.oldestLoadedSeq
    setOlderMessages([])
    setHasMoreOlder(group.hasMoreMessages)
    setTopicFilter('all')
    setFilteredTopicMessages([])
  }, [group?.groupId, group, olderMessages.length])

  useEffect(() => {
    const node = scrollRef.current
    if (node !== null && stickToBottomRef.current) node.scrollTop = node.scrollHeight
  }, [group?.messages.length, group?.currentSpeakerId])

  useEffect(() => {
    if (sessionId === null) return
    const abort = new AbortController()
    rpc.catalog(abort.signal)
      .then((next) => {
        setCatalog(next)
        if (next.defaultTimeoutMs > 0) {
          setMemberForm(form => form.timeout.trim() === ''
            ? { ...form, timeout: String(next.defaultTimeoutMs) }
            : form)
        }
      })
      .catch(() => setCatalog(null))
    return () => { abort.abort() }
  }, [sessionId])

  useEffect(() => {
    if (sessionId === null) return
    if (currentSessionId === undefined) {
      controller.close()
      return
    }
    if (sessionId !== currentSessionId) controller.open(currentSessionId)
  }, [sessionId, currentSessionId, controller])

  async function run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    setBusy(true)
    setError(null)
    try {
      return await operation(new AbortController().signal)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return undefined
    } finally {
      setBusy(false)
    }
  }

  async function sendMessage(): Promise<void> {
    if (sessionId === null || text.trim().length === 0) return
    if (text.trim().startsWith('/group')) {
      setError('群聊命令请在主 dsh 聊天输入框使用；这里直接输入群聊发言内容。')
      return
    }
    const envelope = await run(signal => mentionId
      ? rpc.at(sessionId, mentionId, text, { writeAccess: allowWrite }, groupId === '' ? undefined : groupId, signal)
      : rpc.send(sessionId, text, groupId === '' ? undefined : groupId, signal))
    if (envelope === undefined) return
    setGroup(envelope.group)
    setRevision(envelope.revision)
    revisionRef.current = envelope.revision
    setText('')
    setMentionId('')
    setAllowWrite(false)
  }

  async function createGroup(): Promise<void> {
    if (sessionId === null) return
    const envelope = await run(signal => rpc.create(sessionId, signal))
    if (envelope === undefined) return
    setGroupId(envelope.group?.groupId ?? '')
    setGroup(envelope.group)
    setRevision(envelope.revision)
    revisionRef.current = envelope.revision
  }

  async function switchGroup(target: string): Promise<void> {
    if (sessionId === null || target === groupId) return
    const envelope = await run(signal => rpc.useGroup(sessionId, target as GroupId, signal))
    if (envelope === undefined) return
    setGroupId(target)
    setGroup(envelope.group)
    setRevision(envelope.revision)
    revisionRef.current = envelope.revision
    setOlderMessages([])
    setHasMoreOlder(false)
    setTopicFilter('all')
    setFilteredTopicMessages([])
    setText('')
    setMentionId('')
  }

  async function renameGroup(): Promise<void> {
    if (sessionId === null || group === null) return
    const name = renameValue.trim()
    if (name.length === 0) return
    const envelope = await run(signal => rpc.renameGroup(sessionId, name, groupId === '' ? undefined : groupId, signal))
    if (envelope === undefined) return
    setGroup(envelope.group)
    setRevision(envelope.revision)
    revisionRef.current = envelope.revision
    setRenameValue('')
  }

  async function stopRound(): Promise<void> {
    if (sessionId === null) return
    const envelope = await run(signal => rpc.stop(sessionId, groupId === '' ? undefined : groupId, signal))
    if (envelope === undefined) return
    setGroup(envelope.group)
    setRevision(envelope.revision)
    revisionRef.current = envelope.revision
  }

  async function addMember(): Promise<void> {
    if (sessionId === null) return
    if (memberForm.name.trim().length === 0 || memberForm.provider.trim().length === 0 || memberForm.model.trim().length === 0) return
    const envelope = await run(signal => rpc.addMember(sessionId, {
      name: memberForm.name.trim(),
      provider: memberForm.provider.trim(),
      model: memberForm.model.trim(),
      ...memberForm.systemPrompt.trim() ? { systemPrompt: memberForm.systemPrompt.trim() } : {},
      ...memberForm.timeout.trim() ? { timeoutMs: Number(memberForm.timeout.trim()) } : {},
    }, groupId === '' ? undefined : groupId, signal))
    if (envelope === undefined) return
    setGroup(envelope.group)
    setRevision(envelope.revision)
    revisionRef.current = envelope.revision
    setMemberForm({
      name: '',
      provider: '',
      model: '',
      systemPrompt: '',
      timeout: catalog === null ? '' : String(catalog.defaultTimeoutMs),
    })
  }

  async function removeMember(name: string): Promise<void> {
    if (sessionId === null) return
    const envelope = await run(signal => rpc.removeMember(sessionId, name, groupId === '' ? undefined : groupId, signal))
    if (envelope === undefined) return
    setGroup(envelope.group)
    setRevision(envelope.revision)
    revisionRef.current = envelope.revision
  }

  async function saveOrder(): Promise<void> {
    if (sessionId === null) return
    const names = orderText.split(/[,，\s]+/).map(token => token.trim()).filter(Boolean)
    const envelope = await run(signal => rpc.reorderMembers(sessionId, names, groupId === '' ? undefined : groupId, signal))
    if (envelope === undefined) return
    setGroup(envelope.group)
    setRevision(envelope.revision)
    revisionRef.current = envelope.revision
  }

  async function toggleMention(): Promise<void> {
    if (sessionId === null || group === null) return
    const envelope = await run(signal => rpc.setMentionEnabled(sessionId, !group.mentionEnabled, groupId === '' ? undefined : groupId, signal))
    if (envelope === undefined) return
    setGroup(envelope.group)
    setRevision(envelope.revision)
    revisionRef.current = envelope.revision
  }

  async function dissolve(): Promise<void> {
    if (sessionId === null) return
    await run(signal => rpc.dissolve(sessionId, groupId === '' ? undefined : groupId, signal))
    setGroup(null)
    setRevision(-1)
    revisionRef.current = -1
  }

  async function loadOlder(): Promise<void> {
    if (sessionId === null || group === null || loadingOlder || !hasMoreOlder || topicFilter !== 'all') return
    const beforeSeq = oldestLoadedSeqRef.current ?? group.oldestLoadedSeq
    if (beforeSeq === undefined || beforeSeq <= 0) {
      setHasMoreOlder(false)
      return
    }

    setLoadingOlder(true)
    try {
      const page = await rpc.messagesBefore(sessionId, beforeSeq, undefined, groupId === '' ? undefined : groupId)
      setOlderMessages(previous => {
        const existing = new Set(previous.map(message => message.seq))
        return [...page.messages.filter(message => !existing.has(message.seq)), ...previous]
      })
      oldestLoadedSeqRef.current = page.oldestLoadedSeq ?? (page.messages[0]?.seq ?? beforeSeq)
      setHasMoreOlder(page.hasMore)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoadingOlder(false)
    }
  }

  async function selectTopicFilter(topicId: string): Promise<void> {
    setTopicFilter(topicId)
    if (topicId === 'all') {
      setFilteredTopicMessages([])
      return
    }
    if (sessionId === null) return
    try {
      const page = await rpc.topicMessages(sessionId, topicId, groupId === '' ? undefined : groupId)
      setFilteredTopicMessages(page.messages)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  function handleMessageScroll(event: React.UIEvent<HTMLDivElement>): void {
    const node = event.currentTarget
    stickToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
    if (node.scrollTop < 40) void loadOlder()
  }

  async function saveConfig(): Promise<void> {
    if (sessionId === null || group === null) return
    const maxAi = Number(configForm.maxAi)
    const defaultTimeoutMs = Number(configForm.defaultTimeoutMs)
    const waitTimeoutMs = Number(configForm.waitTimeoutMs)
    const maxPromptMessages = Number(configForm.maxPromptMessages)
    const messagePageSize = Number(configForm.messagePageSize)
    const maxEditableMessages = Number(configForm.maxEditableMessages)
    const maxProactivePerRound = Number(configForm.maxProactivePerRound)
    const maxAiMentionDepth = Number(configForm.maxAiMentionDepth)
    const readonlyTools = configForm.readonlyTools.split(',').map(tool => tool.trim()).filter(Boolean)

    if (![maxAi, defaultTimeoutMs, waitTimeoutMs, maxPromptMessages, messagePageSize, maxEditableMessages, maxProactivePerRound, maxAiMentionDepth].every(Number.isSafeInteger)) {
      setError('配置数值必须是整数')
      return
    }
    if (readonlyTools.length === 0) {
      setError('只读工具列表不能为空')
      return
    }

    const envelope = await run(signal => rpc.updateConfig(sessionId, {
      maxAi,
      defaultTimeoutMs,
      readonlyTools,
      waitTimeoutMs,
      maxPromptMessages,
      messagePageSize,
      maxEditableMessages,
      aiProactive: configForm.aiProactive === 'true',
      maxProactivePerRound,
      maxAiMentionDepth,
    }, groupId === '' ? undefined : groupId, signal))
    if (envelope === undefined) return
    setGroup(envelope.group)
    setRevision(envelope.revision)
    revisionRef.current = envelope.revision
  }

  async function exportChat(): Promise<void> {
    if (sessionId === null) return
    try {
      const result = await rpc.exportTranscript(sessionId, groupId === '' ? undefined : groupId)
      const blob = new Blob([result.content], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = result.filename
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function copyMessage(message: ChatGroupMessage): Promise<void> {
    if (message.text.length === 0) return
    try {
      await navigator.clipboard.writeText(message.text)
      setCopiedMessageId(message.id)
      setTimeout(() => setCopiedMessageId(current => current === message.id ? null : current), 1500)
    } catch {
      setError('复制失败：浏览器未允许剪贴板访问')
    }
  }

  function beginEdit(message: ChatGroupMessage): void {
    setEditingSeq(message.seq)
    setEditDraft(message.editedText ?? message.text)
  }

  async function saveEdit(): Promise<void> {
    if (sessionId === null || editingSeq === null || editDraft.trim().length === 0) return
    const envelope = await run(signal => rpc.editMessage(sessionId, editingSeq, editDraft, groupId === '' ? undefined : groupId, signal))
    if (envelope === undefined) return
    setGroup(envelope.group)
    setRevision(envelope.revision)
    revisionRef.current = envelope.revision
    setEditingSeq(null)
    setEditDraft('')
  }

  async function withdrawMessage(message: ChatGroupMessage): Promise<void> {
    if (sessionId === null) return
    if (typeof window !== 'undefined' && !window.confirm(`撤回该消息？\n${message.text.slice(0, 80)}`)) return
    const envelope = await run(signal => rpc.withdrawMessage(sessionId, message.seq, groupId === '' ? undefined : groupId, signal))
    if (envelope === undefined) return
    setGroup(envelope.group)
    setRevision(envelope.revision)
    revisionRef.current = envelope.revision
  }

  async function startNewTopic(): Promise<void> {
    if (sessionId === null) return
    const title = topicTitle.trim()
    if (title.length === 0) {
      setError('请输入新议题内容')
      return
    }
    if (typeof window !== 'undefined' && !window.confirm(`结束当前讨论并开启新议题：${title}？`)) return
    const envelope = await run(signal => rpc.startTopic(sessionId, title, groupId === '' ? undefined : groupId, signal))
    if (envelope === undefined) return
    setGroup(envelope.group)
    setRevision(envelope.revision)
    revisionRef.current = envelope.revision
    setTopicTitle('')
    setText('')
    setMentionId('')
    setAllowWrite(false)
  }

  async function startAuto(): Promise<void> {
    if (sessionId === null) return
    const rounds = Number(autoForm.rounds)
    if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 10) {
      setError('自动讨论轮数必须是 1–10 的整数')
      return
    }
    const envelope = await run(signal => rpc.startAuto(
      sessionId,
      rounds,
      autoForm.topic.trim().length > 0 ? autoForm.topic.trim() : undefined,
      groupId === '' ? undefined : groupId,
      signal,
    ))
    if (envelope === undefined) return
    setGroup(envelope.group)
    setRevision(envelope.revision)
    revisionRef.current = envelope.revision
    setAutoForm(form => ({ ...form, topic: '' }))
  }

  if (sessionId === null) {
    if (currentSessionId === undefined) return null
    return createElement('button', {
      type: 'button',
      style: launcherStyle,
      title: '打开群聊',
      onClick: () => controller.open(currentSessionId),
    }, '群聊')
  }

  const aiMembers = group?.members.filter(member => member.kind === 'ai') ?? []
  const selectedProvider = catalog?.providers.find(provider => provider.id === memberForm.provider)
  const running = group?.status === 'running'
  const formatTime = (ms: number): string => new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

  const header = createElement('div', { style: headerStyle },
    createElement('div', { style: { flex: 1, minWidth: 0 } },
      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        createElement('div', { style: titleStyle },
          group === null
            ? '项目讨论群'
            : `${group.name ?? group.groupId} · 第 ${group.round} 轮${group.blindRoundActive ? ' · 盲发中' : ''}`),
        group === null || group.groups.length <= 1 ? null : createElement('select', {
          style: { ...inputStyle, width: 170, fontSize: 12 },
          value: group.groupId,
          onChange: (event: ReactChangeEvent<HTMLSelectElement>) => { void switchGroup(event.target.value) },
        },
          ...group.groups.map(summary => createElement('option', { key: summary.groupId, value: summary.groupId },
            `${summary.groupId}${summary.status === 'running' ? ' · 发言中' : ''} · ${summary.currentTopicTitle}`))),
        group === null ? null : createElement('button', {
          type: 'button',
          style: { ...buttonStyle, padding: '2px 8px', fontSize: 11 },
          title: '新建群（需 maxGroups > 1）',
          onClick: () => { void createGroup() },
        }, '＋新建群')),
      group === null ? null : createElement('div', {
        style: { fontSize: 11, color: group.cwd === undefined ? '#b45309' : '#4b5563', marginTop: 2 },
        title: group.cwd ?? '当前会话没有工作目录',
      }, group.cwd === undefined ? '工作目录未设置' : `工作目录：${group.cwd}`),
        group?.autoActive === true
          ? createElement('div', { style: { fontSize: 11, color: '#7c3aed', marginTop: 2 } },
            `自动讨论 ${group.autoCurrentRound}/${group.autoTotalRounds}`)
          : null),
    group !== null && running ? createElement('span', { style: { fontSize: 12, color: '#b45309', whiteSpace: 'nowrap' } },
      group.currentSpeakerId === undefined
        ? '准备发言…'
        : `${memberName(group, group.currentSpeakerId)} 发言中`) : null,
    group?.toolActivity?.active === true
      ? createElement('span', {
        style: { fontSize: 12, color: '#7c3aed', whiteSpace: 'nowrap', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' },
        title: `${memberName(group, group.toolActivity.memberId)} 正在调用 ${group.toolActivity.tool} ${group.toolActivity.argsPreview}`,
      }, `${memberName(group, group.toolActivity.memberId)} 正在${group.toolActivity.tool}${group.toolActivity.argsPreview === '' ? '' : ` ${group.toolActivity.argsPreview}`}…`)
      : null,
    createElement('button', { type: 'button', style: buttonStyle, onClick: () => { void exportChat() } }, '导出'),
    createElement('button', { type: 'button', style: buttonStyle, onClick: () => controller.close() }, '关闭'),
  )

  const displayMessages = group === null
    ? []
    : topicFilter === 'all'
      ? [...olderMessages, ...group.messages].filter((message, index, all) => all.findIndex(candidate => candidate.seq === message.seq) === index)
      : filteredTopicMessages
  const messageNodes = group === null ? null : displayMessages.flatMap((message, index) => {
    const previous = displayMessages[index - 1]
    const topicChanged = index === 0 || previous?.topicId !== message.topicId
    const nodes = []
    if (topicChanged) {
      const topicId = message.topicId ?? group.currentTopicId
      const topic = group.topics.find(candidate => candidate.id === topicId)
      nodes.push(createElement('div', {
        key: `topic-separator-${message.seq}`,
        style: {
          alignSelf: 'center',
          margin: '8px 0 4px',
          fontSize: 11,
          color: '#9ca3af',
          borderTop: '1px solid #e5e7eb',
          paddingTop: 6,
          width: '100%',
          textAlign: 'center',
        },
      }, `—— 话题：${topic?.title ?? '历史话题'} ——`))
    }

    const own = message.senderId === 'user'
    const system = message.senderId === 'system'
    const withdrawn = message.status === 'withdrawn'
    const editable = !system && !withdrawn && message.status !== 'speaking' && message.text.length > 0
    nodes.push(createElement('div', {
      key: message.id,
      style: {
        alignSelf: system ? 'center' : own ? 'flex-end' : 'flex-start',
        maxWidth: system ? '92%' : '88%',
        background: system ? '#f3f4f6' : own ? '#2563eb' : '#f1f5f9',
        color: system ? '#6b7280' : own ? '#ffffff' : '#111827',
        borderRadius: 10,
        padding: '7px 10px',
        fontSize: system ? 12 : 13,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
    },
      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, opacity: 0.85, marginBottom: 3 } },
        createElement('span', { style: { flex: 1 } },
          `${memberName(group, message.senderId)} · R${message.round} · ${statusLabel(message.status, true)} · ${formatTime(message.createdAt)}${message.writeAccess === true ? ' · 临时写权限' : ''}${message.editedAt !== undefined ? ' · 已编辑' : ''}`),
        message.senderId === 'system' || message.status === 'speaking' || message.text.length === 0
          ? null
          : createElement('button', {
            type: 'button',
            style: { ...buttonStyle, padding: '1px 6px', fontSize: 11 },
            onClick: () => { void copyMessage(message) },
          }, copiedMessageId === message.id ? '已复制' : '复制'),
        editable
          ? createElement('button', {
            type: 'button',
            style: { ...buttonStyle, padding: '1px 6px', fontSize: 11 },
            onClick: () => beginEdit(message),
          }, '编辑')
          : null,
        editable
          ? createElement('button', {
            type: 'button',
            style: { ...buttonStyle, padding: '1px 6px', fontSize: 11, color: '#b91c1c' },
            onClick: () => { void withdrawMessage(message) },
          }, '撤回')
          : null),
      withdrawn
        ? createElement('span', { style: { fontStyle: 'italic', opacity: 0.6 } }, '（已撤回）')
        : editingSeq === message.seq
          ? createElement('div', null,
            createElement('textarea', {
              style: { ...inputStyle, marginBottom: 6, minHeight: 40 },
              value: editDraft,
              onChange: (event: ReactChangeEvent<HTMLTextAreaElement>) => setEditDraft(event.target.value),
            }),
            createElement('div', { style: { display: 'flex', gap: 6 } },
              createElement('button', { type: 'button', style: { ...buttonStyle, ...primaryButtonStyle }, disabled: editDraft.trim().length === 0, onClick: () => { void saveEdit() } }, '保存'),
              createElement('button', { type: 'button', style: buttonStyle, onClick: () => { setEditingSeq(null); setEditDraft('') } }, '取消')))
          : message.status === 'speaking' && message.text.length === 0 ? '正在输入…' : (message.editedText ?? message.text),
      message.error === undefined ? null : createElement('div', { style: { fontSize: 11, opacity: 0.7, marginTop: 4 } }, message.error),
    ))
    return nodes
  })

  const composer = group === null ? null : createElement('div', { style: { borderTop: '1px solid #e2e5ea', padding: 10 } },
    createElement('div', { style: { fontSize: 11, color: '#6b7280', margin: '0 0 6px' } },
      '群聊面板与主聊天独立：群聊消息不会进入主 Agent 的上下文。'),
    createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 8 } },
      running
        ? createElement('button', { type: 'button', style: dangerButtonStyle, disabled: busy, onClick: () => { void stopRound() } }, '结束本轮')
        : null,
      createElement('button', { type: 'button', style: buttonStyle, onClick: () => setShowSettings(value => !value) }, showSettings ? '收起设置' : '成员与设置'),
      createElement('button', { type: 'button', style: buttonStyle, onClick: () => { void dissolve() } }, '解散'),
    ),
    createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
      group.mentionEnabled && aiMembers.length > 0
        ? createElement('select', { style: { ...inputStyle, width: 140 }, value: mentionId, onChange: (event: ReactChangeEvent<HTMLSelectElement>) => setMentionId(event.target.value) },
          createElement('option', { value: '' }, '普通发言'),
          ...aiMembers.map(member => createElement('option', { key: member.id, value: member.name }, `@${member.name}`)))
        : null,
      group.mentionEnabled && mentionId !== ''
        ? createElement('label', {
          style: {
            fontSize: 12,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            color: group.sandboxMode === 'read-only' ? '#9ca3af' : '#111827',
          },
        },
          createElement('input', {
            type: 'checkbox',
            disabled: group.sandboxMode === 'read-only',
            checked: allowWrite,
            onChange: event => setAllowWrite(event.target.checked),
            title: group.sandboxMode === 'read-only'
              ? '当前为 read-only 模式，无法授予写权限'
              : '允许本次 @ 使用 write/edit',
          }),
          ' 允许本次写入')
        : null,
      createElement('textarea', {
        style: { ...inputStyle, flex: 1, minHeight: 42, resize: 'vertical' },
        placeholder: running ? '插话内容（本轮剩余 AI 可见）' : '输入议题，开始一轮讨论',
        value: text,
        onChange: (event: ReactChangeEvent<HTMLTextAreaElement>) => setText(event.target.value),
        onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void sendMessage()
        },
      }),
      createElement('button', { type: 'button', style: primaryButtonStyle, disabled: busy || text.trim().length === 0, onClick: () => { void sendMessage() } }, '发送'),
    ),
  )

  const settings = group === null || !showSettings ? null : createElement('aside', { style: sidebarStyle },
    createElement('div', { style: labelStyle }, '群名称'),
    createElement('div', { style: { display: 'flex', gap: 6 } },
      createElement('input', { style: inputStyle, placeholder: group.name ?? group.groupId, value: renameValue, onChange: event => setRenameValue(event.target.value) }),
      createElement('button', { type: 'button', style: buttonStyle, disabled: busy || renameValue.trim().length === 0, onClick: () => { void renameGroup() } }, '重命名')),
    createElement('div', { style: labelStyle }, '开启新议题'),
    createElement('input', { style: inputStyle, placeholder: '新议题内容', value: topicTitle, onChange: event => setTopicTitle(event.target.value) }),
    createElement('button', { type: 'button', style: dangerButtonStyle, disabled: busy, onClick: () => { void startNewTopic() } }, '结束当前并开启新议题'),
    createElement('div', { style: labelStyle }, '自动多轮讨论'),
    createElement('div', { style: { display: 'grid', gridTemplateColumns: '70px 1fr', gap: 6, marginBottom: 8 } },
      createElement('input', { style: inputStyle, value: autoForm.rounds, placeholder: '轮数', onChange: event => setAutoForm({ ...autoForm, rounds: event.target.value }) }),
      createElement('input', { style: inputStyle, value: autoForm.topic, placeholder: '议题（可选，默认继续当前话题）', onChange: event => setAutoForm({ ...autoForm, topic: event.target.value }) }),
    ),
    createElement('button', { type: 'button', style: primaryButtonStyle, disabled: busy || running || aiMembers.length === 0, onClick: () => { void startAuto() } }, busy ? '处理中…' : '启动自动讨论'),
    createElement('div', { style: { marginTop: 8, paddingTop: 8, borderTop: '1px solid #e2e5ea' } },
      createElement('div', { style: labelStyle }, '群配置（仅当前群生效，idle 时可修改）'),
      createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 } },
        createElement('input', { style: inputStyle, placeholder: 'maxAi (1-5)', value: configForm.maxAi, onChange: event => setConfigForm({ ...configForm, maxAi: event.target.value }) }),
        createElement('input', { style: inputStyle, placeholder: 'defaultTimeoutMs', value: configForm.defaultTimeoutMs, onChange: event => setConfigForm({ ...configForm, defaultTimeoutMs: event.target.value }) }),
        createElement('input', { style: inputStyle, placeholder: 'waitTimeoutMs', value: configForm.waitTimeoutMs, onChange: event => setConfigForm({ ...configForm, waitTimeoutMs: event.target.value }) }),
        createElement('input', { style: inputStyle, placeholder: 'maxPromptMessages (0=不限)', value: configForm.maxPromptMessages, onChange: event => setConfigForm({ ...configForm, maxPromptMessages: event.target.value }) }),
        createElement('input', { style: inputStyle, placeholder: 'messagePageSize', value: configForm.messagePageSize, onChange: event => setConfigForm({ ...configForm, messagePageSize: event.target.value }) }),
        createElement('input', { style: inputStyle, placeholder: 'maxEditableMessages', value: configForm.maxEditableMessages, onChange: event => setConfigForm({ ...configForm, maxEditableMessages: event.target.value }) }),
        createElement('select', { style: inputStyle, value: configForm.aiProactive, onChange: (event: ReactChangeEvent<HTMLSelectElement>) => setConfigForm({ ...configForm, aiProactive: event.target.value }) },
          createElement('option', { value: 'false' }, 'aiProactive: off'),
          createElement('option', { value: 'true' }, 'aiProactive: on')),
        createElement('input', { style: inputStyle, placeholder: 'maxProactivePerRound', value: configForm.maxProactivePerRound, onChange: event => setConfigForm({ ...configForm, maxProactivePerRound: event.target.value }) }),
        createElement('input', { style: inputStyle, placeholder: 'maxAiMentionDepth', value: configForm.maxAiMentionDepth, onChange: event => setConfigForm({ ...configForm, maxAiMentionDepth: event.target.value }) }),
      ),
      createElement('input', { style: { ...inputStyle, marginTop: 6 }, placeholder: 'readonlyTools（逗号分隔）', value: configForm.readonlyTools, onChange: event => setConfigForm({ ...configForm, readonlyTools: event.target.value }) }),
      createElement('button', { type: 'button', style: buttonStyle, disabled: busy || running, onClick: () => { void saveConfig() } }, '保存群配置'),
    ),
    createElement('div', { style: labelStyle }, '添加 AI 成员'),
    createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 } },
      createElement('input', { style: inputStyle, placeholder: '名称', value: memberForm.name, onChange: event => setMemberForm({ ...memberForm, name: event.target.value }) }),
      createElement('input', {
        style: inputStyle,
        placeholder: 'provider',
        list: 'chatgroup-provider-list',
        value: memberForm.provider,
        onChange: event => setMemberForm({ ...memberForm, provider: event.target.value }),
      }),
      createElement('input', {
        style: inputStyle,
        placeholder: 'model',
        list: 'chatgroup-model-list',
        value: memberForm.model,
        onChange: event => setMemberForm({ ...memberForm, model: event.target.value }),
      }),
      createElement('input', { style: inputStyle, placeholder: 'timeoutMs（默认已预填）', value: memberForm.timeout, onChange: event => setMemberForm({ ...memberForm, timeout: event.target.value }) }),
    ),
    createElement('input', { style: { ...inputStyle, marginTop: 6 }, placeholder: 'systemPrompt（可选）', value: memberForm.systemPrompt, onChange: event => setMemberForm({ ...memberForm, systemPrompt: event.target.value }) }),
    createElement('datalist', { id: 'chatgroup-provider-list' },
      (catalog?.providers ?? []).map(provider => createElement('option', { key: provider.id, value: provider.id }, provider.name))),
    createElement('datalist', { id: 'chatgroup-model-list' },
      (selectedProvider?.models ?? []).map(model => createElement('option', { key: model, value: model }))),
    createElement('button', { type: 'button', style: primaryButtonStyle, disabled: busy || running, onClick: () => { void addMember() } }, busy ? '处理中…' : '添加成员'),
    aiMembers.length > 0 ? createElement(Fragment, null,
      createElement('div', { style: labelStyle }, '成员'),
      ...aiMembers.map(member => createElement('div', {
        key: member.id,
        style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 13 },
      },
        createElement('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' } }, `${member.name} · ${member.ai?.provider}/${member.ai?.model}`),
        createElement('button', { type: 'button', style: buttonStyle, disabled: running, onClick: () => { void removeMember(member.name) } }, '移除'))),
      createElement('div', { style: labelStyle }, '发言顺序（用逗号分隔）'),
      createElement('input', { style: inputStyle, value: orderText, onChange: event => setOrderText(event.target.value) }),
      createElement('button', { type: 'button', style: buttonStyle, disabled: running, onClick: () => { void saveOrder() } }, '保存顺序'),
      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 } },
        createElement('span', { style: { fontSize: 13 } }, `@ 功能：${group.mentionEnabled ? '开启' : '关闭'}`),
        createElement('button', { type: 'button', style: buttonStyle, disabled: running, onClick: () => { void toggleMention() } }, group.mentionEnabled ? '关闭' : '开启')),
    ) : null,
  )

  const content = group === null
    ? createElement('div', { style: { padding: 24 } },
      createElement('p', { style: { fontSize: 14, color: '#4b5563' } }, '当前会话还没有群聊。'),
      createElement('button', {
        type: 'button',
        style: primaryButtonStyle,
        disabled: busy,
        onClick: () => { void createGroup() },
      }, busy ? '创建中…' : '创建群聊'),
    )
    : createElement('div', { style: bodyStyle },
      createElement('div', { style: mainColumnStyle },
        createElement('div', { ref: scrollRef, style: messageListStyle, onScroll: handleMessageScroll },
          createElement('select', {
            style: { ...inputStyle, alignSelf: 'center', width: 'auto', marginBottom: 4 },
            value: topicFilter,
            onChange: (event: ReactChangeEvent<HTMLSelectElement>) => { void selectTopicFilter(event.target.value) },
          },
            createElement('option', { value: 'all' }, '全部消息'),
            ...group.topics.map(topic => createElement('option', { key: topic.id, value: topic.id }, `话题：${topic.title}`))),
          topicFilter === 'all' && hasMoreOlder
            ? createElement('button', {
              type: 'button',
              style: { ...buttonStyle, alignSelf: 'center', marginBottom: 4 },
              disabled: loadingOlder,
              onClick: () => { void loadOlder() },
            }, loadingOlder ? '加载中…' : '加载更早消息')
            : null,
          createElement('div', { style: { alignSelf: 'center', fontSize: 11, color: '#9ca3af', marginBottom: 4 } },
            topicFilter === 'all'
              ? `已显示 ${displayMessages.length} / ${group.totalMessages} 条`
              : `话题消息 ${displayMessages.length} 条`),
          messageNodes,
        ),
        composer,
      ),
      settings,
    )

  return createElement('aside', { style: { ...drawerStyle, width: drawerWidth }, 'aria-label': '群聊面板' },
    createElement('div', { style: resizeHandleStyle, title: '拖动调整宽度', onPointerDown: beginResize }),
    header,
    error === null ? null : createElement('div', { style: { padding: '6px 12px', background: '#fef2f2', color: '#b91c1c', fontSize: 12 } }, error),
    content,
  )
}
