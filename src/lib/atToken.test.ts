import { describe, expect, it } from 'vitest'
import { atTokenAt } from './atToken'

describe('atTokenAt — @ 文件选择器触发 token 探测', () => {
  it('@ 就是输入首字符时也开选择器（caret 紧跟 @ → 空 query）', () => {
    expect(atTokenAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(atTokenAt('@sr', 3)).toEqual({ start: 0, query: 'sr' })
  })

  it('空白（含换行）之后的 @ 开选择器', () => {
    expect(atTokenAt('see @sr', 7)).toEqual({ start: 4, query: 'sr' })
    expect(atTokenAt('foo\n@sr', 7)).toEqual({ start: 4, query: 'sr' })
  })

  it('嵌在单词里的 @（邮箱）不触发', () => {
    expect(atTokenAt('mail@do', 7)).toBeNull()
  })

  it('紧跟标点后的 @ 不触发（token 必须词首锚定）', () => {
    expect(atTokenAt('a/@sr', 5)).toBeNull()
  })

  it('query 里可以带 /（继续往子路径打）', () => {
    expect(atTokenAt('@src/co', 7)).toEqual({ start: 0, query: 'src/co' })
  })

  it('根目录带点文件名照当一个 token（@package.json）', () => {
    expect(atTokenAt('@package.json', 13)).toEqual({ start: 0, query: 'package.json' })
  })

  it('token 里出现空白 → 光标不在 token 内', () => {
    expect(atTokenAt('@a b', 4)).toBeNull()
  })

  it('caret 正好停在 @ 上不算在 token 内', () => {
    expect(atTokenAt('@', 0)).toBeNull()
  })

  it('整段文本没有 @ 返回 null', () => {
    expect(atTokenAt('普通提问', 4)).toBeNull()
  })
})
