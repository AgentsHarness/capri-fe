import type { ActiveTab } from '../../../lib/gitPanel'

const TABS: { id: ActiveTab; label: string; shortLabel: string }[] = [
  { id: 'changes', label: '变更', shortLabel: '变更' },
  { id: 'log', label: '历史', shortLabel: '历史' },
  { id: 'sync', label: '分支与同步', shortLabel: '同步' },
]

/** Git 面板分类 tab 条（变更 / 历史 / 分支与同步）。 */
export function GitPanelTabs({
  activeTab,
  setActiveTab,
  rowCount,
}: {
  activeTab: ActiveTab
  setActiveTab: (tab: ActiveTab) => void
  rowCount: number
}) {
  return (
          <nav
            role="tablist"
            aria-label="Git 面板分类"
            className="shrink-0 border-b border-gn-prompt-border bg-gn-bg-dark/30 p-1.5"
          >
            <div className="flex w-full gap-1">
              {TABS.map((tab) => {
                const on = activeTab === tab.id
                const count = tab.id === 'changes' && rowCount > 0 ? rowCount : undefined
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-label={tab.label}
                    aria-selected={on}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded px-1.5 py-1.5 text-[11.5px] transition-colors sm:flex-none sm:px-3 sm:py-1.5 sm:text-[12px] ${
                      on
                        ? 'bg-gn-bg-highlight font-medium text-gn-fg'
                        : 'text-gn-muted hover:bg-gn-bg-highlight/60 hover:text-gn-fg'
                    }`}
                  >
                    <span className="sm:hidden">{tab.shortLabel}</span>
                    <span className="hidden sm:inline">{tab.label}</span>
                    {count != null && (
                      <span className="rounded bg-gn-bg-dark/80 px-1 font-mono text-[10px] text-gn-muted">
                        {count}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </nav>
  )
}
