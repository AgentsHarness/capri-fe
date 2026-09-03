import { describe, expect, it, vi } from 'vitest'
import { afterEach, beforeEach } from 'vitest'

// registry 依赖 chat / promptQueue store；theme store 用真实实现（jsdom 可跑）。
vi.mock('../store/chat', () => ({
  useChatStore: {
    getState: vi.fn(),
    setState: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  },
}))
vi.mock('../store/promptQueue', () => ({
  usePromptQueue: {
    getState: vi.fn(),
  },
}))

import { useChatStore } from '../store/chat'
import { usePromptQueue } from '../store/promptQueue'
import { useThemeStore } from '../store/theme'
import { bumpSlashRecency } from './recency'
import { setCachedSkills } from './skills'
import { setCachedWorkflows } from './workflows'
import {
  escapeSlash,
  filterSlashArgs,
  filterSlashCommands,
  isMultilineEnabled,
  isSlashEscaped,
  isSlashInvocationComplete,
  isSlashLiteral,
  literalSlashPayload,
  matchSlash,
  mergedSlashCommands,
  parseBudgetTokens,
  parseSlashLine,
  registerMcpPanelOpener,
  registerModelMenuOpener,
  slashCommandInsertText,
  slashCommands,
  unescapeSlash,
} from './registry'

interface FakeChat {
  models: Array<Record<string, unknown>>
  modelName: string
  reasoningEffort?: string
  conn: string
  sessionId: string | null
  cwd: string | null
  sessionTitle: string | null
  entries: Array<Record<string, unknown>>
  historyLoadedStart?: number
  historyHasMore?: boolean
  statusText?: string
  agentCommands: Array<{ name: string; description: string; argHint?: string }>
  appendLocalEntry: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  setModel: ReturnType<typeof vi.fn>
  setState: null
  openExtensions: ReturnType<typeof vi.fn>
  openSettings: ReturnType<typeof vi.fn>
  setWorkflowPanelOpen: ReturnType<typeof vi.fn>
  openHistory: ReturnType<typeof vi.fn>
  newSession: ReturnType<typeof vi.fn>
  openRewind: ReturnType<typeof vi.fn>
  compactSession: ReturnType<typeof vi.fn>
  deleteSession: ReturnType<typeof vi.fn>
  renameSession: ReturnType<typeof vi.fn>
  forkSession: ReturnType<typeof vi.fn>
  requestRecap: ReturnType<typeof vi.fn>
  askBtw: ReturnType<typeof vi.fn>
  openSessionInfo: ReturnType<typeof vi.fn>
  sessionInfoOpen?: boolean
  openContext: ReturnType<typeof vi.fn>
  togglePlanMode: ReturnType<typeof vi.fn>
  openPlanViewer: ReturnType<typeof vi.fn>
  planViewerOpen?: boolean
  planMode: boolean
  permissionMode?: string
  todos?: Array<Record<string, unknown>>
  toggleTimestamps: ReturnType<typeof vi.fn>
  setAlwaysApproveMode: ReturnType<typeof vi.fn>
  setAutoMode: ReturnType<typeof vi.fn>
  resetPermissions: ReturnType<typeof vi.fn>
  goalStatus: ReturnType<typeof vi.fn>
  goalPause: ReturnType<typeof vi.fn>
  goalResume: ReturnType<typeof vi.fn>
  goalClear: ReturnType<typeof vi.fn>
  goalSet: ReturnType<typeof vi.fn>
  openMemory: ReturnType<typeof vi.fn>
  memoryFlush: ReturnType<typeof vi.fn>
  rememberNote: ReturnType<typeof vi.fn>
  workflowRuns: Record<
    string,
    { runId: string; name: string; status?: string; script?: string }
  >
  workflowControl: ReturnType<typeof vi.fn>
  saveWorkflowScript: ReturnType<typeof vi.fn>
}

let fake: FakeChat

beforeEach(() => {
  fake = {
    models: [],
    modelName: '',
    conn: 'idle',
    sessionId: 's1',
    cwd: '/tmp',
    sessionTitle: 'My Session',
    entries: [],
    agentCommands: [],
    appendLocalEntry: vi.fn(),
    send: vi.fn(() => Promise.resolve()),
    setModel: vi.fn(() => Promise.resolve()),
    setState: null,
    openExtensions: vi.fn(),
    openSettings: vi.fn(),
    setWorkflowPanelOpen: vi.fn(),
    openHistory: vi.fn(),
    newSession: vi.fn(),
    openRewind: vi.fn(),
    compactSession: vi.fn(),
    deleteSession: vi.fn(),
    renameSession: vi.fn(),
    forkSession: vi.fn(),
    requestRecap: vi.fn(),
    askBtw: vi.fn(),
    sessionInfoOpen: false,
    // 真实 store 里 openSessionInfo 就是置 sessionInfoOpen；fake 同步语义。
    openSessionInfo: vi.fn(() => {
      fake.sessionInfoOpen = true
    }),
    openContext: vi.fn(),
    togglePlanMode: vi.fn(),
    openPlanViewer: vi.fn(() => {
      fake.planViewerOpen = true
    }),
    planMode: false,
    todos: [],
    toggleTimestamps: vi.fn(),
    setAlwaysApproveMode: vi.fn(),
    setAutoMode: vi.fn(),
    resetPermissions: vi.fn(),
    goalStatus: vi.fn(),
    goalPause: vi.fn(),
    goalResume: vi.fn(),
    goalClear: vi.fn(),
    goalSet: vi.fn(),
    openMemory: vi.fn(),
    memoryFlush: vi.fn(),
    rememberNote: vi.fn(),
    workflowRuns: {},
    workflowControl: vi.fn(),
    saveWorkflowScript: vi.fn(() => Promise.resolve()),
  } as FakeChat
  vi.mocked(useChatStore.getState).mockReturnValue(fake as never)
  // registry 的 status() 走 setState；让 setState 真实写入 fake
  vi.mocked(useChatStore.setState).mockImplementation((partial) => {
    Object.assign(fake, partial as unknown as Record<string, unknown>)
    return fake as never
  })
  vi.mocked(usePromptQueue.getState).mockReturnValue({
    enqueue: vi.fn(),
  } as never)
  window.localStorage.clear()
})

afterEach(() => {
  registerModelMenuOpener(null)
  registerMcpPanelOpener(null)
})

