// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  advanceStreamTextView,
  EMPTY_STREAM_TEXT_VIEW,
  releaseStreamTextView,
  splitStreamGraphemes,
  streamTextFadeMs,
  streamViewSettledAt,
  STREAM_TEXT_BURST_CHARS,
  STREAM_TEXT_BURST_LAG_MS,
  STREAM_TEXT_FADE_MS,
  STREAM_TEXT_FRAME_MS,
  STREAM_TEXT_MAX_LAG_MS,
  STREAM_TEXT_MAX_SUB_PARTS,
  STREAM_TEXT_MIN_FADE_MS,
  STREAM_TEXT_SUB_STAGGER_MS,
  type StreamTextView,
} from './streamTextFade'

let seq = 0
const makeId = () => ++seq

const shownText = (view: StreamTextView) =>
  view.parts.map((part) => part.text).join('')
const fullText = (view: StreamTextView) =>
  shownText(view) + view.pending.join('')

/** 按动画帧推进，直到 pending 排空。 */
function drain(
  view: StreamTextView,
  now: number,
  step = STREAM_TEXT_FRAME_MS,
  limit = 200,
): { view: StreamTextView; now: number; frames: number } {
  let current = view
  let frames = 0
  while (current.pending.length > 0 && frames < limit) {
    now += step
    current = releaseStreamTextView(current, now, makeId)
    frames += 1
  }
  return { view: current, now, frames }
}

describe('splitStreamGraphemes', () => {
  it('按字素切分：emoji 与组合字符不会被拆开', () => {
    expect(splitStreamGraphemes('a👍🏽e\u0301')).toEqual(['a', '👍🏽', 'e\u0301'])
    expect(splitStreamGraphemes('')).toEqual([])
  })
})

describe('streamTextFadeMs', () => {
  it('慢流用满 180ms，高吞吐按目标半透明字符数缩短', () => {
    expect(streamTextFadeMs(1)).toBe(STREAM_TEXT_FADE_MS)
    expect(streamTextFadeMs(4)).toBe(STREAM_TEXT_FADE_MS)
    expect(streamTextFadeMs(8)).toBeLessThan(STREAM_TEXT_FADE_MS)
    expect(streamTextFadeMs(8)).toBe(96)
    expect(streamTextFadeMs(100)).toBe(STREAM_TEXT_MIN_FADE_MS)
  })

  it('高吞吐释放的片段使用缩短后的动画时长', () => {
    const view = advanceStreamTextView(
      EMPTY_STREAM_TEXT_VIEW,
      'x'.repeat(120),
      0,
      makeId,
    )
    const durations = new Set(view.parts.map((part) => part.durationMs))
    expect(durations.size).toBe(1)
    expect([...durations][0]).toBe(streamTextFadeMs(12))
    expect([...durations][0]).toBeLessThan(STREAM_TEXT_FADE_MS)
  })
})

