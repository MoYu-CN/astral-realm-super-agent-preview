/* knowledge/plugin.js — 内置项目知识库（原生隔离沙箱 UI）
 *
 * 与 DSH 的 dsh-knowledge 对齐：方法/避错分册、编号只增不改、
 * 每册容量/总量/自动清理可配、kb_guide 工序检索、8 个智能体工具、
 * 总纲与「本项目必读」注入。存储层复用其 MIT 实现（kb-store.mjs）。
 *
 * 这个文件只使用隔离沙箱 API（astral.*）：
 *   - 不 import 主界面模块，不能访问主界面 DOM / 全局状态；
 *   - 数据读写经 astral.knowledge.call 走主进程服务；
 *   - 编辑/设置用 astral.ui.modal，打开时宿主把 iframe 提升为全窗口浮层；
 *   - 主题与组件样式由宿主注入，外观与主界面一致。
 */

const KIND_META = {
  方法: { label: '方法', cls: 'method', prefix: 'M' },
  避错: { label: '避错', cls: 'pitfall', prefix: 'P' }
}

let astral = null
let h = null

let hostEl = null
let listEl = null
let countEl = null
let pathEl = null
let projectEl = null
let data = { exists: false, entries: [], config: {} }
let query = ''
let viewEntries = null
let loading = false

function projectName () {
  const project = astral && astral.project ? astral.project.current() : null
  return (project && project.name) || '默认项目'
}