const run = (name: string, args = '') => {
  const cmd = slashCommands.find((c) => c.name === name)
  if (!cmd) throw new Error(`no command ${name}`)
  return cmd.run(args)
}

const chat = () => fake

describe('matchSlash', () => {
  it('非 / 开头 / 空 name → null', () => {
    expect(matchSlash('hello')).toBeNull()
    expect(matchSlash('/')).toBeNull()
    expect(matchSlash('  /  ')).toBeNull()
  })

  it('name / alias 精确匹配（大小写不敏感），args 提取', () => {
    const m = matchSlash('/model  grok-3 ')
    expect(m?.cmd.name).toBe('model')
    expect(m?.args).toBe('grok-3')
    expect(matchSlash('/CLEAR')?.cmd.name).toBe('new')
    expect(matchSlash('/unknown x')).toBeNull()
  })

  it('agent 命令也可匹配', () => {
    fake.agentCommands = [{ name: 'deploy', description: 'deploy' }]
    expect(matchSlash('/deploy --env prod')?.cmd.source).toBe('agent')
  })

  it('\\/ 转义行不是命令', () => {
    expect(matchSlash('\\/clear')).toBeNull()
  })
})

describe('\\/ 字面量斜杠转义', () => {
  it('isSlashEscaped：只有 trimStart 后以 \\/ 开头才算', () => {
    expect(isSlashEscaped('\\/clear')).toBe(true)
    expect(isSlashEscaped('  \\/etc/hosts')).toBe(true)
    expect(isSlashEscaped('/clear')).toBe(false)
    expect(isSlashEscaped('a \\/b')).toBe(false)
    expect(isSlashEscaped('')).toBe(false)
  })

  it('unescapeSlash 只去掉行首那一个反斜杠', () => {
    expect(unescapeSlash('\\/clear all')).toBe('/clear all')
    expect(unescapeSlash('  \\/x')).toBe('  /x')
    // 未转义（含普通文本、已发出的原文）原样返回
    expect(unescapeSlash('/clear')).toBe('/clear')
    expect(unescapeSlash('hello')).toBe('hello')
    expect(unescapeSlash('a \\/b')).toBe('a \\/b')
  })

  it('escapeSlash：幂等，且历史回填后再次 Enter 仍是原文', () => {
    expect(escapeSlash('/clear')).toBe('\\/clear')
    expect(escapeSlash('\\/clear')).toBe('\\/clear')
    expect(escapeSlash('hello')).toBe('hello')
    expect(escapeSlash('  /x')).toBe('\\/x')
    // 往返：转义 → 发送 → 记历史 → 回填 → 再发送，命令永不被触发
    const sent = unescapeSlash('\\/tmp/log 报错是什么')
    expect(sent).toBe('/tmp/log 报错是什么')
    const recalled = escapeSlash(sent)
    expect(isSlashEscaped(recalled)).toBe(true)
    expect(matchSlash(recalled)).toBeNull()
    expect(unescapeSlash(recalled)).toBe(sent)
  })
})

describe('原文发送判定（\\/ 与行首空格两种写法等价）', () => {
  it('isSlashLiteral：\\/ 或前导空白 + / 才算，普通草稿不受影响', () => {
    expect(isSlashLiteral('\\/clear')).toBe(true)
    expect(isSlashLiteral(' /clear all')).toBe(true)
    expect(isSlashLiteral('   /x')).toBe(true)
    expect(isSlashLiteral('  \\/x')).toBe(true)
    // 首字符就是 / → 走命令路径
    expect(isSlashLiteral('/clear')).toBe(false)
    // 不以 / 结尾于 trimStart 之后 → 不是原文写法
    expect(isSlashLiteral('hello')).toBe(false)
    expect(isSlashLiteral('  hello')).toBe(false)
    expect(isSlashLiteral('')).toBe(false)
  })

  it('literalSlashPayload：剥掉前缀，未命中命令的 /… 行原样保留', () => {
    expect(literalSlashPayload('\\/clear')).toBe('/clear')
    expect(literalSlashPayload(' /clear all')).toBe('/clear all')
    expect(literalSlashPayload('  \\/x')).toBe('/x')
    // 未知命令行 FE 放行：文本本身不动
    expect(literalSlashPayload('/tmp/log 是什么')).toBe('/tmp/log 是什么')
    // 普通消息（含前导空白）保持原样
    expect(literalSlashPayload('hello')).toBe('hello')
    expect(literalSlashPayload('  hello')).toBe('  hello')
  })
})

describe('mergedSlashCommands', () => {
  it('无 agent 命令 → 本地列表内容一致（skills 仍会追加，不再返回同一引用）', () => {
    const merged = mergedSlashCommands([])
    for (const c of slashCommands) {
      expect(merged.find((m) => m.name === c.name)).toBe(c)
    }
  })

  it('agent 命令追加；与本地名/别名冲突时跳过', () => {
    const merged = mergedSlashCommands([
      { name: 'deploy', description: 'Deploy app', argHint: '[env]' },
      { name: 'model', description: 'collides-local' },
      { name: 'clear', description: 'collides-alias' },
      { name: '  ', description: 'blank' },
    ])
    expect(merged).toHaveLength(slashCommands.length + 1)
    const deploy = merged.find((c) => c.name === 'deploy')
    expect(deploy).toMatchObject({ name: 'deploy', description: 'Deploy app', argHint: '[env]', source: 'agent' })
    expect(merged.filter((c) => c.name === 'model')).toHaveLength(1)
  })

  it('agent run 以原始 /name args 作为提示词发送', () => {
    fake.agentCommands = [{ name: 'deploy', description: 'd' }]
    const merged = mergedSlashCommands()
    const deploy = merged.find((c) => c.name === 'deploy')!
    deploy.run('--env prod')
    expect(fake.send).toHaveBeenCalledWith('/deploy --env prod')
    deploy.run('')
    expect(fake.send).toHaveBeenCalledWith('/deploy')
  })
})

