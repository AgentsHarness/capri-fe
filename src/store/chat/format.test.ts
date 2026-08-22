import { describe, expect, it } from 'vitest'
import {
  contentText,
  fmtTokens,
  formatElapsed,
  formatSessionInfo,
  formatTurnDuration,
  imageSrc,
  planTodos,
  stillRunningCue,
  toolVerb,
} from './format'

describe('contentText', () => {
  it('字符串 / 对象 text / 嵌套 content / 数组', () => {
    expect(contentText('s')).toBe('s')
    expect(contentText({ text: 't' })).toBe('t')
    expect(contentText({ content: { text: 'n' } })).toBe('n')
    expect(contentText([{ text: 'a' }, { content: { text: 'b' } }])).toBe('ab')
    expect(contentText(42)).toBe('')
    expect(contentText(null)).toBe('')
  })
})

describe('toolVerb / formatElapsed / formatTurnDuration', () => {
  it('工具动词', () => {
    expect(toolVerb('read')).toBe('Read')
    expect(toolVerb('edit', true)).toBe('Editing')
    expect(toolVerb(undefined)).toBe('Ran')
  })

  it('formatElapsed：秒 / 分', () => {
    expect(formatElapsed(3_500)).toBe('3.5s')
    expect(formatElapsed(90_000)).toBe('1m30s')
    expect(formatElapsed(155_000)).toBe('2m35s')
  })

  it('formatTurnDuration：<10s 小数；<60s 整数；<60m m+s；else h+m', () => {
    expect(formatTurnDuration(5_200)).toBe('5.2s')
    expect(formatTurnDuration(32_000)).toBe('32s')
    expect(formatTurnDuration(125_000)).toBe('2m5s')
    expect(formatTurnDuration(3_720_000)).toBe('1h2m')
  })
})

describe('fmtTokens', () => {
  it('K / M 阈值与精度', () => {
    expect(fmtTokens(500)).toBe('500')
    expect(fmtTokens(5_200)).toBe('5.2K')
    expect(fmtTokens(8_800)).toBe('8.8K')
    expect(fmtTokens(10_000)).toBe('10K')
    // >=10K 起四舍五入到整 K
    expect(fmtTokens(48_800)).toBe('49K')
    expect(fmtTokens(1_200_000)).toBe('1.2M')
    expect(fmtTokens(10_000_000)).toBe('10M')
  })
})

describe('formatSessionInfo', () => {
  it('字段齐全时逐行渲染', () => {
    const text = formatSessionInfo({
      title: 'My session',
      sessionId: 's1',
      cwd: '/tmp',
      model: { name: 'grok-3', modelId: 'grok-3', reasoningEffort: 'high' },
      contextSize: 1000,
      contextUsed: 250,
      gitBranch: 'main',
      gitIsWorktree: true,
      gitMainRepo: 'capri',
      hostName: 'mac',
      hostId: 'h1',
    } as never)
    expect(text).toContain('Session info')
    expect(text).toContain('Title: My session')
    expect(text).toContain('Session ID: s1')
    expect(text).toContain('Workspace: /tmp')
    expect(text).toContain('Model: grok-3 · high')
    expect(text).toContain('Context: 250 / 1.0K tokens (25%)')
    expect(text).toContain('Git: main (worktree of capri)')
    expect(text).toContain('Host: mac · h1')
  })

  it('contextUsed 超窗口 → 百分比钳 100', () => {
    const text = formatSessionInfo({ contextSize: 100, contextUsed: 500, model: { name: 'x' } } as never)
    expect(text).toContain('(100%)')
  })

  it('最小字段也能渲染', () => {
    const text = formatSessionInfo({} as never)
    expect(text).toBe('Session info')
  })
})

describe('planTodos', () => {
  it('状态映射 + 计数 + cancelled 排除', () => {
    const { items, counts } = planTodos([
      { id: '1', content: 'a', status: 'completed' },
      { id: '2', content: 'b', status: 'in_progress' },
      { id: '3', content: 'c', status: 'pending', priority: 'high' },
      { id: '4', content: 'd', status: 'completed', meta: { cancelled: true } },
      'junk',
      { content: { text: 'nested' } },
    ])
    expect(items).toHaveLength(5) // 'junk' 非对象被跳过
    expect(counts).toEqual({ total: 4, inProgress: 1, pending: 2, completed: 1 })
    const ids = Object.fromEntries(items.map((i) => [i.id, i.status]))
    expect(ids).toMatchObject({ '1': 'completed', '2': 'in_progress', '3': 'pending', '4': 'cancelled' })
    expect(items[4].content).toBe('nested')
  })

  it('空/非数组 → items [] / counts undefined', () => {
    expect(planTodos(null)).toEqual({ items: [] })
    expect(planTodos([]).counts).toBeUndefined()
  })

  it('字符串 content 原样；缺 content 用 title', () => {
    const { items } = planTodos([{ content: 'x' }, { title: 't' }])
    expect(items.map((i) => i.content)).toEqual(['x', 't'])
  })
})

describe('imageSrc', () => {
  it('已有 data: 前缀原样返回；裸 base64 包 mime', () => {
    expect(imageSrc('data:image/png;base64,AA')).toBe('data:image/png;base64,AA')
    expect(imageSrc('AA==', 'image/jpeg')).toBe('data:image/jpeg;base64,AA==')
  })

  it('非法 mime 回退 png；空串 → undefined', () => {
    expect(imageSrc('AA', 'bad mime')).toBe('data:image/png;base64,AA')
    expect(imageSrc('  ')).toBeUndefined()
  })
})

describe('stillRunningCue', () => {
  it('按条目 + topTasks 汇总进行中的任务', () => {
    const cue = stillRunningCue(
      [
        { id: 'b1', kind: 'bg_task', title: 't', status: 'started', running: true, command: 'npm' },
        { id: 'b2', kind: 'bg_task', title: 'm', status: 'started', running: true, isMonitor: true },
        { id: 'b3', kind: 'bg_task', title: 'done', status: 'completed' },
        { id: 's1', kind: 'subagent', title: 's', status: 'started', running: true },
        { id: 'w1', kind: 'workflow', title: 'w', status: 'running', running: true },
      ] as never,
      [{ taskId: 'x', title: 't' } as never],
    )
    expect(cue).toBe('2 commands · 1 monitor · 1 subagent · 1 workflow still running')
  })

  it('无运行任务 → null', () => {
    expect(stillRunningCue([])).toBeNull()
    expect(stillRunningCue([{ id: 'b', kind: 'bg_task', title: 't', status: 'completed' }] as never)).toBeNull()
  })
})