import { useChatStore } from '../store/chat'

/** TUI usage-info modal tabs（/context /usage /session-info 同一弹窗族）。 */
export type UsageInfoTabId = 'context' | 'session-usage' | 'session-info'

const TABS: { id: UsageInfoTabId; label: string }[] = [
  { id: 'context', label: 'Context usage' },
  { id: 'session-usage', label: 'Session usage' },
  { id: 'session-info', label: 'Session info' },
]

/**
 * Shared tab bar for the /context · /usage · /session-info modals.
 * Clicking a tab opens that surface (store flags are mutually exclusive,
 * so the current modal unmounts and the target mounts in the same commit).
 * Independent of the TopBar host-aggregate UsageModal (`usageOpen`).
 */
export function UsageInfoTabs({ active }: { active: UsageInfoTabId }) {
  return (
    <div
      role="tablist"
      aria-label="usage info tabs"
      className="gn-no-scrollbar flex gap-1 overflow-x-auto border-b border-gn-prompt-border px-2 pt-2"
    >
      {TABS.map((t) => {
        const selected = t.id === active
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => {
              if (selected) return
              const s = useChatStore.getState()
              if (t.id === 'context') s.openContext()
              else if (t.id === 'session-usage') s.openSessionUsage()
              else s.openSessionInfo()
            }}
            className={`shrink-0 whitespace-nowrap rounded px-3 py-1.5 text-[12px] ${
              selected
                ? 'bg-gn-bg-highlight text-gn-fg'
                : 'text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg'
            }`}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}