describe('filterSlashCommands', () => {
  it('空查询 → 全部 score 0', () => {
    const out = filterSlashCommands('/')
    expect(out.length).toBe(slashCommands.length)
    expect(out.every((m) => m.score === 0)).toBe(true)
  })

  it('name 前缀 < name 包含 < alias 前缀 < alias 包含 < description', () => {
    const byName = filterSlashCommands('/model').find((m) => m.cmd.name === 'model')!
    const byDesc = filterSlashCommands('/记').find((m) => m.cmd.name === 'remember')
    expect(byName.score).toBe(0)
    expect(byDesc?.score).toBe(4)
  })

  it('排序稳定：同 rank 按 name localeCompare', () => {
    const out = filterSlashCommands('/n')
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].score <= out[i].score).toBe(true)
    }
  })
})

describe('slash command runs — 会话类', () => {
  it('/new /resume /compact /rewind /fork /recap /session-info /context /plan /timestamps /settings /flush', () => {
    run('new')
    expect(fake.newSession).toHaveBeenCalled()
    run('resume')
    expect(fake.openHistory).toHaveBeenCalled()
    run('compact', 'note here')
    expect(fake.compactSession).toHaveBeenCalledWith('note here')
    run('rewind')
    expect(fake.openRewind).toHaveBeenCalled()
    run('fork')
    expect(fake.forkSession).toHaveBeenCalled()
    run('recap')
    expect(fake.requestRecap).toHaveBeenCalled()
    run('session-info')
    expect(fake.openSessionInfo).toHaveBeenCalled()
    expect(fake.sessionInfoOpen).toBe(true)
    run('context')
    expect(fake.openContext).toHaveBeenCalled()
    run('plan')
    expect(fake.togglePlanMode).toHaveBeenCalled()
    run('timestamps')
    expect(fake.toggleTimestamps).toHaveBeenCalled()
    run('settings')
    expect(fake.openSettings).toHaveBeenCalled()
    run('flush')
    expect(fake.memoryFlush).toHaveBeenCalled()
  })

  it('/view-plan（含别名 show-plan / plan-view）：有会话即打开弹窗，无会话提示', () => {
    // 有会话就打开：plan 正文由弹窗自己按优先级取（host plan.md → 审批
    // 请求 → 滚动区工具输出），命令层不预设「有没有 plan」——TUI 也是先
    // 开预览再报 no plan。
    run('view-plan')
    expect(fake.openPlanViewer).toHaveBeenCalledTimes(1)
    expect(fake.planViewerOpen).toBe(true)
    expect(fake.appendLocalEntry).not.toHaveBeenCalled()
    // 无活动会话 → 提示（/rename /delete 同款写法）。
    fake.sessionId = null
    run('view-plan')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({
      kind: 'error',
      text: '查看失败: 无活动会话',
    })
    expect(fake.openPlanViewer).toHaveBeenCalledTimes(1)
    // 别名同语义（run() helper 只认 c.name，别名走 matchSlash 解析）。
    fake.sessionId = 's1'
    const aliasRun = (alias: string) => {
      const m = matchSlash(`/${alias}`)
      if (!m) throw new Error(`no alias ${alias}`)
      m.cmd.run(m.args)
    }
    aliasRun('show-plan')
    expect(fake.openPlanViewer).toHaveBeenCalledTimes(2)
    aliasRun('plan-view')
    expect(fake.openPlanViewer).toHaveBeenCalledTimes(3)
    run('view-plan')
    expect(fake.openPlanViewer).toHaveBeenCalledTimes(4)
  })

  it('/plan 已进入 plan 模式 → 提示用 /view-plan（TUI modes.rs 对齐），不改切换语义', () => {
    fake.planMode = true
    run('plan')
    expect(fake.togglePlanMode).not.toHaveBeenCalled()
    expect(fake.statusText).toBe('已在 plan 模式，用 /view-plan 查看当前 plan')
    // plan·auto / plan·always 叠加态（permissionMode==='plan'）同样视为已进入。
    fake.planMode = false
    fake.permissionMode = 'plan'
    run('plan')
    expect(fake.togglePlanMode).not.toHaveBeenCalled()
    // 未进入 → 照常切换。
    fake.permissionMode = undefined
    run('plan')
    expect(fake.togglePlanMode).toHaveBeenCalledTimes(1)
  })

  it('/fork 参数（TUI parse_fork_args 对齐）：--worktree / --no-worktree / 互斥 / directive 拒绝', () => {
    run('fork', '')
    expect(fake.forkSession).toHaveBeenLastCalledWith({})
    run('fork', '--worktree')
    expect(fake.forkSession).toHaveBeenLastCalledWith({ worktree: true })
    run('fork', '  --no-worktree  ')
    expect(fake.forkSession).toHaveBeenLastCalledWith({ worktree: false })
    const callsBefore = fake.forkSession.mock.calls.length
    run('fork', '--worktree --no-worktree')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', text: expect.stringContaining('互斥') }),
    )
    run('fork', '--worktree --worktree')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', text: expect.stringContaining('重复') }),
    )
    // 未知 bareword 视作 directive 开头（TUI 语义），FE 无首条提示通道 → 拒绝。
    run('fork', 'investigate the bug')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', text: expect.stringContaining('首条提示') }),
    )
    expect(fake.forkSession.mock.calls.length).toBe(callsBefore)
  })

  it('扩展命令 /hooks /plugins /skills /marketplace', () => {
    run('hooks')
    expect(fake.openExtensions).toHaveBeenCalledWith('hooks')
    run('plugins')
    expect(fake.openExtensions).toHaveBeenCalledWith('plugins')
    run('skills')
    expect(fake.openExtensions).toHaveBeenCalledWith('skills')
    run('marketplace')
    expect(fake.openExtensions).toHaveBeenCalledWith('marketplace')
  })

  it('/workflows → 扩展面板的 workflows tab（目录浏览），不再是运行面板', () => {
    run('workflows')
    expect(fake.openExtensions).toHaveBeenCalledWith('workflows')
    expect(fake.setWorkflowPanelOpen).not.toHaveBeenCalled()
  })
})

