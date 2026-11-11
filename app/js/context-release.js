/* context-release.js — 运行中释放上下文（纯函数，无 DOM 依赖，可单测）
 *
 * 「释放」= 把某条已存在的消息从**下一轮发给模型的上下文**里排除，
 * 界面上仍然留着（变淡、标记「已释放」），随时可以恢复。
 * 它和「撤回」的区别：撤回删历史；释放只是不再占用上下文。
 * 它和「预算压缩」的区别：压缩会把旧消息折成摘要继续带着；释放是彻底不带，连摘要都不进。
 */

export function isContextReleased (msg) {
  return Boolean(msg && msg.ctxReleased === true)
}

/* 三参写法：toggleContextRelease(msg) 反转；toggleContextRelease(msg, true/false) 指定 */
export function toggleContextRelease (msg, released) {
  if (!msg) return false
  const next = typeof released === 'boolean' ? released : !msg.ctxReleased
  msg.ctxReleased = next === true
  return msg.ctxReleased
}

/* 发给模型的那部分消息：被释放的不再出现 */
export function liveMessages (messages) {
  return (messages || []).filter((msg) => !isContextReleased(msg))
}

/* 统计口径与界面一致：只数文字，不含附件/任务（那些由各自的预算管） */
export function releasedStats (messages, tokensOf) {
  const count = (messages || []).filter((m) => isContextReleased(m)).length
  let tokens = 0
  if (typeof tokensOf === 'function') {
    for (const msg of messages || []) {
      if (isContextReleased(msg)) tokens += tokensOf(msg)
    }
  }
  return { count, tokens: Math.max(0, Math.round(tokens)) }
}
