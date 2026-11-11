/* security.js — 设置 → 安全边界
 *
 * 这一页只做三件事：让你看见「哪些东西正要出去」、让 AI 的活有据可查、
 * 让账本自己证明自己没被改过。不做的事同样明确：不替你决定发不发，
 * 也不假装拦得住它看不见的东西（比如工具自己去读的本地文件）。
 */

import { h, toast } from './core.js'
import { openModal, closeModal } from './modal.js'

let cache = { status: null, pending: [], tasks: [], entries: [], verify: null, error: '' }

const RISK = {
  critical: { text: '密钥级', cls: 'crit' },
  high: { text: '高危', cls: 'high' },
  medium: { text: '敏感', cls: 'mid' },
  low: { text: '轻微', cls: '' },
  none: { text: '干净', cls: '' }
}

const STATUS = {
  candidate: { text: '待确认', cls: '' },
  open: { text: '留痕中', cls: 'on' },
  closed: { text: '已归档', cls: '' },
  dropped: { text: '未采用', cls: '' }
}

const KIND = {
  task: '任务', understand: '理解', action: '动作', outbound: '外发',
  approval: '批准', gate: '拦下', close: '归档', correct: '更正', note: '备注'
}

function api (name, payload) {
  const fn = window.astral && window.astral[name]
  if (typeof fn !== 'function') return Promise.resolve({ ok: false, error: '这个版本还没有接入接口' })
  return fn(payload).catch((err) => ({ ok: false, error: err.message || String(err) }))
}

function pad (n) { return String(n).padStart(2, '0') }

function shortTime (iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function clip (text, max) {
  const value = String(text || '')
  return value.length > max ? value.slice(0, max) + '…' : value
}

function riskTag (risk) {
  const item = RISK[risk] || RISK.none
  return h('span', { class: 'tag' + (item.cls ? ' ' + item.cls : ''), text: item.text })
}

async function load () {
  const [status, pending, tasks, ledger] = await Promise.all([
    api('securityStatus'),
    api('securityPending'),
    api('securityTasks', { status: 'all', limit: 60 }),
    api('securityLedger', { limit: 40 })
  ])
  cache.status = status.ok ? status : null
  cache.error = status.ok ? '' : (status.error || '安全边界不可用')
  cache.pending = pending.gates || []
  cache.tasks = tasks.tasks || []
  cache.entries = ledger.entries || []
  cache.verify = ledger.verify || null
}

/* ------------------------------------------------------------ 主渲染 */

export async function renderSecurity (body) {
  body.textContent = ''
  body.append(h('div', { class: 'hint', text: '正在读取闸门与账本…' }))
  await load()
  body.textContent = ''

  if (!cache.status) {
    body.append(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, '安全边界'),
      h('div', { class: 'hint', text: cache.error || '记忆服务已关闭，闸门与账本都跟着停了。' }),
      h('div', { class: 'hint', text: '去「个人资料 → 记忆库」重新启用后，这一页会恢复。' })
    ))
    return
  }

  body.append(overviewCard())
  body.append(pendingCard())
  body.append(tasksCard())
  body.append(ledgerCard())
}

