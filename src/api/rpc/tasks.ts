import type { TransportCore } from '../transport'
import { assertRpcOk, findArrayField, readRpcJson } from './core'

/** 后台任务 / subagent 控制：取消、终止、查询输出。 */
export const tasksRpc = {
  async cancelSubagent(this: TransportCore, subagentId: string, sessionId?: string) {
    const res = await this.fetch(this.url('/api/subagent-cancel'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subagentId,
        ...(sessionId ? { sessionId } : {}),
      }),
    })
    const data = await readRpcJson(res)
    assertRpcOk(res, data, 'subagent cancel failed')
    return data
  },

  async killTask(this: TransportCore, taskId: string, sessionId?: string) {
    const res = await this.fetch(this.url('/api/task-kill'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId,
        ...(sessionId ? { sessionId } : {}),
      }),
    })
    const data = await readRpcJson(res)
    assertRpcOk(res, data, 'task kill failed')
    return data
  },

  async listTasks(this: TransportCore): Promise<
    Array<{
      taskId: string
      command?: string
      output?: string
      outputFile?: string
      completed?: boolean
      description?: string
      truncated?: boolean
    }>
  > {
    const res = await this.fetch(this.url('/api/task-list'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'task list failed')
    // Walk common envelopes until we find a tasks array:
    //   { ok, result: { result: { tasks }, error } }  // ExtMethodResult via JSON-RPC
    //   { ok, result: { tasks } }
    //   { tasks }
    const list = findArrayField(data, 'tasks')
    return list
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .map((t) => parseTaskSnap(t))
      .filter((t) => t.taskId)
  },

  async taskOutput(this: TransportCore,
    taskId: string,
    session?: { sessionId?: string; cwd?: string },
  ): Promise<{
    taskId: string
    command?: string
    output?: string
    outputFile?: string
    completed?: boolean
    description?: string
    truncated?: boolean
    running?: boolean
    failed?: boolean
  }> {
    const res = await this.fetch(this.url('/api/task-output'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId,
        ...(session?.sessionId ? { sessionId: session.sessionId } : {}),
        ...(session?.cwd ? { cwd: session.cwd } : {}),
      }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'task output failed')
    return parseTaskSnap((data.task ?? {}) as Record<string, unknown>, taskId)
  },
}

function parseTaskSnap(
    t: Record<string, unknown>,
    fallbackId = '',
  ): {
    taskId: string
    command?: string
    output?: string
    outputFile?: string
    completed?: boolean
    description?: string
    truncated?: boolean
    running?: boolean
    failed?: boolean
  } {
    const id = t.task_id ?? t.taskId ?? fallbackId
    return {
      taskId: id == null || id === '' ? '' : String(id),
      command:
        (typeof t.display_command === 'string' && t.display_command) ||
        (typeof t.displayCommand === 'string' && t.displayCommand) ||
        (typeof t.command === 'string' ? t.command : undefined) ||
        undefined,
      output: typeof t.output === 'string' ? t.output : undefined,
      outputFile:
        (typeof t.output_file === 'string' && t.output_file) ||
        (typeof t.outputFile === 'string' ? t.outputFile : undefined) ||
        undefined,
      completed: typeof t.completed === 'boolean' ? t.completed : undefined,
      description:
        typeof t.description === 'string' && t.description.trim()
          ? t.description.trim()
          : undefined,
      truncated: typeof t.truncated === 'boolean' ? t.truncated : undefined,
      // Host reconstruction (TaskLog) fields — camelCase on the wire.
      running: typeof t.running === 'boolean' ? t.running : undefined,
      failed: typeof t.failed === 'boolean' ? t.failed : undefined,
    }
  }
