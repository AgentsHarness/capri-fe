/**
 * Best-effort LaTeX math → Unicode plain-text conversion + math delimiter
 * normalization, ported from the TUI's `xai-grok-markdown` crate
 * (`latex/mod.rs`, `latex/commands.rs`, `latex/symbols.rs`,
 * `latex_delimiters.rs`).
 *
 * - Delimiters: `$...$` (inline), `$$...$$` (display), `\(...\)` / `\[...\]`
 *   and `\begin{equation[*]}...\end{equation[*]}` (normalized to the `$`
 *   forms, boundary whitespace trimmed, interior lines joined — exactly the
 *   TUI's latex_delimiters transform set, applied to the RAW source before
 *   markdown parsing so CommonMark cannot eat the backslashes).
 * - The converter is best-effort: superscripts/subscripts via Unicode script
 *   chars, fractions, roots, Greek letters, common symbols, accents,
 *   alphabets and row environments. Unsupported commands degrade to their
 *   bare name; unsupported formulas keep their raw source (TUI semantics).
 * - Streaming-safe: an unclosed delimiter never converts (the span is only
 *   emitted once its closing delimiter is present).
 *
 * No third-party dependencies — the TUI's converter is also self-written.
 */

/* ------------------------------------------------------------------------
 * Raw-level delimiter normalization + span escape protection.
 *
 * Mirrors the TUI's LatexDelimiterNormalizer: applied OUTSIDE code (fenced
 * and inline code is copied verbatim), with escape parity (`\\` is a
 * literal pair, so `\\(` is not an opener) and a bounded look-ahead
 * (MAX_MATH_SOURCE_LEN).
 *
 * Why the raw level: remark-parse treats `\(`/`\[`/`\\`/`\$` as CommonMark
 * escapes and would strip the backslashes before the AST exists, so the
 * backslash delimiter forms must be rewritten before parsing — the same
 * reason the TUI normalizes before pulldown-cmark.
 *
 * Span interiors additionally get their backslashes DOUBLED. Markdown's
 * escape processing then undoes the doubling one-for-one (`\\` → `\`), so
 * row separators (`\\`), `\$`, `\{` etc. inside math arrive at the AST
 * intact. Outside math spans nothing is doubled, so prose is untouched.
 * ---------------------------------------------------------------------- */

export type MathSpan =
  | { kind: 'text'; text: string }
  | { kind: 'inline'; src: string }
  | { kind: 'display'; src: string }

/** Inputs larger than this are not converted (TUI MAX_MATH_SOURCE_LEN). */
export const MAX_MATH_SOURCE_LEN = 4096

const WS_RE = /\s/
const DIGIT_RE = /^[0-9]$/

function isAsciiWs(ch: string): boolean {
  return ch === ' ' || (ch >= '\t' && ch <= '\r')
}

/** Trim ASCII whitespace at both ends (TUI trim set: ' ' | '\t'..='\r'). */
function trimBoundaryWs(s: string): string {
  let a = 0
  let b = s.length
  while (a < b && isAsciiWs(s[a])) a++
  while (b > a && isAsciiWs(s[b - 1])) b--
  return s.slice(a, b)
}

/**
 * Join a span interior's lines (TUI push_joined_lines: each line trimmed,
 * non-empty lines joined with single spaces — TeX treats newlines as
 * spaces), then double every backslash so the markdown parser's escape
 * processing leaves the math content byte-identical in the AST.
 */
function joinAndProtect(s: string): string {
  let joined: string
  if (!s.includes('\n')) {
    joined = s
  } else {
    joined = s
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
      .join(' ')
  }
  return joined.replace(/\\/g, '\\\\')
}

/** True when the `$` at `i` is escaped by an odd run of backslashes. */
function isEscapedDollar(text: string, i: number): boolean {
  let bs = 0
  let k = i - 1
  while (k >= 0 && text[k] === '\\') {
    bs++
    k--
  }
  return bs % 2 === 1
}

/** Find the unescaped `\)` closing a `\(` at `openIdx` (index of the `\`). */
function findInlineClose(text: string, openIdx: number): number {
  let k = openIdx + 2
  const n = text.length
  while (k < n) {
    if (k - (openIdx + 2) > MAX_MATH_SOURCE_LEN) return -1
    if (text[k] === '\\') {
      const nx = text[k + 1]
      if (nx === ')') return k
      if (nx === undefined) break
      k += 2 // `\\` pair or `\x` escape: span content
    } else {
      k += 1
    }
  }
  return -1
}

/**
 * Find a display-span close token from `contentStart` and return its
 * `{ start, len }` (token start and length). Any of `\]`, `$$` (run ≥ 2),
 * `\end{equation[*]}` closes — matching the TUI's "every delimiter
 * normalizes to `$$` independently". Bounded by MAX_MATH_SOURCE_LEN; null
 * when no close is in reach.
 *
 * `raw` mode additionally aborts at a blank line or a `>` blockquote
 * marker (TUI display_join_aborts_at_blank_line / _blockquote_marker) —
 * those are paragraph breaks / quoted math that must not fuse into one span
 * at the raw level.
 */
function findDisplayClose(
  text: string,
  contentStart: number,
  raw: boolean,
): { start: number; len: number } | null {
  let k = contentStart
  const n = text.length
  while (k < n) {
    if (k - contentStart > MAX_MATH_SOURCE_LEN) return null
    const ch = text[k]
    if (ch === '\\') {
      const nx = text[k + 1]
      if (nx === ']') return { start: k, len: 2 }
      if (nx === undefined) break
      if (nx === 'e') {
        const m = /^\\end\{equation\*?\}/.exec(text.slice(k))
        if (m) return { start: k, len: m[0].length }
      }
      k += 2 // `\\` pair or `\x` escape: span content
    } else if (ch === '$') {
      if (text[k + 1] === '$') return { start: k, len: 2 }
      if (text[k + 1] === undefined) break
      k += 1 // lone `$` is span content
    } else if (ch === '\n' && raw) {
      // Look at the next line's start: blank line or `>` marker aborts.
      let j = k + 1
      while (j < n && (text[j] === ' ' || text[j] === '\t')) j++
      if (j >= n) break
      if (text[j] === '\n' || text[j] === '>') return null
      k += 1
    } else {
      k += 1
    }
  }
  return null
}