function overviewCard () {
  const status = cache.status
  const stats = status.stats || {}
  const allowTypes = Object.entries(status.allowTypes || {})
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', { class: 'card-title' }, '安全边界',
        h('span', { class: 'tag' + (status.guard ? ' on' : ''), text: status.guard ? '守卫开着' : '守卫已关' })
      ),
      h('button', { class: 'btn ghost', onclick: () => refresh() }, '刷新')
    ),
    h('div', { class: 'hint' },
      '三道边界：出去之前先问（密钥、身份证、银行卡、手机号都不许悄悄走），派活留下原话，做完存一条改不了的链。归档时账本会压成一条事件进事件网，事后问原委按权重和时间查。'),
    h('div', { class: 'mini-row' },
      h('span', {}, '等你点头'),
      h('span', { class: 'hint', text: String(stats.pending || 0) + ' 件' }),
      h('span', {}, '被你拦下'),
      h('span', { class: 'hint', text: String(stats.denied || 0) + ' 次' }),
      h('span', {}, '留痕中'),
      h('span', { class: 'hint', text: String(stats.openTasks || 0) + ' 条' }),
      h('span', {}, '账本'),
      h('span', { class: 'hint', text: String(stats.entries || 0) + ' 条' })
    ),
    h('div', { class: 'mini-row' },
      h('span', {}, '已进事件网'),
      h('span', { class: 'hint', text: String(stats.digested || 0) + ' 条' }),
      h('span', {}, '已归档'),
      h('span', { class: 'hint', text: String(stats.closedTasks || 0) + ' 条' })
    ),
    h('div', { class: 'mini-row' },
      h('span', {}, '出站守卫'),
      h('div', { class: 'hint', style: { flex: '1', textAlign: 'right', marginRight: '10px' }, text: '命中敏感内容先问你，不问不发' }),
      h('div', {
        class: 'switch' + (status.guard ? ' on' : ''),
        onclick: async (event) => {
          const node = event.currentTarget
          const next = !node.classList.contains('on')
          node.classList.toggle('on', next)
          const res = await api('securitySet', { guard: next })
          if (!res.ok) { toast(res.error || '保存失败', 'err'); node.classList.toggle('on', !next); return }
          toast(next ? '守卫已开' : '守卫已关：AI 外发不再先问', next ? 'ok' : 'err')
          await refresh()
        }
      })
    ),
    h('div', { class: 'mini-row' },
      h('span', {}, '派活留痕'),
      h('div', { class: 'hint', style: { flex: '1', textAlign: 'right', marginRight: '10px' }, text: '有人 @ 你派活时给你一条候选，你点头才记账' }),
      h('div', {
        class: 'switch' + (status.ledger ? ' on' : ''),
        onclick: async (event) => {
          const node = event.currentTarget
          const next = !node.classList.contains('on')
          node.classList.toggle('on', next)
          const res = await api('securitySet', { ledger: next })
          if (!res.ok) { toast(res.error || '保存失败', 'err'); node.classList.toggle('on', !next); return }
          toast(next ? '留痕已开' : '留痕已关', 'ok')
          await refresh()
        }
      })
    ),
    allowTypes.length
      ? h('div', { class: 'mini-row', style: { flexWrap: 'wrap', gap: '8px' } },
        h('span', {}, '这类的放行期'),
        ...allowTypes.map(([type, until]) => h('span', { class: 'tag', style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } },
          `${type} → ${shortTime(until)}`,
          h('button', {
            class: 'btn ghost',
            style: { padding: '0 4px', height: 'auto', fontSize: '10px' },
            onclick: async () => {
              await api('securitySet', { revokeType: type })
              toast('已撤销', 'ok')
              await refresh()
            }
          }, '×')
        ))
      )
      : null
  )
}

/* ------------------------------------------------------------ 待确认 */

function pendingCard () {
  const gates = cache.pending
  const card = h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', { class: 'card-title' }, '等你点头',
        h('span', { class: 'tag' + (gates.length ? ' warn' : ' on'), text: gates.length ? gates.length + ' 件' : '没有' })
      )
    ),
    h('div', { class: 'hint' }, '这些是 AI 想发出去、但内容里有不该流出去的东西。批准只对「这一份内容 + 这一个去处」有效。')
  )
  if (!gates.length) {
    card.append(h('div', { class: 'hint', style: { marginTop: '8px' }, text: '没有等着你决定的事。' }))
    return card
  }
  for (const gate of gates) {
    const risk = RISK[gate.risk] || RISK.none
    const hits = gate.hits || []
    card.append(h('div', { class: 'gate-row' },
      h('div', { class: 'gate-head' },
        riskTag(gate.risk),
        h('span', { class: 'gate-target', text: gate.target || gate.channel || '外部' }),
        h('span', { class: 'hint', text: shortTime(gate.at) })
      ),
      h('div', { class: 'hint', text: hits.map((hit) => `${hit.label} ×${hit.count}${hit.where ? '（' + hit.where + '）' : ''}`).join(' · ') }),
      gate.preview ? h('div', { class: 'gate-preview', text: gate.preview }) : null,
      gate.purpose ? h('div', { class: 'hint', text: '为什么发：' + gate.purpose }) : null,
      h('div', { class: 'btn-row', style: { marginTop: '8px' } },
        h('button', {
          class: 'btn' + (gate.risk === 'critical' ? ' ghost' : ' primary'),
          onclick: () => decide(gate, 'allow')
        }, '允许这一次'),
        gate.risk === 'critical' || gate.risk === 'high'
          ? null
          : h('button', { class: 'btn ghost', onclick: () => decide(gate, 'allow-type') }, '这类今天不再问'),
        h('button', { class: 'btn ghost', onclick: () => decide(gate, 'deny') }, '拒绝')
      )
    ))
  }
  return card
}

