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
import {
  filterSlashCommands,
  isMultilineEnabled,
  matchSlash,
  mergedSlashCommands,
  parseBudgetTokens,
  registerMcpPanelOpener,
  registerModelMenuOpener,
  slashCommands,
} from './registry'

interface FakeChat {
  models: Array<Record<string, unknown>>
  modelName: string
  conn: string
  sessionId: string | null
  cwd: string | null
  sessionTitle: string | null
  entries: Array<Record<string, unknown>>
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
  showSessionInfo: ReturnType<typeof vi.fn>
  openContext: ReturnType<typeof vi.fn>
  togglePlanMode: ReturnType<typeof vi.fn>
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
    showSessionInfo: vi.fn(),
    openContext: vi.fn(),
    togglePlanMode: vi.fn(),
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
  } as FakeChat
  vi.mocked(useChatStore.getState).mockReturnValue(fake as never)
  // registry 的 status() 走 setState；让 setState 真实写入 fake
  vi.mocked(useChatStore.setState).mockImplementation((partial) => {
    Object.assign(fake, partial as Record<string, unknown>)
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
})

describe('mergedSlashCommands', () => {
  it('无 agent 命令 → 本地列表', () => {
    expect(mergedSlashCommands([])).toBe(slashCommands)
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
  it('/new /resume /compact /rewind /fork /recap /session-info /context /plan /timestamps /settings /flush /workflows', () => {
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
    expect(fake.showSessionInfo).toHaveBeenCalled()
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
    run('workflows')
    expect(fake.setWorkflowPanelOpen).toHaveBeenCalledWith(true)
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
  it('缺间隔或提示 → 用法错误', () => {
    run('loop')
    run('loop', '5m')
    expect(fake.appendLocalEntry).toHaveBeenCalledTimes(2)
  })

  it('busy → 排队；空闲 → 直发', () => {
    fake.conn = 'busy'
    fake.sessionId = 's2'
    run('loop', '5m 检查测试状态')
    const q = vi.mocked(usePromptQueue.getState).mock.results[0]?.value as { enqueue: ReturnType<typeof vi.fn> }
    expect(q.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('每 5m 执行一次') }),
      's2',
    )

    fake.conn = 'idle'
    run('loop', '1h 汇报')
    expect(fake.send).toHaveBeenCalledWith(expect.stringContaining('每 1h 执行一次'))
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
  it('on/off 走提示词路径；无参打开浏览', () => {
    run('memory', 'on')
    expect(fake.send).toHaveBeenCalledWith('请开启记忆')
    fake.send.mockClear()
    run('memory', 'off')
    expect(fake.send).toHaveBeenCalledWith('请关闭记忆')
    run('memory')
    expect(fake.openMemory).toHaveBeenCalled()
  })

  it('/remember 无参报错；有参走提示词', () => {
    run('remember')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({ kind: 'error', text: expect.stringContaining('用法') })
    run('remember', '部署用 eu-west')
    expect(fake.send).toHaveBeenCalledWith('请记住：部署用 eu-west（写入记忆）')
  })

  it('/dream 走提示词路径', () => {
    run('dream')
    expect(fake.send).toHaveBeenCalledWith('请执行记忆整合（memory consolidation）')
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