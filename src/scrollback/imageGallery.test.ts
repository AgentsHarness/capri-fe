import { describe, expect, it } from 'vitest'
import type { DisplayRow } from './verbGroup'
import { appendImageRow } from './imageGallery'

function imgRow(
  id: string,
  data: string,
): Extract<DisplayRow, { type: 'entry' }> {
  return {
    type: 'entry',
    index: 0,
    entry: { id, kind: 'image', data, mimeType: 'image/png', ts: 0 },
  }
}

describe('appendImageRow', () => {
  it('首行建组：key 取首条 entry id，images 里已有这张', () => {
    const g = appendImageRow(undefined, imgRow('a', 'A'), 0)
    expect(g.key).toBe('ig_a')
    expect(g.rows.map((r) => r.row.entry.id)).toEqual(['a'])
    expect(g.images).toEqual([{ data: 'A', mimeType: 'image/png' }])
  })

  it('追加行时 images 同步增长，且顺序与 rows 一致（组内第 N 张 = images[N]）', () => {
    const g = appendImageRow(undefined, imgRow('a', 'A'), 0)
    appendImageRow(g, imgRow('b', 'B'), 1)
    appendImageRow(g, imgRow('c', 'C'), 2)
    expect(g.rows).toHaveLength(3)
    expect(g.images.map((i) => i.data)).toEqual(['A', 'B', 'C'])
    // 点击第 3 张：按 entry id 定位的索引要在 lightbox 集合范围内且指向它。
    const idx = g.rows.findIndex(({ row }) => row.entry.id === 'c')
    expect(idx).toBe(2)
    expect(g.images[idx]?.data).toBe('C')
  })

  it('缺 mimeType 的行原样透传，不伪造类型', () => {
    const g = appendImageRow(undefined, {
      type: 'entry',
      index: 0,
      entry: { id: 'x', kind: 'image', data: 'X', ts: 0 },
    }, 0)
    expect(g.images[0]).toEqual({ data: 'X', mimeType: undefined })
  })
})
