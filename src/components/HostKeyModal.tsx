import { useEffect, useState } from 'react'
import { KeyRound } from 'lucide-react'
import { transport } from '../api/client'
import { useChatStore } from '../store/chat'
import { pushToast } from '../store/toast'
import { ModalShell } from './HostActions'

/**
 * 「这台 Host 的钥匙」弹窗 —— 与全屏的 Hub 门禁是两回事，只服务本机近路。
 *
 * 触发时机（见 localTransport.probeLocalRoute）：hub 已经登录成功、选中了
 * 一台本机上跑着的 capri-host、它自报 `authRequired:true`，而浏览器拿 hub
 * 那把去打它的 `/api/probe` 换回 401。两把 FE_TOKEN 允许不同值，所以这里
 * 问的是**那台机器的钥匙**，文案必须写明不是 Hub 密钥，否则用户会把上一步
 * 刚输过的值再输一遍、然后继续吃 401。
 *
 * 三条出路：
 * - 输入并验证通过 → 这台开直连（钥匙按 hostId 存进 host 槽，不覆盖 hub 槽）。
 * - 输入但被拒 → 不落库，留在弹窗里改。
 * - 取消 / 关闭 → 这台改走 Hub 中继；**hub 登录不动**，其他 host 也不受影响。
 */
export function HostKeyModal() {
  const hosts = useChatStore((s) => s.hosts)
  const [queue, setQueue] = useState<string[]>([])

  useEffect(
    () =>
      transport.onHostKeyRequired((hostId) => {
        setQueue((q) => (q.includes(hostId) ? q : [...q, hostId]))
      }),
    [],
  )

  const hostId = queue[0]
  if (!hostId) return null
  const host = hosts.find((h) => h.hostId === hostId)
  const label = host?.hostName || hostId
  const settle = () => setQueue((q) => q.slice(1))

  return (
    <HostKeyForm
      key={hostId}
      hostId={hostId}
      hostLabel={label}
      onSuccess={() => {
        pushToast(`本机直连已开启：${label}`)
        settle()
      }}
      onDecline={() => {
        transport.declineHostKey(hostId)
        pushToast(`未输入 ${label} 的本机钥匙，这台改走 Hub 中继`)
        settle()
      }}
    />
  )
}

function HostKeyForm({
  hostId,
  hostLabel,
  onSuccess,
  onDecline,
}: {
  hostId: string
  hostLabel: string
  onSuccess: () => void
  onDecline: () => void
}) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const token = value.trim()
    if (!token || busy) return
    setBusy(true)
    setError(undefined)
    try {
      if (await transport.tryHostKey(hostId, token)) {
        onSuccess()
      } else {
        setError('这把钥匙开不了这台 Host，请核对后重试')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell title={`${hostLabel} 的本机钥匙`} onClose={onDecline}>
      <div className="px-4 py-3">
        <div className="mb-3 flex items-center gap-2 text-gn-cyan">
          <KeyRound size={15} aria-hidden />
          <span className="text-[13px] font-medium">这台机器要第二把钥匙</span>
        </div>
        <p className="mb-3 text-[12px] leading-relaxed text-gn-muted">
          你已经用 Hub 密钥进到页面里了；下面这把<strong className="text-gn-fg">不是
          Hub 密钥</strong>，而是 <code className="text-gn-fg2">{hostLabel}</code>{' '}
          这台机器自己的接口密钥（它部署时配的{' '}
          <code className="text-gn-fg2">FE_TOKEN</code>）。两把可以完全不同。
        </p>
        <p className="mb-3 text-[12px] leading-relaxed text-gn-muted">
          输入后页面就能直连本机端口（少一跳中继、Hub 不可达时也还能用）。不想输
          就选「改用 Hub 中继」——这台照样能用，只是绕一趟 Hub，你的 Hub 登录不受
          任何影响。
        </p>
        <label className="mb-1 block text-[12px] text-gn-gray" htmlFor="capri-host-token">
          {hostLabel} 的访问密钥
        </label>
        <input
          id="capri-host-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder="粘贴这台 Host 的 FE_TOKEN…"
          className="mb-2 w-full rounded-md border border-gn-prompt-border bg-gn-bg-base px-3 py-2 font-mono text-[13px] text-gn-fg outline-none placeholder:text-gn-gray-dim focus:border-gn-prompt-border-active"
        />
        {error ? (
          <p className="mb-2 text-[12px] text-gn-red" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={onDecline}
            className="flex-1 rounded-md border border-gn-prompt-border px-3 py-2 text-[13px] text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
            title="不直连这台，请求继续经 Hub 中转（不影响 Hub 登录）"
          >
            改用 Hub 中继
          </button>
          <button
            type="button"
            disabled={!value.trim() || busy}
            onClick={() => void submit()}
            className="flex-1 rounded-md bg-gn-blue px-3 py-2 text-[13px] font-medium text-gn-bg-base transition-opacity enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? '验证中…' : '直连这台'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
