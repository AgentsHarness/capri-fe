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

  it('maxLines 为 0 时只剩省略号', () => {
    expect(collapseUserText('l1\nl2', 0)).toEqual({ text: Glyphs.ellipsis, truncated: true })
  })
})
