import { describe, expect, it } from 'vitest'
import type { SessionInfo, WorkspaceGroup } from '../api/types'
import {
  groupWorkspaces,
  repoNameFromCwd,
  sanitizeTitle,
  sessionContextPct,
  sessionGroupKey,
  sessionSortRank,
} from './historyGroups'

const session = (over: Partial<SessionInfo> & { sessionId: string }): SessionInfo => over

describe('sessionSortRank', () => {
  it('待处理（awaiting / awaitingInput）永远最前（0）', () => {
    expect(
      sessionSortRank(session({ sessionId: 'a', status: { state: 'awaiting' } })),
    ).toBe(0)
    expect(
      sessionSortRank(
        session({ sessionId: 'a', status: { state: 'idle', awaitingInput: true } }),
      ),
    ).toBe(0)
  })

  it('完成对勾（completedNotices 命中）= 1', () => {
    expect(sessionSortRank(session({ sessionId: 'a' }), { a: 1 })).toBe(1)
  })

  it('运行中：有后台任务 2、无后台任务 3', () => {
    expect(
      sessionSortRank(session({ sessionId: 'a', status: { state: 'active' }, bgRunning: 2 })),
    ).toBe(2)
    expect(
      sessionSortRank(session({ sessionId: 'a', status: { state: 'active' } })),
    ).toBe(3)
  })

  it('空闲但有后台任务 4、纯空闲 5', () => {
    expect(sessionSortRank(session({ sessionId: 'a', bgRunning: 1 }))).toBe(4)
    expect(sessionSortRank(session({ sessionId: 'a' }))).toBe(5)
  })
})

describe('sessionGroupKey', () => {
  it('分桶优先级：awaiting > active > bg > idle', () => {
    expect(
      sessionGroupKey(session({ sessionId: 'a', status: { state: 'awaiting' } })),
    ).toBe('awaiting')
    expect(
      sessionGroupKey(session({ sessionId: 'a', status: { state: 'active' } })),
    ).toBe('active')
    expect(sessionGroupKey(session({ sessionId: 'a', bgRunning: 1 }))).toBe('bg')
    expect(sessionGroupKey(session({ sessionId: 'a' }))).toBe('idle')
    // awaitingInput 派生：即使 state 是 idle 也算待处理
    expect(
      sessionGroupKey(session({ sessionId: 'a', status: { state: 'idle', awaitingInput: true } })),
    ).toBe('awaiting')
  })

  it('当前正在查看不影响分桶：active 会话仍在处理中组（currentSessionId 分支实际只兜 idle）', () => {
    const s = session({ sessionId: 'me', status: { state: 'active' } })
    expect(sessionGroupKey(s, 'me')).toBe('active')
  })
})

describe('repoNameFromCwd', () => {
  it('取路径最后两个组件以 - 连接', () => {
    expect(repoNameFromCwd('/home/user/fw/1')).toBe('fw-1')
    expect(repoNameFromCwd('/home/user/xai')).toBe('user-xai')
  })

  it('单组件取自身；空与根特殊值', () => {
    expect(repoNameFromCwd('/xai')).toBe('xai')
    expect(repoNameFromCwd('')).toBe('unknown')
    expect(repoNameFromCwd('/')).toBe('/')
  })

  it('过滤 . / .. 组件（仅过滤、不做词法解析）', () => {
    // '/a/./b/../c' → 组件 [a,b,c]（.. 不回抵上级）→ 取尾两个
    expect(repoNameFromCwd('/a/./b/../c')).toBe('b-c')
  })
})

describe('sanitizeTitle', () => {
  it('丢弃控制字符与 bidi/零宽格式符，保留普通文本与 ZWJ', () => {
    expect(sanitizeTitle('a\u0001b\u007fc')).toBe('abc')
    expect(sanitizeTitle('x\u202ey')).toBe('xy') // bidi 覆盖
    expect(sanitizeTitle('x\u200by')).toBe('xy') // 零宽空格
    expect(sanitizeTitle('👨‍👩‍👦')).toBe('👨‍👩‍👦') // ZWJ 序列完整保留
    expect(sanitizeTitle('正常标题')).toBe('正常标题')
  })

  it('上限 100 个标量（超长截断）', () => {
    expect(sanitizeTitle('a'.repeat(250))).toHaveLength(100)
  })
})

describe('sessionContextPct', () => {
  it('字段缺失 / size 无效 → undefined', () => {
    expect(sessionContextPct(session({ sessionId: 'a' }))).toBeUndefined()
    const zero = session({ sessionId: 'a' }) as SessionInfo & { contextUsed: number; contextSize: number }
    zero.contextUsed = 10
    zero.contextSize = 0
    expect(sessionContextPct(zero)).toBeUndefined()
  })

  it('正常取整，超过 100 封顶', () => {
    const mk = (used: number, size: number): SessionInfo => {
      const s = session({ sessionId: 'a' }) as SessionInfo & { contextUsed: number; contextSize: number }
      s.contextUsed = used
      s.contextSize = size
      return s
    }
    expect(sessionContextPct(mk(50, 100))).toBe(50)
    expect(sessionContextPct(mk(150, 100))).toBe(100)
  })
})

describe('groupWorkspaces', () => {
  const ws = (cwd: string, label: string, times: string[]): WorkspaceGroup => ({
    cwd,
    label,
    sessions: times.map((updatedAt, i) => ({ sessionId: `${label}-${i}`, cwd, updatedAt })),
  })

  it('按组内最新活动降序；同活动按 label 字母序', () => {
    const groups = [
      ws('/a', 'alpha', ['2024-01-01T00:00:00Z']),
      ws('/b', 'beta', ['2025-06-01T00:00:00Z']),
      ws('/c', 'gamma', ['2025-06-01T00:00:00Z']),
    ]
    expect(groupWorkspaces(groups).map((g) => g.label)).toEqual(['beta', 'gamma', 'alpha'])
  })

  it('不修改原数组（拷贝排序）', () => {
    const groups = [ws('/a', 'a', ['2024-01-01T00:00:00Z']), ws('/b', 'b', ['2025-01-01T00:00:00Z'])]
    const before = groups.map((g) => g.label)
    groupWorkspaces(groups)
    expect(groups.map((g) => g.label)).toEqual(before)
  })
})
