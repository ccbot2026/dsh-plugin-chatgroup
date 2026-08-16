/** Stable error codes surfaced by chat-group commands (and later RPC). */

export type ChatGroupErrorCode =
  | 'NO_GROUP'
  | 'GROUP_EXISTS'
  | 'GROUP_IDLE_REQUIRED'
  | 'AI_LIMIT_EXCEEDED'
  | 'NO_AI_MEMBERS'
  | 'UNKNOWN_MEMBER'
  | 'DUPLICATE_MEMBER'
  | 'INVALID_NAME'
  | 'INVALID_ORDER'
  | 'MENTION_DISABLED'
  | 'INVALID_TEXT'
  | 'INVALID_TIMEOUT'
  | 'INVALID_ROUNDS'
  | 'WRITE_BLOCKED'
  | 'UNKNOWN_PROVIDER'
  | 'UNKNOWN_TOOL'

export class ChatGroupError extends Error {
  readonly code: ChatGroupErrorCode

  constructor(code: ChatGroupErrorCode, message: string) {
    super(message)
    this.name = 'ChatGroupError'
    this.code = code
  }
}
