import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import {
  buildGitGraph,
  getLaneX,
  getLaneColor,
  GRAPH_LANE_COLORS,
  GRAPH_ROW_HEIGHT,
  GRAPH_CENTER_Y,
} from './gitGraph'
import { GitGraphCell } from './GitGraphCell'
import type { GitLogEntry } from '../../api/types'

function makeCommit(opts: Partial<GitLogEntry> & { hash: string }): GitLogEntry {
  return {
    shortHash: opts.hash.slice(0, 7),
    author: 'Dev',
    email: 'dev@example.com',
    timestamp: 1600000000,
    date: '2026-09-05T00:00:00Z',
    message: `commit ${opts.hash}`,
    ...opts,
  }
}

describe('gitGraph 历史线与拓扑图算法', () => {
  it('空列表返回空 rows 与默认宽度', () => {
    const res = buildGitGraph([])
    expect(res.rows).toEqual([])
    expect(res.graphWidth).toBeGreaterThan(0)
    expect(getLaneColor(0)).toBe(GRAPH_LANE_COLORS[0])
    expect(getLaneColor(1)).toBe(GRAPH_LANE_COLORS[1])
  })

  it('单分支线性提交：首项为 HEAD（空心圆环，顶部无引出线），中间项带上下贯通线，尾项底部终止', () => {
    const commits = [
      makeCommit({ hash: 'c1', parents: ['c2'] }),
      makeCommit({ hash: 'c2', parents: ['c3'] }),
      makeCommit({ hash: 'c3', parents: [] }),
    ]

    const { rows, graphWidth } = buildGitGraph(commits)
    expect(rows).toHaveLength(3)
    expect(graphWidth).toBe(30) // 14 + 16

    // 第 0 项：最新提交（HEAD 空心环）
    const row0 = rows[0]
    expect(row0.isHead).toBe(true)
    expect(row0.nodeLane).toBe(0)
    expect(row0.nodeColor).toBe(GRAPH_LANE_COLORS[0])
    // 顶部不应有 incoming 连线
    expect(row0.lines.some((l) => l.key.startsWith('in-'))).toBe(false)
    // 底部有向下的主干连线
    expect(row0.lines.some((l) => l.key.startsWith('out-'))).toBe(true)

    // 第 1 项：普通提交（实心小圆点）
    const row1 = rows[1]
    expect(row1.isHead).toBe(false)
    expect(row1.nodeLane).toBe(0)
    expect(row1.lines.some((l) => l.key.startsWith('in-'))).toBe(true)
    expect(row1.lines.some((l) => l.key.startsWith('out-'))).toBe(true)

    // 第 2 项：根提交（无父提交）
    const row2 = rows[2]
    expect(row2.isHead).toBe(false)
    expect(row2.nodeLane).toBe(0)
    expect(row2.lines.some((l) => l.key.startsWith('in-'))).toBe(true)
    // 底部不再向下延伸
    expect(row2.lines.some((l) => l.key.startsWith('out-'))).toBe(false)
  })

  it('显式指定 HEAD ref 时准确识别目标提交，否则默认首项为 HEAD', () => {
    const commits = [
      makeCommit({ hash: 'c1', parents: ['c2'] }),
      makeCommit({ hash: 'c2', refs: 'HEAD -> feature', parents: ['c3'] }),
      makeCommit({ hash: 'c3', parents: [] }),
    ]

    const { rows } = buildGitGraph(commits)
    expect(rows[0].isHead).toBe(false)
    expect(rows[1].isHead).toBe(true)
    expect(rows[2].isHead).toBe(false)
  })

  it('合并提交（Merge Commit）：支持多父提交分叉连线与多泳道展开', () => {
    const commits = [
      makeCommit({ hash: 'm1', parents: ['c1', 'f1'] }), // 合并提交
      makeCommit({ hash: 'c1', parents: ['root'] }),
      makeCommit({ hash: 'f1', parents: ['root'] }),
      makeCommit({ hash: 'root', parents: [] }),
    ]

    const { rows, graphWidth } = buildGitGraph(commits)
    expect(rows).toHaveLength(4)
    // 多泳道展开
    expect(graphWidth).toBeGreaterThan(30)

    const mergeRow = rows[0]
    expect(mergeRow.nodeLane).toBe(0)
    // 存在发往主父提交 (lane 0) 和发往次级父提交 (lane 1) 的两条 outgoing 连线
    const outgoing = mergeRow.lines.filter((l) => l.key.startsWith('out-'))
    expect(outgoing).toHaveLength(2)

    // c1 提交在 lane 0 上
    expect(rows[1].nodeLane).toBe(0)
    // f1 提交在 lane 1 上
    expect(rows[2].nodeLane).toBe(1)
    expect(rows[2].nodeColor).toBe(GRAPH_LANE_COLORS[1])
  })

  it('无 parents 属性时，自动 fallback 到下一条提交维持单线连续性', () => {
    const commits = [
      makeCommit({ hash: 'c1' }),
      makeCommit({ hash: 'c2' }),
    ]
    const { rows } = buildGitGraph(commits)
    expect(rows[0].lines.some((l) => l.key.startsWith('out-'))).toBe(true)
    expect(rows[1].lines.some((l) => l.key.startsWith('in-'))).toBe(true)
  })
})

describe('GitGraphCell 组件渲染', () => {
  it('渲染 HEAD 空心圆环', () => {
    const row = {
      nodeLane: 0,
      nodeColor: '#3b82f6',
      isHead: true,
      lines: [
        { key: 'out-0-0', d: 'M 14 18.5 L 14 28', color: '#3b82f6' },
      ],
      maxLane: 0,
    }
    const { container } = render(<GitGraphCell row={row} width={30} />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('width')).toBe('30')
    expect(svg?.getAttribute('height')).toBe(`${GRAPH_ROW_HEIGHT}`)

    const circle = container.querySelector('circle')
    expect(circle).not.toBeNull()
    expect(circle?.getAttribute('fill')).toBe('none')
    expect(circle?.getAttribute('stroke')).toBe('#3b82f6')
    expect(circle?.getAttribute('cx')).toBe(`${getLaneX(0)}`)
    expect(circle?.getAttribute('cy')).toBe(`${GRAPH_CENTER_Y}`)
    expect(circle?.getAttribute('r')).toBe('5')

    const path = container.querySelector('path')
    expect(path).not.toBeNull()
    expect(path?.getAttribute('d')).toBe('M 14 18.5 L 14 28')
  })

  it('渲染普通提交实心小圆点', () => {
    const row = {
      nodeLane: 1,
      nodeColor: '#10b981',
      isHead: false,
      lines: [],
      maxLane: 1,
    }
    const { container } = render(<GitGraphCell row={row} width={46} />)
    const circle = container.querySelector('circle')
    expect(circle).not.toBeNull()
    expect(circle?.getAttribute('fill')).toBe('#10b981')
    expect(circle?.getAttribute('r')).toBe('3.8')
    expect(circle?.getAttribute('cx')).toBe(`${getLaneX(1)}`)
  })

  it('row 为空时渲染空占位 span', () => {
    const { container } = render(<GitGraphCell width={30} />)
    expect(container.querySelector('svg')).toBeNull()
    const span = container.querySelector('span')
    expect(span).not.toBeNull()
    expect(span?.style.width).toBe('30px')
  })
})