/**
 * Find the `$` closing an inline `$…$` span opened at `openIdx`.
 * Flanking rules (pulldown-cmark math extension): the closing `$` must not
 * be preceded by whitespace and must not be followed by a digit (`$5` is
 * currency, not a close). A `$$` run is a display opener, not a close;
 * an escaped `\$` (odd backslash run) is span content, not a close.
 */
function findInlineDollarClose(text: string, openIdx: number): number {
  let k = openIdx + 1
  const n = text.length
  while (k < n) {
    if (k - openIdx > MAX_MATH_SOURCE_LEN) return -1
    const ch = text[k]
    if (ch === '\\') {
      k += 2 // `\$`, `\\` etc: span content (escape parity)
      continue
    }
    if (ch === '$') {
      if (text[k + 1] === '$') {
        k += 2
        continue
      }
      const prev = text[k - 1]
      const nx = text[k + 1]
      if (prev !== undefined && !isAsciiWs(prev) && !(nx !== undefined && DIGIT_RE.test(nx))) {
        return k
      }
    }
    k += 1
  }
  return -1
}

/**
 * Normalize math delimiters in RAW markdown source (before parsing):
 * `\(…\)` → `$…$`, `\[…\]` / `$$…$$` / `\begin{equation[*]}` → `$$…$$`,
 * interiors line-joined and backslash-protected. Code (fenced + inline),
 * escaped delimiters (`\\`, `\$`) and unclosed spans stay verbatim.
 *
 * The TUI's `LatexDelimiterNormalizer` is chunk-split invariant; the FE
 * re-normalizes the whole source on every render (streaming chunks arrive
 * as one growing string), which is equivalent to one-shot `push`+`finish`
 * — and unclosed tails simply stay literal until their close arrives.
 */
export function normalizeMathDelimiters(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  type State =
    | { kind: 'normal' }
    | { kind: 'inline'; run: number }
    | { kind: 'fenced'; ch: string; len: number }
  let state: State = { kind: 'normal' }
  let atLineStart = true

  while (i < n) {
    if (state.kind === 'normal') {
      if (atLineStart) {
        // Fence open: up to 3 spaces, then a run of ≥3 backticks/tildes.
        const m = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(src.slice(i))
        if (m) {
          const run = m[1]
          out += src.slice(i, i + m[0].length)
          i += m[0].length
          state = { kind: 'fenced', ch: run[0], len: run.length }
          atLineStart = false
          continue
        }
      }
      const ch = src[i]
      if (ch === '\n') {
        out += '\n'
        i += 1
        atLineStart = true
        continue
      }
      if (ch === '`') {
        let j = i
        while (j < n && src[j] === '`') j++
        out += src.slice(i, j)
        i = j
        state = { kind: 'inline', run: j - i }
        atLineStart = false
        continue
      }
      if (ch === '\\') {
        const nx = src[i + 1]
        if (nx === '\\') {
          // Escaped backslash pair: literal, so `\\(` is not an opener.
          out += '\\\\'
          i += 2
          atLineStart = false
          continue
        }
        if (nx === '$') {
          // Escaped dollar: literal (TUI escape parity).
          out += '\\$'
          i += 2
          atLineStart = false
          continue
        }
        if (nx === '(') {
          const close = findInlineClose(src, i)
          if (close > i) {
            out += `$${joinAndProtect(trimBoundaryWs(src.slice(i + 2, close)))}$`
            i = close + 2
            atLineStart = false
            continue
          }
          out += '\\'
          i += 1
          atLineStart = false
          continue
        }
        if (nx === '[') {
          const close = findDisplayClose(src, i + 2, true)
          if (close) {
            out += `$$${joinAndProtect(trimBoundaryWs(src.slice(i + 2, close.start)))}$$`
            i = close.start + close.len
            atLineStart = false
            continue
          }
          out += '\\'
          i += 1
          atLineStart = false
          continue
        }
        if (nx === 'b' || nx === 'e') {
          const begin = /^\\begin\{equation\*?\}/.exec(src.slice(i))
          if (begin) {
            const close = findDisplayClose(src, i + begin[0].length, true)
            if (close) {
              out += `$$${joinAndProtect(
                trimBoundaryWs(src.slice(i + begin[0].length, close.start)),
              )}$$`
              i = close.start + close.len
              atLineStart = false
              continue
            }
          } else {
            const end = /^\\end\{equation\*?\}/.exec(src.slice(i))
            if (end) {
              // Stray \end{equation[*]}: maps to `$$` position-for-position.
              out += '$$'
              i += end[0].length
              atLineStart = false
              continue
            }
          }
        }
        out += '\\'
        i += 1
        atLineStart = false
        continue
      }
      if (ch === '$') {
        if (src[i + 1] === '$') {
          const close = findDisplayClose(src, i + 2, true)
          if (close) {
            out += `$$${joinAndProtect(trimBoundaryWs(src.slice(i + 2, close.start)))}$$`
            i = close.start + close.len
            atLineStart = false
            continue
          }
          out += '$$'
          i += 2
          atLineStart = false
          continue
        }
        const nx = src[i + 1]
        if (nx !== undefined && !WS_RE.test(nx) && nx !== '$') {
          const close = findInlineDollarClose(src, i)
          if (close > i) {
            out += `$${joinAndProtect(src.slice(i + 1, close))}$`
            i = close + 1
            atLineStart = false
            continue
          }
        }
        out += '$'
        i += 1
        atLineStart = false
        continue
      }
      // Plain run up to the next interesting char.
      const start = i
      while (i < n && !'\n`\\$'.includes(src[i])) i++
      out += src.slice(start, i)
      atLineStart = false
    } else if (state.kind === 'inline') {
      // Single-line inline code: copy verbatim until a matching backtick
      // run closes it or the line ends (unterminated → back to normal).
      const start = i
      let handled = false
      while (i < n) {
        const c = src[i]
        if (c === '\n') {
          i += 1
          out += src.slice(start, i)
          state = { kind: 'normal' }
          atLineStart = true
          handled = true
          break
        }
        if (c === '`') {
          let j = i
          while (j < n && src[j] === '`') j++
          const run = j - i
          if (run === state.run) {
            i = j
            out += src.slice(start, i)
            state = { kind: 'normal' }
            atLineStart = false
            handled = true
            break
          }
          i = j // non-matching run is literal content
        } else {
          i += 1
        }
      }
      if (!handled) {
        out += src.slice(start, i) // EOF inside code
      }
    } else {
      // Fenced code: copy verbatim until a close fence at line start.
      if (atLineStart) {
        const m = new RegExp(`^[ \\t]{0,3}${state.ch}{${state.len},}[ \\t]*$`).exec(
          src.slice(i),
        )
        if (m) {
          out += src.slice(i, i + m[0].length)
          i += m[0].length
          state = { kind: 'normal' }
          atLineStart = false
          continue
        }
      }
      const start = i
      while (i < n && src[i] !== '\n') i++
      if (i < n) {
        i += 1 // include the newline
        atLineStart = true
      } else {
        atLineStart = false
      }
      out += src.slice(start, i)
    }
  }
  return out
}

