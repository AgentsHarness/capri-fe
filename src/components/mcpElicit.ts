/**
 * x.ai/mcp/elicit form schema — the subset the TUI card edits
 * (mcp_elicitation/schema.rs): string / number / integer / boolean,
 * enum or oneOf single-select, array-of-enum multi-select.
 */

export type ElicitOption = { value: string; label: string }

export type ElicitField =
  | { name: string; title: string; description?: string; required: boolean; kind: 'string' | 'number' | 'integer'; defaultText: string }
  | { name: string; title: string; description?: string; required: boolean; kind: 'boolean'; defaultOn: boolean }
  | { name: string; title: string; description?: string; required: boolean; kind: 'single'; options: ElicitOption[]; defaultIndex: number | null }
  | { name: string; title: string; description?: string; required: boolean; kind: 'multi'; options: ElicitOption[]; defaultIndexes: number[] }
  | { name: string; title: string; description?: string; required: boolean; kind: 'unsupported'; reason: string }

function scalar(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return undefined
}

function optionsFromEnum(values: unknown, names: unknown): ElicitOption[] {
  if (!Array.isArray(values)) return []
  const labels = Array.isArray(names) ? names : []
  const out: ElicitOption[] = []
  values.forEach((v, i) => {
    const value = scalar(v)
    if (!value) return
    const label = typeof labels[i] === 'string' && labels[i] ? (labels[i] as string) : value
    out.push({ value, label })
  })
  return out
}

function optionsFromConst(entries: unknown): ElicitOption[] {
  if (!Array.isArray(entries)) return []
  const out: ElicitOption[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    const value = scalar(rec.const)
    if (!value) continue
    const label = typeof rec.title === 'string' && rec.title ? rec.title : value
    out.push({ value, label })
  }
  return out
}

function defaultIndex(options: ElicitOption[], raw: unknown): number | null {
  const want = scalar(raw)
  if (!want) return null
  const i = options.findIndex((o) => o.value === want)
  return i >= 0 ? i : null
}

export function parseElicitFields(schema: unknown): ElicitField[] {
  if (!schema || typeof schema !== 'object') return []
  const root = schema as Record<string, unknown>
  const props = root.properties
  if (!props || typeof props !== 'object' || Array.isArray(props)) return []
  const required = new Set(
    Array.isArray(root.required) ? root.required.filter((n): n is string => typeof n === 'string') : [],
  )
  const fields: ElicitField[] = []
  for (const [name, prop] of Object.entries(props as Record<string, unknown>)) {
    if (!prop || typeof prop !== 'object' || Array.isArray(prop)) continue
    const p = prop as Record<string, unknown>
    const title = typeof p.title === 'string' && p.title ? p.title : name
    const description = typeof p.description === 'string' ? p.description : undefined
    const base = { name, title, description, required: required.has(name) }
    const enumOpts = optionsFromEnum(p.enum, p.enumNames)
    if (enumOpts.length > 0) {
      fields.push({ ...base, kind: 'single', options: enumOpts, defaultIndex: defaultIndex(enumOpts, p.default) })
      continue
    }
    const oneOf = optionsFromConst(p.oneOf)
    if (oneOf.length > 0) {
      fields.push({ ...base, kind: 'single', options: oneOf, defaultIndex: defaultIndex(oneOf, p.default) })
      continue
    }
    const ty = typeof p.type === 'string' ? p.type : 'string'
    if (ty === 'boolean') {
      fields.push({ ...base, kind: 'boolean', defaultOn: p.default === true })
      continue
    }
    if (ty === 'number' || ty === 'integer') {
      fields.push({ ...base, kind: ty, defaultText: scalar(p.default) ?? '' })
      continue
    }
    if (ty === 'array') {
      const items = p.items && typeof p.items === 'object' ? (p.items as Record<string, unknown>) : undefined
      const opts = items
        ? optionsFromEnum(items.enum, undefined).length
          ? optionsFromEnum(items.enum, undefined)
          : optionsFromConst(items.anyOf ?? items.oneOf)
        : []
      if (opts.length === 0) {
        fields.push({ ...base, kind: 'unsupported', reason: '不支持的多选' })
      } else {
        const defaults = Array.isArray(p.default) ? p.default : []
        const indexes = defaults
          .map((d) => opts.findIndex((o) => o.value === scalar(d)))
          .filter((i) => i >= 0)
        fields.push({ ...base, kind: 'multi', options: opts, defaultIndexes: indexes })
      }
      continue
    }
    if (ty === 'string') {
      fields.push({ ...base, kind: 'string', defaultText: scalar(p.default) ?? '' })
      continue
    }
    fields.push({ ...base, kind: 'unsupported', reason: `不支持的类型 ${ty}` })
  }
  return fields
}

export type ElicitDraft = Record<string, string | boolean | number | number[] | null>

export function initialDrafts(fields: ElicitField[]): ElicitDraft {
  const out: ElicitDraft = {}
  for (const f of fields) {
    if (f.kind === 'boolean') out[f.name] = f.defaultOn
    else if (f.kind === 'single') out[f.name] = f.defaultIndex
    else if (f.kind === 'multi') out[f.name] = [...f.defaultIndexes]
    else if (f.kind === 'unsupported') out[f.name] = ''
    else out[f.name] = f.defaultText
  }
  return out
}

/** Build the accept `content` object, or an error naming the first bad field. */
export function contentFromDraft(
  fields: ElicitField[],
  draft: ElicitDraft,
): { ok: true; content: Record<string, unknown> } | { ok: false; error: string } {
  const content: Record<string, unknown> = {}
  for (const f of fields) {
    if (f.kind === 'unsupported') {
      if (f.required) return { ok: false, error: `${f.title} 无法在这里填写` }
      continue
    }
    if (f.kind === 'boolean') {
      content[f.name] = draft[f.name] === true
      continue
    }
    if (f.kind === 'single') {
      const idx = typeof draft[f.name] === 'number' ? (draft[f.name] as number) : null
      if (idx == null) {
        if (f.required) return { ok: false, error: `请选择${f.title}` }
        continue
      }
      content[f.name] = f.options[idx]?.value
      continue
    }
    if (f.kind === 'multi') {
      const indexes = Array.isArray(draft[f.name]) ? (draft[f.name] as number[]) : []
      if (f.required && indexes.length === 0) return { ok: false, error: `请选择${f.title}` }
      content[f.name] = indexes.map((i) => f.options[i]?.value).filter((v) => v != null)
      continue
    }
    const text = typeof draft[f.name] === 'string' ? (draft[f.name] as string).trim() : ''
    if (!text) {
      if (f.required) return { ok: false, error: `请填写${f.title}` }
      continue
    }
    if (f.kind === 'integer') {
      if (!/^-?\d+$/.test(text)) return { ok: false, error: `${f.title} 需要整数` }
      content[f.name] = Number(text)
      continue
    }
    if (f.kind === 'number') {
      const n = Number(text)
      if (!Number.isFinite(n)) return { ok: false, error: `${f.title} 需要数字` }
      content[f.name] = n
      continue
    }
    content[f.name] = text
  }
  return { ok: true, content }
}

export function safeHttpUrl(raw: string): string | null {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.username || u.password) return null
    return u.toString()
  } catch {
    return null
  }
}
