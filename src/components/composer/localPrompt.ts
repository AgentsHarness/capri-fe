/**
 * 本端发出的最近一条回合身份（promptId）。
 *
 * send() 在同步段锚定 currentPromptId；host 自己开跑的回合（队列收养
 * adoptTurn / 历史回放）同样锚定 currentPromptId、同样没有
 * promptAcceptedAt，只有这条模块级记录能区分「我发的」与「host 自己开
 * 的」——等待受理回执的提示只对前者有意义。放在模块级而非 ref：Composer
 * 重挂载（焦点模式等）后不该忘记刚发的那条。
 */
let lastLocalPromptId: string | undefined

export function noteLocalPrompt(id: string | undefined): void {
  lastLocalPromptId = id
}

export function isLastLocalPrompt(id: string | null | undefined): boolean {
  return id != null && id === lastLocalPromptId
}
