export type PanelListener = () => void

/** Tiny external store: which session's chat-group panel is open. */
export class ChatGroupPanelController {
  private sessionId: string | null = null
  private readonly listeners = new Set<PanelListener>()

  getSessionId = (): string | null => this.sessionId

  subscribe = (listener: PanelListener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  open(sessionId: string): void {
    if (this.sessionId === sessionId) return
    this.sessionId = sessionId
    this.emit()
  }

  close(): void {
    if (this.sessionId === null) return
    this.sessionId = null
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
