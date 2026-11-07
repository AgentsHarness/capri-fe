import { useEffect, useState } from 'react'
import { useChatStore } from '../../store/chat'
import { Glyphs } from '../../theme/glyphs'
import { COMPOSER_BODY_PAD_LEFT_PX } from '../../theme/layout'
import { IconGlyph } from '../ui/IconGlyph'

/** TUI mode-switch banner（notices.rs）：满亮 2s，再 0.3s 淡出。 */
export function ModeSwitchBanner() {
  const modeBanner = useChatStore((s) => s.modeBanner)
  const clearModeBanner = useChatStore((s) => s.clearModeBanner)
  // ── TUI mode-switch banner (notices.rs) — "Switched to mode: X" above
  // the prompt: full visibility for 2 s, then a 0.3 s fade-out. ──
  useEffect(() => {
    if (!modeBanner) {
      setModeBannerVisible(false)
      return
    }
    setModeBannerVisible(true)
    const t1 = window.setTimeout(() => setModeBannerVisible(false), 2000)
    const t2 = window.setTimeout(() => clearModeBanner(), 2300)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [modeBanner, clearModeBanner])


  const [modeBannerVisible, setModeBannerVisible] = useState(false)

  return (
    <>        {/* ── TUI mode-switch banner (notices.rs) — above the prompt,
            full brightness 2 s, fade-out 0.3 s. ── */}
        {modeBanner && (
          <div
            className={`flex min-h-5 items-center gap-1.5 pb-2 pr-0.5 font-ui text-[13px] leading-[1.4] select-none transition-opacity duration-300 ${
 modeBannerVisible ? 'opacity-100' : 'opacity-0'
            }`}
            style={{ paddingLeft: COMPOSER_BODY_PAD_LEFT_PX }}
          >
            <span className="text-gn-cyan" aria-hidden>
              <IconGlyph glyph={Glyphs.diamondFilled} color="currentColor" />
            </span>
            <span className="truncate text-gn-fg2">{modeBanner}</span>
          </div>
        )}
    </>
  )
}
