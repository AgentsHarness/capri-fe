import type { ReactNode } from 'react'

/** 分类内的小节标题 + 行组。 */
export function SettingsGroup({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="border-b border-gn-prompt-border/50 py-1 last:border-b-0">
      <div className="flex items-baseline gap-1.5 border-b border-gn-prompt-border/30 bg-gn-bg-base px-3 pt-2 pb-1.5 sm:border-0 sm:bg-transparent sm:px-4 sm:pt-1.5 sm:pb-0.5">
        <span className="text-[11px] font-medium tracking-wide text-gn-fg2 sm:text-[10.5px]">
          {title}
        </span>
        {hint ? (
          <span className="text-[10.5px] text-gn-gutter sm:text-[10px]">{hint}</span>
        ) : null}
      </div>
      {children}
    </div>
  )
}

/**
 * One settings row: key + hint on the left, control on the right. Narrow
 * panes (and mobile) stack the control under the label for multi-item choices,
 * while keeping single toggles / inputs inline for a clean mobile settings layout.
 */
export function SettingRow({
  label,
  hint,
  code,
  stackOnMobile = false,
  children,
}: {
  label: string
  hint?: string
  /** 配置键名，悬停可见，界面不直接展示。 */
  code?: string
  /** 移动端多选项（如 ChoiceTabs）强制换行堆叠，默认单控件左右同行。 */
  stackOnMobile?: boolean
  children: ReactNode
}) {
  return (
    <div
      className={`border-b border-gn-prompt-border/40 px-3 py-3 last:border-b-0 sm:px-4 sm:py-2.5 ${
        stackOnMobile
          ? 'flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6'
          : 'flex items-start justify-between gap-3 sm:gap-6'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div
          className="text-[13px] leading-snug text-gn-fg sm:text-[12px]"
          title={code ?? label}
        >
          {label}
        </div>
        {hint ? (
          <div className="mt-1 text-[11.5px] leading-relaxed text-gn-fg2 sm:mt-0.5 sm:text-[10.5px] sm:leading-snug">
            {hint}
          </div>
        ) : null}
      </div>
      <div
        className={`flex min-w-0 flex-wrap items-center gap-1.5 sm:max-w-[58%] sm:justify-end sm:gap-1 ${
          stackOnMobile
            ? 'w-full justify-end self-start sm:w-auto sm:self-center'
            : 'max-w-[52%] shrink-0 justify-end self-center'
        }`}
      >
        {children}
      </div>
    </div>
  )
}