/**
 * Split an AST text run into math spans (`$…$` inline, `$$…$$` display).
 * Unclosed delimiters stay literal, so a streaming tail (`$E=mc^2` without
 * its closing `$`) renders as plain text until the close arrives — the same
 * "closed-only" rule the mermaid rendering uses.
 *
 * Post-parse only the `$` forms can appear: the backslash delimiter forms
 * were already normalized (or escaped) at the raw level, and code content
 * never flows through text runs (react-markdown routes it through the
 * `code` component).
 */
export function scanMathSpans(text: string): MathSpan[] {
  const out: MathSpan[] = []
  const n = text.length
  let i = 0
  let plain = ''
  const flush = () => {
    if (plain) {
      out.push({ kind: 'text', text: plain })
      plain = ''
    }
  }
  while (i < n) {
    const ch = text[i]
    if (ch === '\\') {
      const nx = text[i + 1]
      if (nx === '\\') {
        // Escaped backslash pair (post-parse `\\` = one literal `\`):
        // emit both so a following `(`/`[`/`$` is not read as a delimiter.
        plain += '\\\\'
        i += 2
        continue
      }
      plain += '\\'
      i += 1
      continue
    }
    if (ch === '$') {
      if (text[i + 1] === '$') {
        const close = findDisplayClose(text, i + 2, false)
        if (close) {
          flush()
          out.push({ kind: 'display', src: trimBoundaryWs(text.slice(i + 2, close.start)) })
          i = close.start + close.len
          continue
        }
        plain += '$$'
        i += 2
        continue
      }
      const nx = text[i + 1]
      if (
        nx !== undefined &&
        !WS_RE.test(nx) &&
        nx !== '$' &&
        !isEscapedDollar(text, i)
      ) {
        const close = findInlineDollarClose(text, i)
        if (close > i) {
          flush()
          out.push({ kind: 'inline', src: text.slice(i + 1, close) })
          i = close + 1
          continue
        }
      }
      plain += '$'
      i += 1
      continue
    }
    const start = i
    while (i < n && text[i] !== '\\' && text[i] !== '$') i++
    plain += text.slice(start, i)
  }
  flush()
  return out
}

/* ------------------------------------------------------------------------
 * LaTeX → Unicode converter (TUI latex/commands.rs + symbols.rs port).
 * ---------------------------------------------------------------------- */

type Mode = 'math' | 'text'
type ScriptKind = 'super' | 'sub'

const MAX_DEPTH = 32

class Cursor {
  src: string
  pos: number
  constructor(src: string) {
    this.src = src
    this.pos = 0
  }
  atEnd(): boolean {
    return this.pos >= this.src.length
  }
  peek(): string | undefined {
    return this.src[this.pos]
  }
  bump(): string | undefined {
    const ch = this.src[this.pos]
    this.pos += 1
    return ch
  }
}

/** Output buffer: flat string with '\n' row separators. */
class Out {
  buf: string
  constructor() {
    this.buf = ''
  }
  push(s: string): void {
    this.buf += s
  }
  atLineStart(): boolean {
    return this.buf.length === 0 || this.buf.endsWith('\n')
  }
  endsWithSpace(): boolean {
    return this.buf.length > 0 && WS_RE.test(this.buf[this.buf.length - 1])
  }
  lines(): string[] {
    return this.buf.split('\n')
  }
}

/** Unicode superscripts — TUI symbols.rs to_superscript. */
const SUPERSCRIPTS: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶',
  '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼',
  '(': '⁽', ')': '⁾', a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ',
  g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ', o: 'ᵒ',
  p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ',
  z: 'ᶻ', T: 'ᵀ', '*': '*', '∗': '*', '′': '′', "'": '′', ' ': ' ',
}

/** Unicode subscripts — TUI symbols.rs to_subscript. */
const SUBSCRIPTS: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆',
  '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌',
  '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ',
  l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ',
  v: 'ᵥ', x: 'ₓ', ' ': ' ',
}

/** Build an alphabet map: A-Z from `baseUpper`, a-z from `baseLower`. */
function mappedAlphabet(baseUpper: number, baseLower: number, baseDigits?: number): Record<string, string> {
  const map: Record<string, string> = {}
  for (let i = 0; i < 26; i++) {
    map[String.fromCharCode(65 + i)] = String.fromCodePoint(baseUpper + i)
    map[String.fromCharCode(97 + i)] = String.fromCodePoint(baseLower + i)
  }
  if (baseDigits !== undefined) {
    for (let i = 0; i < 10; i++) {
      map[String(i)] = String.fromCodePoint(baseDigits + i)
    }
  }
  return map
}

