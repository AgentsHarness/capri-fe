/**
 * SVG path registry for IconGlyph — deterministic icon rendering that never
 * depends on system font fallback (SF Mono / Menlo / … render ⌄ ◈ ◆ ❯ with
 * wildly different ink positions, and some systems lack them entirely).
 *
 * All paths are drawn in a 1×1 viewBox (y-down), optical center at (0.5, 0.5).
 * Stroke widths are in viewBox units: 0.08 ≈ 1px at the 13px icon size.
 */
import { Glyphs } from './glyphs'

export type IconPath = {
  /** SVG path `d` (may contain multiple subpaths). */
  d: string
  /** Fill instead of stroke. */
  fill?: boolean
  /** Stroke width in viewBox units (ignored for fill). */
  sw?: number
}

export const ICON_PATHS: Record<string, IconPath> = {
  // Diamonds span 0.09–0.91 of the em like the mono-font glyphs.
  [Glyphs.diamondFilled]: {
    d: 'M0.5 0.09 L0.91 0.5 L0.5 0.91 L0.09 0.5 Z',
    fill: true,
  },
  [Glyphs.diamondHollow]: {
    d: 'M0.5 0.09 L0.91 0.5 L0.5 0.91 L0.09 0.5 Z',
    sw: 0.08,
  },
  [Glyphs.diamondDotted]: {
    d: 'M0.5 0.09 L0.91 0.5 L0.5 0.91 L0.09 0.5 Z M0.5 0.33 L0.67 0.5 L0.5 0.67 L0.33 0.5 Z',
    sw: 0.07,
  },
  [Glyphs.ballotX]: {
    d: 'M0.26 0.26 L0.74 0.74 M0.74 0.26 L0.26 0.74',
    sw: 0.09,
  },
  [Glyphs.checkMark]: {
    d: 'M0.17 0.51 L0.4 0.72 L0.83 0.3',
    sw: 0.09,
  },
  [Glyphs.chevron]: {
    d: 'M0.36 0.18 L0.66 0.5 L0.36 0.82',
    sw: 0.08,
  },
  [Glyphs.chevronLeft]: {
    d: 'M0.64 0.18 L0.34 0.5 L0.64 0.82',
    sw: 0.08,
  },
  [Glyphs.chevronDown]: {
    d: 'M0.22 0.36 L0.5 0.66 L0.78 0.36',
    sw: 0.09,
  },
  [Glyphs.promptArrow]: {
    d: 'M0.3 0.16 L0.72 0.5 L0.3 0.84',
    sw: 0.15,
  },
  // "$" execute prefix — the real SF Mono dollar outline (bar + S), scaled
  // uniformly into the viewBox at its natural aspect (ink ≈0.49×0.86,
  // optical center 0.5, 0.5).
  $: {
    d: 'M0.5319 0.93H0.4751V0.07H0.5319ZM0.2567 0.6727H0.3225Q0.3295 0.7376 0.3789 0.7762Q0.4282 0.8148 0.5035 0.8148Q0.5808 0.8148 0.6284 0.775Q0.676 0.7351 0.676 0.6713Q0.676 0.6164 0.6413 0.5835Q0.6067 0.5506 0.5284 0.5307L0.4721 0.5162Q0.3699 0.4898 0.3223 0.4424Q0.2747 0.3951 0.2747 0.3188Q0.2747 0.2599 0.3031 0.2166Q0.3315 0.1732 0.3828 0.1493Q0.4342 0.1253 0.5035 0.1253Q0.5688 0.1253 0.6187 0.149Q0.6685 0.1727 0.6979 0.2156Q0.7273 0.2585 0.7308 0.3163H0.665Q0.6575 0.2555 0.6144 0.2203Q0.5713 0.1852 0.5035 0.1852Q0.4287 0.1852 0.3853 0.2211Q0.342 0.257 0.342 0.3188Q0.342 0.3716 0.3746 0.4028Q0.4073 0.4339 0.484 0.4544L0.5424 0.4698Q0.6496 0.4978 0.6964 0.5449Q0.7433 0.592 0.7433 0.6713Q0.7433 0.7326 0.7134 0.7782Q0.6835 0.8238 0.6296 0.8492Q0.5758 0.8747 0.5035 0.8747Q0.4322 0.8747 0.3781 0.85Q0.324 0.8253 0.2926 0.7799Q0.2612 0.7346 0.2567 0.6727Z',
    fill: true,
  },
}
