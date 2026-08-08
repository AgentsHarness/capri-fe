import { transport } from './localTransport'

/**
 * ── TUI shell mode bridge ────────────────────────────────────────────
 * POST /api/shell { command, cwd?, timeoutMs? } runs a local command in
 * the session workspace (host contract — acp-host handleShell): cwd
 * defaults to the active session's cwd, timeout defaults to 10s and is
 * capped at 60s. The host answers HTTP 200 with the run's outcome
 * ({ok: true, exitCode, stdout, stderr, timedOut}) — there is no
 * `output` key. Non-2xx / ok:false paths are kept defensively (older or
 * future hosts) and degrade to a friendly error line instead of an
 * unhandled rejection.
 *
 * Deliberately NOT in localTransport.ts (owned by the transport team):
 * this is a standalone client for a dedicated endpoint.
 */

export type ShellResult = {
  ok: boolean
  /** Process exit code (host contract; absent on transport failures). */
  exitCode?: number
  stdout?: string
  stderr?: string
  /** True when the host's timeout killed the command. */
  timedOut?: boolean
  /** Failure detail — only present when ok is false. */
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
  /** Host-side timeout (ms) — omitted → host default (10s, capped 60s). */
  timeoutMs?: number,
): Promise<ShellResult> {
  try {
    const res = await fetch(`/api/shell${hostQuery()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        timeoutMs != null ? { command, cwd, timeoutMs } : { command, cwd },
      ),
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
      exitCode: typeof data.exitCode === 'number' ? data.exitCode : undefined,
      stdout: typeof data.stdout === 'string' ? data.stdout : undefined,
      stderr: typeof data.stderr === 'string' ? data.stderr : undefined,
      timedOut: data.timedOut === true,
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}
