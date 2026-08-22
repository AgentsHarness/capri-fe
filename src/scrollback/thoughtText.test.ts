import { describe, expect, it } from 'vitest'
import { Glyphs } from '../theme/glyphs'
import {
  THOUGHT_TRUNCATED_HEAD_LINES,
  THOUGHT_TRUNCATED_TAIL_LINES,
  streamThoughtBody,
  thoughtStreamTail,
  truncatedThoughtLines,
} from './thoughtText'

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

  it('行数超限时从第 6 个换行后截断', () => {
    const per = 300 // 每行 300 字符，9 行 = 2700 字符 > 1600
    const lines = Array.from({ length: 9 }, () => 'L'.repeat(per))
    const text = lines.join('\n')
    const tail = thoughtStreamTail(text)
    expect(tail).not.toBeNull()
    const n = tail!.split('\n').length
    expect(n).toBeLessThanOrEqual(6)
  })

  it('巨段无换行 → 硬切 char 窗口', () => {
    const text = 'a'.repeat(5000)
    const tail = thoughtStreamTail(text)
    expect(tail).toBe(text.slice(5000 - 1600))
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