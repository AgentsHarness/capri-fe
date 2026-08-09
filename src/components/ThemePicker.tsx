import { useState } from 'react'
import { THEMES, useThemeStore } from '../store/theme'
import type { ThemeId } from '../theme/tokens'

const OPTIONS: { id: ThemeId; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'Follow system light/dark' },
  ...THEMES.map((t) => ({
    id: t.id as ThemeId,
    label: t.name,
    hint: t.description,
  })),
]

/**
 * Theme option rows — shared by the standalone ThemePicker dropdown and
 * the mobile top-bar "更多" menu (inline accordion), so both offer the
 * same choices. `onSelect` fires after a choice is applied (used to
 * close the enclosing panel).
 */
export function ThemeOptions({ onSelect }: { onSelect?: (id: ThemeId) => void }) {
  const preference = useThemeStore((s) => s.preference)
  const setTheme = useThemeStore((s) => s.setTheme)

  return (
    <>
      {OPTIONS.map((opt) => {
        const active = preference === opt.id
        const swatch =
          opt.id === 'auto'
            ? null
            : THEMES.find((t) => t.id === opt.id)?.tokens
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => {
              setTheme(opt.id)
              onSelect?.(opt.id)
            }}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-gn-bg-highlight ${
              active ? 'bg-gn-bg-highlight/60' : ''
            }`}
          >
            {swatch ? (
              <span
                className="h-4 w-4 shrink-0 rounded border border-gn-prompt-border"
                style={{
                  background: `linear-gradient(135deg, ${swatch.bgBase} 50%, ${swatch.magenta} 50%)`,
                }}
              />
            ) : (
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-gn-prompt-border text-[9px] text-gn-muted">
                A
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className={`truncate ${active ? 'text-gn-magenta' : 'text-gn-fg'}`}>
                {opt.label}
                {active && ' ·'}
              </div>
              <div className="truncate text-[10px] text-gn-muted">{opt.hint}</div>
            </div>
          </button>
        )
      })}
    </>
  )
}

export function ThemePicker() {
  const preference = useThemeStore((s) => s.preference)
  const resolved = useThemeStore((s) => s.resolved)
  const [open, setOpen] = useState(false)

  const currentLabel =
    preference === 'auto'
      ? `Auto (${THEMES.find((t) => t.id === resolved)?.name ?? resolved})`
      : THEMES.find((t) => t.id === preference)?.name ?? preference

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded border border-transparent px-2 py-0.5 hover:border-gn-prompt-border hover:bg-gn-bg-highlight hover:text-gn-fg min-h-8 text-[12px] text-gn-muted"
        title="Theme"
      >
        <span className="hidden sm:inline truncate max-w-[7rem]">{currentLabel}</span>
        <span className="sm:hidden">theme</span>
        <span className="text-gn-gutter">▾</span>
      </button>
      {open && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-30 cursor-default"
            aria-label="close theme menu"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-full z-40 mt-1 w-64 max-w-[90vw] rounded border border-gn-prompt-border bg-gn-bg-base shadow-xl py-1">
            <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gn-gutter">
              theme
            </div>
            <ThemeOptions onSelect={() => setOpen(false)} />
            <div className="border-t border-gn-prompt-border px-3 py-2 text-[10px] text-gn-gutter leading-snug">
              Mirrors Grok Build TUI themes · saved in this browser
            </div>
          </div>
        </>
      )}
    </div>
  )
}
