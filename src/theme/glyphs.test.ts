import { describe, expect, it } from 'vitest'
import { Glyphs, toolHeader } from './glyphs'
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS, MONITOR_PULSE_FRAMES, MONITOR_PULSE_INTERVAL_MS } from './glyphs'

describe('glyph 常量', () => {
  it('SVG key 与文本字形齐全', () => {
    expect(Glyphs.promptArrow).toBe('❯')
    expect(Glyphs.diamondFilled).toBe('◆')
    expect(Glyphs.ellipsis).toBe('…')
    expect(Glyphs.cronPrompt).toBe('\u21BB')
  })

  it('spinner / pulse 帧序列与节奏', () => {
    expect(SPINNER_FRAMES).toHaveLength(8)
    expect(SPINNER_INTERVAL_MS).toBe(133)
    expect(MONITOR_PULSE_FRAMES).toEqual(['○', '◎', '◉', '◎'])
    expect(MONITOR_PULSE_INTERVAL_MS).toBe(266)
  })
})

describe('toolHeader', () => {
  it('read / file → Read（running → Reading），pathish', () => {
    expect(toolHeader('read', false)).toEqual({ verb: 'Read', pathish: true })
    expect(toolHeader('Read', true)).toEqual({ verb: 'Reading', pathish: true })
    expect(toolHeader('file', false)).toEqual({ verb: 'Read', pathish: true })
  })

  it('edit / write / create → Edit；delete → Deleted；move → Moved', () => {
    expect(toolHeader('edit', false)).toEqual({ verb: 'Edit', pathish: true })
    expect(toolHeader('create', true)).toEqual({ verb: 'Editing', pathish: true })
    expect(toolHeader('delete', false)).toEqual({ verb: 'Deleted', pathish: true })
    expect(toolHeader('move', true)).toEqual({ verb: 'Moving', pathish: true })
    expect(toolHeader('rename', false)).toEqual({ verb: 'Moved', pathish: true })
  })

  it('search / grep / glob → Searched（非 pathish）', () => {
    expect(toolHeader('search', false)).toEqual({ verb: 'Searched', pathish: false })
    expect(toolHeader('grep', true)).toEqual({ verb: 'Searching', pathish: false })
    expect(toolHeader('glob', false)).toEqual({ verb: 'Searched', pathish: false })
  })

  it('execute 系 → Run；fetch → Fetched；web_search → Searched；list → Listed；think → Thought；mcp → Called', () => {
    expect(toolHeader('execute', false)).toEqual({ verb: 'Run', pathish: false })
    expect(toolHeader('bash', true)).toEqual({ verb: 'Running', pathish: false })
    expect(toolHeader('fetch', false)).toEqual({ verb: 'Fetched', pathish: false })
    expect(toolHeader('webfetch', true)).toEqual({ verb: 'Fetching', pathish: false })
    expect(toolHeader('web_search', false)).toEqual({ verb: 'Searched', pathish: false })
    expect(toolHeader('list_dir', false)).toEqual({ verb: 'Listed', pathish: true })
    expect(toolHeader('think', true)).toEqual({ verb: 'Thinking', pathish: false })
    expect(toolHeader('mcp', false)).toEqual({ verb: 'Called', pathish: false })
    expect(toolHeader('use_tool', true)).toEqual({ verb: 'Calling', pathish: false })
  })

  it('未知 kind → Ran / Running（非 pathish）；undefined 兜底 other', () => {
    expect(toolHeader('weird_tool', false)).toEqual({ verb: 'Ran', pathish: false })
    expect(toolHeader('weird_tool', true)).toEqual({ verb: 'Running', pathish: false })
    expect(toolHeader(undefined, false)).toEqual({ verb: 'Ran', pathish: false })
  })
})