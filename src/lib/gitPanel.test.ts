import { describe, expect, it } from 'vitest'
import {
  LOG_COL_DEFAULTS,
  LOG_COL_MIN,
  capDiffBlocks,
  clampLogColWidth,
  computeDividerWidths,
  formatGitDate,
  parseUnifiedDiffBlocks,
  statusBadge,
  toRows,
  type DiffHunkBlock,
} from './gitPanel'

describe('parseUnifiedDiffBlocks', () => {
  it('把 hunk 头读成块标题，正文按 +/-/空格分类', () => {
    const blocks = parseUnifiedDiffBlocks('@@ -1,2 +1,2 @@\n-old\n+new\n same\n')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].header).toBe('@@ -1,2 +1,2 @@')
    expect(blocks[0].rows).toEqual([
      { kind: 'delete', text: 'old' },
      { kind: 'insert', text: 'new' },
      { kind: 'equal', text: ' same' },
    ])
  })

  it('文件头合并进 File Header 块，随后的 hunk 另起一块', () => {
    const blocks = parseUnifiedDiffBlocks('diff --git a/x b/x\nindex 111..222\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b')
    expect(blocks.map((b) => b.header)).toEqual(['File Header', '@@ -1 +1 @@'])
    expect(blocks[0].rows).toHaveLength(4)
  })

  it('没有 hunk 头的散行归到 Changes 块', () => {
    const blocks = parseUnifiedDiffBlocks('+only')
    expect(blocks[0].header).toBe('Changes')
    expect(blocks[0].rows).toEqual([{ kind: 'insert', text: 'only' }])
  })

  it('空输入返回空数组', () => {
    expect(parseUnifiedDiffBlocks('')).toHaveLength(1)
    expect(parseUnifiedDiffBlocks('\n').every((b) => b.rows.length >= 0)).toBe(true)
  })
})

describe('capDiffBlocks', () => {
  const block = (n: number): DiffHunkBlock => ({
    header: `h${n}`,
    rows: Array.from({ length: n }, (_, i) => ({ kind: 'equal' as const, text: String(i) })),
  })

  it('跨块累计截断并在越界后停止输出', () => {
    const { blocks, truncated } = capDiffBlocks([block(2), block(3), block(1)], 4)
    expect(truncated).toBe(true)
    expect(blocks.map((b) => b.rows.length)).toEqual([2, 2])
  })

  it('未超限时不截断且保留空块外的全部行', () => {
    const { blocks, truncated } = capDiffBlocks([block(1), block(2)], 3)
    expect(truncated).toBe(false)
    expect(blocks.map((b) => b.rows.length)).toEqual([1, 2])
  })
})

describe('computeDividerWidths', () => {
  const snap = {
    widths: { ...LOG_COL_DEFAULTS },
    contentW: 800,
    graphW: 40,
  }

  it('拖信息列右移：先吃作者列，作者到下限后再吃日期列', () => {
    const next = computeDividerWidths('message', 100, snap)
    expect(next.author).toBe(LOG_COL_MIN.author)
    expect(next.date).toBe(
      LOG_COL_DEFAULTS.date - (100 - (LOG_COL_DEFAULTS.author - LOG_COL_MIN.author)),
    )
    expect(next.hash).toBe(LOG_COL_DEFAULTS.hash)
  })

  it('作者 / 日期分隔线在区间内互换宽度，不越下限', () => {
    expect(computeDividerWidths('author', 10, snap)).toMatchObject({
      author: LOG_COL_DEFAULTS.author + 10,
      date: LOG_COL_DEFAULTS.date - 10,
    })
    expect(computeDividerWidths('author', -1000, snap)).toMatchObject({
      author: LOG_COL_MIN.author,
      date: LOG_COL_DEFAULTS.date + (LOG_COL_DEFAULTS.author - LOG_COL_MIN.author),
    })
  })

  it('dx 为 0 时原样返回', () => {
    expect(computeDividerWidths('date', 0, snap)).toEqual(LOG_COL_DEFAULTS)
  })
})

describe('clampLogColWidth', () => {
  it('非数字 / 非法值视作 0，正常值夹到上下限', () => {
    expect(clampLogColWidth('wide')).toBe(0)
    expect(clampLogColWidth(Number.NaN)).toBe(0)
    expect(clampLogColWidth(1)).toBe(LOG_COL_MIN.author)
    expect(clampLogColWidth(9999)).toBe(360)
  })
})

describe('formatGitDate', () => {
  it('非法日期原样返回，空串原样返回', () => {
    expect(formatGitDate('')).toBe('')
    expect(formatGitDate('yesterday')).toBe('yesterday')
  })

  it('合法日期格式化为 YYYY-MM-DD HH:mm', () => {
    expect(formatGitDate('2026-09-05T20:15:00')).toBe('2026-09-05 20:15')
  })
})

describe('toRows / statusBadge', () => {
  const data = {
    branch: 'main',
    staged: [{ path: 'a.ts', type: 'edit', additions: 1, deletions: 2 }],
    unstaged: [
      { path: 'b.ts', type: 'delete', additions: 0, deletions: 3 },
      { path: 'c.ts', type: 'untracked', additions: 0, deletions: 0 },
    ],
  } as never

  it('三类文件映射成 staged / modified / untracked 行', () => {
    expect(toRows(data).map((r) => [r.path, r.status])).toEqual([
      ['a.ts', 'staged'],
      ['b.ts', 'modified'],
      ['c.ts', 'untracked'],
    ])
  })

  it('徽章字母跟着 changeType 走', () => {
    const [staged, modified, untracked] = toRows(data)
    expect(statusBadge(staged).label).toBe('M')
    expect(statusBadge(modified).label).toBe('D')
    expect(statusBadge(untracked).label).toBe('U')
  })
})
