/** Non-empty trimmed string, or undefined. */
export function nonBlankStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** First non-empty candidate coerced to string (task / tool ids). */
export function wireTaskId(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (c == null || c === '') continue
    if (typeof c === 'string' || typeof c === 'number' || typeof c === 'bigint') {
      return String(c)
    }
  }
  return ''
}
