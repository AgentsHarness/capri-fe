/**
 * Theme palettes ported from xai-grok-pager-render/src/theme/*.rs
 * (groknight, grokday, tokyonight, rosepine, oscura).
 */
import type { ThemeMeta, ThemeTokens } from './tokens'

function hex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b]
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('')
  )
}

const groknight: ThemeTokens = {
  // groknight.rs
  bg: hex(10, 10, 10),
  bgBase: hex(20, 20, 20),
  bgDark: hex(12, 12, 12),
  bgHighlight: hex(36, 36, 36),
  bgCode: hex(28, 28, 28),
  bgHover: hex(44, 44, 44),
  bgVisual: hex(54, 54, 54),
  fg: hex(225, 225, 225),
  fg2: hex(200, 200, 200),
  muted: hex(108, 108, 108),
  gray: hex(120, 120, 120),
  grayDim: hex(88, 88, 88),
  gutter: hex(65, 65, 65),
  magenta: hex(187, 154, 247),
  blue: hex(122, 162, 247),
  cyan: hex(125, 207, 255),
  green: hex(158, 206, 106),
  green1: hex(115, 218, 202),
  orange: hex(255, 158, 100),
  yellow: hex(224, 175, 104),
  red: hex(247, 118, 142),
  teal: hex(26, 188, 156),
  purple: hex(157, 124, 216),
  plan: hex(255, 219, 141),
  promptBorder: hex(50, 50, 55),
  promptBorderActive: hex(80, 80, 88),
  selection: hex(60, 60, 65),
  hoverBorder: hex(30, 30, 34), // groknight hover_border
  diffDelBg: hex(66, 14, 20),
  diffDelFg: hex(247, 118, 142),
  diffInsBg: hex(6, 56, 6),
  diffInsFg: hex(158, 206, 106),
  link: hex(122, 166, 218),
  mdCode: hex(58, 149, 171),
}

const grokday: ThemeTokens = {
  // grokday.rs — light counterpart (pure-white bg, grays shifted +10 to match)
  bg: hex(255, 255, 255),
  // bgBase 是页面可见主背景（body / 主框架），同样纯白
  bgBase: hex(255, 255, 255),
  // 其余灰色背景层统一 #F5F5F5（扁平两层色调：纯白底 + 浅灰面）
  bgDark: hex(245, 245, 245),
  bgHighlight: hex(245, 245, 245),
  bgCode: hex(245, 245, 245),
  bgHover: hex(245, 245, 245),
  bgVisual: hex(245, 245, 245),
  fg: hex(38, 38, 38),
  fg2: hex(68, 68, 68),
  muted: hex(128, 128, 128),
  gray: hex(108, 108, 108),
  grayDim: hex(175, 175, 175),
  gutter: hex(188, 188, 188),
  magenta: hex(125, 75, 198),
  blue: hex(47, 100, 210),
  cyan: hex(0, 130, 170),
  green: hex(55, 142, 35),
  green1: hex(12, 148, 124),
  orange: hex(195, 105, 30),
  yellow: hex(162, 118, 18),
  red: hex(205, 48, 72),
  teal: hex(10, 142, 112),
  purple: hex(108, 62, 178),
  plan: hex(168, 120, 10),
  promptBorder: hex(210, 210, 215),
  promptBorderActive: hex(175, 175, 185),
  selection: hex(195, 195, 200),
  hoverBorder: hex(222, 222, 226), // grokday hover_border
  diffDelBg: hex(245, 218, 222),
  diffDelFg: hex(205, 48, 72),
  diffInsBg: hex(218, 242, 220),
  diffInsFg: hex(55, 142, 35),
  link: hex(47, 100, 210),
  mdCode: hex(15, 135, 162),
}

const tokyonight: ThemeTokens = {
  // tokyonight.rs Storm
  bg: hex(26, 27, 38),
  bgBase: hex(36, 40, 59),
  bgDark: hex(22, 22, 30),
  bgHighlight: hex(41, 46, 66),
  bgCode: hex(41, 46, 66),
  bgHover: hex(40, 49, 76),
  bgVisual: hex(40, 52, 87),
  fg: hex(192, 202, 245),
  fg2: hex(169, 177, 214),
  muted: hex(86, 95, 137),
  gray: hex(115, 122, 162),
  grayDim: hex(59, 66, 97),
  gutter: hex(59, 66, 97),
  magenta: hex(187, 154, 247),
  blue: hex(122, 162, 247),
  cyan: hex(125, 207, 255),
  green: hex(158, 206, 106),
  green1: hex(115, 218, 202),
  orange: hex(255, 158, 100),
  yellow: hex(224, 175, 104),
  red: hex(247, 118, 142),
  teal: hex(26, 188, 156),
  purple: hex(157, 124, 216),
  plan: hex(230, 180, 50),
  promptBorder: hex(60, 75, 120),
  promptBorderActive: hex(75, 92, 140),
  selection: hex(58, 72, 115),
  hoverBorder: hex(55, 58, 80), // tokyonight hover_border
  diffDelBg: hex(85, 15, 20),
  diffDelFg: hex(247, 118, 142),
  diffInsBg: hex(15, 65, 20),
  diffInsFg: hex(158, 206, 106),
  link: hex(122, 162, 247),
  mdCode: hex(115, 218, 202),
}