describe('advanceStreamTextView', () => {
  it('慢流单字到达：立即挂成一个单字淡入片段', () => {
    const view = advanceStreamTextView(EMPTY_STREAM_TEXT_VIEW, '思', 1000, makeId)
    expect(shownText(view)).toBe('思')
    expect(view.pending).toEqual([])
    expect(view.parts).toHaveLength(1)
    expect(view.parts[0]).toMatchObject({
      text: '思',
      fading: true,
      delayMs: 0,
      durationMs: STREAM_TEXT_FADE_MS,
    })
    expect(view.deadline).toBe(0)
  })

  it('慢流下一个 token 到来时，旧片段收口、新 token 单独淡入', () => {
    const first = advanceStreamTextView(
      EMPTY_STREAM_TEXT_VIEW,
      '思',
      1000,
      makeId,
    )
    const next = advanceStreamTextView(
      first,
      '思考',
      1000 + STREAM_TEXT_FADE_MS + 1,
      makeId,
    )
    expect(shownText(next)).toBe('思考')
    expect(next.parts).toHaveLength(2)
    expect(next.parts[0]).toMatchObject({ text: '思', fading: false })
    expect(next.parts[1]).toMatchObject({ text: '考', fading: true })
  })

  it('成段文本逐帧释放，不会整块同时淡入', () => {
    const text = 'x'.repeat(120)
    let view = advanceStreamTextView(EMPTY_STREAM_TEXT_VIEW, text, 0, makeId)

    // 首帧只放出短缓冲允许的一小段（160ms 窗口 ≈ 10 帧）。
    expect(shownText(view).length).toBeGreaterThan(0)
    expect(shownText(view).length).toBeLessThan(text.length)
    expect(fullText(view)).toBe(text)
    for (const part of view.parts) {
      expect(part.text.length).toBeLessThanOrEqual(2)
    }

    const { view: done, frames } = drain(view, 0)
    expect(fullText(done)).toBe(text)
    expect(frames).toBeGreaterThan(3)
    expect(done.pending).toEqual([])
    expect(done.deadline).toBe(0)
  })

  it('十几个字的短段仍然逐字淡入', () => {
    const text = 'abcdefghij' // 10 个字
    let view = advanceStreamTextView(EMPTY_STREAM_TEXT_VIEW, text, 0, makeId)
    expect(shownText(view)).toBe('a')
    expect(view.parts.map((part) => part.text)).toEqual(['a'])

    const seen: string[] = []
    while (view.pending.length > 0) {
      view = releaseStreamTextView(view, seen.length * STREAM_TEXT_FRAME_MS + 16, makeId)
      const last = view.parts[view.parts.length - 1]
      seen.push(last.text)
    }
    expect(seen.join('')).toBe('bcdefghij')
    expect(seen.every((chunk) => chunk.length === 1)).toBe(true)
    expect(fullText(view)).toBe(text)
  })

  it('大首包走更长的铺开窗口，且始终拆成多个错峰片段', () => {
    const text = 'x'.repeat(1000)
    let view = advanceStreamTextView(EMPTY_STREAM_TEXT_VIEW, text, 0, makeId)

    expect(shownText(view).length).toBeLessThan(text.length)
    expect(view.parts.length).toBeLessThanOrEqual(STREAM_TEXT_MAX_SUB_PARTS)
    for (const part of view.parts) {
      expect(part.text.length).toBeLessThan(Math.ceil(text.length / 4))
      expect(part.delayMs).toBeLessThan(STREAM_TEXT_SUB_STAGGER_MS * STREAM_TEXT_MAX_SUB_PARTS)
    }

    // 420ms 的铺开窗口不会在一两帧内把 1000 字全部放完。
    const oneFrame = releaseStreamTextView(view, STREAM_TEXT_FRAME_MS, makeId)
    expect(oneFrame.pending.length).toBeGreaterThan(0)

    const { view: done, frames } = drain(view, 0)
    expect(fullText(done)).toBe(text)
    expect(frames).toBeGreaterThan(10)
    expect(frames).toBeLessThanOrEqual(
      Math.ceil(STREAM_TEXT_BURST_LAG_MS / STREAM_TEXT_FRAME_MS) + 2,
    )
  })

  it('低于大块阈值的增量走短缓冲（160ms），不会误用首包窗口', () => {
    const text = 'x'.repeat(STREAM_TEXT_BURST_CHARS)
    const view = advanceStreamTextView(EMPTY_STREAM_TEXT_VIEW, text, 0, makeId)
    const expectedPerFrame = Math.ceil(
      text.length / Math.ceil(STREAM_TEXT_MAX_LAG_MS / STREAM_TEXT_FRAME_MS),
    )
    expect(shownText(view).length).toBe(expectedPerFrame)
  })

  it('连续快流：显示滞后有上限，排空后文本完整', () => {
    let view = EMPTY_STREAM_TEXT_VIEW
    let text = ''
    const step = STREAM_TEXT_FRAME_MS
    let now = 0
    for (let i = 0; i < 40; i++) {
      now += step
      text += 'abcdef'
      view = advanceStreamTextView(view, text, now, makeId)
      expect(view.pending.length).toBeLessThanOrEqual(80)
      for (const part of view.parts) {
        // 已收口的稳定片段会合并成长前缀；这里只约束正在淡入的新片段。
        if (part.fading) expect(part.text.length).toBeLessThanOrEqual(10)
      }
    }
    const { view: done } = drain(view, now)
    expect(fullText(done)).toBe(text)
  })

  it('超过 deadline 后的下一帧直接排空（后台标签页回来不继续拖）', () => {
    const text = 'abcdefghijklmnopqrst'
    const view = advanceStreamTextView(EMPTY_STREAM_TEXT_VIEW, text, 0, makeId)
    const catchUp = releaseStreamTextView(
      view,
      STREAM_TEXT_MAX_LAG_MS + 1,
      makeId,
    )
    expect(catchUp.pending).toEqual([])
    expect(fullText(catchUp)).toBe(text)
    expect(catchUp.parts.length).toBeLessThanOrEqual(STREAM_TEXT_MAX_SUB_PARTS)
  })

  it('尾窗滑动：从片段头部裁剪，剩余部分和新增量都保持正确', () => {
    let view = advanceStreamTextView(EMPTY_STREAM_TEXT_VIEW, 'ABCDEFGH', 0, makeId)
    // 逐帧显示到只剩尾部，再让窗口丢掉开头。
    let now = 0
    for (let i = 0; i < 3; i++) {
      now += STREAM_TEXT_FRAME_MS
      view = releaseStreamTextView(view, now, makeId)
    }
    expect(shownText(view)).toBe('ABCD')

    const next = advanceStreamTextView(view, 'CDEFGHIJ', now + 1, makeId)
    expect(fullText(next)).toBe('CDEFGHIJ')
    expect(shownText(next).startsWith('CD')).toBe(true)
    expect(shownText(next).includes('AB')).toBe(false)

    const { view: done } = drain(next, now + 1)
    expect(fullText(done)).toBe('CDEFGHIJ')
  })

  it('尾窗滑动落在 pending 上：被丢掉的字不会再显示', () => {
    const first = advanceStreamTextView(
      EMPTY_STREAM_TEXT_VIEW,
      'ABCDEFGHIJKLMNOP',
      0,
      makeId,
    )
    expect(shownText(first)).toBe('AB') // 160ms 窗口首帧 2 字
    const next = advanceStreamTextView(
      first,
      'DEFGHIJKLMNOPQRST',
      1,
      makeId,
    )
    expect(fullText(next)).toBe('DEFGHIJKLMNOPQRST')
    expect(fullText(next).startsWith('DE')).toBe(true)

    const { view: done } = drain(next, 1)
    expect(fullText(done)).toBe('DEFGHIJKLMNOPQRST')
  })

  it('已收口片段合并为稳定文本，且不改写旧视图对象', () => {
    const first = advanceStreamTextView(EMPTY_STREAM_TEXT_VIEW, 'ab', 0, makeId)
    const oldText = first.parts[0].text
    const next = advanceStreamTextView(
      first,
      'abc',
      STREAM_TEXT_FADE_MS + 1,
      makeId,
    )
    expect(first.parts[0].text).toBe(oldText)
    expect(next.parts[0]).toMatchObject({ text: 'a', fading: false })
    expect(fullText(next)).toBe('abc')
    const { view: done } = drain(next, STREAM_TEXT_FADE_MS + 1)
    expect(fullText(done)).toBe('abc')
  })

  it('文本未变时返回原视图（避免无意义重渲染）', () => {
    const first = advanceStreamTextView(EMPTY_STREAM_TEXT_VIEW, 'abc', 0, makeId)
    expect(advanceStreamTextView(first, 'abc', 2000, makeId)).toBe(first)
  })

  it('文本清空：片段和 pending 一起清掉', () => {
    const first = advanceStreamTextView(EMPTY_STREAM_TEXT_VIEW, 'abc', 0, makeId)
    const empty = advanceStreamTextView(first, '', 100, makeId)
    expect(empty.parts).toEqual([])
    expect(empty.pending).toEqual([])
    expect(fullText(empty)).toBe('')
  })
})

describe('streamViewSettledAt', () => {
  it('空视图与已过期片段都视为已落定', () => {
    expect(streamViewSettledAt(EMPTY_STREAM_TEXT_VIEW, 100)).toBe(0)
    const view: StreamTextView = {
      source: 'ab',
      pending: [],
      parts: [
        {
          id: 1,
          text: 'ab',
          fading: true,
          expiresAt: 200,
          delayMs: 0,
          durationMs: 180,
        },
      ],
      deadline: 0,
    }
    expect(streamViewSettledAt(view, 100)).toBe(200)
    expect(streamViewSettledAt(view, 201)).toBe(0)
  })

  it('pending 未排空时按队列截止时刻 + 最后一段淡入时长估算', () => {
    const view: StreamTextView = {
      source: 'abc',
      pending: ['b', 'c'],
      parts: [
        {
          id: 1,
          text: 'a',
          fading: true,
          expiresAt: 150,
          delayMs: 0,
          durationMs: 180,
        },
      ],
      deadline: 500,
    }
    expect(streamViewSettledAt(view, 100)).toBe(
      500 + STREAM_TEXT_FADE_MS + STREAM_TEXT_SUB_STAGGER_MS,
    )
  })
})
