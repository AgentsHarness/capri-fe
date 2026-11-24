// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ScrollEntry } from '../api/types'
import type { AbsorbingEntry } from './absorbEntries'
import { withAbsorbingRows } from './absorbLayout'

const ghost = (id: string, afterKey: string | null): AbsorbingEntry => ({
  entry: { id, kind: 'tool', title: id } as ScrollEntry,
  afterKey,
  waitForFade: false,
})

type Item =
  | { kind: 'row'; key: string }
  | { kind: 'gallery'; keys: string[] }
  | { kind: 'ghost'; ghost: AbsorbingEntry }

const keysOf = (item: Item): readonly string[] => {
  if (item.kind === 'row') return [item.key]
  if (item.kind === 'gallery') return item.keys
  return []
}

const ghostItem = (g: AbsorbingEntry): Item => ({ kind: 'ghost', ghost: g })

const label = (items: Item[]) =>
  items.map((i) =>
    i.kind === 'row'
      ? i.key
      : i.kind === 'gallery'
        ? `g:${i.keys.join(',')}`
        : `+${i.ghost.entry.id}`,
  )

describe('withAbsorbingRows', () => {
  it('没有退出行时原样返回', () => {
    const items: Item[] = [{ kind: 'row', key: 'a' }]
    expect(withAbsorbingRows(items, [], keysOf, ghostItem)).toEqual(items)
  })

  it('按 afterKey 插在锚点之后；null 放最前', () => {
    const items: Item[] = [
      { kind: 'row', key: 'a' },
      { kind: 'row', key: 'b' },
    ]
    const out = withAbsorbingRows(
      items,
      [ghost('lead', null), ghost('g1', 'a'), ghost('g2', 'a')],
      keysOf,
      ghostItem,
    )
    expect(label(out)).toEqual(['+lead', 'a', '+g1', '+g2', 'b'])
  })

  it('锚点是画廊组成员时插在整组之后', () => {
    const items: Item[] = [
      { kind: 'gallery', keys: ['i1', 'i2'] },
      { kind: 'row', key: 'b' },
    ]
    const out = withAbsorbingRows(items, [ghost('g', 'i2')], keysOf, ghostItem)
    expect(label(out)).toEqual(['g:i1,i2', '+g', 'b'])
  })

  it('锚点丢失时兜底放到末尾，且同一个 id 不会重复插', () => {
    const items: Item[] = [{ kind: 'row', key: 'a' }]
    const out = withAbsorbingRows(
      items,
      [ghost('x', 'missing'), ghost('x', 'missing')],
      keysOf,
      ghostItem,
    )
    expect(label(out)).toEqual(['a', '+x'])
  })
})