/** \mathbb — TUI symbols.rs map_mathbb. */
const MATHBB: Record<string, string> = {
  ...mappedAlphabet(0x1d538, 0x1d552, 0x1d7d8),
  C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ',
}

/** \mathcal — TUI symbols.rs map_mathcal. */
const MATHCAL: Record<string, string> = {
  ...mappedAlphabet(0x1d49c, 0x1d4b6),
  B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ',
  e: 'ℯ', g: 'ℊ', o: 'ℴ',
}

/** \mathfrak — TUI symbols.rs map_mathfrak. */
const MATHFRAK: Record<string, string> = {
  ...mappedAlphabet(0x1d504, 0x1d51e),
  C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ',
}

/** \mathbf — TUI symbols.rs map_mathbf. */
const MATHBF: Record<string, string> = {
  ...mappedAlphabet(0x1d400, 0x1d41a, 0x1d7ce),
}

/** Symbol command table — TUI symbols.rs symbol(). */
const SYMBOLS: Record<string, string> = {
  // Greek lowercase
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ',
  varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  omicron: 'ο', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ',
  varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ',
  psi: 'ψ', omega: 'ω',
  // Greek uppercase
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  // Big operators
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭',
  oint: '∮', bigcup: '⋃', bigcap: '⋂', bigvee: '⋁', bigwedge: '⋀',
  bigoplus: '⨁', bigotimes: '⨂', bigodot: '⨀', biguplus: '⨄',
  // Named operators (render as plain words)
  lim: 'lim', limsup: 'lim sup', liminf: 'lim inf', sin: 'sin', cos: 'cos',
  tan: 'tan', cot: 'cot', sec: 'sec', csc: 'csc', arcsin: 'arcsin',
  arccos: 'arccos', arctan: 'arctan', sinh: 'sinh', cosh: 'cosh',
  tanh: 'tanh', coth: 'coth', log: 'log', ln: 'ln', lg: 'lg', exp: 'exp',
  max: 'max', min: 'min', sup: 'sup', inf: 'inf', det: 'det', dim: 'dim',
  ker: 'ker', deg: 'deg', arg: 'arg', gcd: 'gcd', hom: 'hom', Pr: 'Pr',
  // Binary operators
  times: '×', cdot: '⋅', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆',
  circ: '∘', bullet: '•', oplus: '⊕', ominus: '⊖', otimes: '⊗',
  oslash: '⊘', odot: '⊙', wedge: '∧', land: '∧', vee: '∨', lor: '∨',
  cap: '∩', cup: '∪', setminus: '∖', smallsetminus: '∖', uplus: '⊎',
  sqcap: '⊓', sqcup: '⊔', triangleleft: '◁', triangleright: '▷', wr: '≀',
  diamond: '⋄', dagger: '†', ddagger: '‡', amalg: '⨿',
  // Relations
  le: '≤', leq: '≤', leqslant: '≤', ge: '≥', geq: '≥', geqslant: '≥',
  ne: '≠', neq: '≠', ll: '≪', gg: '≫', approx: '≈', sim: '∼',
  simeq: '≃', cong: '≅', equiv: '≡', doteq: '≐', propto: '∝', prec: '≺',
  succ: '≻', preceq: '⪯', succeq: '⪰', asymp: '≍', in: '∈', ni: '∋',
  owns: '∋', notin: '∉', subset: '⊂', supset: '⊃', subseteq: '⊆',
  supseteq: '⊇', subsetneq: '⊊', supsetneq: '⊋', sqsubseteq: '⊑',
  sqsupseteq: '⊒', vdash: '⊢', dashv: '⊣', models: '⊨', vDash: '⊨',
  perp: '⊥', parallel: '∥', nparallel: '∦', mid: '∣', nmid: '∤',
  smile: '⌣', frown: '⌢', bowtie: '⋈',
  // Arrows
  to: '→', rightarrow: '→', leftarrow: '←', gets: '←',
  leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐',
  Leftrightarrow: '⇔', implies: '⟹', impliedby: '⟸', iff: '⟺',
  longrightarrow: '⟶', longleftarrow: '⟵', longmapsto: '⟼', mapsto: '↦',
  uparrow: '↑', downarrow: '↓', updownarrow: '↕', Uparrow: '⇑',
  Downarrow: '⇓', nearrow: '↗', searrow: '↘', swarrow: '↙', nwarrow: '↖',
  hookrightarrow: '↪', hookleftarrow: '↩', rightharpoonup: '⇀',
  leftharpoonup: '↼', rightleftharpoons: '⇌',
  // Logic / sets / misc letters
  forall: '∀', exists: '∃', nexists: '∄', neg: '¬', lnot: '¬',
  emptyset: '∅', varnothing: '∅', infty: '∞', nabla: '∇', partial: '∂',
  hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', beth: 'ℶ', wp: '℘',
  imath: 'ı', jmath: 'ȷ', top: '⊤', bot: '⊥', angle: '∠',
  measuredangle: '∡', triangle: '△', square: '□', Box: '□',
  blacksquare: '■', diamondsuit: '♦', heartsuit: '♥', clubsuit: '♣',
  spadesuit: '♠', flat: '♭', natural: '♮', sharp: '♯', checkmark: '✓',
  degree: '°', prime: '′', dprime: '″', therefore: '∴', because: '∵',
  dots: '…', ldots: '…', dotsc: '…', dotso: '…', dotsb: '…', dotsm: '…',
  cdots: '⋯', vdots: '⋮', ddots: '⋱', surd: '√', AA: 'Å',
  // Delimiters
  langle: '⟨', rangle: '⟩', lceil: '⌈', rceil: '⌉', lfloor: '⌊',
  rfloor: '⌋', lbrace: '{', rbrace: '}', lbrack: '[', rbrack: ']',
  vert: '|', Vert: '‖', '|': '‖', backslash: '\\', setbslash: '∖',
  // Escaped literals
  '{': '{', '}': '}', '%': '%', '$': '$', '&': '&', '#': '#', '_': '_',
}

