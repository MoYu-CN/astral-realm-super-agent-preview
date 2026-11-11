/* scout.js — 探子：只读扫描项目目录，交给超级智能体整理，再写入权重网
 *
 * 链路：主进程只读扫描 → 可编辑摘要 → 超级智能体产出 JSON → 用户确认 →
 *       记忆库写入项目节点与事件 → reindex / syncTime / syncPhase 自动重建三张网。
 *
 * 不做的事：不自动扫聊天记录、不自动改文件、不自动调模型、不自动写库。
 */

import { $, h, toast, activeProject } from './core.js'
import { openModal, closeModal, field } from './modal.js'
import { enterSuperChat } from './superagent.js'

const SUPER_INSTRUCTION = [
  '请把下面的探子扫描摘要整理成权重图，严格只输出 JSON（不要代码块、不要解释）：',
  '{"nodes":[{"name":"项目名","summary":"一句话","events":[{"prefix":"S","summary":"要点"}]}]}',
  '节点名用真实项目 / 模块名，事件只写可复用要点，不要编造未提供的内容。',
  '',
  ''
].join('\n')

async function sendToSuper (digest) {
  if (!String(digest || '').trim()) {
    toast('先扫描或粘贴一段摘要', 'err')
    return
  }
  await enterSuperChat()
  closeModal()
  const input = $('#input')
  if (input) {
    input.value = SUPER_INSTRUCTION + String(digest).slice(0, 6000)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
  }
  toast('已写进直连会话输入框，确认后发送；把返回的 JSON 贴回探子即可写入')
}

async function commit (projectName, text, rootPath) {
  if (!String(text || '').trim()) {
    toast('摘要为空，先扫描或粘贴内容', 'err')
    return
  }
  let res
  try {
    res = await window.astral.memoryCommitScout({ project: projectName, text, rootPath })
  } catch (err) {
    toast('写入失败：' + err.message, 'err')
    return
  }
  if (!res || !res.ok) {
    toast((res && res.error) || '写入失败', 'err')
    return
  }
  const data = res.data || {}
  toast(`已写入 ${data.projects || 0} 个项目 / ${data.events || 0} 条事件，三张网已重建`, 'ok')
  closeModal()
}

export function openScout (project = null) {
  const current = project || activeProject()
  if (!current) {
    toast('先选择一个项目', 'err')
    return
  }
  let rootPath = current.rootPath || ''

  openModal({
    title: '探子 · 快速搭建权重网',
    sub: '只读扫描 → 摘要 → 超级智能体整理 → 写入权重网',
    width: 720,
    render: (body) => {
      const dirInput = h('input', {
        class: 'input',
        value: rootPath,
        placeholder: '项目目录（必填，探子不会扫描桌面 / 下载 / 文档等个人目录）',
        oninput: (e) => { rootPath = e.target.value }
      })
      const chooseBtn = h('button', {
        class: 'btn ghost',
        type: 'button',
        onclick: async () => {
          if (!window.astral.pickFolder) return
          try {
            const picked = await window.astral.pickFolder()
            if (picked) { dirInput.value = picked; rootPath = picked }
          } catch (err) {
            toast('选择目录失败：' + err.message, 'err')
          }
        }
      }, '选择目录')
      const report = h('div', { class: 'scout-report hint', text: '尚未扫描。' })
      const area = h('textarea', {
        class: 'input scout-area',
        rows: 12,
        placeholder: '扫描后这里会出现可编辑摘要；也可以粘贴超级智能体整理好的 JSON。'
      })

      const scanBtn = h('button', {
        class: 'btn ghost',
        type: 'button',
        onclick: async () => {
          if (!rootPath.trim()) { toast('先指定项目目录', 'err'); return }
          report.textContent = '扫描中…'
          let res
          try {
            res = await window.astral.scoutScan({ rootPath })
          } catch (err) {
            report.textContent = '扫描失败：' + err.message
            return
          }
          if (!res || !res.ok) {
            report.textContent = (res && res.error) || '扫描失败'
            toast((res && res.error) || '扫描失败', 'err')
            return
          }
          const stats = res.stats || {}
          report.textContent = `${stats.scanned || 0} 个文本文件 · ${(res.files || []).length} 份摘录 · 跳过 ${stats.skipped || 0} 项` +
            (stats.truncated ? ' · 已触及扫描上限，仅代表性样本' : '')
          area.value = res.digest || ''
          rootPath = res.root || rootPath
          toast('扫描完成，摘要可编辑')
        }
      }, '扫描目录')

      body.append(
        h('div', { class: 'hint', text: '探子只读取你指定的项目目录，跳过依赖目录与隐藏文件，不跟随符号链接，也不改动任何文件。工作聊天记录等敏感来源不在这里扫描，需经「观察」通道显式写入。' }),
        field('项目目录', h('div', { class: 'input-with-btn' }, dirInput, chooseBtn),
          '留空时不会扫描；当前项目：' + current.name),
        h('div', { class: 'btn-row', style: { marginTop: '10px' } }, scanBtn),
        report,
        field('摘要 / 超级智能体整理结果', area,
          '纯文本会按当前项目建一个节点；粘贴 JSON（含 nodes 数组）可一次建多个节点与事件。'),
        h('div', { class: 'btn-row', style: { marginTop: '16px' } },
          h('button', { class: 'btn ghost', type: 'button', onclick: () => closeModal() }, '取消'),
          h('button', {
            class: 'btn ghost', type: 'button',
            onclick: async () => { await sendToSuper(area.value) }
          }, '交给超级智能体整理'),
          h('button', {
            class: 'btn-primary', type: 'button',
            onclick: async () => { await commit(current.name, area.value, rootPath) }
          }, '写入权重网')
        )
      )
    }
  })
}
