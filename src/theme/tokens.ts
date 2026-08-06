/**
 * Theme tokens shared by all Grok Build TUI themes.
 * CSS custom properties use the `--color-gn-*` names already wired into Tailwind.
 */

export type ThemeId =
  | 'groknight'
  | 'grokday'
  | 'tokyonight'
  | 'rosepine-moon'
  | 'oscura-midnight'
  | 'auto'

export type ThemeTokens = {
  // backgrounds
  bg: string
  bgBase: string
  bgDark: string
  bgHighlight: string
  bgCode: string
  bgHover: string
  bgVisual: string
  // text
  fg: string
  fg2: string
  muted: string
  gray: string
  grayDim: string
  gutter: string
  // accents
  magenta: string
  blue: string
  cyan: string
  green: string
  green1: string
  orange: string
  yellow: string
  red: string
  teal: string
  purple: string
  plan: string
  // chrome
  promptBorder: string
  promptBorderActive: string
  /** Selected entry SelectionBox (theme.selection_border). */
  selection: string
  /** Hover pre-select SelectionBox (theme.hover_border) — dimmer than selection. */
  hoverBorder: string
  // diff
  diffDelBg: string
  diffDelFg: string
  diffInsBg: string
  diffInsFg: string
  link: string
  // md code inline
  mdCode: string
}

export type ThemeMeta = {
  id: Exclude<ThemeId, 'auto'>
  name: string
  description: string
  polarity: 'dark' | 'light'
  tokens: ThemeTokens
}

/** Map ThemeTokens → CSS vars consumed by Tailwind `gn-*` utilities. */
export function tokensToCssVars(t: ThemeTokens): Record<string, string> {
  return {
    '--color-gn-bg': t.bg,
    '--color-gn-bg-base': t.bgBase,
    '--color-gn-bg-dark': t.bgDark,
    '--color-gn-bg-highlight': t.bgHighlight,
    '--color-gn-bg-code': t.bgCode,
    '--color-gn-bg-hover': t.bgHover,
    '--color-gn-bg-visual': t.bgVisual,
    '--color-gn-fg': t.fg,
    '--color-gn-fg2': t.fg2,
    '--color-gn-muted': t.muted,
    '--color-gn-gray': t.gray,
    '--color-gn-gray-dim': t.grayDim,
    '--color-gn-gutter': t.gutter,
    '--color-gn-magenta': t.magenta,
    '--color-gn-blue': t.blue,
    '--color-gn-cyan': t.cyan,
    '--color-gn-green': t.green,
    '--color-gn-green1': t.green1,
    '--color-gn-orange': t.orange,
    '--color-gn-yellow': t.yellow,
    '--color-gn-red': t.red,
    '--color-gn-teal': t.teal,
    '--color-gn-purple': t.purple,
    '--color-gn-plan': t.plan,
    '--color-gn-prompt-border': t.promptBorder,
    '--color-gn-prompt-border-active': t.promptBorderActive,
    '--color-gn-selection': t.selection,
    '--color-gn-hover-border': t.hoverBorder,
    '--color-gn-diff-del-bg': t.diffDelBg,
    '--color-gn-diff-del-fg': t.diffDelFg,
    '--color-gn-diff-ins-bg': t.diffInsBg,
    '--color-gn-diff-ins-fg': t.diffInsFg,
    '--color-gn-link': t.link,
    // Theme accent slots (xai-grok-pager-render Theme)
    '--color-gn-accent-running': t.magenta,
    '--color-gn-accent-tool': t.gray,
    '--color-gn-accent-success': t.green,
    '--color-gn-accent-error': t.red,
    '--color-gn-accent-thinking': t.magenta,
    '--color-gn-accent-assistant': t.magenta,
    '--color-gn-accent-user': t.fg2,
    '--color-gn-accent-system': t.blue,
    '--color-gn-accent-skill': t.blue,
    '--color-gn-accent-plan': t.plan,
    '--color-gn-accent-verify': t.magenta,
    '--color-gn-accent-feedback': t.green1,
    '--color-gn-accent-remember': t.green,
    '--color-gn-accent-model': t.teal,
    '--color-gn-warning': t.yellow,
    '--color-gn-path': t.orange,
    '--color-gn-md-code': t.mdCode,
  }
}

export function applyTokens(t: ThemeTokens, polarity: 'dark' | 'light' = 'dark') {
  const root = document.documentElement
  const vars = tokensToCssVars(t)
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v)
  }
  root.style.colorScheme = polarity
  document.body.style.background = t.bgBase
  document.body.style.color = t.fg
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', t.bgDark)
}
