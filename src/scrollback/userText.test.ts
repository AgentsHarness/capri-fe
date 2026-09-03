import { describe, expect, it } from 'vitest'
import { Glyphs } from '../theme/glyphs'
import {
  USER_COLLAPSED_MAX_LINES,
  collapseUserText,
  userIsFoldable,
  userVisualLines,
} from './userText'

describe('userVisualLines', () => {
  it('空文本按 1 行计', () => {
    expect(userVisualLines('')).toBe(1)
  })

  it('按 60 字符内容宽度折行估算', () => {
    expect(userVisualLines('a')).toBe(1)
    expect(userVisualLines('a'.repeat(60))).toBe(1)
    expect(userVisualLines('a'.repeat(61))).toBe(2)
  })

  it('多逻辑行求和（空行算 1 行）', () => {
    expect(userVisualLines('a\n\nb')).toBe(3)
    expect(userVisualLines('a\nb\nc\nd')).toBe(4)
  })

  it('CJK/全角宽字符按 2 列计（TUI 按显示宽度折行）', () => {
    // 31 个汉字 = 62 显示列 → 2 行（按字符数 31 只会算成 1 行）。
    expect(userVisualLines('汉'.repeat(31))).toBe(2)
    // 30 个汉字 = 60 列 → 恰好 1 行。
    expect(userVisualLines('汉'.repeat(30))).toBe(1)
    // 全角符号（￥）同宽。
    expect(userVisualLines('￥'.repeat(31))).toBe(2)
  })

  it('Emoji 按宽字符计列', () => {
    expect(userVisualLines('🚀'.repeat(31))).toBe(2)
    expect(userVisualLines('😀'.repeat(30))).toBe(1)
  })

  it('混排宽度求和（宽 2 窄 1）', () => {
    // 20 汉字(40 列) + 20 窄字符(20 列) = 60 列 → 1 行。
    expect(userVisualLines('汉'.repeat(20) + 'a'.repeat(20))).toBe(1)
    // 再多一个汉字 → 62 列 → 2 行。
    expect(userVisualLines('汉'.repeat(21) + 'a'.repeat(20))).toBe(2)
  })
})

describe('userIsFoldable', () => {
  it('超过折叠上限（3 行）才可折叠', () => {
    expect(userVisualLines('a\nb\nc')).toBe(USER_COLLAPSED_MAX_LINES)
    expect(userIsFoldable('a\nb\nc')).toBe(false)
    expect(userIsFoldable('a\nb\nc\nd')).toBe(true)
  })
})

describe('collapseUserText', () => {
  it('行数在上限内原样返回', () => {
    const text = 'l1\nl2\nl3'
    expect(collapseUserText(text, 3)).toEqual({ text, truncated: false })
  })

  it('按 maxLines 截断并给末行补省略号', () => {
    const { text, truncated } = collapseUserText('l1\nl2\nl3\nl4', 2)
    expect(truncated).toBe(true)
    expect(text).toBe(`l1\nl2 ${Glyphs.ellipsis}`)
  })

  it('单逻辑长行按内容宽度折算后截断', () => {
    const { text, truncated } = collapseUserText('x'.repeat(200), 2)
    expect(truncated).toBe(true)
    expect(text.startsWith('x'.repeat(118))).toBe(true)
    expect(text.endsWith(Glyphs.ellipsis)).toBe(true)
  })

  it('CJK 长行截头按显示列宽算（宽字符整体不切半）', () => {
    const { text, truncated } = collapseUserText('汉'.repeat(200), 2)
    expect(truncated).toBe(true)
    // 120 列配额 - 2 列省略号 = 118 列 = 59 个汉字（按字符数 118 会得到
    // 双倍宽度、撑爆折叠行）。
    expect(text.startsWith('汉'.repeat(59))).toBe(true)
    expect(text.startsWith('汉'.repeat(60))).toBe(false)
    expect(text.endsWith(Glyphs.ellipsis)).toBe(true)
  })

  it('maxLines 为 0 时只剩省略号', () => {
    expect(collapseUserText('l1\nl2', 0)).toEqual({ text: Glyphs.ellipsis, truncated: true })
  })
})