async function invoke (action, args = {}) {
  try {
    const res = await astral.knowledge.call(action, args)
    return res && typeof res === 'object' ? res : { ok: false, error: '知识库没有返回数据' }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
}

function formatPath (value) {
  const text = String(value || '')
  return text.length > 42 ? `${text.slice(0, 18)}…${text.slice(-20)}` : text
}

function fieldText (entry, key) {
  const value = entry ? entry[key] : ''
  return typeof value === 'string' ? value.trim() : ''
}

function visibleEntries () {
  const rows = Array.isArray(viewEntries) ? viewEntries : (data.entries || [])
  const needle = query.trim().toLowerCase()
  if (!needle || viewEntries) return rows
  return rows.filter((entry) => {
    const hay = `${entry.id || ''}\n${entry.title || ''}\n${entry.domain || ''}\n${entry.kind || ''}\n${entry.trigger || ''}\n${(entry.steps || []).join('\n')}\n${entry.why || ''}`.toLowerCase()
    return hay.includes(needle)
  })
}

function updateHeader () {
  if (projectEl) projectEl.textContent = projectName()
  if (countEl) {
    const counts = data.counts || { 方法: 0, 避错: 0, total: 0 }
    countEl.textContent = data.exists ? `${counts.total} 条 · 方法 ${counts.方法} / 避错 ${counts.避错}` : '未初始化'
  }
  if (pathEl) {
    pathEl.textContent = data.dir ? formatPath(data.dir) : ''
    pathEl.title = data.dir || ''
  }
}

function entryText (entry) {
  const lines = [`## ${entry.id} ${entry.title}`, `类别：${entry.kind}　领域：${entry.domain || '未分类'}`]
  if (fieldText(entry, 'trigger')) lines.push(`触发条件：${fieldText(entry, 'trigger')}`)
  if (entry.steps && entry.steps.length) lines.push('先做/步骤：\n' + entry.steps.map((step, i) => `${i + 1}. ${step}`).join('\n'))
  if (fieldText(entry, 'why')) lines.push(`为什么：${fieldText(entry, 'why')}`)
  if (fieldText(entry, 'symptoms')) lines.push(`违规症状：${fieldText(entry, 'symptoms')}`)
  if (fieldText(entry, 'verify')) lines.push(`验证方式：${fieldText(entry, 'verify')}`)
  if (fieldText(entry, 'boundaries')) lines.push(`已知边界：${fieldText(entry, 'boundaries')}`)
  return lines.join('\n')
}

async function copyEntry (entry) {
  try {
    await astral.clipboard.write(entryText(entry))
    astral.toast('条目已复制', 'ok')
  } catch (err) {
    astral.toast(`复制失败：${err.message || String(err)}`, 'err')
  }
}

function entryCard (entry) {
  const meta = KIND_META[entry.kind] || KIND_META.方法
  return h('article', { class: 'kb-entry' },
    h('div', { class: 'kb-entry-head' },
      h('span', { class: `kb-kind kb-kind-${meta.cls}`, text: entry.id || meta.label }),
      h('div', { class: 'kb-entry-title', text: entry.title || '未命名条目' }),
      h('span', { class: 'kb-domain', text: entry.domain || '未分类' })
    ),
    h('div', { class: 'kb-entry-meta', text: `${entry.kind || ''} · ${entry.book || ''}` }),
    h('div', { class: 'kb-entry-fields' },
      fieldText(entry, 'trigger') ? h('div', {}, h('b', { text: '触发条件：' }), entry.trigger) : null,
      entry.steps && entry.steps.length
        ? h('div', {}, h('b', { text: '先做 / 步骤：' }),
          h('ol', { class: 'kb-steps' }, ...entry.steps.map((step) => h('li', { text: step }))))
        : null,
      fieldText(entry, 'why') ? h('div', {}, h('b', { text: '为什么：' }), entry.why) : null,
      fieldText(entry, 'symptoms') ? h('div', {}, h('b', { text: '违规症状：' }), entry.symptoms) : null,
      fieldText(entry, 'verify') ? h('div', {}, h('b', { text: '验证方式：' }), entry.verify) : null,
      fieldText(entry, 'boundaries') ? h('div', {}, h('b', { text: '已知边界：' }), entry.boundaries) : null
    ),
    h('div', { class: 'kb-entry-actions' },
      h('button', { class: 'btn ghost kb-action', type: 'button', onclick: () => copyEntry(entry) }, '复制'),
      h('button', { class: 'btn ghost kb-action', type: 'button', onclick: () => openEntryEditor(entry) }, '编辑'),
      h('button', { class: 'btn ghost kb-action kb-danger', type: 'button', onclick: () => removeEntry(entry) }, '删除')
    )
  )
}

function paintList () {
  if (!listEl) return
  updateHeader()
  listEl.textContent = ''
  if (loading) {
    listEl.append(h('div', { class: 'kb-empty' }, h('div', { class: 'kb-empty-title', text: '正在读取知识库…' })))
    return
  }
  if (!data.exists) {
    listEl.append(h('div', { class: 'kb-empty' },
      h('div', { class: 'kb-empty-title', text: '这个项目还没有知识库' }),
      h('div', { class: 'hint', text: '知识库尚未初始化。点击「初始化知识库」会建立总纲与 方法/避错 两个主体索引，不会覆盖已有文件。' }),
      h('div', { class: 'toggle-row', style: { marginTop: '10px' } },
        h('button', { class: 'btn', type: 'button', onclick: initLibrary }, '初始化知识库')
      )
    ))
    return
  }
  const rows = visibleEntries()
  if (!rows.length) {
    listEl.append(h('div', { class: 'kb-empty' },
      h('div', { class: 'kb-empty-title', text: viewEntries ? '没有匹配的条目' : '知识库还是空的' }),
      h('div', { class: 'hint', text: viewEntries ? '换个关键词，或清除检索条件。' : '把可复用的方法、踩过的坑沉淀下来；之后智能体可以用 kb_guide / kb_search 查到。' })
    ))
    return
  }
  for (const entry of rows) listEl.append(entryCard(entry))
}

async function load () {
  if (loading) return
  loading = true
  viewEntries = null
  paintList()
  const res = await invoke('browse')
  loading = false
  if (!res || res.ok === false) {
    paintList()
    astral.toast((res && res.error) || '读取知识库失败', 'err')
    return
  }
  data = res
  paintList()
}

async function initLibrary () {
  const res = await invoke('init')
  if (!res || res.ok === false) {
    astral.toast((res && res.error) || '初始化失败', 'err')
    return
  }
  astral.toast('知识库已初始化', 'ok')
  await load()
}

async function removeEntry (entry) {
  const ok = await astral.ui.confirm({
    title: `删除 ${entry.id}？`,
    message: `「${entry.title}」将被永久删除，不可撤销。`,
    confirmText: '删除',
    danger: true
  })
  if (!ok) return
  const res = await invoke('remove', { id: entry.id })
  if (!res || res.ok === false) {
    astral.toast((res && res.error) || '删除失败', 'err')
    return
  }
  astral.toast(`${entry.id} 已删除`, 'ok')
  await load()
}

async function runSearch () {
  const text = query.trim()
  const res = await invoke('search', { text, limit: 50 })
  if (!res || res.ok === false) {
    astral.toast((res && res.error) || '检索失败', 'err')
    return
  }
  viewEntries = res.entries || []
  paintList()
}

async function runGuide () {
  const task = query.trim()
  if (!task) {
    astral.toast('先写一点正在做的事，再按工序查', 'err')
    return
  }
  const res = await invoke('guide', { task, limit: 20 })
  if (!res || res.ok === false) {
    astral.toast((res && res.error) || '工序检索失败', 'err')
    return
  }
  viewEntries = res.entries || []
  paintList()
}

function clearSearch () {
  query = ''
  viewEntries = null
  const input = hostEl && hostEl.querySelector('.kb-search')
  if (input) input.value = ''
  paintList()
}

function distillConversation () {
  const prompt = [
    '请把当前对话里值得复用的「方法」和踩过的「坑」沉淀到本项目知识库。',
    '先调用 kb_list / kb_guide 查重；每条用 kb_add 写入当前项目：',
    '方法：写清步骤、适用场景、依据；',
    '避错：触发条件、先做、为什么、违规症状四段必填。',
    '不要编造对话里没有发生的事；没有值得沉淀的内容就直接说明。'
  ].join('\n')
  try {
    astral.chat.submit(prompt)
    astral.toast('已把沉淀指令交给主对话', 'ok')
  } catch (err) {
    astral.toast(`提交失败：${err.message || String(err)}`, 'err')
  }
}

function textarea (className, rows, value) {
  const el = h('textarea', { class: `input ${className}`, rows: String(rows) })
  el.value = value || ''
  return el
}

function textField (value, placeholder) {
  return h('input', { class: 'input', value: String(value || ''), placeholder: placeholder || '' })
}

function openEntryEditor (entry = null) {
  const editing = Boolean(entry && entry.id)
  const title = textField(entry ? entry.title : '', '一句话标题')
  const kind = h('select', { class: 'select' },
    ...Object.keys(KIND_META).map((value) => h('option', {
      value,
      selected: (entry ? entry.kind : (data.config && data.config.defaultKind) || '避错') === value
    }, value))
  )
  const domain = textField(entry ? entry.domain : (data.config && data.config.defaultDomain) || '', '例如：构建与部署')
  const trigger = textField(entry ? entry.trigger : '', '下次什么时候会遇到')
  const steps = textarea('kb-editor-steps', 5, entry && Array.isArray(entry.steps) ? entry.steps.join('\n') : '')
  steps.placeholder = '每行一条可执行动作'
  const why = textarea('kb-editor-small', 3, entry ? entry.why : '')
  why.placeholder = '依据是什么'
  const symptoms = textarea('kb-editor-small', 3, entry ? entry.symptoms : '')
  symptoms.placeholder = '怎么判断没做（避错必填）'
  const verify = textField(entry ? entry.verify : '', '怎么确认做对了（可选）')
  const boundaries = textField(entry ? entry.boundaries : '', '什么情况下不适用（可选）')

  let modal = null
  const save = h('button', {
    class: 'btn primary',
    type: 'button',
    text: editing ? '保存修改' : '添加条目',
    onclick: async () => {
      const payload = {
        kind: kind.value,
        domain: domain.value.trim(),
        title: title.value.trim(),
        trigger: trigger.value.trim(),
        steps: steps.value.split(/\r?\n/).map((step) => step.trim()).filter(Boolean),
        why: why.value.trim(),
        symptoms: symptoms.value.trim(),
        verify: verify.value.trim(),
        boundaries: boundaries.value.trim()
      }
      if (!payload.title) { astral.toast('标题不能为空', 'err'); title.focus(); return }
      if (!payload.steps.length) { astral.toast('至少写一条步骤', 'err'); steps.focus(); return }
      if (payload.kind === '避错' && (!payload.trigger || !payload.why || !payload.symptoms)) {
        astral.toast('避错条目必须填写触发条件、为什么和违规症状', 'err')
        return
      }
      save.disabled = true
      const res = editing
        ? await invoke('update', { id: entry.id, ...payload })
        : await invoke('add', payload)
      save.disabled = false
      if (!res || res.ok === false) {
        astral.toast((res && res.error) || '保存失败', 'err')
        return
      }
      if (modal) modal.close()
      astral.toast(editing ? '条目已更新' : '条目已添加', 'ok')
      await load()
    }
  })

  modal = astral.ui.modal({
    title: editing ? `编辑 ${entry.id}` : '沉淀一条知识',
    sub: `项目知识库 · ${projectName()}`,
    width: 760,
    render: (body) => {
      body.append(
        h('div', { class: 'field-row' },
          h('div', { class: 'field' }, h('label', { class: 'label', text: '标题' }), title),
          h('div', { class: 'field', style: { maxWidth: '130px' } }, h('label', { class: 'label', text: '类别' }), kind)
        ),
        h('div', { class: 'field' }, h('label', { class: 'label', text: '领域' }), domain),
        h('div', { class: 'field' }, h('label', { class: 'label', text: '触发条件 / 适用场景' }), trigger),
        h('div', { class: 'field' }, h('label', { class: 'label', text: '先做 / 步骤（每行一条）' }), steps),
        h('div', { class: 'field' }, h('label', { class: 'label', text: '为什么' }), why),
        h('div', { class: 'field' }, h('label', { class: 'label', text: '违规症状' }), symptoms),
        h('div', { class: 'field-row' },
          h('div', { class: 'field' }, h('label', { class: 'label', text: '验证方式' }), verify),
          h('div', { class: 'field' }, h('label', { class: 'label', text: '已知边界' }), boundaries)
        ),
        h('div', { class: 'btn-row', style: { marginTop: '14px' } }, save,
          h('button', { class: 'btn ghost', type: 'button', onclick: () => modal && modal.close() }, '取消'))
      )
    }
  })
}

function numberField (label, key, value, hint = '') {
  return h('div', { class: 'field' },
    h('label', { class: 'label', text: label }),
    h('input', {
      class: 'input',
      type: 'number',
      value: String(value ?? ''),
      dataset: { key }
    }),
    hint ? h('div', { class: 'hint', text: hint }) : null
  )
}

function checkField (label, key, checked, hint = '') {
  const input = h('input', { type: 'checkbox', dataset: { key } })
  input.checked = Boolean(checked)
  return h('label', { class: 'kb-check' },
    input,
    h('span', { text: label }),
    hint ? h('small', { text: hint }) : null
  )
}

async function openSettings () {
  const current = await invoke('config')
  if (current && current.ok) {
    data = {
      ...data,
      ...current,
      config: current.config || data.config || {},
      dir: current.dir || data.dir,
      exists: typeof current.exists === 'boolean' ? current.exists : data.exists,
      counts: current.counts || data.counts
    }
  }
  const cfg = { ...(data.config || {}) }
  const baseDir = textField(cfg.baseDir || '', '留空 = 每个项目在项目根目录下建「知识库」')
  baseDir.dataset.key = 'baseDir'
  const pick = h('button', {
    class: 'btn ghost',
    type: 'button',
    onclick: async () => {
      try {
        const res = await astral.knowledge.pickDir()
        if (res && res.ok && res.dir) baseDir.value = res.dir
      } catch (err) {
        astral.toast(`选择目录失败：${err.message || String(err)}`, 'err')
      }
    }
  }, '选择目录')
  const defaultKind = h('select', { class: 'select', dataset: { key: 'defaultKind' } },
    ...Object.keys(KIND_META).map((kind) => h('option', {
      value: kind,
      selected: (cfg.defaultKind || '避错') === kind
    }, kind))
  )

  const settingsBody = h('div', { class: 'kb-settings-form' },
    h('div', { class: 'field' },
      h('label', { class: 'label', text: '知识库父目录（baseDir）' }),
      h('div', { class: 'kb-inline' }, baseDir, pick),
      h('div', { class: 'hint', text: '留空时每个项目在项目根目录下创建「知识库」；填写后集中到该目录下按项目名存放。修改不会自动搬运已有条目。' })
    ),
    h('div', { class: 'field-row-3' },
      numberField('每册容量', 'volumePerBook', cfg.volumePerBook ?? 10, '装满自动开新册，1–200'),
      numberField('总量上限', 'maxTotal', cfg.maxTotal ?? 0, '0 = 不限；达到上限会拒绝写入'),
      numberField('单条字节上限', 'maxEntryBytes', cfg.maxEntryBytes ?? 65536, '默认 64KB')
    ),
    h('div', { class: 'field-row-3' },
      numberField('自动清理阈值', 'autoPruneThreshold', cfg.autoPruneThreshold ?? 0, '0 = 不自动清理'),
      numberField('自动清理保留', 'autoPruneKeep', cfg.autoPruneKeep ?? 0, '0 = 按每册容量推算'),
      numberField('检索条数', 'searchLimit', cfg.searchLimit ?? 5, 'kb_search 默认返回条数')
    ),
    h('div', { class: 'pane-title', style: { marginTop: '12px' }, text: '提示词注入' }),
    checkField('注入知识库使用总纲', 'injectEnabled', cfg.injectEnabled !== false, '关掉可省 token，但智能体不会再主动知道知识库怎么用'),
    numberField('知识块字数上限', 'injectMaxChars', cfg.injectMaxChars ?? 6000, '仅作保险：正常只注入用法与几条标题，约 200 字'),
    checkField('注入「现在最该先看的几条」', 'guideInjectEnabled', cfg.guideInjectEnabled !== false, '只给编号、标题与权重，正文按需取'),
    numberField('注入条数上限', 'guideInjectLimit', cfg.guideInjectLimit ?? 3, '1–10，默认 3'),
    h('div', { class: 'pane-title', style: { marginTop: '12px' }, text: '沉淀默认值' }),
    h('div', { class: 'field-row' },
      h('div', { class: 'field' }, h('label', { class: 'label', text: '默认类别' }), defaultKind),
      h('div', { class: 'field' }, h('label', { class: 'label', text: '默认领域' }),
        (() => {
          const el = textField(cfg.defaultDomain || '', '留空 = 自动判断')
          el.dataset.key = 'defaultDomain'
          return el
        })())
    ),
    h('div', { class: 'hint', text: `实际库路径：${data.dir || '未确定'}` })
  )

  const collect = () => {
    const patch = {}
    for (const input of settingsBody.querySelectorAll('[data-key]')) {
      const key = input.dataset.key
      if (input.type === 'checkbox') patch[key] = input.checked
      else if (input.type === 'number') patch[key] = Number(input.value)
      else patch[key] = input.value
    }
    return patch
  }

  let modal = null
  const save = h('button', {
    class: 'btn primary',
    type: 'button',
    text: '保存并生效',
    onclick: async () => {
      save.disabled = true
      const res = await invoke('saveConfig', collect())
      save.disabled = false
      if (!res || res.ok === false) {
        astral.toast((res && res.error) || '保存配置失败', 'err')
        return
      }
      if (modal) modal.close()
      astral.toast('知识库配置已保存并生效', 'ok')
      await load()
    }
  })
  const reset = h('button', {
    class: 'btn ghost',
    type: 'button',
    text: '恢复默认',
    onclick: async () => {
      const ok = await astral.ui.confirm({
        title: '恢复知识库默认配置？',
        message: '已有条目不会受影响；已经写在磁盘上的目录结构不会自动搬运。',
        confirmText: '恢复默认'
      })
      if (!ok) return
      const res = await invoke('resetConfig')
      if (!res || res.ok === false) {
        astral.toast((res && res.error) || '恢复默认失败', 'err')
        return
      }
      if (modal) modal.close()
      astral.toast('已恢复默认配置', 'ok')
      await load()
    }
  })

  modal = astral.ui.modal({
    title: '知识库设置',
    sub: '配置保存后立即作用于检索、注入与工具',
    width: 760,
    render: (body) => {
      body.append(
        settingsBody,
        h('div', { class: 'btn-row kb-settings-actions' }, save, reset,
          h('button', { class: 'btn ghost', type: 'button', onclick: () => modal && modal.close() }, '取消'))
      )
    }
  })
}

function openPrune () {
  let modal = null
  const input = h('input', { class: 'input', type: 'number', value: '20', min: '0', step: '1' })
  const run = h('button', {
    class: 'btn danger',
    type: 'button',
    text: '清理',
    onclick: async () => {
      const keep = Number(input.value)
      if (!Number.isInteger(keep) || keep < 0) {
        astral.toast('请输入不小于 0 的整数', 'err')
        return
      }
      run.disabled = true
      const res = await invoke('prune', { keep })
      run.disabled = false
      if (!res || res.ok === false) {
        astral.toast((res && res.error) || '清理失败', 'err')
        return
      }
      if (modal) modal.close()
      astral.toast(`已清理 ${res.removed?.length || 0} 条`, 'ok')
      await load()
    }
  })
  modal = astral.ui.modal({
    title: '清理知识库',
    sub: `当前 ${data.counts?.total || 0} 条`,
    width: 520,
    render: (body) => {
      body.append(
        h('div', { class: 'field' },
          h('label', { class: 'label', text: '保留条数' }),
          input,
          h('div', { class: 'hint', text: '只删除最旧的条目，不可撤销。建议先确认要保留哪几条。' })
        ),
        h('div', { class: 'btn-row', style: { justifyContent: 'flex-end', marginTop: '18px' } },
          run,
          h('button', { class: 'btn ghost', type: 'button', onclick: () => modal && modal.close() }, '取消'))
      )
    }
  })
}

function render (host) {
  hostEl = host
  host.classList.add('dock-body', 'plugin-pane-mode')
  host.textContent = ''
  query = ''
  viewEntries = null
  countEl = h('span', { class: 'kb-count' })
  pathEl = h('span', { class: 'kb-path' })
  projectEl = h('span', { text: projectName() })
  listEl = h('div', { class: 'kb-list' })
  const search = h('input', {
    class: 'input kb-search',
    placeholder: '搜索标题、内容或领域…',
    oninput: (event) => {
      query = event.target.value || ''
      if (!viewEntries) paintList()
    },
    onkeydown: (event) => {
      if (event.key === 'Enter') runSearch()
    }
  })

  host.append(
    h('div', { class: 'kb-head' },
      h('div', {},
        h('div', { class: 'kb-title', text: '知识库' }),
        h('div', { class: 'kb-sub' }, projectEl, h('span', { class: 'kb-dot', text: '·' }), countEl),
        pathEl
      ),
      h('div', { class: 'kb-head-actions' },
        h('button', { class: 'btn ghost kb-add', type: 'button', onclick: distillConversation }, 'AI 沉淀'),
        h('button', { class: 'btn ghost kb-add', type: 'button', onclick: () => openEntryEditor() }, '＋ 沉淀')
      )
    ),
    h('div', { class: 'kb-toolbar' }, search),
    h('div', { class: 'kb-toolbar-actions' },
      h('button', { class: 'btn ghost', type: 'button', onclick: runSearch }, '搜索'),
      h('button', { class: 'btn ghost', type: 'button', onclick: runGuide }, '按工序查'),
      h('button', { class: 'btn ghost', type: 'button', onclick: clearSearch }, '清除')
    ),
    listEl,
    h('div', { class: 'kb-footer' },
      h('button', { class: 'btn ghost', type: 'button', onclick: openPrune }, '清理'),
      h('span', { class: 'kb-spacer' }),
      h('button', {
        class: 'btn ghost kb-settings-btn',
        type: 'button',
        title: '知识库插件设置',
        onclick: openSettings
      }, '⚙ 设置')
    )
  )
  load()
}

function latestUserTask (messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message && message.role === 'user') {
      const content = message.content
      return typeof content === 'string' ? content.slice(0, 1500) : ''
    }
  }
  return ''
}

function setup (api) {
  astral = api
  h = api.h
  astral.log('知识库插件已加载（隔离沙箱）')
  astral.ui.registerDockPane({
    id: 'knowledge',
    label: '知识库',
    order: 10,
    render
  })
  astral.on('before:request', async ({ messages }) => {
    if (!Array.isArray(messages) || !messages.length) return
    try {
      const res = await invoke('inject', { task: latestUserTask(messages) })
      if (!res || !res.text) return
      const system = messages.find((message) => message && message.role === 'system')
      if (system) system.content = `${system.content || ''}\n\n${res.text}`
      else messages.unshift({ role: 'system', content: res.text })
      return { messages }
    } catch {
      return
    }
  })
  astral.project.onChange(() => {
    updateHeader()
    load()
  })
}

export default setup
