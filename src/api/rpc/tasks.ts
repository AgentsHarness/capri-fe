import type { TransportCore } from '../transport'
import { assertRpcOk, findArrayField, readRpcJson } from './core'

/** 后台任务 / subagent 控制：取消、终止、查询输出。 */

/**
 * `x.ai/task/kill` 的终止来源，即 agent 侧 `TaskKillSource` 的 wire 名。
 * 它决定任务收尾时 agent 要不要唤醒模型：
 * - `clientUi`：单条 UI 终止，agent 会在完成通知里补一句
 *   "This task was killed by the user — do not restart it."
 * - `teardown`：agent 视为已把结果交付给调用方，不再为这条任务唤醒。
 */
export type TaskKillSource = 'clientUi' | 'teardown'

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

  async sendSubagentMessage(
    this: TransportCore,
    agentAddress: string,
    text: string,
    opts: { queue?: boolean; sessionId?: string } = {}
  ) {
    const res = await this.fetch(this.url('/api/subagent/message'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentAddress,
        text,
        queue: opts.queue ?? false,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      }),
    })
    const data = await readRpcJson(res)
    assertRpcOk(res, data, 'subagent message failed')
    return data
  },

  /**
   * Kill one background task (x.ai/task/kill). The agent answers
   * `{result: {result: {taskId, outcome}}}` through the ExtMethodResult
   * envelope, and `outcome` is the only truthful verdict: not_found is
   * delivered inside a successful response, so callers MUST branch on it.
   *
   * `source` is the kill's provenance and the only lever on whether the agent
   * is woken about it — omitted, the agent applies its `clientUi` default.
   */
  async killTask(
    this: TransportCore,
    taskId: string,
    sessionId?: string,
    source?: TaskKillSource,
  ): Promise<'killed' | 'already_exited' | 'not_found' | 'unknown'> {
    const res = await this.fetch(this.url('/api/task-kill'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId,
        ...(sessionId ? { sessionId } : {}),
        ...(source ? { source } : {}),
      }),
    })
    const data = await readRpcJson(res)
    assertRpcOk(res, data, 'task kill failed')
    return parseKillOutcome(data)
  },

  /**
   * The agent's live task registry (x.ai/task/list). Pass `sessionId` to ask
   * for THAT session's registry: without it the host answers for whichever
   * session is active, which would paint another session's tasks on this
   * view (the top task strip is per-session).
   */
  async listTasks(
    this: TransportCore,
    sessionId?: string,
  ): Promise<
    Array<{
      taskId: string
      command?: string
      output?: string
      outputFile?: string
      completed?: boolean
      description?: string
      truncated?: boolean
      running?: boolean
      failed?: boolean
      isBackgrounded?: boolean
      sessionId?: string
      exitCode?: number
    }>
  > {
    const res = await this.fetch(this.url('/api/task-list'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
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

/**
 * Pull `outcome` out of an x.ai/task/kill reply. The agent answers through
 * the ExtMethodResult envelope and the host may have unwrapped any number
 * of its layers, so walk `result` links looking for the verdict.
 * 'unknown' = the reply parsed but carried no outcome (older/foreign host).
 */
export function parseKillOutcome(
  data: unknown,
): 'killed' | 'already_exited' | 'not_found' | 'unknown' {
  let node: unknown = data
  for (let depth = 0; depth < 4 && node && typeof node === 'object'; depth++) {
    const rec = node as Record<string, unknown>
    if (typeof rec.outcome === 'string') {
      const o = rec.outcome
      if (o === 'killed' || o === 'already_exited' || o === 'not_found') return o
      return 'unknown'
    }
    node = rec.result
  }
  return 'unknown'
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
    isBackgrounded?: boolean
    sessionId?: string
    exitCode?: number
  } {
    const id = t.task_id ?? t.taskId ?? fallbackId
    const isBackgrounded =
      typeof t.is_backgrounded === 'boolean'
        ? t.is_backgrounded
        : typeof t.isBackgrounded === 'boolean'
          ? t.isBackgrounded
          : undefined
    const sessionId =
      typeof t.owner_session_id === 'string' && t.owner_session_id
        ? t.owner_session_id
        : typeof t.ownerSessionId === 'string' && t.ownerSessionId
          ? t.ownerSessionId
          : typeof t.session_id === 'string' && t.session_id
            ? t.session_id
            : typeof t.sessionId === 'string' && t.sessionId
              ? t.sessionId
              : undefined
    const exitCode =
      typeof t.exit_code === 'number'
        ? t.exit_code
        : typeof t.exitCode === 'number'
          ? t.exitCode
          : undefined
    const rawCompleted = typeof t.completed === 'boolean' ? t.completed : undefined
    const completed =
      rawCompleted === true ||
      exitCode !== undefined ||
      t.end_time != null ||
      t.endTime != null ||
      (typeof t.signal === 'string' && t.signal.length > 0) ||
      t.status === 'completed' ||
      t.status === 'failed' ||
      t.running === false
    const running =
      t.running === true
        ? true
        : completed
          ? false
          : isBackgrounded === false
            ? false
            : rawCompleted === false
              ? true
              : undefined
    const failed =
      t.failed === true ||
      t.explicitly_killed === true ||
      t.explicitlyKilled === true ||
      (exitCode !== undefined && exitCode !== 0) ||
      (typeof t.signal === 'string' && t.signal.length > 0)
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
      completed,
      description:
        typeof t.description === 'string' && t.description.trim()
          ? t.description.trim()
          : undefined,
      truncated: typeof t.truncated === 'boolean' ? t.truncated : undefined,
      running,
      failed,
      isBackgrounded,
      sessionId,
      exitCode,
    }
  }