const rosepine: ThemeTokens = {
  // rosepine.rs Moon
  bg: hex(35, 33, 54),
  bgBase: hex(35, 33, 54),
  bgDark: hex(42, 39, 63),
  bgHighlight: hex(57, 53, 82),
  bgCode: hex(42, 39, 63),
  bgHover: hex(68, 65, 90),
  bgVisual: hex(68, 65, 90),
  fg: hex(224, 222, 244),
  fg2: hex(144, 140, 170),
  muted: hex(110, 106, 134),
  gray: hex(144, 140, 170),
  grayDim: hex(68, 65, 90),
  gutter: hex(68, 65, 90),
  magenta: hex(196, 167, 231), // iris
  blue: hex(62, 143, 176), // pine
  cyan: hex(156, 207, 216), // foam
  green: hex(156, 207, 216),
  green1: hex(156, 207, 216),
  orange: hex(234, 154, 151), // rose
  yellow: hex(246, 193, 119), // gold
  red: hex(235, 111, 146), // love
  teal: hex(62, 143, 176),
  purple: hex(196, 167, 231),
  plan: hex(246, 193, 119),
  promptBorder: hex(68, 65, 90),
  promptBorderActive: hex(86, 82, 110),
  selection: hex(86, 82, 110),
  hoverBorder: hex(68, 65, 90), // HIGHLIGHT_MED-ish
  diffDelBg: hex(55, 30, 40),
  diffDelFg: hex(235, 111, 146),
  diffInsBg: hex(25, 45, 55),
  diffInsFg: hex(156, 207, 216),
  link: hex(156, 207, 216),
  mdCode: hex(156, 207, 216),
}

const oscura: ThemeTokens = {
  // oscura.rs Midnight
  bg: hex(3, 3, 4),
  bgBase: hex(3, 3, 4),
  bgDark: hex(4, 5, 7),
  bgHighlight: hex(15, 18, 22),
  bgCode: hex(4, 5, 7),
  bgHover: hex(36, 32, 52),
  bgVisual: hex(36, 32, 52),
  fg: hex(228, 228, 228),
  fg2: hex(190, 190, 190),
  muted: hex(129, 134, 143),
  gray: hex(190, 190, 190),
  grayDim: hex(94, 100, 108),
  gutter: hex(94, 100, 108),
  magenta: hex(155, 126, 206),
  blue: hex(125, 207, 223),
  cyan: hex(125, 207, 223),
  green: hex(80, 180, 140),
  green1: hex(80, 180, 140),
  orange: hex(241, 189, 0),
  yellow: hex(235, 217, 110),
  red: hex(220, 90, 100),
  teal: hex(80, 180, 140),
  purple: hex(155, 126, 206),
  plan: hex(235, 217, 110),
  promptBorder: hex(36, 32, 52),
  promptBorderActive: hex(52, 48, 72),
  selection: hex(52, 48, 72),
  hoverBorder: hex(36, 32, 52),
  diffDelBg: hex(45, 15, 25),
  diffDelFg: hex(220, 90, 100),
  diffInsBg: hex(10, 35, 30),
  diffInsFg: hex(80, 180, 140),
  link: hex(125, 207, 223),
  mdCode: hex(125, 207, 223),
}

export const THEMES: ThemeMeta[] = [
  {
    id: 'groknight',
    name: 'Grok Night',
    description: 'Neutral gray + TokyoNight accents (default)',
    polarity: 'dark',
    tokens: groknight,
  },
  {
    id: 'grokday',
    name: 'Grok Day',
    description: 'Light gray base, deepened accents',
    polarity: 'light',
    tokens: grokday,
  },
  {
    id: 'tokyonight',
    name: 'Tokyo Night',
    description: 'Blue-tinted Storm palette',
    polarity: 'dark',
    tokens: tokyonight,
  },
  {
    id: 'rosepine-moon',
    name: 'Rose Pine Moon',
    description: 'Soft purple night',
    polarity: 'dark',
    tokens: rosepine,
  },
  {
    id: 'oscura-midnight',
    name: 'Oscura Midnight',
    description: 'Deep purple-tinted black',
    polarity: 'dark',
    tokens: oscura,
  },
]

export function getTheme(id: Exclude<import('./tokens').ThemeId, 'auto'>): ThemeMeta {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}

export function resolveThemeId(
  preference: import('./tokens').ThemeId,
): Exclude<import('./tokens').ThemeId, 'auto'> {
  if (preference !== 'auto') return preference
  const dark =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  return dark ? 'groknight' : 'grokday'
}
