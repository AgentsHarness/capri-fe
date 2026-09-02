import { describe, expect, it, vi } from 'vitest'
import type { ToolCall } from '../../api/types'
import {
  absorbBashOutputIntoBgTask,
  absorbTaskOutputIntoBgTask,
  bashOutputText,
  bashRawOutput,
  clearSuppressedTools,
  extractTarget,
  isBgExecuteTool,
  isBgPlumbingTool,
  isExecuteToolFunctionName,
  isGoalTool,
  isOrphanBashStreamUpdate,
  isSchedulerTool,
  isTaskSpawnTool,
  isTodoTool,
  isWorkflowTool,
  shouldSuppressToolFromScrollback,
  suppressedToolIds,
  toolCallIdOf,
  toolKindName,
  toolRawInput,
  toolRawOutput,
  toolTitle,
  toolVariant,
  xaiToolKind,
} from './tools'

function tc(over: Partial<ToolCall> = {}): ToolCall {
  return { id: 't', title: '', ...over } as ToolCall
}

describe('extractTarget / raw 访问器', () => {
  it('路径/命令/查询逐键提取；title 兜底', () => {
    expect(extractTarget(tc({ rawInput: { path: '/a' } }))).toBe('/a')
    expect(extractTarget(tc({ rawInput: { filePath: 'b' } }))).toBe('b')
    expect(extractTarget(tc({ rawInput: { command: 'ls' } }))).toBe('ls')
    expect(extractTarget(tc({ rawInput: { query: 'q' } }))).toBe('q')
    expect(extractTarget(tc({ rawInput: { url: 'u' } }))).toBe('u')
    expect(extractTarget(tc({ rawInput: { pattern: 'p' } }))).toBe('p')
    expect(extractTarget(tc({ title: 'fallback' }))).toBe('fallback')
  })

  it('原始字段 camel/snake 兼容', () => {
    expect(toolRawInput(tc({ rawInput: { a: 1 } }))).toEqual({ a: 1 })
    expect(toolRawInput(tc({ raw_input: { b: 2 } }))).toEqual({ b: 2 })
    expect(toolRawInput(tc({ rawInput: 'str' as never }))).toBeUndefined()
    expect(toolRawOutput(tc({ rawOutput: 'o' }))).toBe('o')
    expect(toolRawOutput(tc({ raw_output: 'u' }))).toBe('u')
  })

  it('toolTitle / toolVariant', () => {
    expect(toolTitle(tc({ title: 'x' }))).toBe('x')
    expect(toolTitle(tc())).toBe('')
    expect(toolVariant(tc({ rawInput: { variant: 'V' } }))).toBe('V')
    expect(toolVariant(tc())).toBeUndefined()
  })

  it('toolCallIdOf：camel/snake/id/tool_call_id', () => {
    expect(toolCallIdOf(tc({ toolCallId: 'a' }))).toBe('a')
    expect(toolCallIdOf(tc({ tool_call_id: 'b' }))).toBe('b')
    expect(toolCallIdOf(tc({ id: 'c' }))).toBe('c')
    expect(toolCallIdOf({ title: 'x' } as ToolCall)).toBeUndefined()
  })

  it('xaiToolKind / toolKindName：x.ai/tool.kind 优先于顶层 kind', () => {
    // send_subagent_message（1.0.9+）：官方顶层 kind 恒为 other，扩展
    // 分类 active_agent_message 驱动动词渲染。
    const msg = tc({
      kind: 'other',
      _meta: { 'x.ai/tool': { kind: 'active_agent_message', version: 1 } },
    })
    expect(xaiToolKind(msg)).toBe('active_agent_message')
    expect(toolKindName(msg, undefined)).toBe('active_agent_message')
    // 无扩展 meta → 官方 kind / 兜底
    expect(xaiToolKind(tc({ kind: 'read' }))).toBeUndefined()
    expect(toolKindName(tc({ kind: 'read' }), undefined)).toBe('read')
    expect(toolKindName(tc(), 'other')).toBe('other')
    // 形状防御：meta / x.ai/tool 非对象
    expect(xaiToolKind(tc({ _meta: 'x' as never }))).toBeUndefined()
    expect(xaiToolKind(tc({ _meta: { 'x.ai/tool': 'x' } as never }))).toBeUndefined()
    // 顶层 kind 非字符串不得污染 kindName——它会被塞进条目，随后
    // toolFamily / toolHeader / verbGroupKind 都对它调 .toLowerCase()
    expect(toolKindName(tc({ kind: 3 as never }), undefined)).toBe('other')
    expect(toolKindName(tc({ kind: { k: 'read' } as never }), 'edit')).toBe('edit')
  })
})