describe('slash command runs — /workflow（单数，TUI workflow.rs + shell resolve 对齐）', () => {
  const runs = {
    wf_1: { runId: 'wf_1', name: 'deep research', status: 'running' },
  }

  it('/workflow runs 打开运行面板（大小写不敏感）；runs 带参数不拦截', () => {
    run('workflow', 'runs')
    expect(fake.setWorkflowPanelOpen).toHaveBeenCalledWith(true)
    run('workflow', 'RUNS')
    expect(fake.setWorkflowPanelOpen).toHaveBeenCalledTimes(2)
    fake.setWorkflowPanelOpen.mockClear()
    // 带附加参数的 runs 是名为 runs 的 workflow 的 launch（shell 语义）。
    run('workflow', 'runs extra')
    expect(fake.setWorkflowPanelOpen).not.toHaveBeenCalled()
    expect(fake.send).toHaveBeenCalledWith('/workflow runs extra')
  })

  it('manage op（前置，按 runId 或名称，大小写不敏感）→ workflowControl', () => {
    fake.workflowRuns = runs
    run('workflow', 'pause wf_1')
    expect(fake.workflowControl).toHaveBeenCalledWith('wf_1', 'pause')
    run('workflow', 'RESUME deep research')
    expect(fake.workflowControl).toHaveBeenCalledWith('wf_1', 'resume')
    run('workflow', 'stop wf_1')
    expect(fake.workflowControl).toHaveBeenCalledWith('wf_1', 'stop')
    expect(fake.send).not.toHaveBeenCalled()
  })

  it('manage op 倒序形式 `/workflow <run> pause`（shell second_is_final_op）', () => {
    fake.workflowRuns = runs
    run('workflow', 'wf_1 pause')
    expect(fake.workflowControl).toHaveBeenCalledWith('wf_1', 'pause')
    // 三个 token 不构成倒序管理（仍是 launch 透传）。
    run('workflow', 'wf_1 pause x')
    expect(fake.send).toHaveBeenCalledWith('/workflow wf_1 pause x')
  })

  it('/workflow save <run> → 保存脚本（复用面板的 saveWorkflowScript）', () => {
    fake.workflowRuns = runs
    run('workflow', 'save wf_1')
    expect(fake.saveWorkflowScript).toHaveBeenCalledWith('wf_1')
  })

  it('管理 op 缺 handle / 未知 handle → 中文提示，不猜 run', () => {
    run('workflow', 'pause')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', text: expect.stringContaining('用法: /workflow') }),
    )
    expect(fake.workflowControl).not.toHaveBeenCalled()
    // 有运行但 handle 未知 → 提示 + 列出当前运行。
    fake.workflowRuns = runs
    fake.appendLocalEntry.mockClear()
    run('workflow', 'pause unknown-x')
    expect(fake.workflowControl).not.toHaveBeenCalled()
    expect(fake.appendLocalEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'error',
        text: expect.stringContaining('未找到工作流运行「unknown-x」'),
      }),
    )
  })

  it('launch 与裸调用原样透传（断言发出的文本）', () => {
    run('workflow', 'deep-research foo')
    expect(fake.send).toHaveBeenCalledWith('/workflow deep-research foo')
    run('workflow', 'deep-research rust pitfalls --agent-budget 4')
    expect(fake.send).toHaveBeenCalledWith(
      '/workflow deep-research rust pitfalls --agent-budget 4',
    )
    // 裸调用：透传让 shell 给文本概览（TUI PassThrough("/workflow")）。
    run('workflow', '')
    expect(fake.send).toHaveBeenCalledWith('/workflow')
  })
})

describe('slash command runs — /model', () => {
  it('无参 → 打开模型菜单（注册的 opener）', () => {
    const opener = vi.fn()
    registerModelMenuOpener(opener)
    run('model')
    expect(opener).toHaveBeenCalled()
  })

  it('精确/包含匹配 → setModel（默认 effort）', () => {
    fake.models = [
      { modelId: 'grok-3', name: 'Grok 3', reasoningEfforts: [{ value: 'high', default: true }, { value: 'low' }] },
      { modelId: 'grok-4', name: 'Grok 4' },
    ]
    run('model', 'grok-3')
    expect(fake.setModel).toHaveBeenCalledWith('grok-3', 'high')

    fake.setModel.mockClear()
    run('model', 'GROK 4')
    expect(fake.setModel).toHaveBeenCalledWith('grok-4', undefined)

    fake.setModel.mockClear()
    run('model', '4') // 包含匹配
    expect(fake.setModel).toHaveBeenCalledWith('grok-4', undefined)
  })

  it('链式两 token（`<名字> <强度>`）→ 用该档位切换', () => {
    fake.models = [
      { modelId: 'm1', name: 'M1', reasoningEfforts: [{ id: 'low', value: 'low' }, { id: 'high', value: 'high' }] },
      { modelId: 'm2', name: 'M2' },
    ]
    run('model', 'M1 high')
    expect(fake.setModel).toHaveBeenCalledWith('m1', 'high')
    fake.setModel.mockClear()
    run('model', 'M1 insane')
    expect(fake.setModel).not.toHaveBeenCalled()
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({
      kind: 'error',
      text: expect.stringContaining('不支持强度'),
    })
    fake.appendLocalEntry.mockClear()
    // 名字里带空格时整串精确匹配优先，不会被拆成 `<短名> <强度>`
    fake.models = [
      { modelId: 'm1', name: 'M1', reasoningEfforts: [{ id: 'low', value: 'low' }] },
      { modelId: 'm1p', name: 'M1 high', reasoningEfforts: [{ id: 'low', value: 'low' }] },
    ]
    fake.setModel.mockClear()
    run('model', 'M1 high')
    expect(fake.setModel).toHaveBeenCalledWith('m1p', 'low')
  })

  it('未找到 → error 行（有/无可用模型）', () => {
    run('model', 'nope')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({
      kind: 'error',
      text: expect.stringContaining('暂无可用模型'),
    })

    fake.models = [{ modelId: 'a', name: 'A' }]
    fake.appendLocalEntry.mockClear()
    run('model', 'nope')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({
      kind: 'error',
      text: expect.stringContaining('可用: a'),
    })
  })
})

