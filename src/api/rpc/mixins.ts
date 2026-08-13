import { sessionsRpc } from './sessions'
import { gitRpc } from './git'
import { toolsRpc } from './tools'
import { miscRpc } from './misc'

export const rpcMixins = { ...sessionsRpc, ...gitRpc, ...toolsRpc, ...miscRpc }

export type RpcApi = {
  [K in keyof typeof rpcMixins]: OmitThisParameter<(typeof rpcMixins)[K]>
}
