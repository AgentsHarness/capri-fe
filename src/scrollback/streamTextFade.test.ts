import { describe, expect, it } from 'vitest'
import {
  advanceStreamTextView,
  EMPTY_STREAM_TEXT_VIEW,
  splitStreamFadeParts,
  STREAM_TEXT_BULK_CHARS,
  STREAM_TEXT_BULK_FADE_MS,
  STREAM_TEXT_FADE_MS,
  STREAM_TEXT_MAX_PART_CHARS,
  type StreamTextView,
} from './streamTextFade'

let seq = 0
const makeId = () => ++seq
const viewText = (v: StreamTextView) => v.parts.map((p) => p.text).join('')

describe('splitStreamFadeParts', () => {
  it('优先按换行切，长行按上限切', () => {
    expect(splitStreamFadeParts('a\nbb\n')).toEqual(['a\n', 'bb\n'])
    const long = 'x'.repeat(STREAM_TEXT_MAX_PART_CHARS + 5)
    expect(splitStreamFadeParts(long).map((s) => s.length)).toEqual([
      STREAM_TEXT_MAX_PART_CHARS,
      5,
    ])
    expect(splitStreamFadeParts('')).toEqual([])
  })
})

describe('advanceStreamTextView', () => {
  it('首个大包按行拆成多个淡入片段', () => {
    const view = advanceStreamTextView(
      EMPTY_STREAM_TEXT_VIEW,
      '第一行\n第二行\n第三行',
      1000,
      makeId,
    )
    expect(view.parts).toHaveLength(3)
    expect(view.parts.every((p) => p.fading)).toBe(true)
    expect(viewText(view)).toBe('第一行\n第二行\n第三行')
  })

  it('追加文本只新增尾部片段，旧片段保持', () => {
    const first = advanceStreamTextView(EMPTY_STREAM_TEXT_VIEW, 'abc', 1000, makeId)
    const next = advanceStreamTextView(first, 'abcdef', 1050, makeId)
    expect(viewText(next)).toBe('abcdef')
    expect(next.parts[0]).toBe(first.parts[0])
    expect(next.parts.at(-1)?.text).toBe('def')
    expect(next.parts.at(-1)?.fading).toBe(true)
  })

  it('尾窗滑动时按重合后缀裁剪，再淡入新增部分', () => {
    const first = advanceStreamTextView(EMPTY_STREAM_TEXT_VIEW, 'ABCDEFGH', 1000, makeId)
    const next = advanceStreamTextView(first, 'CDEFGHIJ', 1100, makeId)
    expect(viewText(next)).toBe('CDEFGHIJ')
    expect(next.parts.every((p) => p.fading)).toBe(true)
    expect(next.parts.at(-1)?.text).toBe('IJ')
  })

  it('大首包走长淡入，稳定流小增量走短淡入', () => {
    const bulk = advanceStreamTextView(
      EMPTY_STREAM_TEXT_VIEW,
      'x'.repeat(STREAM_TEXT_BULK_CHARS + 1),
      1000,
      makeId,
    )
    expect(bulk.parts.every((p) => p.durationMs === STREAM_TEXT_BULK_FADE_MS)).toBe(true)

    const quick = advanceStreamTextView(EMPTY_STREAM_TEXT_VIEW, 'abc', 1000, makeId)
    expect(quick.parts[0].durationMs).toBe(STREAM_TEXT_FADE_MS)
  })

  it('超过淡入窗口的片段合并成稳定文本', () => {
    const first = advanceStreamTextView(EMPTY_STREAM_TEXT_VIEW, 'abc', 1000, makeId)
    const next = advanceStreamTextView(
      first,
      'abcdef',
      1000 + STREAM_TEXT_FADE_MS + 1,
      makeId,
    )
    expect(next.parts[0].fading).toBe(false)
    expect(next.parts[0].text).toBe('abc')
    expect(next.parts.at(-1)?.text).toBe('def')
  })

  it('文本未变时返回原视图（避免无意义重渲染）', () => {
    const first = advanceStreamTextView(EMPTY_STREAM_TEXT_VIEW, 'abc', 1000, makeId)
    expect(advanceStreamTextView(first, 'abc', 2000, makeId)).toBe(first)
  })
})