describe('isExecuteToolFunctionName', () => {
  it('大小写不敏感匹配各别名', () => {
    for (const s of ['run_terminal_command', 'run_terminal_cmd', 'bash', 'shell', 'execute', 'run_command', 'terminal', 'Run_Terminal_Command']) {
      expect(isExecuteToolFunctionName(s)).toBe(true)
    }
    expect(isExecuteToolFunctionName('read')).toBe(false)
  })
})

describe('isBgPlumbingTool', () => {
  it('标题 / 前缀 / 变体 / rawOutput type 识别', () => {
    expect(isBgPlumbingTool(tc({ title: 'get_command_or_subagent_output' }))).toBe(true)
    expect(isBgPlumbingTool(tc({ title: 'kill_task' }))).toBe(true)
    expect(isBgPlumbingTool(tc({ title: 'Await: 5' }))).toBe(true)
    expect(isBgPlumbingTool(tc({ title: 'Sleep 3s' }))).toBe(true)
    expect(isBgPlumbingTool(tc({ title: 'Wait tasks: x' }))).toBe(true)
    expect(isBgPlumbingTool(tc({ rawInput: { variant: 'TaskOutput' } }))).toBe(true)
    expect(isBgPlumbingTool(tc({ rawOutput: { type: 'WaitTasks' } }))).toBe(true)
    expect(isBgPlumbingTool(tc({ title: 'normal tool' }))).toBe(false)
  })
})

describe('isBgExecuteTool / isTaskSpawnTool / isTodoTool / isGoalTool / isSchedulerTool / isWorkflowTool', () => {
  it('execute + is_background → bg 工具', () => {
    expect(isBgExecuteTool(tc({ kind: 'execute', rawInput: { is_background: true } }))).toBe(true)
    expect(isBgExecuteTool(tc({ kind: 'execute', rawInput: { is_background: false } }))).toBe(false)
    expect(isBgExecuteTool(tc({ kind: 'execute' }))).toBe(false)
    expect(isBgExecuteTool(tc({ title: 'run_terminal_command', rawInput: { background: true } }))).toBe(true)
  })

  it('task 派生 / todo / goal / scheduler / workflow', () => {
    expect(isTaskSpawnTool(tc({ title: 'task' }))).toBe(true)
    expect(isTaskSpawnTool(tc({ rawInput: { variant: 'SpawnSubagent' } }))).toBe(true)
    expect(isTodoTool(tc({ title: 'todo_write' }))).toBe(true)
    expect(isGoalTool(tc({ title: 'Goal: fix the bug' }))).toBe(true)
    expect(isGoalTool(tc({ rawInput: { variant: 'WorkflowSignal' } }))).toBe(true)
    expect(isSchedulerTool(tc({ title: 'scheduler_create' }))).toBe(true)
    expect(isSchedulerTool(tc({ rawInput: { variant: 'SchedulerDelete' } }))).toBe(true)
    // workflow（validate_only 除外）
    expect(isWorkflowTool(tc({ title: 'workflow' }))).toBe(true)
    expect(isWorkflowTool(tc({ rawInput: { variant: 'Workflow', validate_only: true } }))).toBe(false)
    expect(isWorkflowTool(tc({ title: 'valid_workflow' }))).toBe(false)
  })

  it('shouldSuppressToolFromScrollback 汇总', () => {
    expect(shouldSuppressToolFromScrollback(tc({ title: 'get_task_output' }))).toBe(true)
    expect(shouldSuppressToolFromScrollback(tc({ title: 'todo_write' }))).toBe(true)
    expect(shouldSuppressToolFromScrollback(tc({ title: 'redirect stdout' }))).toBe(false)
  })
})

