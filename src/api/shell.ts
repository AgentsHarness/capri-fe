import { transport } from './localTransport'

/**
 * ── TUI shell mode bridge ────────────────────────────────────────────
 * POST /api/shell { command, cwd } runs a local command in the session
 * workspace. The endpoint is being implemented host-side in parallel —
 * it may 404 for now, so every failure path degrades to a friendly
 * error line instead of an unhandled rejection.
 *
 * Deliberately NOT in localTransport.ts (owned by the transport team):
 * this is a standalone client for a dedicated endpoint.
 */

export type ShellResult = {
  ok: boolean
  output?: string
  error?: string
}

/** Hub-mode host param (mirrors LocalTransport.url's ?host=). */
function hostQuery(): string {
  const host = transport.getHost()
  return host ? `?host=${encodeURIComponent(host)}` : ''
}

export async function runShellCommand(
  command: string,
  cwd?: string,
): Promise<ShellResult> {
  try {
    const res = await fetch(`/api/shell${hostQuery()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, cwd }),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        error:
          typeof data.error === 'string' && data.error
            ? String(data.error)
            : res.status === 404
              ? 'shell 端点不可用 (404) — host 侧尚未实现'
              : `shell 执行失败 (${res.status})`,
      }
    }
    return {
      ok: true,
      output: typeof data.output === 'string' ? data.output : '',
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}
