/* intake.js — 设置 → 消息接入
 *
 * 所有渠道共用一套卡片：状态、开关、配置、接收地址。
 * 用户不需要知道哪条是官方、哪条是本地读取 —— 只需要看风险标签和能力位，
 * 然后自己决定开哪一条。
 */

import { h, toast } from './core.js'
import { openModal, closeModal, field } from './modal.js'
import { confirmAction } from './confirm.js'

let cache = { channels: [], kinds: [], stats: null, port: 0 }

const ROUTE_LABEL = {
  alert: { text: '提醒', cls: 'on' },
  observe: { text: '观察', cls: '' },
  knowledge: { text: '知识', cls: '' },
  archive: { text: '归档', cls: '' }
}

function api (name, payload) {
  const fn = window.astral && window.astral[name]
  if (typeof fn !== 'function') return Promise.resolve({ ok: false, error: '这个版本还没有接入接口' })
  return fn(payload).catch((err) => ({ ok: false, error: err.message || String(err) }))
}

function statusDot (channel) {
  const running = channel.enabled && (channel.live && channel.live.running || channel.status === '运行中')
  const text = !channel.enabled ? '未启用' : (running ? '运行中' : (channel.status || '待启动'))
  return h('span', { class: 'tag' + (running ? ' on' : ''), text })
}

async function load () {
  const [list, catalog, stats] = await Promise.all([
    api('intakeList'), api('intakeCatalog'), api('intakeStats')
  ])
  cache.channels = list.channels || []
  cache.port = list.port || 0
  cache.kinds = catalog.kinds || []
  cache.stats = stats.stats || null
}

/* ------------------------------------------------------------ 主渲染 */

export async function renderIntake (body) {
  body.textContent = ''
  body.append(h('div', { class: 'hint', text: '正在读取渠道…' }))
  await load()
  body.textContent = ''

  body.append(overviewCard())
  body.append(channelCard())
  body.append(inboxCard())
  body.append(catalogCard())
}

function overviewCard () {
  const stats = cache.stats || {}
  const running = cache.channels.filter((item) => item.enabled).length
  const routes = stats.routes || {}
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', { class: 'card-title' }, '消息接入',
        h('span', { class: 'tag' + (running ? ' on' : ''), text: running ? `${running} 条在收` : '全部停用' })
      ),
      h('button', {
        class: 'btn ghost',
        onclick: async () => { await load(); await renderIntake(document.querySelector('#modal-root .modal-body') || document.body) }
      }, '刷新')
    ),
    h('div', { class: 'hint' },
      '所有渠道走同一套接口：收到的东西先落进收件箱，原文不进上下文，只有摘要、索引和「要不要问你一句」会越界。'),
    h('div', { class: 'mini-row' },
      h('span', {}, '今日收到'),
      h('span', { class: 'hint', text: String(stats.today || 0) }),
      h('span', {}, '待看'),
      h('span', { class: 'hint', text: String(routes.alert || 0) + ' 提醒 · ' + String(routes.observe || 0) + ' 观察' }),
      h('span', {}, '本地入口'),
      h('span', { class: 'hint', text: cache.port ? `127.0.0.1:${cache.port}` : '未启动' })
    )
  )
}

function channelCard () {
  const card = h('div', { class: 'card', style: { marginTop: '12px' } },
    h('div', { class: 'card-head' },
      h('div', { class: 'card-title' }, '已接入的渠道')
    )
  )
  if (!cache.channels.length) {
    card.append(h('div', { class: 'hint', text: '还没有接入任何渠道。从下面的清单里挑一条添加。' }))
    return card
  }
  for (const channel of cache.channels) {
    card.append(h('div', { class: 'mini-row', style: { alignItems: 'center' } },
      h('div', { style: { minWidth: 0 } },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('span', { class: 'card-title', style: { fontSize: '13px' }, text: channel.label }),
          statusDot(channel)
        ),
        h('div', { class: 'hint', style: { marginTop: '2px' },
          text: (channel.catalog ? channel.catalog.label : channel.kind) + (channel.lastAt ? ' · 最后一条 ' + shortTime(channel.lastAt) : '') + (channel.lastError ? ' · ' + channel.lastError : '') })
      ),
      h('div', { class: 'btn-row', style: { marginLeft: 'auto' } },
        h('button', { class: 'btn ghost', onclick: () => openChannelDialog(channel) }, '配置'),
        h('button', {
          class: 'btn ghost',
          onclick: () => removeChannel(channel)
        }, '移除'),
        h('div', {
          class: 'switch' + (channel.enabled ? ' on' : ''),
          onclick: async (event) => {
            const on = !event.currentTarget.classList.contains('on')
            event.currentTarget.classList.toggle('on', on)
            const res = await api('intakeEnable', { id: channel.id, enabled: on })
            if (!res.ok) {
              event.currentTarget.classList.toggle('on', !on)
              toast(res.error || '切换失败', 'err')
              return
            }
            if (on) toast('已启动：' + channel.label, 'ok')
            await refresh()
          }
        })
      )
    ))
  }
  return card
}

