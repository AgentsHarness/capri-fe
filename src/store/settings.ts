import { transport } from '../api/client'

/**
 * `[ui]` section of GET /api/settings — cached module-wide and shared by
 * every FE-side replica of TUI behavior (page_flip_on_send,
 * collapsed_edit_blocks, remember_tool_approvals, [ui.notifications] …).
 *
 * config.toml stays the single source of truth: the host serves it
 * read-only, we consume. A FAILED fetch is not cached — the abort window
 * during host-switch / reconnect must not permanently lose the config, so
 * the next caller simply retries.
 */
type UiSection = Record<string, unknown>

let cachedUi: UiSection | undefined
let inflight: Promise<UiSection> | null = null
const readyCallbacks = new Set<() => void>()

/** Fetch (once) and cache the `[ui]` settings section. Resolves `{}` on
 *  failure; the next call retries. */
export function ensureUiSettings(): Promise<UiSection> {
  inflight ??= transport
    .settings()
    .then((s) => {
      const ui = (
        s.ui && typeof s.ui === 'object' && !Array.isArray(s.ui) ? s.ui : {}
      ) as UiSection
      cachedUi = ui
      readyCallbacks.forEach((cb) => cb())
      readyCallbacks.clear()
      return ui
    })
    .catch(() => {
      inflight = null // failed — retry next call
      return {}
    })
  return inflight
}

/** Sync accessor — `{}` until ensureUiSettings resolves. */
export function uiSettings(): UiSection {
  return cachedUi ?? {}
}

/** True once a settings fetch has resolved successfully (even if empty). */
export function uiSettingsLoaded(): boolean {
  return cachedUi !== undefined
}

/** Run cb once the ui settings are available (immediately if already). */
export function onUiSettingsReady(cb: () => void): void {
  if (cachedUi !== undefined) {
    cb()
    return
  }
  readyCallbacks.add(cb)
}

/** `[ui] <key>` as a boolean with a TUI-matching default. */
export function uiBool(key: string, dflt: boolean): boolean {
  const v = uiSettings()[key]
  return typeof v === 'boolean' ? v : dflt
}

/** `[ui] <key>` as a non-empty string, else undefined. */
export function uiString(key: string): string | undefined {
  const v = uiSettings()[key]
  return typeof v === 'string' && v ? v : undefined
}

/** `[ui.notifications]` table (host may or may not ship it). */
export function notificationsSettings(): Record<string, unknown> {
  const v = uiSettings().notifications
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}