/** \not negation map — TUI commands.rs. */
const NEGATIONS: Record<string, string> = {
  '∈': '∉', '=': '≠', '<': '≮', '>': '≯', '≡': '≢', '⊂': '⊄', '⊆': '⊈',
  '∃': '∄',
}

/** Text-family commands: scripts over them render as words, not letters. */
const TEXT_MARKERS = [
  '\\text',
  '\\mathrm',
  '\\mathsf',
  '\\mathtt',
  '\\mathit',
  '\\operatorname',
  '\\mbox',
  '\\hbox',
]

/** Row-layout environments (TUI environments.rs): rows split on `\\`. */
const ROW_ENVIRONMENTS = new Set([
  'aligned',
  'align',
  'align*',
  'gathered',
  'matrix',
  'pmatrix',
  'bmatrix',
  'Bmatrix',
  'vmatrix',
  'Vmatrix',
  'cases',
  'dcases',
  'rcases',
])

/* ── rendering primitives ─────────────────────────────────────────── */

/** Consume `{...}` (after optional whitespace) and return the body source. */
function takeBraceArg(c: Cursor): string | undefined {
  while (!c.atEnd() && WS_RE.test(c.peek()!)) c.bump()
  if (c.peek() === '{') {
    c.bump()
    return readGroupBody(c)
  }
  return undefined
}

/** Read a `{...}` group body; the opening `{` is already consumed. */
function readGroupBody(c: Cursor): string {
  let depth = 1
  const start = c.pos
  while (!c.atEnd()) {
    const ch = c.src[c.pos]
    if (ch === '\\') {
      // Escaped braces (`\{`, `\}`) don't count; consume the pair.
      c.pos += Math.min(2, c.src.length - c.pos)
      continue
    }
    c.pos += 1
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) break
    }
  }
  return c.src.slice(start, Math.max(start, c.pos - 1))
}

/**
 * Read the next atom: a `{...}` group body, a `\command` (returned with its
 * backslash), or a single char. Skips leading whitespace (TUI cursor.rs
 * read_atom — so `\not =` reads `=`, `x^\alpha` reads `\alpha`).
 */
function readAtom(c: Cursor): string | undefined {
  skipWs(c)
  const start = c.pos
  const ch = c.peek()
  if (ch === undefined) return undefined
  if (ch === '{') {
    c.bump()
    return readGroupBody(c)
  }
  if (ch === '\\') {
    c.bump()
    readCommandName(c)
    return c.src.slice(start, c.pos)
  }
  c.bump()
  return ch
}

/** Read a command name after the consumed `\` (letters, else one char). */
function readCommandName(c: Cursor): string {
  const rest = c.src.slice(c.pos)
  const m = /^[a-zA-Z]+/.exec(rest)
  if (m) {
    c.pos += m[0].length
    return m[0]
  }
  const ch = c.src[c.pos]
  if (ch !== undefined) {
    c.pos += 1
    return ch
  }
  return ''
}

function skipWs(c: Cursor): void {
  while (!c.atEnd() && WS_RE.test(c.peek()!)) c.bump()
}

/** Render an atom (command argument) to a flat string. */
function renderAtom(atom: string, depth: number, mode: Mode): string {
  const c = new Cursor(atom)
  const out = new Out()
  renderSequence(c, out, depth + 1, mode)
  return out.lines().join('')
}

function renderSequence(c: Cursor, out: Out, depth: number, mode: Mode): void {
  while (!c.atEnd()) {
    const ch = c.peek()!
    if (ch === '\\') {
      c.bump()
      renderCommand(c, out, depth, mode)
      continue
    }
    c.bump()
    switch (ch) {
      case '{':
        if (depth >= MAX_DEPTH) {
          // Too deep: render the group body flat, without recursing.
          out.push(readGroupBody(c))
        } else {
          const body = readGroupBody(c)
          const sub = new Cursor(body)
          renderSequence(sub, out, depth + 1, mode)
        }
        break
      case '}':
        // Unbalanced closing brace: drop it.
        break
      case '^':
        renderScript(c, out, depth, mode, 'super')
        break
      case '_':
        renderScript(c, out, depth, mode, 'sub')
        break
      case '~':
        out.push(' ')
        break
      case '&':
        // Alignment marker outside an environment: drop.
        break
      case '$':
        // Stray math delimiter inside math: drop.
        break
      case '-':
        out.push(mode === 'math' ? '−' : '-')
        break
      case "'":
        out.push(mode === 'math' ? '′' : "'")
        break
      default:
        if (WS_RE.test(ch)) {
          // TeX collapses whitespace runs; keep a single space.
          while (!c.atEnd() && WS_RE.test(c.peek()!)) c.bump()
          if (!out.atLineStart() && !out.endsWithSpace()) out.push(' ')
        } else {
          out.push(ch)
        }
    }
  }
}

/**
 * Render `^atom` / `_atom` via Unicode script chars when every char maps;
 * otherwise `^x` / `^(…)` fallback. Word-like atoms (`x_{max}`) take the
 * fallback even when fully mappable (TUI script_atom_is_wordlike).
 */
function renderScript(
  c: Cursor,
  out: Out,
  depth: number,
  mode: Mode,
  kind: ScriptKind,
): void {
  const atom = readAtom(c)
  if (atom === undefined) {
    out.push(kind === 'super' ? '^' : '_')
    return
  }
  const rendered = renderAtom(atom, depth, mode)
  if (!scriptAtomIsWordlike(atom, rendered)) {
    const table = kind === 'super' ? SUPERSCRIPTS : SUBSCRIPTS
    const mapped = [...rendered].map((ch) => table[ch]).filter((s) => s !== undefined)
    if (mapped.length === rendered.length && mapped.length > 0) {
      out.push(mapped.join(''))
      return
    }
  }
  out.push(kind === 'super' ? '^' : '_')
  if ([...rendered].length > 1) {
    out.push(`(${rendered})`)
  } else {
    out.push(rendered)
  }
}

