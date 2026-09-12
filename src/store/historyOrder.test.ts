import { beforeEach, describe, expect, it } from 'vitest'
import {
  activityMs,
  rowOrderMs,
  sortGroupsByOrderMs,
  useHistoryOrder,
  type AnchorMap,
} from './historyOrder'
import type { WorkspaceGroup } from '../api/types'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()

function reset() {
  localStorage.clear()
  useHistoryOrder.setState({
    anchors: {},
    collapse: {},
    pendingReanchor: false,
    hostScope: '',
  })
}

beforeEach(reset)

describe('useHistoryOrder.seed', () => {
  it('首次落地建锚，之后活动变化不动锚点', () => {
    useHistoryOrder.getState().seed([{ sessionId: 'a', ms: T0 }], 'local')
    expect(useHistoryOrder.getState().anchors.a).toBe(T0)
    useHistoryOrder.getState().seed([{ sessionId: 'a', ms: T0 + 9_999 }], 'local')
    expect(useHistoryOrder.getState().anchors.a).toBe(T0)
  })

  it('只补新会话的锚，老会话锚点保持', () => {
    useHistoryOrder.getState().seed([{ sessionId: 'a', ms: T0 }], 'local')
    useHistoryOrder.getState().seed(
      [
        { sessionId: 'b', ms: T0 + 5 },
        { sessionId: 'a', ms: T0 + 5000 },
      ],
      'local',
    )
    expect(useHistoryOrder.getState().anchors).toEqual({ a: T0, b: T0 + 5 })
  })

  it('无时间戳的行不建锚', () => {
    useHistoryOrder.getState().seed([{ sessionId: 'a', ms: 0 }], 'local')
    expect(useHistoryOrder.getState().anchors).toEqual({})
  })

  it('锚点没变时不产生新的数组身份（避免多渲染一轮）', () => {
    const rows = [{ sessionId: 'a', ms: T0 }]
    useHistoryOrder.getState().seed(rows, 'local')
    const before = useHistoryOrder.getState().anchors
    useHistoryOrder.getState().seed(rows, 'local')
    expect(useHistoryOrder.getState().anchors).toBe(before)
  })

  it('显式刷新整表重锚，本次没出现的旧锚保留', () => {
    useHistoryOrder.getState().seed([{ sessionId: 'a', ms: T0 }], 'local')
    useHistoryOrder.getState().seed([{ sessionId: 'b', ms: T0 + 1 }], 'local')
    useHistoryOrder.getState().requestReanchor()
    useHistoryOrder.getState().seed([{ sessionId: 'a', ms: T0 + 70 }], 'local')
    expect(useHistoryOrder.getState().anchors).toEqual({ a: T0 + 70, b: T0 + 1 })
    // 重锚是一次性的：下一次落地回到只补新锚。
    useHistoryOrder.getState().seed([{ sessionId: 'a', ms: T0 + 900 }], 'local')
    expect(useHistoryOrder.getState().anchors.a).toBe(T0 + 70)
  })

  it('换 host 丢掉旧 host 的锚，只留本次的', () => {
    useHistoryOrder.getState().seed([{ sessionId: 'a', ms: T0 }], 'local')
    useHistoryOrder.getState().seed([{ sessionId: 'b', ms: T0 + 3 }], 'host-2')
    expect(useHistoryOrder.getState().anchors).toEqual({ b: T0 + 3 })
    expect(useHistoryOrder.getState().hostScope).toBe('host-2')
  })

  it('锚点持久化到 localStorage', () => {
    useHistoryOrder.getState().seed([{ sessionId: 'a', ms: T0 }], 'local')
    expect(
      JSON.parse(window.localStorage.getItem('capri-fe.historyOrder') ?? '{}'),
    ).toEqual({ a: T0 })
  })

  it('刷新页面后（从存档重建 store）首次 seed 不抹掉锚点', () => {
    useHistoryOrder.getState().seed([{ sessionId: 'a', ms: T0 }], 'local')
    // 模拟重新加载：hostScope 复位为「还没定过」，锚点从 localStorage 回来。
    const stored: AnchorMap = JSON.parse(
      window.localStorage.getItem('capri-fe.historyOrder') ?? '{}',
    )
    useHistoryOrder.setState({ anchors: stored, hostScope: '', pendingReanchor: false })
    useHistoryOrder.getState().seed([{ sessionId: 'a', ms: T0 + 60_000 }], 'local')
    expect(useHistoryOrder.getState().anchors.a).toBe(T0)
  })
})

describe('activityMs / rowOrderMs', () => {
  it('解析 ISO 活动时间为 epoch ms', () => {
    expect(activityMs({ updatedAt: iso(1234) })).toBe(T0 + 1234)
    expect(activityMs({})).toBe(0)
    expect(activityMs({ updatedAt: 'garbage' })).toBe(0)
  })

  it('有锚用锚，无锚退回本次时间', () => {
    const anchors: AnchorMap = { a: T0 }
    expect(rowOrderMs(anchors, { sessionId: 'a', updatedAt: iso(9999) })).toBe(T0)
    expect(rowOrderMs(anchors, { sessionId: 'b', updatedAt: iso(10) })).toBe(T0 + 10)
    expect(rowOrderMs(anchors, { sessionId: 'b' })).toBe(0)
  })
})

describe('sortGroupsByOrderMs', () => {
  const group = (cwd: string, ids: [string, string][]): WorkspaceGroup => ({
    cwd,
    label: cwd,
    sessions: ids.map(([sessionId, updatedAt]) => ({ sessionId, cwd, updatedAt })),
  })

  it('按组内最大排序锚降序，不改入参数组', () => {
    const anchors: AnchorMap = { old: T0, mid: T0 + 100, new: T0 + 500 }
    const groups = [
      group('/a', [['old', iso(0)]]),
      group('/c', [['new', iso(500)]]),
      group('/b', [['mid', iso(100)]]),
    ]
    expect(sortGroupsByOrderMs(groups, anchors).map((g) => g.cwd)).toEqual([
      '/c',
      '/b',
      '/a',
    ])
    expect(groups.map((g) => g.cwd)).toEqual(['/a', '/c', '/b'])
  })

  it('锚点不变时，实时时间戳前进不会改变组序', () => {
    const anchors: AnchorMap = { x: T0, y: T0 + 100 }
    const stale = [group('/x', [['x', iso(0)]]), group('/y', [['y', iso(100)]])]
    const bumped = [group('/x', [['x', iso(99999)]]), group('/y', [['y', iso(100)]])]
    expect(sortGroupsByOrderMs(stale, anchors).map((g) => g.cwd)).toEqual(
      sortGroupsByOrderMs(bumped, anchors).map((g) => g.cwd),
    )
  })

  it('同分按 label 字母序', () => {
    const sorted = sortGroupsByOrderMs(
      [group('/b', [['s2', '']]), group('/a', [['s1', 'garbage']])],
      {},
    )
    expect(sorted.map((g) => g.cwd)).toEqual(['/a', '/b'])
  })
})

describe('useHistoryOrder.setCollapse', () => {
  it('记录折叠偏好并持久化，重复设置不产生新对象', () => {
    useHistoryOrder.getState().setCollapse('/x', true)
    expect(useHistoryOrder.getState().collapse).toEqual({ '/x': true })
    expect(
      JSON.parse(window.localStorage.getItem('capri-fe.historyGroupCollapse') ?? '{}'),
    ).toEqual({ '/x': true })
    const before = useHistoryOrder.getState().collapse
    useHistoryOrder.getState().setCollapse('/x', true)
    expect(useHistoryOrder.getState().collapse).toBe(before)
  })
})
