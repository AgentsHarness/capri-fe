import { describe, expect, it } from 'vitest'
import { contentFromDraft, initialDrafts, parseElicitFields, safeHttpUrl } from './mcpElicit'

describe('mcp elicit schema', () => {
  it('parses string, enum, boolean and builds accept content', () => {
    const fields = parseElicitFields({
      type: 'object',
      required: ['email'],
      properties: {
        email: { type: 'string', title: '邮箱' },
        level: { type: 'string', enum: ['low', 'high'], enumNames: ['低', '高'], default: 'high' },
        agree: { type: 'boolean', default: true },
      },
    })
    expect(fields.map((f) => f.kind)).toEqual(['string', 'single', 'boolean'])
    const draft = initialDrafts(fields)
    draft.email = 'a@b.c'
    const built = contentFromDraft(fields, draft)
    expect(built).toEqual({
      ok: true,
      content: { email: 'a@b.c', level: 'high', agree: true },
    })
  })

  it('refuses a missing required field and a non-http url', () => {
    const fields = parseElicitFields({
      type: 'object',
      required: ['n'],
      properties: { n: { type: 'integer', title: '数量' } },
    })
    expect(contentFromDraft(fields, initialDrafts(fields)).ok).toBe(false)
    expect(safeHttpUrl('https://example.com/auth')).toMatch(/^https:/)
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull()
    expect(safeHttpUrl('https://user:pw@example.com')).toBeNull()
  })
})