async function decide (gate, action) {
  if (action === 'deny') {
    const res = await api('securityDecide', { gateId: gate.id, decision: 'deny' })
    if (!res.ok) { toast(res.error || '操作失败', 'err'); return }
    toast('已拒绝，AI 不会再发这一份', 'ok')
  } else {
    const res = await api('securityDecide', {
      gateId: gate.id,
      decision: 'allow',
      scope: action === 'allow-type' ? 'type' : 'once'
    })
    if (!res.ok) { toast(res.error || '操作失败', 'err'); return }
    toast(res.note || '已允许这一次', 'ok')
  }
  await refresh()
}

/* ------------------------------------------------------------ 留痕 */

function taskRow (task) {
  const candidates = task.status === 'candidate'
  return h('div', { class: 'gate-row' },
    h('div', { class: 'gate-head' },
      h('span', { class: 'tag' + (STATUS[task.status] && STATUS[task.status].cls ? ' ' + STATUS[task.status].cls : ''), text: (STATUS[task.status] || {}).text || task.status }),
      h('span', { class: 'gate-target', text: task.id }),
      task.eventCode ? h('span', { class: 'tag on', text: task.eventCode, title: '已压缩进事件网' }) : null,
      h('span', { class: 'hint', text: [...new Set([task.fromName, task.channel, task.chat].filter(Boolean))].join(' · ') || shortTime(task.createdAt) })
    ),
    h('div', { class: 'gate-quote', text: clip(task.ask, 160) }),
    h('div', { class: 'hint', text: [task.deadline ? '时限 ' + task.deadline : '', task.entries ? task.entries + ' 条记录' : '', task.outcome ? '结果：' + clip(task.outcome, 40) : ''].filter(Boolean).join(' · ') }),
    h('div', { class: 'btn-row', style: { marginTop: '8px' } },
      candidates
        ? h('button', { class: 'btn primary', onclick: () => taskAction(task, 'open') }, '开始留痕')
        : null,
      candidates
        ? h('button', { class: 'btn ghost', onclick: () => taskAction(task, 'drop') }, '不用')
        : null,
      !candidates
        ? h('button', { class: 'btn ghost', onclick: () => taskAction(task, 'trace') }, '看原委')
        : null,
      !candidates
        ? h('button', { class: 'btn ghost', onclick: () => taskAction(task, 'export') }, '导出存证')
        : null,
      task.status === 'open'
        ? h('button', { class: 'btn ghost', onclick: () => taskAction(task, 'digest') }, task.eventCode ? '再压一次' : '压进事件')
        : null,
      task.status === 'open'
        ? h('button', { class: 'btn ghost', onclick: () => taskAction(task, 'close') }, '归档')
        : null
    )
  )
}

