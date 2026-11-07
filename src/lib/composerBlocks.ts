import type { ContentBlock } from '../api/types'
import { expandChips, type PasteChip } from '../components/composer/pasteChips'

/**
 * Build the wire blocks for the current buffer: the text block (text
 * chips expanded) followed by image blocks in chip order. Image chips
 * never occupy the buffer — the text block carries only what the user
 * typed, and each image travels as its own ContentBlock.
 */
export function buildComposerBlocks(
  textValue: string,
  chipList: PasteChip[],
): { expandedText: string; blocks: ContentBlock[] } {
  const expandedText = expandChips(textValue, chipList)
  const blocks: ContentBlock[] = [{ type: 'text', text: expandedText }]
  for (const c of chipList) {
    if (c.image) {
      blocks.push({ type: 'image', data: c.image.data, mimeType: c.image.mimeType })
    }
  }
  return { expandedText, blocks }
}
