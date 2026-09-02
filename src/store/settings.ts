import { transport } from '../api/client'
import type { SettingsPayload } from '../api/transport'

/**
 * `[ui]` section of GET /api/settings — cached module-wide and shared by
 * every FE-side replica of TUI behavior (page_flip_on_send,
 * collapsed_edit_blocks, remember_tool_approvals, [ui.notifications] …).
 *
 * config.toml stays the source of truth. GET is the full safe subset;
 * POST /api/settings patches the four FE-consumed [ui] scalars. A FAILED
 * fetch is not cached — the abort window during host-switch / reconnect
 * must not permanently lose the config, so the next caller retries.
 *
 * `[ui]` 与下面的 `toolset` 是两个分区缓存，但读的是同一个 GET /api/settings
 * 应答——此前两边各发一条一模一样的请求。现在共用同一次拉取，并按端点键控：
 * 同一端点已经拿到手的数据绝不重问，端点变了（换 host / 换近路）才重读。
 */
type UiSection = Record<string, unknown>

let cachedUi: UiSection | undefined
/** cachedUi 读自哪个端点（'' = 无法判定，等价于「只有单一端点」）。 */
let cachedUiUrl = ''
const readyCallbacks = new Set<() => void>()
const changeListeners = new Set<() => void>()

/**
 * 本模块的 GET /api/settings 归属的端点：hub 模式下 `apiUrl` 随选中 host
 * （?host= 或本机近路）变化，正是缓存该作废的信号。
 */
function settingsUrl(): string {
  return transport.apiUrl?.('/api/settings') ?? ''
}

/** hub 模式还没选中 host：host 级请求不带 ?host= 会打到 hub 根路径（404），
 *  而且多半随即被 setHost 的 abort 风暴取消——直接不发。 */
function hostlessInHub(): boolean {
  return transport.getConnectionMode?.() === 'hub' && !transport.getHost?.()
}

let pending: Promise<SettingsPayload | null> | null = null
let pendingUrl = ''

/** 拉一次完整 settings 应答：同端点的并发调用共享这条在途请求；失败返回
 *  null（不留缓存，下次调用重试）。 */
function loadSettings(): Promise<SettingsPayload | null> {
  const url = settingsUrl()
  if (hostlessInHub()) return Promise.resolve(null)
  if (pending && pendingUrl === url) return pending
  const p = transport.settings().then(
    (payload) => {
      if (pending === p) pending = null
      return payload
    },
    () => {
      if (pending === p) pending = null
      return null
    },
  )
  pending = p
  pendingUrl = url
  return p
}

function notifyUiSettings(): void {
  readyCallbacks.forEach((cb) => cb())
  readyCallbacks.clear()
  changeListeners.forEach((cb) => cb())
}

/** 把应答里的 `[ui]` 落进缓存；拉取失败（payload null）时保持现状并回 null。 */
function applyUiPayload(payload: SettingsPayload | null, url: string): UiSection | null {
  if (payload === null) return null
  const ui = (
    payload.ui && typeof payload.ui === 'object' && !Array.isArray(payload.ui)
      ? payload.ui
      : {}
  ) as UiSection
  cachedUi = ui
  cachedUiUrl = url
  notifyUiSettings()
  return ui
}

/** Fetch (once per endpoint) and cache the `[ui]` settings section. Resolves
 *  `{}` on failure; the next call retries. */
export function ensureUiSettings(): Promise<UiSection> {
  const url = settingsUrl()
  if (cachedUi !== undefined && cachedUiUrl === url) return Promise.resolve(cachedUi)
  return loadSettings().then((p) => applyUiPayload(p, url) ?? cachedUi ?? {})
}

/**
 * Re-read `[ui]` for the CURRENT host — settings are HOST-scoped, so a cached
 * section belongs to whichever endpoint it was read from and must not survive
 * a host switch. A fetch for that same endpoint already in flight is joined
 * rather than duplicated. Resolves null (cache left at the previous host's
 * value) when the fetch fails, so callers can tell "empty config" apart from
 * "couldn't reach the host".
 */
export function refreshUiSettings(): Promise<UiSection | null> {
  const before = cachedUi
  const url = settingsUrl()
  return loadSettings().then((p) => {
    const ui = applyUiPayload(p, url)
    return ui === null || ui === before ? null : ui
  })
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

/** Replace the cached `[ui]` section (after GET/POST /api/settings). */
export function applyUiSettings(ui: UiSection): void {
  cachedUi = ui
  cachedUiUrl = settingsUrl()
  notifyUiSettings()
}

/** Subscribe to every cache update (not just the first successful fetch). */
export function onUiSettingsChange(cb: () => void): () => void {
  changeListeners.add(cb)
  return () => {
    changeListeners.delete(cb)
  }
}

/** `[ui.notifications]` table (host may or may not ship it). */
export function notificationsSettings(): Record<string, unknown> {
  const v = uiSettings().notifications
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

/**
 * `toolset.ask_user_question` section of GET /api/settings — the host
 * filters the payload to the two timeout scalars. Cached per endpoint with
 * the same semantics as the `[ui]` cache above (same GET, shared fetch); a
 * FAILED fetch is not cached.
 */
type ToolsetSection = {
  ask_user_question?: { timeout_enabled?: boolean; timeout_secs?: number }
}

let cachedToolset: ToolsetSection | undefined
let cachedToolsetUrl = ''
const toolsetReadyCallbacks = new Set<() => void>()
const toolsetChangeListeners = new Set<() => void>()

function notifyToolsetSettings(): void {
  toolsetReadyCallbacks.forEach((cb) => cb())
  toolsetReadyCallbacks.clear()
  toolsetChangeListeners.forEach((cb) => cb())
}

/** 把应答里的 `toolset` 落进缓存；拉取失败时保持现状并回 null。 */
function applyToolsetPayload(
  payload: SettingsPayload | null,
  url: string,
): ToolsetSection | null {
  if (payload === null) return null
  const ts =
    payload.toolset && typeof payload.toolset === 'object' && !Array.isArray(payload.toolset)
      ? (payload.toolset as ToolsetSection)
      : {}
  cachedToolset = ts
  cachedToolsetUrl = url
  notifyToolsetSettings()
  return ts
}

/** Fetch (once per endpoint) and cache the `toolset` section; `{}` on failure
 *  (retried by the next caller, same as ensureUiSettings). */
export function ensureToolsetSettings(): Promise<ToolsetSection> {
  const url = settingsUrl()
  if (cachedToolset !== undefined && cachedToolsetUrl === url) {
    return Promise.resolve(cachedToolset)
  }
  return loadSettings().then((p) => applyToolsetPayload(p, url) ?? cachedToolset ?? {})
}

/** Sync accessor — `undefined` until ensureToolsetSettings resolves. */
export function toolsetSettings(): ToolsetSection | undefined {
  return cachedToolset
}

/** Run cb once the toolset settings are available (immediately if already). */
export function onToolsetSettingsReady(cb: () => void): void {
  if (cachedToolset !== undefined) {
    cb()
    return
  }
  toolsetReadyCallbacks.add(cb)
}

/** Replace the cached `toolset` section (after GET/POST /api/settings). */
export function applyToolsetSettings(ts: ToolsetSection | undefined): void {
  cachedToolset = ts
  cachedToolsetUrl = settingsUrl()
  notifyToolsetSettings()
}

/** Subscribe to every toolset cache update. */
export function onToolsetSettingsChange(cb: () => void): () => void {
  toolsetChangeListeners.add(cb)
  return () => {
    toolsetChangeListeners.delete(cb)
  }
}
