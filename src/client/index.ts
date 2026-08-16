import type { Context } from '@deepseek-ai/cordis'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { ChatGroupHeaderButton } from './HeaderButton.js'
import { ChatGroupPanel } from './ChatGroupPanel.js'
import { ChatGroupPanelController } from './panel-controller.js'
import { ChatGroupRpcClient } from './rpc-client.js'

export const inject = ['connection', 'slots']

export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) {
    throw new Error('chatgroup client plugin requires the dsh client connection service')
  }

  const controller = new ChatGroupPanelController()
  const rpc = new ChatGroupRpcClient(connection.rpc)

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'chatgroup-open',
    order: 100,
    label: '群聊',
    inject: (sessionId) => ({ onOpen: () => controller.open(sessionId) }),
  }, ChatGroupHeaderButton))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'chatgroup-panel',
    order: 100,
    inject: () => ({ controller, rpc }),
  }, ChatGroupPanel))
}

export type { ChatGroupPanelController } from './panel-controller.js'
export { ChatGroupRpcClient, ChatGroupRpcError } from './rpc-client.js'