describe('slash command runs — /effort', () => {
  const withModel = () => {
    fake.modelName = 'grok-3'
    fake.models = [
      { modelId: 'grok-3', name: 'Grok 3', reasoningEfforts: [{ id: 'high', value: 'high' }, { id: 'low', value: 'low' }] },
    ]
  }

  it('无参 / 非法强度 → 用法错误', () => {
    run('effort')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({ kind: 'error', text: expect.stringContaining('用法') })
    run('effort', 'insane')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({ kind: 'error', text: expect.stringContaining('无效强度') })
  })

  it('无法确定当前模型 → 错误', () => {
    run('effort', 'high')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({ kind: 'error', text: expect.stringContaining('无法确定当前模型') })
  })

  it('模型不支持该强度 → 提示可选；支持 → setModel', () => {
    withModel()
    run('effort', 'xhigh')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({ kind: 'error', text: expect.stringContaining('不支持强度') })

    fake.appendLocalEntry.mockClear()
    run('effort', 'low')
    expect(fake.setModel).toHaveBeenCalledWith('grok-3', 'low')
    expect(fake.appendLocalEntry).not.toHaveBeenCalled()
  })
})

describe('slash command runs — /theme', () => {
  it('无参 → 循环到下一个主题并提示', () => {
    run('theme')
    expect(window.localStorage.getItem('capri-fe.theme')).toBe('grokday')
    expect(chat().statusText).toBe('主题: grokday')
  })

  it('按 id / name 匹配', () => {
    run('theme', 'tokyonight')
    expect(window.localStorage.getItem('capri-fe.theme')).toBe('tokyonight')
    run('theme', 'rose pine')
    expect(window.localStorage.getItem('capri-fe.theme')).toBe('rosepine-moon')
  })

  it('未找到 → 错误行', () => {
    run('theme', 'vaporwave')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({ kind: 'error', text: expect.stringContaining('未找到主题') })
  })
})

describe('slash command runs — /delete /rename', () => {
  it('/delete：无活动会话报错；confirm 拒绝不删', () => {
    fake.sessionId = null
    run('delete')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({ kind: 'error', text: expect.stringContaining('无活动会话') })

    fake.sessionId = 's1'
    const confirm = vi.spyOn(window, 'confirm')
    confirm.mockReturnValue(false)
    fake.appendLocalEntry.mockClear()
    run('delete')
    expect(fake.deleteSession).not.toHaveBeenCalled()

    confirm.mockReturnValue(true)
    run('delete')
    expect(fake.deleteSession).toHaveBeenCalledWith('s1', '/tmp')
    confirm.mockRestore()
  })

  it('/rename：无会话报错；无参 → prompt；有参直接改', () => {
    fake.sessionId = null
    run('rename', 'x')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({ kind: 'error', text: expect.stringContaining('无活动会话') })

    fake.sessionId = 's1'
    const prompt = vi.spyOn(window, 'prompt')
    prompt.mockReturnValue('新标题')
    fake.appendLocalEntry.mockClear()
    run('rename')
    expect(fake.renameSession).toHaveBeenCalledWith('新标题')

    prompt.mockReturnValue(null)
    fake.renameSession.mockClear()
    run('rename')
    expect(fake.renameSession).not.toHaveBeenCalled()

    run('rename', '直接改名')
    expect(fake.renameSession).toHaveBeenCalledWith('直接改名')
    prompt.mockRestore()
  })
})

describe('slash command runs — /loop', () => {
  it('无参数 → 用法错误，不发请求', () => {
    run('loop')
    run('loop', '   ')
    expect(fake.appendLocalEntry).toHaveBeenCalledTimes(2)
    expect(fake.send).not.toHaveBeenCalled()
  })

  it('原文透传：有参数 → 发送 /loop <args> 原文（busy 排队 / 空闲直发）', () => {
    fake.conn = 'busy'
    fake.sessionId = 's2'
    run('loop', '5m 检查测试状态')
    const q = vi.mocked(usePromptQueue.getState)()
    expect(q.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ text: '/loop 5m 检查测试状态' }),
      's2',
    )

    fake.conn = 'idle'
    run('loop', '1h 汇报')
    expect(fake.send).toHaveBeenCalledWith('/loop 1h 汇报')
  })

  it('回执：leading interval → 「每 n 单位 · prompt」；否则「调度中…」占位', () => {
    run('loop', '5m 检查测试状态')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({
      kind: 'session_event',
      text: expect.stringContaining('已请求定时任务：每 5 分钟 · 检查测试状态'),
    })

    fake.appendLocalEntry.mockClear()
    run('loop', '每 30 分钟检查一次')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({
      kind: 'session_event',
      text: expect.stringContaining('已请求定时任务：调度中…'),
    })
  })

  it('非 interval 首 token / 裸 interval / 零值 / 坏后缀 → 不当错误，整串透传', () => {
    fake.send.mockClear()
    for (const args of ['每 30 分钟检查一次', '5m', '0m 检查', '5x 检查']) {
      run('loop', args)
      expect(fake.send).toHaveBeenCalledWith(`/loop ${args}`)
      fake.send.mockClear()
    }
  })
})

describe('slash command runs — /btw', () => {
  it('无参数 → 用法错误，不发请求', () => {
    run('btw')
    run('btw', '   ')
    expect(fake.appendLocalEntry).toHaveBeenCalledTimes(2)
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({
      kind: 'error',
      text: expect.stringContaining('用法'),
    })
    expect(fake.askBtw).not.toHaveBeenCalled()
  })

  it('有参数 → 调 askBtw（store 直发 x.ai/btw 并带当前 sessionId）', () => {
    run('btw', '还有多少步完成？')
    expect(fake.askBtw).toHaveBeenCalledWith('还有多少步完成？')
  })

  it('busy（回合进行中）也必须照常发出——不走 sendPrompt 排队分支、不进 prompt 队列', () => {
    fake.conn = 'busy'
    fake.sessionId = 's2'
    run('btw', '当前回合还剩几步')
    expect(fake.askBtw).toHaveBeenCalledWith('当前回合还剩几步')
    const q = vi.mocked(usePromptQueue.getState)()
    expect(q.enqueue).not.toHaveBeenCalled()
    expect(fake.send).not.toHaveBeenCalled()
  })
})

describe('slash command runs — /copy', () => {
  it('无助手回复 → 错误', async () => {
    fake.entries = [{ id: '1', kind: 'user', text: 'q' }]
    await run('copy')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({ kind: 'error', text: '没有可复制的助手回复' })
  })

  it('复制最近回复；失败 → status', async () => {
    fake.entries = [
      { id: '1', kind: 'assistant', text: '  ' },
      { id: '2', kind: 'assistant', text: 'hello world' },
    ]
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    writeText.mockResolvedValue(undefined)
    await run('copy')
    expect(writeText).toHaveBeenCalledWith('hello world')
    expect(chat().statusText).toContain('已复制')

    writeText.mockRejectedValue(new Error('denied'))
    await run('copy')
    expect(chat().statusText).toBe('复制失败: denied')
  })
})

