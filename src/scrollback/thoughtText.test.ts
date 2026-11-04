import { describe, expect, it } from 'vitest'
import { Glyphs } from '../theme/glyphs'
import {
  THOUGHT_LINES_DEFAULT,
  THOUGHT_LINES_MAX,
  THOUGHT_LINES_MIN,
  THOUGHT_STREAM_WINDOW_MAX_CHARS,
  THOUGHT_TRUNCATED_HEAD_LINES,
  THOUGHT_TRUNCATED_TAIL_LINES,
  clampThoughtLines,
  streamThoughtBody,
  thoughtStreamTail,
  thoughtStreamWindow,
  truncatedThoughtLines,
} from './thoughtText'

describe('clampThoughtLines', () => {
  it('范围内取整保留', () => {
    expect(clampThoughtLines(THOUGHT_LINES_MIN)).toBe(1)
    expect(clampThoughtLines(THOUGHT_LINES_MAX)).toBe(20)
    expect(clampThoughtLines(4.4)).toBe(4)
  })

  it('范围外夹到 1–20', () => {
    expect(clampThoughtLines(0)).toBe(THOUGHT_LINES_MIN)
    expect(clampThoughtLines(-3)).toBe(THOUGHT_LINES_MIN)
    expect(clampThoughtLines(99)).toBe(THOUGHT_LINES_MAX)
  })

  it('非法值回落默认 4', () => {
    expect(clampThoughtLines(undefined)).toBe(THOUGHT_LINES_DEFAULT)
    expect(clampThoughtLines(Number.NaN)).toBe(THOUGHT_LINES_DEFAULT)
    expect(clampThoughtLines('8')).toBe(THOUGHT_LINES_DEFAULT)
  })
})

describe('thoughtStreamWindow', () => {
  it('短文本全量，长文本只保留滚动缓冲窗口', () => {
    expect(thoughtStreamWindow('short').text).toBe('short')
    const text = 'x'.repeat(THOUGHT_STREAM_WINDOW_MAX_CHARS + 1)
    const win = thoughtStreamWindow(text)
    expect(win.start).toBeGreaterThan(0)
    expect(win.text.length).toBeLessThanOrEqual(THOUGHT_STREAM_WINDOW_MAX_CHARS)
  })

  it('窗口在 block 边界才推进，不随每个 chunk 滑动', () => {
    const base = 'x'.repeat(THOUGHT_STREAM_WINDOW_MAX_CHARS)
    const w1 = thoughtStreamWindow(base + 'a')
    const w2 = thoughtStreamWindow(base + 'ab')
    const w3 = thoughtStreamWindow(base + 'a'.repeat(2000))
    expect(w2.start).toBe(w1.start)
    expect(w3.start).toBeGreaterThan(w2.start)
  })
})

describe('truncatedThoughtLines', () => {
  it('短正文（<= head+tail）原样返回', () => {
    const lines = ['a', 'b', 'c']
    expect(truncatedThoughtLines(lines.join('\n'))).toEqual(lines)
  })

  it('长正文切成 head + … + tail', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`)
    const out = truncatedThoughtLines(lines.join('\n'))
    expect(out).toEqual([
      ...lines.slice(0, THOUGHT_TRUNCATED_HEAD_LINES),
      Glyphs.ellipsis,
      ...lines.slice(-THOUGHT_TRUNCATED_TAIL_LINES),
    ])
  })

  it('正好 head+tail 行不截断', () => {
    const lines = Array.from({ length: THOUGHT_TRUNCATED_HEAD_LINES + THOUGHT_TRUNCATED_TAIL_LINES }, (_, i) => `l${i}`)
    expect(truncatedThoughtLines(lines.join('\n'))).toEqual(lines)
  })
})

describe('thoughtStreamTail', () => {
  it('短文本 → null（全量渲染）', () => {
    expect(thoughtStreamTail('short')).toBeNull()
    expect(thoughtStreamTail('x'.repeat(1599))).toBeNull()
  })

  it('超长文本取尾部窗口（无近窗换行 → 从窗口起点硬切）', () => {
    const text = 'y'.repeat(1600) + '\n' + 'tail'
    const tail = thoughtStreamTail(text)
    expect(tail).toBe(text.slice(1605 - 1600))
    expect(tail).toBe('y'.repeat(1595) + '\ntail')
  })

  it('窗口边缘行首快照：line start 距窗边 <= SNAP_PAD → 整行纳入', () => {
    // 2000 字符；窗口起点 400；换行在 300 → 行首 301 距窗边 99 → 快照
    const text = 'a'.repeat(300) + '\n' + 'c'.repeat(1699)
    const tail = thoughtStreamTail(text)
    expect(tail).toBe('c'.repeat(1699))
  })

  it('行首远在窗边之前（> SNAP_PAD）→ 硬切 char 窗口', () => {
    const text = 'x'.repeat(401) + '\n' + 'c'.repeat(1598)
    const tail = thoughtStreamTail(text)
    expect(tail).toBe(text.slice(400))
    expect(tail?.startsWith('x')).toBe(true)
  })

  it('行数超限时只保留最后 6 行', () => {
    const per = 300 // 每行 300 字符，9 行 = 2700 字符 > 1600
    const lines = Array.from({ length: 9 }, () => 'L'.repeat(per))
    const text = lines.join('\n')
    const tail = thoughtStreamTail(text)
    expect(tail).not.toBeNull()
    expect(tail!.split('\n')).toEqual(lines.slice(-6))
  })

  it('短行也不突破行数上限（回归：正向扫描曾保留上百行）', () => {
    const lines = Array.from({ length: 300 }, () => 'abcdefgh')
    const tail = thoughtStreamTail(lines.join('\n'))
    expect(tail).not.toBeNull()
    expect(tail!.split('\n')).toEqual(lines.slice(-6))
  })

  it('巨段无换行 → 硬切 char 窗口', () => {
    const text = 'a'.repeat(5000)
    const tail = thoughtStreamTail(text)
    expect(tail).toBe(text.slice(5000 - 1600))
  })

  it('maxLines 放大时尾部窗口能保留超过默认 6 行的内容', () => {
    const text = Array.from({ length: 30 }, () => 'L'.repeat(200)).join('\n')
    const tail = thoughtStreamTail(text, 20)
    expect(tail).not.toBeNull()
    const n = tail!.split('\n').length
    expect(n).toBeGreaterThan(6)
    expect(n).toBeLessThanOrEqual(20)
  })
})

describe('streamThoughtBody', () => {
  it('未超限 → 原文本', () => {
    expect(streamThoughtBody('ok')).toBe('ok')
  })

  it('超限 → ellipsis + tail', () => {
    const text = 'a'.repeat(5000)
    expect(streamThoughtBody(text)).toBe(`${Glyphs.ellipsis}\n${text.slice(3400)}`)
  })
})