import { describe, expect, it } from 'vitest'
import {
  filterRunningEntries,
  fmtBytes,
  fmtElapsedCompact,
  fmtTok,
  fmtTokBig,
  shortCwd,
  subagentMeta,
  userMessagePreview,
} from './format'
import type { ScrollEntry } from './api/types'

describe('fmtTok / fmtTokBig', () => {
  it('千以下原样输出', () => {
    expect(fmtTok(0)).toBe('0')
    expect(fmtTok(500)).toBe('500')
    expect(fmtTok(999)).toBe('999')
  })

  it('1K–10K 保留一位小数，10K 以上取整', () => {
    expect(fmtTok(1_000)).toBe('1.0K')
    expect(fmtTok(5_200)).toBe('5.2K')
    expect(fmtTok(10_000)).toBe('10K')
    expect(fmtTok(50_000)).toBe('50K')
  })

  it('1M–10M 保留一位小数，10M 以上取整', () => {
    expect(fmtTok(1_200_000)).toBe('1.2M')
    expect(fmtTok(9_500_000)).toBe('9.5M')
    expect(fmtTok(10_000_000)).toBe('10M')
  })

  it('fmtTokBig 百万级换算为 m 且不回退 1000k', () => {
    expect(fmtTokBig(500_000)).toBe('500K')
    expect(fmtTokBig(1_000_000)).toBe('1.0m')
    expect(fmtTokBig(2_500_000)).toBe('2.5m')
  })
})

describe('shortCwd', () => {
  it('home 目录前缀折叠为 ~/', () => {
    expect(shortCwd('/home/u/proj', '/home/u')).toBe('~/proj')
    expect(shortCwd('/home/u', '/home/u')).toBe('~')
  })

  it('前缀不匹配或 homeDir 缺省时原样返回', () => {
    expect(shortCwd('/opt/work', '/home/u')).toBe('/opt/work')
    expect(shortCwd('/any/path')).toBe('/any/path')
  })

  it('已知怪癖：前缀匹配不认路径边界（/home/ux 以 /home/u 视作家目录前缀）', () => {
    // startsWith 纯字符串匹配——待办：若需按路径组件判定可改为 homeDir + '/'
    expect(shortCwd('/home/ux', '/home/u')).toBe('~x')
  })

  it('homeDir 为根 / 时不折叠', () => {
    expect(shortCwd('/x', '/')).toBe('/x')
  })
})

describe('fmtElapsedCompact', () => {
  it('秒/分/时分级', () => {
    expect(fmtElapsedCompact(0)).toBe('0s')
    expect(fmtElapsedCompact(4_999)).toBe('4s')
    expect(fmtElapsedCompact(59_900)).toBe('59s') // 59.9s 未满 1 分钟
    expect(fmtElapsedCompact(60_000)).toBe('1m')
    expect(fmtElapsedCompact(180_000)).toBe('3m')
    expect(fmtElapsedCompact(7_200_000)).toBe('2h')
  })

  it('负数钳到 0s', () => {
    expect(fmtElapsedCompact(-100)).toBe('0s')
  })
})

describe('subagentMeta', () => {
  it('全空返回空串', () => {
    expect(subagentMeta()).toBe('')
    expect(subagentMeta('  ', '')).toBe('')
  })

  it('persona 与 role 同名（忽略大小写）去重', () => {
    expect(subagentMeta('Builder', 'builder', 'grok-4')).toBe(' (Builder · grok-4)')
  })

  it('三者齐全用 · 连接，空白值视为缺失', () => {
    expect(subagentMeta('P', ' R ', 'M')).toBe(' (P · R · M)')
    expect(subagentMeta(undefined, 'Writer')).toBe(' (Writer)')
  })

  it('带 effort 时模型显示为 model(effort)', () => {
    expect(subagentMeta('Builder', 'builder', 'grok-4', 'high')).toBe(' (Builder · grok-4(high))')
    expect(subagentMeta(undefined, undefined, 'grok-4', 'low')).toBe(' (grok-4(low))')
    expect(subagentMeta('P', 'R', 'M', 'medium')).toBe(' (P · R · M(medium))')
    // 若 model 自身已有括号形式的 effort，不重复拼接
    expect(subagentMeta(undefined, undefined, 'grok-4(high)', 'high')).toBe(' (grok-4(high))')
    // 只有 effort 无 model 时回退显示 effort
    expect(subagentMeta('Builder', undefined, undefined, 'high')).toBe(' (Builder · high)')
  })
})

describe('fmtBytes', () => {
  it('B / KB / MB 分级', () => {
    expect(fmtBytes(0)).toBe('0 B')
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(2_048)).toBe('2.0 KB')
    expect(fmtBytes(1024 * 1024)).toBe('1.0 MB')
    expect(fmtBytes(1.5 * 1024 * 1024)).toBe('1.5 MB')
  })
})

describe('filterRunningEntries', () => {
  it('只保留 running 的 subagent / bg_task / workflow', () => {
    const entries: ScrollEntry[] = [
      { id: '1', kind: 'subagent', title: 's1', status: 'started', running: true },
      { id: '2', kind: 'subagent', title: 's2', status: 'completed' },
      { id: '3', kind: 'bg_task', title: 'b1', status: 'started', running: true },
      { id: '4', kind: 'bg_task', title: 'b2', status: 'failed' },
      { id: '5', kind: 'workflow', title: 'w1', status: 'running', running: true },
      { id: '6', kind: 'user', text: 'hi' },
      { id: '7', kind: 'assistant', text: 'yo' },
    ]
    const running = filterRunningEntries(entries)
    expect(running.map((e) => e.id)).toEqual(['1', '3', '5'])
  })
})

describe('userMessagePreview', () => {
  it('取第一个非空行并 trim', () => {
    expect(userMessagePreview('\n\n  hello  \nworld')).toBe('hello')
  })

  it('全空文本返回空串', () => {
    expect(userMessagePreview(' \n \n')).toBe('')
  })

  it('超 80 字符截断并补省略号（总长 80）', () => {
    const line = 'a'.repeat(100)
    const preview = userMessagePreview(line)
    expect(preview).toHaveLength(80)
    expect(preview.endsWith('…')).toBe(true)
    expect(preview.slice(0, -1)).toBe('a'.repeat(79))
  })

  it('恰好 80 字符不截断', () => {
    expect(userMessagePreview('b'.repeat(80))).toBe('b'.repeat(80))
  })
})