describe('clearSuppressedTools', () => {
  it('清空模块级集合', () => {
    suppressedToolIds.add('x')
    clearSuppressedTools()
    expect(suppressedToolIds.size).toBe(0)
    expect(clearSuppressedTools()).toBeUndefined()
  })
})

describe('absorbTaskOutputIntoBgTask', () => {
  it('TaskOutput Result 折叠进匹配 bg_task 条目', () => {
    const tc1 = tc({
      rawOutput: { type: 'TaskOutput', Result: { task_id: 't1', output: 'longer log', command: 'npm' } },
    })
    const get = vi.fn(() => ({ bgTaskIndex: { t1: 'e1' }, entries: [{ id: 'e1', kind: 'bg_task', title: 'x', output: 'short' }] }))
    const set = vi.fn()
    absorbTaskOutputIntoBgTask(get as never, set, tc1)
    expect(set).toHaveBeenCalled()
    const partial = set.mock.calls[0][0] as { entries: Array<{ output: string; command: string }> }
    expect(partial.entries[0].output).toBe('longer log')
    expect(partial.entries[0].command).toBe('npm')
  })

  it('无 TaskOutput / 无任务 / 输出更短 → 不动', () => {
    const set = vi.fn()
    absorbTaskOutputIntoBgTask(
      (() => ({ bgTaskIndex: {} })) as never,
      set,
      tc({ rawOutput: { type: 'Bash' } }),
    )
    expect(set).not.toHaveBeenCalled()
  })
})

describe('bashRawOutput / bashOutputText / isOrphanBashStreamUpdate / absorbBashOutputIntoBgTask', () => {
  it('Bash type 提取；输出字段优先级', () => {
    expect(bashRawOutput(tc({ rawOutput: { type: 'Bash', output: 'x' } }))).toEqual({ type: 'Bash', output: 'x' })
    expect(bashRawOutput(tc({ rawOutput: { type: 'Other' } }))).toBeNull()
    expect(bashOutputText({ output_for_prompt: 'a', output: 'b' })).toBe('a')
    expect(bashOutputText({ outputForPrompt: 'a' })).toBe('a')
    expect(bashOutputText({ output: '[]' })).toBeUndefined()
  })

  it('孤儿 Bash 流更新识别', () => {
    expect(
      isOrphanBashStreamUpdate(tc({ rawOutput: { type: 'Bash', output: 'x' } })),
    ).toBe(true) // 无标题无 kind
    expect(
      isOrphanBashStreamUpdate(tc({ title: 'named', rawOutput: { type: 'Bash', output: 'x' } })),
    ).toBe(false)
    expect(
      isOrphanBashStreamUpdate(tc({ rawOutput: { type: 'Bash', truncated: true } })),
    ).toBe(true)
  })

  it('absorbBashOutputIntoBgTask：按命令精确/模糊匹配', () => {
    const tc1 = tc({
      rawInput: { command: 'npm run dev' },
      rawOutput: { type: 'Bash', command: 'npm run dev', output: 'new log' },
    })
    const get = vi.fn(() => ({
      entries: [{ id: 'e1', kind: 'bg_task', title: 'x', command: 'npm run dev', output: 'old' }],
    }))
    const set = vi.fn()
    absorbBashOutputIntoBgTask(get as never, set, tc1)
    expect(set).toHaveBeenCalled()
    const partial = set.mock.calls[0][0] as { entries: Array<{ output: string }> }
    expect(partial.entries[0].output).toBe('new log')
  })

  it('无匹配任务 → 不动', () => {
    const set = vi.fn()
    absorbBashOutputIntoBgTask(
      (() => ({ entries: [{ id: 'e1', kind: 'user', text: 'x' }] })) as never,
      set,
      tc({ rawOutput: { type: 'Bash', command: 'ls', output: 'o' } }),
    )
    expect(set).not.toHaveBeenCalled()
  })
})