function tasksCard () {
  const candidates = cache.tasks.filter((task) => task.status === 'candidate')
  const open = cache.tasks.filter((task) => task.status === 'open')
  const closed = cache.tasks.filter((task) => task.status === 'closed')
  const card = h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', { class: 'card-title' }, '留痕',
        h('span', { class: 'tag' + (open.length ? ' on' : ''), text: open.length ? open.length + ' 条在记' : '空' })
      )
    ),
    h('div', { class: 'hint' },
      '有人在群里 @ 你派活时，这里会先出一条候选。你点头之后，原话、时间、谁说的、做到哪一步，都记进账本。账本只追加，改一个字后面的哈希就对不上。')
  )

  if (candidates.length) {
    card.append(h('div', { class: 'gate-section', text: '等你决定要不要留痕' }))
    for (const task of candidates) card.append(taskRow(task))
  }
  if (open.length) {
    card.append(h('div', { class: 'gate-section', text: '正在留痕' }))
    for (const task of open) card.append(taskRow(task))
  }
  if (!candidates.length && !open.length) {
    card.append(h('div', { class: 'hint', style: { marginTop: '8px' }, text: '还没有在记的活。消息接入里有人 @ 你派活时，这里会自动出现候选。' }))
  }
  if (closed.length) {
    card.append(h('div', { class: 'gate-section', text: '已归档（最近 ' + Math.min(5, closed.length) + ' 条）' }))
    for (const task of closed.slice(0, 5)) card.append(taskRow(task))
  }
  return card
}

async function taskAction (task, action) {
  if (action === 'trace') {
    const res = await api('securityTask', { action: 'trace', id: task.id })
    if (!res.ok) { toast(res.error || '查不到这条留痕', 'err'); return }
    if (res.found === false) { toast(res.text || '没有找到相关记录', 'err'); return }
    openTrace(res)
    return
  }
  if (action === 'digest') {
    const res = await api('securityTask', { action: 'digest', id: task.id })
    if (!res.ok) { toast(res.error || '压缩失败', 'err'); return }
    toast(res.already ? '账本没有新增，事件已是最新' : '已压进事件网：' + ((res.event && res.event.code) || ''), 'ok')
    await refresh()
    return
  }
  if (action === 'export') {
    const res = await api('securityTask', { action: 'export', id: task.id })
    if (!res.ok) { toast(res.error || '导出失败', 'err'); return }
    openExport(res)
    return
  }
  if (action === 'close') {
    const outcome = await askOutcome()
    if (outcome === null) return
    const res = await api('securityTask', { action: 'close', id: task.id, outcome })
    if (!res.ok) { toast(res.error || '归档失败', 'err'); return }
    const event = res.digest && res.digest.event
    if (res.digest && res.digest.ok === false) {
      toast('已归档；压进事件网失败：' + (res.digest.error || '未知原因'), 'err')
    } else {
      toast('已归档' + (event ? '，已压进事件网 ' + event.code : ''), 'ok')
    }
    await refresh()
    return
  }
  const res = await api('securityTask', { action, id: task.id })
  if (!res.ok) { toast(res.error || '操作失败', 'err'); return }
  toast(action === 'open' ? '开始留痕：' + task.id : '已丢掉这条候选', 'ok')
  await refresh()
}

/* Electron 里没有 window.prompt，收结果得自己开一个框 */
function askOutcome () {
  return new Promise((resolve) => {
    let value = ''
    openModal({
      title: '归档留痕',
      sub: '写一句结果，会原样进存证',
      width: 460,
      onClose: () => resolve(null),
      render: (box) => {
        const input = h('input', {
          class: 'input',
          placeholder: '例如：方案已发出，对方确认收到',
          oninput: (event) => { value = event.target.value },
          onkeydown: (event) => { if (event.key === 'Enter') { resolve(value); closeModal() } }
        })
        box.append(input)
        box.append(h('div', { class: 'btn-row', style: { marginTop: '12px' } },
          h('button', { class: 'btn primary', onclick: () => { resolve(value); closeModal() } }, '归档'),
          h('button', { class: 'btn ghost', onclick: () => { resolve(null); closeModal() } }, '取消')
        ))
      }
    })
  })
}

function openExport (result) {
  const markdown = result.markdown || ''
  openModal({
    title: '存证 · ' + (result.task ? result.task.id : ''),
    sub: result.verify && result.verify.ok ? '哈希链校验通过' : '哈希链校验未通过，请先核对',
    width: 760,
    render: (box) => {
      box.append(h('div', { class: 'hint' },
        '把下面这段贴进邮件、文档或工单即可。对方改了任何一行，链头哈希都对不上 —— 这就是它有用的原因。'))
      box.append(h('pre', { class: 'ledger-doc', text: markdown }))
      box.append(h('div', { class: 'btn-row', style: { marginTop: '12px' } },
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(markdown)
              toast('已复制全文', 'ok')
            } catch { toast('复制失败，可以手动选中', 'err') }
          }
        }, '复制全文'),
        h('button', { class: 'btn ghost', onclick: () => closeModal() }, '关闭')
      ))
    }
  })
}