/** True if a script atom reads as a word label (text family or 3+ letters). */
function scriptAtomIsWordlike(atom: string, rendered: string): boolean {
  if (TEXT_MARKERS.some((m) => atom.includes(m))) return true
  let run = 0
  for (const ch of rendered) {
    if (/[a-zA-Z]/.test(ch)) {
      run += 1
      if (run >= 3) return true
    } else {
      run = 0
    }
  }
  return false
}

/** True if a fraction/root operand needs parentheses for readability. */
function needsParens(s: string): boolean {
  return [...s].length > 1 && /[ +−\-=/]/.test(s)
}

/** Format num/den, mapping common numeric fractions to vulgar fractions. */
function formatFraction(num: string, den: string): string {
  const vulgar: Record<string, string> = {
    '1/2': '½', '1/3': '⅓', '2/3': '⅔', '1/4': '¼', '3/4': '¾',
    '1/5': '⅕', '2/5': '⅖', '3/5': '⅗', '4/5': '⅘', '1/6': '⅙',
    '5/6': '⅚', '1/7': '⅐', '1/8': '⅛', '3/8': '⅜', '5/8': '⅝',
    '7/8': '⅞', '1/9': '⅑', '1/10': '⅒',
  }
  const v = vulgar[`${num}/${den}`]
  if (v) return v
  const n = needsParens(num) ? `(${num})` : num
  const d = needsParens(den) ? `(${den})` : den
  return `${n}/${d}`
}

/** Map a `\mathbb`-style command's argument through a char table. */
function renderMappedAlphabet(
  c: Cursor,
  out: Out,
  depth: number,
  mode: Mode,
  table: Record<string, string>,
): void {
  const atom = readAtom(c)
  if (atom === undefined) return
  const rendered = renderAtom(atom, depth, mode)
  for (const ch of rendered) {
    out.push(table[ch] ?? ch)
  }
}

/** Render an accent command by appending a combining mark to each char. */
function renderAccent(
  c: Cursor,
  out: Out,
  depth: number,
  mode: Mode,
  combining: string,
): void {
  const atom = readAtom(c)
  if (atom === undefined) return
  const rendered = renderAtom(atom, depth, mode)
  for (const ch of rendered) {
    out.push(ch)
    if (!WS_RE.test(ch)) out.push(combining)
  }
}

/** Split an environment body into rows on unescaped `\\`. */
function splitEnvRows(body: string): string[] {
  return body.split(/\\\\/)
}

/** Render a `\begin{env}…\end{env}` body (the `\begin` was consumed). */
function renderEnvironment(c: Cursor, out: Out, depth: number, mode: Mode): void {
  const envName = (takeBraceArg(c) ?? '').trim()
  if (!envName) return
  // Collect the body up to the matching `\end{envName}`.
  const closeTok = `\\end{${envName}}`
  let body = ''
  let k = c.pos
  while (k < c.src.length) {
    if (c.src.startsWith(closeTok, k)) {
      body = c.src.slice(c.pos, k)
      c.pos = k + closeTok.length
      break
    }
    k += 1
  }
  if (k >= c.src.length) {
    // Unclosed environment: consume the rest as the body.
    body = c.src.slice(c.pos)
    c.pos = c.src.length
  }
  if (!ROW_ENVIRONMENTS.has(envName)) {
    // Unknown environment: keep verbatim (TUI leaves inner envs raw).
    out.push(`\\begin{${envName}}${body}\\end{${envName}}`)
    return
  }
  const rows = splitEnvRows(body)
  // Drop a single trailing empty row (`a \\ ` → one row).
  if (rows.length > 1 && rows[rows.length - 1].trim() === '') rows.pop()
  rows.forEach((row, i) => {
    if (i > 0) out.push('\n')
    const cells = row
      .split('&')
      .map((cell) => renderAtom(cell.trim(), depth, mode))
    out.push(cells.join(' '))
  })
}

