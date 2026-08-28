/**
 * Chat store public API.
 *
 * Implementation lives in `src/store/chat/` (domain modules + barrels):
 *   store.ts / actions/*     zustand create + action slices
 *   events.ts / events/*     live SSE handlers by event family
 *   loadHistory.ts etc.      session load / continue / paginate
 *   types.ts / typesPublic   ChatState + exported UI types
 *   history.ts / envelope*   replay + pagination
 *   turn.ts / turn*          finalize / adopt / settle
 *   modeFlags.ts / mode*     permission / plan persistence
 *
 * Existing imports (`from './store/chat'`) stay stable.
 */
export { useChatStore } from './chat/store'
export {
  formatTurnDuration,
  planTodos,
  stillRunningCue,
} from './chat/format'
export type {
  ExtensionsTab,
  FileSearchMatch,
  FileSearchState,
  FocusMode,
  McpInitProgress,
  McpServerInfo,
  TodoCounts,
  TodoItem,
  ViewerTask,
  WorkflowRun,
} from './chat/types'
