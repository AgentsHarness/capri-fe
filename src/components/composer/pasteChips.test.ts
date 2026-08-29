import { describe, expect, it } from 'vitest'
import {
  chipOccurrenceAt,
  chipOccurrenceAtCaret,
  contentLines,
  expandChips,
  normalizeCr,
  pasteChipLabel,
  pruneChips,
  utf8Len,
  type PasteChip,
} from './pasteChips'

const textChip = (id: string, label: string, content: string): PasteChip => ({
  id,
  label,
  content,
})

describe('normalizeCr', () => {
  it('裸 \r → \n，\r\n 保留', () => {
    expect(normalizeCr('a\r\nb\rc')).toBe('a\r\nb\nc')
  })
})

describe('contentLines', () => {
  it('Rust str::lines 语义：尾随 \n 不计行', () => {
    expect(contentLines('a\nb\nc')).toBe(3)
    expect(contentLines('a\nb\n')).toBe(2)
    expect(contentLines('')).toBe(1)
  })
})

describe('pasteChipLabel', () => {
  it('按行数标注', () => {
    expect(pasteChipLabel('a\nb\nc\nd')).toBe('[Pasted: 4 lines]')
    expect(pasteChipLabel('a\nb\nc')).toBe('[Pasted: 3 lines]')
  })

  it('超过 10KB 按字节标注', () => {
    const big = 'x'.repeat(10_001)
    expect(pasteChipLabel(big)).toBe(`[Pasted: ${Math.floor(10_001 / 1000)} KB]`)
  })
})

describe('chipOccurrenceAt / chipOccurrenceAtCaret', () => {
  const chips = [textChip('1', '[A]', 'aa'), textChip('2', '[B]', 'bb')]
  const text = 'x[A]y[B]z'

  it('inside：落在标签内部才算（右端边界不含）', () => {
    expect(chipOccurrenceAt(text, chips, 2, 'inside')?.chip.id).toBe('1')
    expect(chipOccurrenceAt(text, chips, 4, 'inside')).toBeNull() // end 边界不含
    expect(chipOccurrenceAt(text, chips, 6, 'inside')?.chip.id).toBe('2')
  })

  it('end：光标在标签右边缘才算', () => {
    expect(chipOccurrenceAt(text, chips, 4, 'end')?.chip.id).toBe('1')
    expect(chipOccurrenceAt(text, chips, 8, 'end')?.chip.id).toBe('2')
    expect(chipOccurrenceAt(text, chips, 3, 'end')).toBeNull()
  })

  it('caret 模式含两端边界（双击展开用）', () => {
    expect(chipOccurrenceAtCaret(text, chips, 1)?.chip.id).toBe('1')
    expect(chipOccurrenceAtCaret(text, chips, 4)?.chip.id).toBe('1')
    expect(chipOccurrenceAtCaret(text, chips, 5)?.chip.id).toBe('2')
    expect(chipOccurrenceAtCaret(text, chips, 9)).toBeNull()
  })
})

describe('expandChips', () => {
  it('文本 chip 展开为暂存内容，image chip 标签保留', () => {
    const chips = [
      textChip('1', '[A]', 'alpha'),
      {
        id: '2',
        label: '[Img]',
        content: '',
        image: { data: 'd', mimeType: 'image/png', name: 'i.png', size: 1 },
      },
    ]
    expect(expandChips('x [A] y [Img]', chips)).toBe('x alpha y [Img]')
  })

  it('标签已被编辑掉时保持原样', () => {
    const chips = [textChip('1', '[A]', 'alpha')]
    expect(expandChips('no chip here', chips)).toBe('no chip here')
  })
})

describe('pruneChips', () => {
  it('按插入顺序配对出现位置，编辑掉标签的 chip 被丢弃', () => {
    const a = textChip('1', '[A]', 'aa')
    const a2 = textChip('2', '[A]', 'ab')
    const b = textChip('3', '[B]', 'bb')
    // '[A] [A] [B]'：两个同标签 chip 依次配对
    expect(pruneChips('[A] [A] [B]', [a, a2, b]).map((c) => c.id)).toEqual([
      '1',
      '2',
      '3',
    ])
    // 第二个 [A] 被删：chip 2 丢弃，chip 1/3 保留
    expect(pruneChips('[A] [B]', [a, a2, b]).map((c) => c.id)).toEqual(['1', '3'])
    // 全部被删
    expect(pruneChips('gone', [a, b])).toEqual([])
  })
})

describe('utf8Len', () => {
  it('按 UTF-8 字节数计', () => {
    expect(utf8Len('ab')).toBe(2)
    expect(utf8Len('中')).toBe(3)
  })
})
