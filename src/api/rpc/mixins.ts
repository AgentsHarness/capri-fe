import { sessionsRpc } from './sessions'
import { gitRpc } from './git'
import { toolsRpc } from './tools'
import { promptRpc } from './prompt'
import { hostsRpc } from './hosts'
import { tasksRpc } from './tasks'
import { queueRpc } from './queue'
import { searchRpc } from './search'
import { goalRpc } from './goal'
import { modesRpc } from './modes'
import { assistRpc } from './assist'
import { usageRpc } from './usage'

export const rpcMixins = {
  ...sessionsRpc,
  ...gitRpc,
  ...toolsRpc,
  ...promptRpc,
  ...hostsRpc,
  ...tasksRpc,
  ...queueRpc,
  ...searchRpc,
  ...goalRpc,
  ...modesRpc,
  ...assistRpc,
  ...usageRpc,
}

export type RpcApi = {
  [K in keyof typeof rpcMixins]: OmitThisParameter<(typeof rpcMixins)[K]>
}