/** Render a `\command` whose backslash was already consumed. */
function renderCommand(c: Cursor, out: Out, depth: number, mode: Mode): void {
  const name = readCommandName(c)
  switch (name) {
    case '':
      out.push('\\')
      break
    case '\\':
      // Row separator.
      out.push('\n')
      break
    case 'begin':
      renderEnvironment(c, out, depth, mode)
      break
    case 'end':
      // Stray \end without matching \begin: drop its argument.
      takeBraceArg(c)
      break
    case 'left':
    case 'right': {
      // Keep the delimiter that follows; `.` means "no delimiter".
      skipWs(c)
      const ch = c.peek()
      if (ch === '.') {
        c.bump()
      } else if (ch === '\\') {
        c.bump()
        renderCommand(c, out, depth, mode)
      } else if (ch !== undefined) {
        c.bump()
        out.push(ch)
      }
      break
    }
    case 'frac':
    case 'dfrac':
    case 'tfrac':
    case 'cfrac': {
      const nArg = takeBraceArg(c)
      const dArg = takeBraceArg(c)
      const n = nArg !== undefined ? renderAtom(nArg, depth, mode) : undefined
      const d = dArg !== undefined ? renderAtom(dArg, depth, mode) : undefined
      if (n !== undefined && d !== undefined) out.push(formatFraction(n, d))
      else if (n !== undefined) out.push(n)
      break
    }
    case 'binom':
    case 'tbinom':
    case 'dbinom': {
      const n = takeBraceArg(c)
      const k = takeBraceArg(c)
      if (n !== undefined && k !== undefined) {
        out.push(`C(${renderAtom(n, depth, mode)}, ${renderAtom(k, depth, mode)})`)
      }
      break
    }
    case 'sqrt': {
      skipWs(c)
      let index: string | undefined
      if (c.peek() === '[') {
        c.bump()
        const start = c.pos
        while (!c.atEnd() && c.peek() !== ']') c.bump()
        index = c.src.slice(start, c.pos)
        c.bump() // consume `]`
      }
      const idx = index !== undefined ? renderAtom(index, depth, mode) : undefined
      if (idx === undefined || idx === '2') {
        out.push('√')
      } else if (idx === '3') {
        out.push('∛')
      } else if (idx === '4') {
        out.push('∜')
      } else {
        // ⁿ√-style prefix for other indices.
        const sup = [...idx].map((ch) => SUPERSCRIPTS[ch]).filter((s) => s !== undefined)
        out.push(sup.length === idx.length && sup.length > 0 ? sup.join('') : `(${idx})`)
        out.push('√')
      }
      const arg = readAtom(c)
      if (arg !== undefined) {
        const rendered = renderAtom(arg, depth, mode)
        // Parenthesize any multi-char radicand: `√ab` would read as `(√a)b`.
        if ([...rendered].length > 1) out.push(`(${rendered})`)
        else out.push(rendered)
      }
      break
    }
    // Boxes (frame dropped; content preserved).
    case 'boxed': {
      const arg = takeBraceArg(c)
      if (arg !== undefined) out.push(renderAtom(arg, depth, mode))
      break
    }
    case 'fbox':
    case 'framebox': {
      const arg = takeBraceArg(c)
      if (arg !== undefined) out.push(renderAtom(arg, depth, 'text'))
      break
    }
    // Text / alphabets.
    case 'text':
    case 'textrm':
    case 'textit':
    case 'textbf':
    case 'textsf':
    case 'texttt':
    case 'textnormal':
    case 'mbox':
    case 'hbox':
    case 'mathrm':
    case 'operatorname':
    case 'mathit':
    case 'mathsf':
    case 'mathtt':
    case 'mathnormal': {
      const arg = takeBraceArg(c)
      if (arg !== undefined) out.push(renderAtom(arg, depth, 'text'))
      break
    }
    case 'mathbb':
      renderMappedAlphabet(c, out, depth, mode, MATHBB)
      break
    case 'mathcal':
    case 'mathscr':
      renderMappedAlphabet(c, out, depth, mode, MATHCAL)
      break
    case 'mathfrak':
      renderMappedAlphabet(c, out, depth, mode, MATHFRAK)
      break
    case 'mathbf':
    case 'boldsymbol':
    case 'bm':
    case 'bold':
      renderMappedAlphabet(c, out, depth, mode, MATHBF)
      break
    // Accents (combining marks).
    case 'hat':
    case 'widehat':
      renderAccent(c, out, depth, mode, '\u0302')
      break
    case 'bar':
    case 'overline':
      renderAccent(c, out, depth, mode, '\u0304')
      break
    case 'tilde':
    case 'widetilde':
      renderAccent(c, out, depth, mode, '\u0303')
      break
    case 'vec':
      renderAccent(c, out, depth, mode, '\u20D7')
      break
    case 'dot':
      renderAccent(c, out, depth, mode, '\u0307')
      break
    case 'ddot':
      renderAccent(c, out, depth, mode, '\u0308')
      break
    case 'check':
      renderAccent(c, out, depth, mode, '\u030C')
      break
    case 'breve':
      renderAccent(c, out, depth, mode, '\u0306')
      break
    case 'acute':
      renderAccent(c, out, depth, mode, '\u0301')
      break
    case 'grave':
      renderAccent(c, out, depth, mode, '\u0300')
      break
    case 'mathring':
      renderAccent(c, out, depth, mode, '\u030A')
      break
    case 'underline':
      renderAccent(c, out, depth, mode, '\u0332')
      break
    // Negation.
    case 'not': {
      const atom = readAtom(c)
      if (atom !== undefined) {
        const rendered = renderAtom(atom, depth, mode)
        const neg = NEGATIONS[rendered]
        if (neg !== undefined) {
          out.push(neg)
        } else {
          out.push(rendered)
          if (rendered) out.push('\u0338') // combining long solidus overlay
        }
      }
      break
    }
    // Decorations rendered as base + script.
    case 'overset':
    case 'stackrel': {
      const overArg = takeBraceArg(c)
      const baseArg = takeBraceArg(c)
      if (overArg !== undefined && baseArg !== undefined) {
        const over = renderAtom(overArg, depth, mode)
        out.push(renderAtom(baseArg, depth, mode))
        const sup = [...over].map((ch) => SUPERSCRIPTS[ch]).filter((s) => s !== undefined)
        if (sup.length === over.length && sup.length > 0) out.push(sup.join(''))
      }
      break
    }
    case 'underset': {
      const underArg = takeBraceArg(c)
      const baseArg = takeBraceArg(c)
      if (underArg !== undefined && baseArg !== undefined) {
        const under = renderAtom(underArg, depth, mode)
        out.push(renderAtom(baseArg, depth, mode))
        const sub = [...under].map((ch) => SUBSCRIPTS[ch]).filter((s) => s !== undefined)
        if (sub.length === under.length && sub.length > 0) out.push(sub.join(''))
      }
      break
    }
    // Modular arithmetic.
    case 'pmod': {
      const arg = takeBraceArg(c)
      if (arg !== undefined) {
        if (!out.atLineStart() && !out.endsWithSpace()) out.push(' ')
        out.push(`(mod ${renderAtom(arg, depth, mode)})`)
      }
      break
    }
    case 'bmod': {
      if (!out.atLineStart() && !out.endsWithSpace()) out.push(' ')
      out.push('mod ')
      break
    }
    // Spacing.
    case ',':
    case ';':
    case ':':
    case '>':
    case ' ':
    case 'space':
    case 'thinspace':
    case 'medspace':
    case 'thickspace':
    case 'enspace':
      if (!out.atLineStart() && !out.endsWithSpace()) out.push(' ')
      break
    case 'quad':
      out.push('  ')
      break
    case 'qquad':
      out.push('    ')
      break
    case '!':
    case 'negthinspace':
    case 'negmedspace':
    case 'negthickspace':
      break
    // No-ops (sizing/styling/structure hints).
    case 'limits':
    case 'nolimits':
    case 'displaystyle':
    case 'textstyle':
    case 'scriptstyle':
    case 'scriptscriptstyle':
    case 'big':
    case 'Big':
    case 'bigg':
    case 'Bigg':
    case 'bigl':
    case 'Bigl':
    case 'biggl':
    case 'Biggl':
    case 'bigr':
    case 'Bigr':
    case 'biggr':
    case 'Biggr':
    case 'bigm':
    case 'Bigm':
    case 'biggm':
    case 'Biggm':
    case 'mathstrut':
    case 'strut':
    case 'allowbreak':
    case 'nonumber':
    case 'notag':
    case 'mathopen':
    case 'mathclose':
    case 'mathbin':
    case 'mathrel':
    case 'mathord':
    case 'mathpunct':
    case 'mathinner':
    case 'mathop':
    case 'ensuremath':
    case 'label':
    case 'tag':
      // \label/\tag carry non-visual arguments: drop them.
      if (name === 'label' || name === 'tag') takeBraceArg(c)
      break
    // Symbol table.
    default: {
      const sym = SYMBOLS[name]
      if (sym !== undefined) out.push(sym)
      else out.push(name) // unknown command: keep its bare name
      break
    }
  }
}