function inboxCard () {
  const card = h('div', { class: 'card', style: { marginTop: '12px' } },
    h('div', { class: 'card-head' },
      h('div', { class: 'card-title' }, '收件箱 · 最近 12 条'),
      h('span', { class: 'hint', text: '原文留在这里，不进上下文' })
    )
  )
  const list = h('div', {})
  card.append(list)
  api('intakeMessages', { limit: 12 }).then((res) => {
    const messages = res.messages || []
    if (!messages.length) {
      list.append(h('div', { class: 'hint', text: '还没有收到任何消息。' }))
      return
    }
    for (const msg of messages) {
      const route = ROUTE_LABEL[msg.route] || ROUTE_LABEL.archive
      list.append(h('div', { class: 'mini-row' },
        h('div', { style: { minWidth: 0, flex: 1 } },
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h('span', { class: 'hint', text: shortTime(msg.at) }),
            h('span', { class: 'tag' + (route.cls ? ' ' + route.cls : ''), text: route.text }),
            h('span', { class: 'hint', text: msg.chatName || msg.chatId })
          ),
          h('div', { style: { marginTop: '2px', fontSize: '12.5px' }, text: clip(msg.text, 90) })
        )
      ))
    }
  })
  return card
}

function catalogCard () {
  const card = h('div', { class: 'card', style: { marginTop: '12px' } },
    h('div', { class: 'card-head' },
      h('div', { class: 'card-title' }, '可添加的渠道'),
      h('span', { class: 'hint', text: '同一套接口，不同传输；按自己的情况挑' })
    )
  )
  for (const kind of cache.kinds) {
    card.append(h('div', { class: 'mini-row', style: { alignItems: 'flex-start' } },
      h('div', { style: { minWidth: 0, flex: 1 } },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('span', { class: 'card-title', style: { fontSize: '13px' }, text: kind.label }),
          h('span', { class: 'tag' + (kind.risk.level === 'safe' ? ' on' : ''), text: kind.risk.label }),
          h('span', { class: 'hint', text: capText(kind) })
        ),
        h('div', { class: 'hint', style: { marginTop: '3px' }, text: kind.summary }),
        h('div', { class: 'hint', style: { marginTop: '2px', opacity: '.75' }, text: kind.note })
      ),
      h('button', {
        class: 'btn',
        style: { flex: '0 0 auto' },
        onclick: () => openChannelDialog(null, kind)
      }, '添加')
    ))
  }
  return card
}

function capText (kind) {
  const cap = kind.capabilities || {}
  const parts = []
  if (cap.receive) parts.push('能收')
  if (cap.history) parts.push('含历史')
  if (cap.realtime) parts.push('实时')
  if (cap.send) parts.push('能发')
  return parts.join(' · ')
}

/* ------------------------------------------------------------ 配置弹层 */

function clip (text, max) {
  const value = String(text || '')
  return value.length > max ? value.slice(0, max) + '…' : value
}

