/* modal.js — 通用弹层 */

import { $, h } from './core.js'

let escHandler = null

export function closeModal () {
  const root = $('#modal-root')
  if (!root) return
  root.classList.remove('open')
  root.textContent = ''
  if (escHandler) {
    document.removeEventListener('keydown', escHandler)
    escHandler = null
  }
}

export function openModal ({ title, sub = '', tabs = null, render, width = 780, onClose = null, tab = null }) {
  const root = $('#modal-root')
  root.textContent = ''
  root.classList.add('open')

  const done = () => {
    closeModal()
    if (onClose) onClose()
  }

  const body = h('div', { class: 'modal-body' })
  const panel = h('div', { class: 'modal', style: { width: `min(${width}px, 92vw)` } },
    h('div', { class: 'modal-head' },
      h('div', {},
        h('h2', { text: title }),
        sub ? h('div', { class: 'sub', text: sub }) : null
      ),
      h('button', { class: 'close-btn', onclick: done }, '✕')
    )
  )

  if (tabs && tabs.length) {
    const bar = h('div', { class: 'modal-tabs' })
    const paint = (id, animate = true) => {
      ;[...bar.children].forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === id))
      body.textContent = ''
      render(body, id)
      if (animate && !document.body.classList.contains('reduced-motion')) {
        body.classList.remove('tab-enter')
        void body.offsetWidth
        body.classList.add('tab-enter')
      }
    }
    for (const tab of tabs) {
      bar.append(h('button', { dataset: { tab: tab.id }, onclick: () => paint(tab.id), text: tab.label }))
    }
    panel.append(bar, body)
    /* 指定了初始标签就跳过去，否则打开第一个 */
    paint(tab && tabs.some((t) => t.id === tab) ? tab : tabs[0].id, false)
  } else {
    panel.append(body)
    render(body, null)
  }

  root.append(
    h('div', { class: 'modal-backdrop', onclick: done }),
    panel
  )

  escHandler = (e) => { if (e.key === 'Escape') done() }
  document.addEventListener('keydown', escHandler)

  return { body, close: done }
}

export function field (label, control, hint = '') {
  return h('div', { class: 'field' },
    h('label', { class: 'label', text: label }),
    control,
    hint ? h('div', { class: 'hint', text: hint }) : null
  )
}

export function switchRow (label, on, onToggle, hint = '') {
  return h('div', { class: 'mini-row' },
    h('div', {},
      h('div', { text: label }),
      hint ? h('div', { class: 'hint', text: hint }) : null
    ),
    h('div', { class: 'switch' + (on ? ' on' : ''), onclick: (e) => {
      const el = e.currentTarget
      el.classList.toggle('on')
      onToggle(el.classList.contains('on'))
    } })
  )
}
