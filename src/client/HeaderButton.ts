import { createElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

export interface HeaderButtonProps extends PropsRuntime<'conversation.session.header.actions'> {
  readonly onOpen: () => void
}

const buttonStyle = {
  padding: '6px 10px',
  borderRadius: '6px',
  border: '1px solid #d7dbe2',
  background: '#ffffff',
  cursor: 'pointer',
  fontSize: '13px',
  color: '#1f2937',
  whiteSpace: 'nowrap' as const,
}

export function ChatGroupHeaderButton({ onOpen }: HeaderButtonProps) {
  return createElement('button', {
    type: 'button',
    style: buttonStyle,
    title: '打开项目讨论群聊',
    onClick: onOpen,
  }, '群聊')
}
