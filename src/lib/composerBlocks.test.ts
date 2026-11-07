import { describe, expect, it } from 'vitest'
import { buildComposerBlocks } from './composerBlocks'
import type { PasteChip } from '../components/composer/pasteChips'

function chip(over: Partial<PasteChip>): PasteChip {
  return { id: 'c1', label: '[Pasted: 2 lines]', content: 'a\nb', ...over }
}

describe('buildComposerBlocks', () => {
  it('文本块展开 paste chips 的内容', () => {
    const { expandedText, blocks } = buildComposerBlocks('x [Pasted: 2 lines] y', [
      chip({}),
    ])
    expect(expandedText).toBe('x a\nb y')
    expect(blocks).toEqual([{ type: 'text', text: 'x a\nb y' }])
  })

  it('图片 chip 不进文本，按顺序追加 image block', () => {
    const { blocks } = buildComposerBlocks('hi', [
      chip({
        image: { data: 'AAA', mimeType: 'image/png', name: 'a.png', size: 3 },
      }),
      chip({ id: 'c2', image: { data: 'BBB', mimeType: 'image/jpeg', name: 'b.jpg', size: 3 } }),
    ])
    expect(blocks[0]).toEqual({ type: 'text', text: 'hi' })
    expect(blocks.slice(1)).toEqual([
      { type: 'image', data: 'AAA', mimeType: 'image/png' },
      { type: 'image', data: 'BBB', mimeType: 'image/jpeg' },
    ])
  })

  it('无 chips 时只发一个文本块（含空串）', () => {
    expect(buildComposerBlocks('', [])).toEqual({
      expandedText: '',
      blocks: [{ type: 'text', text: '' }],
    })
  })
})
