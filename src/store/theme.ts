import { loadStr, saveStr } from '../lib/storage'
import { create } from 'zustand'
import type { ThemeId } from '../theme/tokens'
import { applyTokens } from '../theme/tokens'
import { THEMES, getTheme, resolveThemeId } from '../theme/palettes'
import { KEY } from '../lib/keys'

const STORAGE_KEY = KEY.theme

type ThemeState = {
  /** User preference (may be "auto") */
  preference: ThemeId
  /** Resolved concrete theme */
  resolved: Exclude<ThemeId, 'auto'>
  setTheme: (id: ThemeId) => void
  /** Re-resolve auto when OS appearance changes */
  syncSystem: () => void
  init: () => () => void
}

function loadPreference(): ThemeId {
  const v = loadStr(STORAGE_KEY)
  if (
    v === 'groknight' ||
    v === 'grokday' ||
    v === 'tokyonight' ||
    v === 'rosepine-moon' ||
    v === 'oscura-midnight' ||
    v === 'auto'
  ) {
    return v
  }
  return 'groknight'
}

function apply(preference: ThemeId): Exclude<ThemeId, 'auto'> {
  const resolved = resolveThemeId(preference)
  const meta = getTheme(resolved)
  applyTokens(meta.tokens, meta.polarity)
  document.documentElement.dataset.theme = resolved
  document.documentElement.dataset.polarity = meta.polarity
  return resolved
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  preference: 'groknight',
  resolved: 'groknight',

  setTheme: (id) => {
    saveStr(STORAGE_KEY, id)
    const resolved = apply(id)
    set({ preference: id, resolved })
  },

  syncSystem: () => {
    const { preference } = get()
    if (preference !== 'auto') return
    const resolved = apply('auto')
    set({ resolved })
  },

  init: () => {
    const preference = loadPreference()
    const resolved = apply(preference)
    set({ preference, resolved })

    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => get().syncSystem()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  },
}))

export { THEMES }
