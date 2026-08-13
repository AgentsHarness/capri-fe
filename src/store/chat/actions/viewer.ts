import type { ChatState, SetState } from '../types'
import { viewerNavActions } from './viewerNav'
import { viewerOpenActions } from './viewerOpen'

export function viewerActions(set: SetState, get: () => ChatState) {
  return {
    ...viewerNavActions(set, get),
    ...viewerOpenActions(set, get),
  }
}