describe('slash command runs — /export', () => {
  const writeText = vi.fn()
  let appendSpy: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(() => {
    writeText.mockReset()
    writeText.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:mock'),
      configurable: true,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: vi.fn(),
      configurable: true,
    })
    // 默认 callThrough：append 照常发生，spy 记录 calls 供断言取 <a>
    // 引用（click 后立即 remove，querySelector 已不可见）。
    appendSpy = vi.spyOn(document.body, 'appendChild')
  })

  afterEach(() => {
    appendSpy?.mockRestore()
  })

  it('无活动会话 → 错误，剪贴板不触发', async () => {
    fake.sessionId = null
    await run('export')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({
      kind: 'error',
      text: '没有可导出的会话',
    })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('无对话内容（只有 status 行）→ 错误', async () => {
    fake.entries = [{ id: '1', kind: 'status', text: 'ready' }]
    await run('export')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({
      kind: 'error',
      text: '没有可导出的对话内容',
    })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('无参数 → 整段转录复制到剪贴板（带未加载历史提示）；失败 → status', async () => {
    fake.entries = [
      { id: '1', kind: 'user', text: '问' },
      { id: '2', kind: 'assistant', text: '答' },
    ]
    fake.historyLoadedStart = 3
    await run('export')
    expect(writeText).toHaveBeenCalledTimes(1)
    const md = writeText.mock.calls[0][0] as string
    expect(md).toContain('## User')
    expect(md).toContain('## Assistant')
    expect(md).toContain('*注：') // 未加载历史提示行
    expect(chat().statusText).toContain('已复制会话转录到剪贴板')

    writeText.mockRejectedValue(new Error('denied'))
    await run('export')
    expect(chat().statusText).toBe('复制失败: denied')
  })

  it('有参数 → Blob 下载 + 文件名安全化 + 及时 revoke', async () => {
    fake.entries = [
      { id: '1', kind: 'user', text: '问' },
      { id: '2', kind: 'assistant', text: '答' },
    ]
    await run('export', '../会话记录.txt')
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    const blob = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob
    expect(blob.type).toBe('text/markdown;charset=utf-8')
    const anchor = appendSpy!.mock.calls[0][0] as HTMLAnchorElement
    expect(anchor.download).toBe('__会话记录.txt.md')
    expect(anchor.href).toBe('blob:mock')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock')
    expect(chat().statusText).toContain('已导出为')
  })
})

describe('slash command runs — /multiline', () => {
  it('on/off/toggle + 持久化与状态提示', () => {
    expect(isMultilineEnabled()).toBe(false)
    run('multiline', 'on')
    expect(isMultilineEnabled()).toBe(true)
    expect(chat().statusText).toContain('开')
    run('multiline', 'OFF')
    expect(isMultilineEnabled()).toBe(false)
    run('multiline', '')
    expect(isMultilineEnabled()).toBe(true) // 切换回开
  })
})

describe('slash command runs — /goal', () => {
  it('无参 / status → goalStatus；pause / resume / clear', () => {
    run('goal')
    expect(fake.goalStatus).toHaveBeenCalled()
    run('goal', 'status')
    expect(fake.goalStatus).toHaveBeenCalledTimes(2)
    run('goal', 'pause')
    expect(fake.goalPause).toHaveBeenCalled()
    run('goal', 'resume')
    expect(fake.goalResume).toHaveBeenCalled()
    run('goal', 'clear')
    expect(fake.goalClear).toHaveBeenCalled()
  })

  it('目标描述 + budget 解析（剥离后单独传参；K/M 后缀换算）', () => {
    run('goal', 'ship the release --budget 2M')
    expect(fake.goalSet).toHaveBeenCalledWith('ship the release', 2000000)
    run('goal', 'fix tests --budget 500k')
    expect(fake.goalSet).toHaveBeenCalledWith('fix tests', 500000)
    run('goal', 'plain goal')
    expect(fake.goalSet).toHaveBeenCalledWith('plain goal', undefined)
  })

  it('只有 budget 没有描述 → 用法错误', () => {
    run('goal', '--budget 100')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({ kind: 'error', text: expect.stringContaining('用法') })
  })
})

describe('parseBudgetTokens', () => {
  it('裸数字 / K / M 后缀，大小写不敏感', () => {
    expect(parseBudgetTokens('500000')).toBe(500000)
    expect(parseBudgetTokens('500k')).toBe(500000)
    expect(parseBudgetTokens('2M')).toBe(2000000)
    expect(parseBudgetTokens('1.5k')).toBe(1500)
    expect(parseBudgetTokens(' 12k ')).toBe(12000)
  })

  it('非法值 → undefined（不把 NaN 传给 host）', () => {
    expect(parseBudgetTokens('abc')).toBeUndefined()
    expect(parseBudgetTokens('2X')).toBeUndefined()
    expect(parseBudgetTokens('-5')).toBeUndefined()
    expect(parseBudgetTokens('')).toBeUndefined()
  })
})

describe('slash command runs — /memory /remember /dream', () => {
  it('on/off 走 session 内置 slash；无参打开浏览', () => {
    run('memory', 'on')
    expect(fake.send).toHaveBeenCalledWith('/memory on')
    fake.send.mockClear()
    run('memory', 'off')
    expect(fake.send).toHaveBeenCalledWith('/memory off')
    run('memory')
    expect(fake.openMemory).toHaveBeenCalled()
  })

  it('/remember 无参报错；有参调 rememberNote（不再发中文提示词）', () => {
    run('remember')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({ kind: 'error', text: expect.stringContaining('用法') })
    run('remember', '部署用 eu-west')
    expect(fake.rememberNote).toHaveBeenCalledWith('部署用 eu-west')
    expect(fake.send).not.toHaveBeenCalled()
  })

  it('/dream 走 session 内置 slash 命令', () => {
    run('dream')
    expect(fake.send).toHaveBeenCalledWith('/dream')
  })
})

describe('slash command runs — 模式与 MCP', () => {
  it('/always /auto /permissions-reset /mcps', () => {
    run('always')
    expect(fake.setAlwaysApproveMode).toHaveBeenCalled()
    run('auto')
    expect(fake.setAutoMode).toHaveBeenCalled()
    run('permissions-reset')
    expect(fake.resetPermissions).toHaveBeenCalled()
    const opener = vi.fn()
    registerMcpPanelOpener(opener)
    run('mcps')
    expect(opener).toHaveBeenCalled()
    registerMcpPanelOpener(null)
    run('mcps')
  })
})

describe('/help', () => {
  it('列出全部命令（含别名与 argHint）', () => {
    run('help')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({
      kind: 'session_event',
      text: expect.stringContaining('/new / /clear'),
    })
  })
})
describe('slash 菜单 recency + skills 分组（TUI 1.0.9 对齐）', () => {
  it('skills 追加在 agent 命令之后，source 为 skill；与已有名冲突时跳过', () => {
    setCachedSkills([
      { name: 'zskill', scope: 'project' },
      { name: 'deploy' }, // 与上面用例注入的 agent 命令无关，但可能与本地冲突
      { name: 'model' }, // 与本地命令冲突 → 跳过
    ])
    const merged = mergedSlashCommands([{ name: 'deploy', description: 'd' }])
    const skill = merged.find((c) => c.name === 'zskill')
    expect(skill).toMatchObject({ name: 'zskill', source: 'skill' })
    expect(merged.filter((c) => c.name === 'model')).toHaveLength(1)
    expect(merged.filter((c) => c.name === 'deploy')).toHaveLength(1)
    // skills 在 agent 命令之后
    expect(merged.findIndex((c) => c.name === 'zskill')).toBeGreaterThan(
      merged.findIndex((c) => c.name === 'deploy'),
    )
    skill!.run('arg')
    expect(fake.send).toHaveBeenCalledWith('/zskill arg')
    setCachedSkills([])
  })

  it('bare / 菜单：最近使用的命令排前，skills 沉底并按字母序', () => {
    setCachedSkills([
      { name: 'zskill' },
      { name: 'askill' },
    ])
    bumpSlashRecency('model')
    const rows = filterSlashCommands('/')
    const names = rows.map((r) => r.cmd.name)
    const modelIdx = names.indexOf('model')
    const settingsIdx = names.indexOf('settings')
    expect(modelIdx).toBeGreaterThan(-1)
    // 用过的 model 排在未用的 settings 之前（同组内 recency 优先）
    expect(modelIdx).toBeLessThan(settingsIdx)
    // skills 在所有命令之后，且按字母序
    const aIdx = names.indexOf('askill')
    const zIdx = names.indexOf('zskill')
    expect(aIdx).toBeGreaterThan(settingsIdx)
    expect(zIdx).toBeGreaterThan(aIdx)
    setCachedSkills([])
  })
})

describe('parseSlashLine（参数阶段的行切分）', () => {
  it('无分隔符 → inCommand，argsStart 落在行尾', () => {
    const p = parseSlashLine('/effort')
    expect(p?.cmd.name).toBe('effort')
    expect(p?.inCommand).toBe(true)
    expect(p?.args).toBe('')
    expect(p?.argsStart).toBe(7)
  })

  it('有分隔符 → 给出参数文本与其起始下标（含多空格）', () => {
    const p = parseSlashLine('/effort   high')
    expect(p?.inCommand).toBe(false)
    expect(p?.args).toBe('high')
    expect(p?.argsStart).toBe(10)
  })

  it('别名与 agent 命令都解析；未知首词 / 非命令行为 null', () => {
    expect(parseSlashLine('/mem on')?.cmd.name).toBe('memory')
    fake.agentCommands = [{ name: 'deploy', description: 'd' }]
    expect(parseSlashLine('/deploy prod')?.cmd.name).toBe('deploy')
    fake.agentCommands = []
    expect(parseSlashLine('/nope x')).toBeNull()
    expect(parseSlashLine('hello')).toBeNull()
    expect(parseSlashLine('/')).toBeNull()
  })
})

describe('isSlashInvocationComplete（两位完备性模型）', () => {
  it('参数必需且为空 → 不完备（Enter 该补全而不是执行）', () => {
    expect(isSlashInvocationComplete('/effort')).toBe(false)
    expect(isSlashInvocationComplete('/effort ')).toBe(false)
    expect(isSlashInvocationComplete('/effort high')).toBe(true)
    expect(isSlashInvocationComplete('/model')).toBe(false)
    expect(isSlashInvocationComplete('/loop')).toBe(false)
    expect(isSlashInvocationComplete('/loop 5m')).toBe(true)
  })

  it('参数可选 / 无参命令 / 未知命令 → 完备', () => {
    expect(isSlashInvocationComplete('/theme')).toBe(true)
    expect(isSlashInvocationComplete('/new')).toBe(true)
    // compact 收参数但无候选列表，空参仍执行
    expect(isSlashInvocationComplete('/compact')).toBe(true)
    expect(isSlashInvocationComplete('/nope')).toBe(true)
  })
})

describe('filterSlashArgs（二级候选的过滤）', () => {
  it('命令阶段 / 无候选命令 / 未知命令 → 空', () => {
    expect(filterSlashArgs('/effort')).toEqual([])
    expect(filterSlashArgs('/compact x')).toEqual([])
    expect(filterSlashArgs('/nope x')).toEqual([])
  })

  it('空参数查询 → 按 builder 顺序全列', () => {
    const rows = filterSlashArgs('/memory ')
    expect(rows.map((r) => r.arg.insertText)).toEqual(['on', 'off'])
    expect(rows.every((r) => r.score === 0)).toBe(true)
  })

  it('前缀命中排在包含命中之前', () => {
    fake.models = [
      { modelId: 'm1', name: 'M1', reasoningEfforts: [{ id: 'low', value: 'low' }, { id: 'xhigh', value: 'xhigh' }] },
    ]
    fake.modelName = 'm1'
    expect(filterSlashArgs('/effort high').map((r) => r.arg.insertText)).toEqual(['xhigh'])
    expect(filterSlashArgs('/effort lo').map((r) => r.arg.insertText)).toEqual(['low'])
  })

  it('链式行的 matchText 带已输入的头部，整段参数仍能匹配', () => {
    fake.models = [{ modelId: 'm1', name: 'M1', reasoningEfforts: [{ id: 'high', value: 'high' }] }]
    fake.modelName = 'm1'
    const rows = filterSlashArgs('/model M1 hi')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.arg.insertText).toBe('M1 high')
  })
})

describe('suggestArgs — 各命令的候选来源', () => {
  const items = (line: string) => filterSlashArgs(line).map((r) => r.arg)
  const cmd = (name: string) => slashCommands.find((c) => c.name === name)

  it('/effort 用当前模型提供的档位，不是硬编码四级', () => {
    fake.models = [
      {
        modelId: 'm1',
        name: 'M1',
        reasoningEfforts: [
          { id: 'deep', label: 'Deep', value: 'xhigh', default: true },
          { id: 'low', label: 'Low', value: 'low' },
        ],
      },
    ]
    fake.modelName = 'm1'
    fake.reasoningEffort = 'low'
    const rows = cmd('effort')!.suggestArgs!('')
    expect(rows.map((r) => r.insertText)).toEqual(['xhigh', 'low'])
    expect(rows[1]?.display).toBe('Low (active)')
    expect(rows[0]?.description).toBe('默认档')
  })

  it('/effort 校验改走模型档位（id 不再被硬编码白名单拒掉）', () => {
    fake.models = [{ modelId: 'm1', name: 'M1', reasoningEfforts: [{ id: 'deep', value: 'xhigh' }] }]
    fake.modelName = 'm1'
    run('effort', 'xhigh')
    expect(fake.setModel).toHaveBeenCalledWith('m1', 'xhigh')
    fake.setModel.mockClear()
    run('effort', 'medium')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({
      kind: 'error',
      text: expect.stringContaining('不支持强度'),
    })
  })

  it('/model 先列模型，选中推理模型后转强度档', () => {
    fake.models = [
      { modelId: 'm1', name: 'M1', reasoningEfforts: [{ id: 'low', value: 'low' }, { id: 'high', value: 'high' }] },
      { modelId: 'm2', name: 'M2' },
    ]
    fake.modelName = 'm2'
    const first = items('/model ')
    expect(first.map((a) => a.insertText)).toEqual(['M1 ', 'M2'])
    expect(first[0]?.display).toBe('M1')
    expect(first[1]?.display).toBe('M2 (current)')
    expect(items('/model M1 ').map((a) => a.insertText)).toEqual(['M1 low', 'M1 high'])
    // 非推理模型不带尾空格 → 选中即执行
    expect(items('/model M2')[0]?.insertText).toBe('M2')
  })

  it('/theme auto 置顶并标 (active)', () => {
    useThemeStore.getState().setTheme('grokday')
    const rows = items('/theme ')
    expect(rows[0]?.insertText).toBe('auto')
    expect(rows.find((r) => r.display.includes('(active)'))?.insertText).toBe('grokday')
  })

  it('/rename 只在参数为空时给当前标题一条', () => {
    fake.sessionTitle = 'Fix Login Bug'
    expect(items('/rename ').map((a) => a.insertText)).toEqual(['Fix Login Bug'])
    expect(items('/rename Fix L')).toEqual([])
    fake.sessionTitle = null
    expect(items('/rename ')).toEqual([])
  })

  it('/fork 与 /multiline /memory 给封闭集合', () => {
    expect(items('/fork ').map((a) => a.insertText)).toEqual(['--worktree', '--no-worktree'])
    expect(items('/multiline ').map((a) => a.insertText)).toEqual(['on', 'off'])
    expect(items('/goal ').map((a) => a.insertText)).toEqual([
      'status',
      'pause',
      'resume',
      'clear',
    ])
  })

  it('/loop 间隔候选带尾空格（正文接着打）', () => {
    const rows = items('/loop ')
    expect(rows.length).toBeGreaterThan(3)
    expect(rows.every((r) => r.insertText.endsWith(' '))).toBe(true)
    expect(rows[1]?.insertText).toBe('5m ')
    expect(rows[1]?.description).toBe('5 分钟')
    // 已经有第二个 token 就不再列间隔
    expect(items('/loop 5m 检查')).toEqual([])
  })

  it('/workflow 三层：动词+目录 → 该动词可作用的 run → launch 旗标', () => {
    setCachedWorkflows([
      { name: 'review-pr', description: '审 PR', source: 'file' },
    ])
    fake.workflowRuns = {
      r1: { runId: 'r1', name: 'deep-research', status: 'active' },
      r2: { runId: 'r2', name: 'boost-coverage', status: 'user_paused', script: 'x' },
    }
    const first = items('/workflow ')
    expect(first.map((a) => a.insertText)).toEqual([
      'review-pr ',
      'runs',
      'pause ',
      'resume ',
      'stop ',
      'save ',
    ])
    // pause 只列 active 的 run；save 只列有脚本的
    expect(items('/workflow pause ').map((a) => a.insertText)).toEqual([
      'pause deep-research',
    ])
    expect(items('/workflow save ').map((a) => a.insertText)).toEqual(['save boost-coverage'])
    expect(items('/workflow pause dee').map((a) => a.insertText)).toEqual([
      'pause deep-research',
    ])
    // 已安装名之后给旗标
    expect(items('/workflow review-pr ').map((a) => a.insertText)).toEqual([
      'review-pr --agent-budget ',
      'review-pr --effort ',
    ])
    // --effort 的取值走当前模型的档位，并带已输入的头部
    fake.models = [
      { modelId: 'm1', name: 'M1', reasoningEfforts: [{ id: 'low', value: 'low' }, { id: 'high', value: 'high' }] },
    ]
    fake.modelName = 'm1'
    expect(items('/workflow review-pr --effort ').map((a) => a.insertText)).toEqual([
      'review-pr --effort low',
      'review-pr --effort high',
    ])
    expect(items('/workflow review-pr --effort h').map((a) => a.insertText)).toEqual([
      'review-pr --effort high',
    ])
    setCachedWorkflows([])
    fake.workflowRuns = {}
  })
})

describe('slashCommandInsertText（尾空格 = 进下一层）', () => {
  it('takes-args 的命令补成 `/name `，无参命令不带空格', () => {
    expect(slashCommandInsertText(slashCommands.find((c) => c.name === 'effort')!)).toBe(
      '/effort ',
    )
    expect(slashCommandInsertText(slashCommands.find((c) => c.name === 'new')!)).toBe('/new')
  })
})
