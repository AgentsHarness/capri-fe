import type { ScrollEntry } from '../api/types'
import type { ViewerTask } from '../store/chat/typesPublic'

export function preambleDescLines(desc: string): string[] {
  const whole = desc.trim()
  if (!whole) return []
  const out: string[] = []
  let prevBlank = false
  for (const line of whole.split('\n')) {
    const trimmed = line.replace(/\s+$/, '')
    if (!trimmed) {
      if (prevBlank) continue
      prevBlank = true
    } else {
      prevBlank = false
    }
    out.push(trimmed)
  }
  return out
}

/** Synthesize a bg_task entry from a task-only view (top strip / replay). */
export function taskViewToEntry(v: ViewerTask): Extract<ScrollEntry, { kind: 'bg_task' }> {
  return {
    id: `task_${v.taskId}`,
    kind: 'bg_task',
    title: v.title || `Task ${v.taskId.slice(0, 8)}`,
    status: v.failed ? 'failed' : v.running || !v.completed ? 'started' : 'completed',
    running: !!v.running,
    taskId: v.taskId,
    command: v.command,
    outputFile: v.outputFile,
    output: v.output ?? '',
  }
}