function shortTime (iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function makeControl (kindField, current, secretSet) {
  const key = kindField.key
  const value = current[key]
  if (kindField.type === 'boolean') {
    return h('div', {
      class: 'switch' + (value === true || (value === undefined && kindField.default === true) ? ' on' : ''),
      onclick: (event) => event.currentTarget.classList.toggle('on')
    })
  }
  if (kindField.type === 'select') {
    const select = h('select', { class: 'input' })
    for (const option of kindField.options || []) {
      select.append(h('option', { value: option.value, text: option.label, selected: String(value ?? kindField.default ?? '') === String(option.value) }))
    }
    return select
  }
  const input = h('input', {
    class: 'input',
    type: kindField.type === 'number' ? 'number' : (kindField.secret ? 'password' : 'text'),
    value: kindField.secret ? '' : (value === undefined || value === null ? '' : String(value)),
    placeholder: kindField.secret && secretSet ? '已设置，留空则不修改' : (kindField.placeholder || '')
  })
  return input
}

function readControl (kindField, node) {
  if (kindField.type === 'boolean') return node.classList.contains('on')
  return node.value
}

function openChannelDialog (channel, kindPreset = null) {
  const kind = kindPreset || cache.kinds.find((item) => item.id === channel.kind)
  if (!kind) { toast('找不到这个渠道类型', 'err'); return }
  const current = (channel && channel.config) || {}
  const secretSet = channel && Array.isArray(channel.secretsSet) && channel.secretsSet.length > 0
  const controls = new Map()

  openModal({
    title: channel ? '配置：' + channel.label : '添加：' + kind.label,
    sub: kind.risk.hint,
    width: 560,
    render: (box) => {
      box.append(h('div', { class: 'hint', style: { marginBottom: '10px' }, text: kind.summary }))
      for (const kindField of kind.fields || []) {
        const control = makeControl(kindField, current, secretSet)
        controls.set(kindField.key, { field: kindField, node: control })
        box.append(field(kindField.label, control, kindField.hint || ''))
      }

      if (channel) {
        box.append(h('div', { class: 'mini-row', style: { marginTop: '10px' } },
          h('span', {}, '接收地址'),
          h('span', { class: 'hint', style: { wordBreak: 'break-all', flex: 1 }, text: '点击下方按钮复制' })
        ))
      }

      box.append(h('div', { class: 'btn-row', style: { marginTop: '14px' } },
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            const values = {}
            for (const [key, item] of controls) values[key] = readControl(item.field, item.node)
            const payload = {
              id: channel ? channel.id : undefined,
              kind: kind.id,
              label: channel ? channel.label : kind.label,
              enabled: channel ? channel.enabled : false,
              values
            }
            const saved = await api('intakeSave', payload)
            if (!saved.ok) { toast(saved.error || '保存失败', 'err'); return }
            closeModal()
            toast('已保存', 'ok')
            await refresh()
          }
        }, '保存'),
        channel ? h('button', {
          class: 'btn ghost',
          onclick: async () => {
            const res = await api('intakeHook', { id: channel.id })
            if (!res.ok || !res.url) { toast('这条渠道没有 HTTP 入口', 'err'); return }
            try { await navigator.clipboard.writeText(res.url); toast('接收地址已复制', 'ok') } catch { toast('复制失败', 'err') }
          }
        }, '复制接收地址') : null,
        channel && kind.id === 'wechat-personal' ? h('button', {
          class: 'btn ghost',
          onclick: async () => {
            const res = await api('intakeDetect', { id: channel.id })
            const env = (res && res.env) || {}
            const lines = []
            lines.push('微信进程：' + (env.wechatRunning ? '在跑' : '没检测到'))
            lines.push('数据目录：' + (env.accounts && env.accounts.length ? env.accounts.length + ' 个账号' : '没找到'))
            lines.push('桥接：' + (env.bridge || '未配置，默认找本机 chatlog'))
            toast(lines.join(' · '), 'ok')
          }
        }, '检测环境') : null,
        h('button', { class: 'btn ghost', onclick: () => closeModal() }, '取消')
      ))
    }
  })
}

async function removeChannel (channel) {
  const ok = await confirmAction({
    title: '移除渠道',
    message: `移除「${channel.label}」会同时删掉它已经收到的消息，确定吗？`,
    confirmText: '移除'
  })
  if (!ok) return
  const res = await api('intakeRemove', { id: channel.id })
  if (!res.ok) { toast(res.error || '移除失败', 'err'); return }
  toast('已移除', 'ok')
  await refresh()
}

async function refresh () {
  await load()
  const body = document.querySelector('#modal-root .modal-body')
  if (body) await renderIntake(body)
}
