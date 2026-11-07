import type { DiffRowKind } from '../../../lib/gitPanel'

export function DiffRowView({ kind, text }: { kind: DiffRowKind; text: string }) {
  if (kind === 'header') {
    return <div className="px-2.5 py-0.5 font-mono text-[11px] text-gn-cyan/80 bg-gn-bg-dark/40">{text}</div>
  }
  if (kind === 'hunk') {
    return <div className="px-2.5 py-0.5 font-mono text-[11px] text-gn-muted bg-gn-bg-base/40">{text}</div>
  }
  const bg =
    kind === 'insert'
      ? 'var(--color-gn-diff-ins-bg)'
      : kind === 'delete'
        ? 'var(--color-gn-diff-del-bg)'
        : undefined
  const fg =
    kind === 'insert'
      ? 'var(--color-gn-diff-ins-fg)'
      : kind === 'delete'
        ? 'var(--color-gn-diff-del-fg)'
        : 'var(--color-gn-fg2)'
  const sign = kind === 'insert' ? '+' : kind === 'delete' ? '−' : ' '
  return (
    <div className="flex font-mono text-[12px] leading-[1.4] hover:bg-gn-bg-highlight/30" style={{ background: bg }}>
      <span className="shrink-0 select-none px-1.5 font-semibold opacity-70" style={{ color: fg }}>
        {sign}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all" style={{ color: fg }}>
        {text || ' '}
      </span>
    </div>
  )
}