function openTrace (result) {
  const task = result.task || {}
  const weight = result.weight || {}
  const metrics = result.metrics || {}
  const verify = result.verify || {}
  openModal({
    title: '原委 · ' + (task.id || ''),
    sub: `权重 ${weight.percent || 0}% · 账本 ${metrics.entries || 0} 条 · ${verify.ok ? '链完整' : '链在第 ' + verify.brokenAt + ' 条断了'}`,
    width: 720,
    render: (box) => {
      box.append(h('div', { class: 'hint' },
        '按时间排，不按重要度排 —— 追责看的是先后。下面这段可以直接复制给需要看的人。'))
      box.append(h('pre', { class: 'ledger-doc', text: result.text || '' }))
      if ((result.gaps || []).length) {
        box.append(h('div', {
          class: 'hint',
          style: { color: 'var(--warn)', marginTop: '8px' },
          text: '记录缺口：' + result.gaps.join('；')
        }))
      }
      box.append(h('div', { class: 'btn-row', style: { marginTop: '12px' } },
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(result.text || '')
              toast('已复制原委', 'ok')
            } catch { toast('复制失败，可以手动选中', 'err') }
          }
        }, '复制原委'),
        h('button', {
          class: 'btn ghost',
          onclick: async () => {
            closeModal()
            const res = await api('securityTask', { action: 'export', id: task.id })
            if (res.ok) openExport(res)
            else toast(res.error || '导出失败', 'err')
          }
        }, '导出存证'),
        h('button', { class: 'btn ghost', onclick: () => closeModal() }, '关闭')
      ))
    }
  })
}

/* ------------------------------------------------------------ 账本 */

function ledgerCard () {
  const verify = cache.verify || {}
  const entries = cache.entries
  const card = h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', { class: 'card-title' }, '账本',
        h('span', { class: 'tag' + (verify.ok ? ' on' : ' crit'), text: verify.ok ? '校验通过 · ' + (verify.count || 0) + ' 条' : '校验未通过' })
      ),
      h('button', {
        class: 'btn ghost',
        onclick: async () => {
          const res = await api('securityVerify')
          if (!res.ok) { toast(res.error || '校验失败', 'err'); return }
          toast(res.ok ? `链完整：${res.count} 条，链头 ${String(res.head).slice(0, 12)}` : `第 ${res.brokenAt} 条断了：${res.reason}`, res.ok ? 'ok' : 'err')
          await refresh()
        }
      }, '校验整条链')
    ),
    h('div', { class: 'hint' },
      '每一行都把上一行的哈希算进自己。数据库层已禁止修改与删除 —— 不是「我们承诺不改」，是「改不了」。'),
    verify.ok === false
      ? h('div', { class: 'hint', style: { color: 'var(--err)' }, text: `第 ${verify.brokenAt} 条开始对不上：${verify.reason}` })
      : null
  )
  if (!entries.length) {
    card.append(h('div', { class: 'hint', style: { marginTop: '8px' }, text: '账本还是空的。开一条留痕之后，这里会一条条长出来。' }))
    return card
  }
  for (const entry of entries.slice(0, 12)) {
    card.append(h('div', { class: 'ledger-row' },
      h('span', { class: 'ledger-time', text: shortTime(entry.at) }),
      h('span', { class: 'tag', text: KIND[entry.kind] || entry.kind }),
      h('span', { class: 'ledger-title', text: entry.title || (entry.body && entry.body.text) || entry.kind }),
      h('span', { class: 'ledger-hash', text: String(entry.hash || '').slice(0, 8) })
    ))
  }
  return card
}

async function refresh () {
  await load()
  const body = document.querySelector('#modal-root .modal-body')
  if (body) await renderSecurity(body)
}