/**
 * Convert math source to one or more Unicode lines (`\\` row separators and
 * row environments lay out line-by-line). Returns null when the source is
 * too large to convert (callers fall back to raw display).
 */
export function latexToUnicode(src: string): string[] | null {
  if (src.length > MAX_MATH_SOURCE_LEN) return null
  const c = new Cursor(src)
  const out = new Out()
  renderSequence(c, out, 0, 'math')
  const lines = out
    .lines()
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
  return lines
}

/** Convert inline math to a single-line Unicode string (rows join `; `). */
export function latexToUnicodeInline(src: string): string | null {
  const lines = latexToUnicode(src)
  if (lines === null) return null
  return lines.map((l) => l.trim()).join('; ')
}

/** Convert display math to Unicode lines. */
export function latexToUnicodeDisplay(src: string): string[] | null {
  return latexToUnicode(src)
}

/* ------------------------------------------------------------------------
 * Remark plugin: convert math in mdast text runs.
 *
 * For each maximal run of consecutive text/break nodes, scan for math spans
 * and rebuild the run as plain text + custom `inlineMath`/`math` nodes that
 * carry the CONVERTED text as their child and use `data.hName`/`hProperties`
 * to render as `<span class="gn-math">` / `<span class="gn-math-block">`
 * (remark-rehype's unknown-node handling honors hName/hProperties, so no
 * custom react-markdown component registration is needed).
 *
 * Code nodes (`code` / `inlineCode`) have no children and are never touched,
 * so `$` inside code blocks or inline code never converts.
 * ---------------------------------------------------------------------- */

type MdNode = {
  type: string
  value?: string
  children?: MdNode[]
  data?: Record<string, unknown>
}

const TEXTISH = new Set(['text', 'break'])

function isTextish(n: MdNode): boolean {
  return TEXTISH.has(n.type)
}

/** Rebuild one textish run (already scanned) into plain/custom nodes. */
function emitMathSpans(spans: MathSpan[]): MdNode[] {
  const out: MdNode[] = []
  for (const span of spans) {
    if (span.kind === 'text') {
      if (span.text) out.push({ type: 'text', value: span.text })
    } else if (span.kind === 'inline') {
      const converted = latexToUnicodeInline(span.src)
      out.push({
        type: 'inlineMath',
        value: span.src,
        data: { hName: 'span', hProperties: { className: 'gn-math' } },
        children: [{ type: 'text', value: converted ?? span.src }],
      })
    } else {
      const lines = latexToUnicodeDisplay(span.src)
      const value = lines && lines.length > 0 ? lines.join('\n') : span.src
      out.push({
        type: 'math',
        value: span.src,
        data: { hName: 'span', hProperties: { className: 'gn-math-block' } },
        children: [{ type: 'text', value }],
      })
    }
  }
  return out
}

function processChildren(node: MdNode): void {
  const kids = node.children
  if (!kids) return
  const out: MdNode[] = []
  let i = 0
  while (i < kids.length) {
    if (isTextish(kids[i])) {
      let j = i
      let src = ''
      while (j < kids.length && isTextish(kids[j])) {
        const k = kids[j]
        // Adjacent text nodes come from consecutive source lines (mdast
        // splits at line endings), so a newline between them is always
        // correct; `break` nodes are hard line breaks.
        if (src && j > i) src += '\n'
        src += k.value ?? ''
        j++
      }
      const spans = scanMathSpans(src)
      if (spans.length === 1 && spans[0].kind === 'text') {
        // No math: keep the original nodes verbatim (streaming perf).
        for (let k = i; k < j; k++) out.push(kids[k])
      } else {
        // A run that is exactly one display span (modulo whitespace)
        // renders as a standalone centered block.
        const trimmed = src.trim()
        const tSpans = trimmed ? scanMathSpans(trimmed) : spans
        if (tSpans.length === 1 && tSpans[0].kind === 'display') {
          out.push(...emitMathSpans([tSpans[0]]))
        } else {
          out.push(...emitMathSpans(spans))
        }
      }
      i = j
    } else {
      out.push(kids[i])
      i++
    }
  }
  node.children = out
  for (const k of out) {
    if (k.children) processChildren(k)
  }
}

/**
 * Remark plugin wiring math conversion into the markdown pipeline.
 * Runs on the mdast tree (before rehype), so the conversion is streaming
 * safe — every re-parse of the active chunk re-runs the scan, and unclosed
 * delimiters simply don't match.
 */
export function remarkMathPlugin(): (tree: unknown) => void {
  return (tree: unknown) => {
    processChildren(tree as MdNode)
  }
}
