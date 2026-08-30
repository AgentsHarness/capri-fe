/**
 * Composer 浮层（斜杠命令 / @ 文件）共用的行样式。
 *
 * 选中态要有底色以外的第二信号，否则 hover 与键盘选中分不开 ——
 * bg-highlight 在浅色主题下与弹层底色同值、在 oscura 下几乎同值，
 * 单靠它看不出选中。底色用 index.css 的 .gn-menu-sel（gn-selection
 * 与浮层底色混到 30%，只剩一层薄抬升），识别再叠上命令名加粗提亮、行尾
 * `↵` 与文字亮度（描述 muted → fg2）。
 */
export function menuRowClass(selected: boolean): string {
  return [
    'flex w-full cursor-pointer items-center py-[5px] pr-2 pl-3 text-left transition-colors',
    selected ? 'gn-menu-sel' : 'hover:bg-gn-bg-highlight',
  ].join(' ')
}

/**
 * 浮层页脚里的动作按钮。必须有描边 + hover 提亮 + 按下位移：
 * Tailwind v4 的 preflight 把 <button> 默认设成 cursor: default，
 * 光靠文字（哪怕带 hover 底色）看起来就跟状态文案没区别。
 */
export function menuActionClass(): string {
  return [
    'shrink-0 cursor-pointer rounded border border-gn-prompt-border-active px-1.5',
    'leading-[15px] text-gn-fg2 transition-colors',
    'hover:border-gn-cyan/60 hover:bg-gn-bg-highlight hover:text-gn-cyan',
    'active:translate-y-[0.5px]',
  ].join(' ')
}
