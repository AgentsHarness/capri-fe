import type { ScrollEntry } from '../api/types'
import { toolHeader } from '../theme/glyphs'
import { entryFailed, entryRunning } from './entryState'
import { toolHeaderExtra } from './toolHeaderExtra'

/** 全文查看弹窗的标题 / 副标题（工具行复用行头部的路径规则）。 */
export function viewerChrome(e: ScrollEntry, cwd?: string): { title: string; subtitle?: string } {
  if (e.kind === 'tool') {
    const running = entryRunning(e)
    const failed = entryFailed(e)
    const { verb } = toolHeader(e.kindName, running)
    if (e.raw) {
      // Fullscreen surface: same rule set as the row header, only the path
      // paint differs (normalized absolute path, no collapsed suffixes).
      const extra = toolHeaderExtra(e.raw, e.kindName, failed, e.mergedRaws, {
        surface: 'fullscreen',
        cwd,
        status: e.status,
      })
      if (extra?.bare) return { title: extra.bare }
      if (extra) {
        const sub = `${extra.head ?? ''}${extra.target ?? ''}`
        return { title: extra.verb ?? verb, subtitle: sub || e.title }
      }
    }
    return { title: verb, subtitle: e.title }
  }
  if (e.kind === 'thought') {
    return {
      title: e.streaming ? 'Thinking' : 'Thought',
      subtitle: e.elapsed ? `for ${e.elapsed}` : undefined,
    }
  }
  if (e.kind === 'user') return { title: 'User prompt' }
  if (e.kind === 'assistant') return { title: 'Assistant' }
  if (e.kind === 'image') return { title: 'Image', subtitle: e.mimeType }
  if (e.kind === 'error') return { title: 'Error' }
  if (e.kind === 'plan') return { title: 'Plan' }
  if (e.kind === 'btw') return { title: '/btw', subtitle: e.question }
  if (e.kind === 'bg_task') {
    const verb =
      e.status === 'started'
        ? 'Task running'
        : e.status === 'completed'
          ? 'Task completed'
          : 'Task failed'
    return {
      title: verb,
      subtitle: e.command || e.title,
    }
  }
  if (e.kind === 'subagent') {
    return {
      title: e.running ? 'Agent running' : `Agent ${e.status}`,
      subtitle: e.title,
    }
  }
  return { title: e.kind }
}
