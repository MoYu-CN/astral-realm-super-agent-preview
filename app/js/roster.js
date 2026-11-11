/* roster.js — 编制列表与成员编辑器 */

import { state, bus, $, h, agentById, persist, toast, uid, pickAvatar, activeProject, normalizeConversationMode, soloAgent, conversationIsTeam, saveProjectSessionNow, saveProjectsNow, superChatActive } from './core.js'
import { openModal, closeModal, field } from './modal.js'
import { ROLE_LABEL } from './llm.js'
import { applyDefaultPerms } from './permissions.js'
import { leaveSuperChat } from './superagent.js'

const ROLE_ORDER = ['commander', 'deputy', 'executor']
const RANK = { commander: 0, deputy: 1, executor: 2 }

export const TRAIT_PRESETS = [
  '冷静', '直接', '谨慎', '幽默', '严厉', '温和', '好奇', '简洁', '锋利', '耐心'
]

export function mountRoster () {
  render()
  bus.on('roster:changed', render)
  bus.on('project:changed', render)
  bus.on('conversation:mode', render)
  bus.on('active:agent', render)
  bus.on('agent:busy', ({ id, busy }) => {
    const row = $(`.agent-row[data-id="${id}"]`)
    if (row) row.classList.toggle('busy', Boolean(busy))
  })
}

function render () {
  const root = $('#roster')
  if (!root) return
  root.textContent = ''

  const agents = state.roster.agents
  const project = activeProject()
  const conversationMode = normalizeConversationMode(
    state.conversationMode,
    project && project.workMode === 'team' ? 'team' : 'solo'
  )
  root.classList.toggle('is-solo', conversationMode !== 'team')

  /* 单独/插件会话只显示当前智能体，不再把整个团队编制摆在左栏。 */
  if (conversationMode !== 'team') {
    const agent = soloAgent()
    if (project) {
      root.append(h('div', { class: 'roster-project-label' },
        h('span', { text: `${conversationMode === 'plugin' ? '插件制作' : '单独会话'} · ${project.name}` }),
        h('small', { text: agent ? (agent.short || agent.name) : '未绑定' })
      ))
    }
    root.append(h('div', { class: 'group-label', text: '当前智能体 · 1' }))
    /* 单独会话没有职位，左栏只留名字与模型 */
    if (agent) root.append(rowNode(agent, { showRole: false }))
    else root.append(h('div', { class: 'dock-empty', text: '这个会话还没有绑定智能体。' }))
    return
  }

  const hasCommand = agents.some((a) => a.role === 'commander' || a.role === 'deputy')
  if (project) {
    root.append(h('div', { class: 'roster-project-label' },
      h('span', { text: `项目成员 · ${project.name}` }),
      h('small', { text: `${agents.length} 人` })
    ))
  }

  for (const role of ROLE_ORDER) {
    const list = agents.filter((a) => a.role === role)
    if (!list.length) continue
    const label = role === 'executor' && !hasCommand ? 'AI 成员' : ROLE_LABEL[role]
    root.append(h('div', { class: 'group-label', text: `${label} · ${list.length}` }))
    for (const agent of list) root.append(rowNode(agent))
  }

  if (!agents.length) {
    root.append(h('div', { class: 'dock-empty', text: '当前项目编制为空。打开设置 → 编制，新增成员；也可以只加 AI 成员，不设总指挥/副指挥。' }))
  }
}

function rowNode (agent, opts = {}) {
  const showRole = opts.showRole !== false
  const active = state.activeAgentId === agent.id
  return h('div', {
    class: 'agent-row' + (active ? ' active' : ''),
    style: { '--agent-color': agent.color || 'var(--accent)' },
    dataset: { id: agent.id },
    onclick: () => select(agent.id)
  },
  h('div', { class: 'agent-ava' + (agent.avatar ? ' has-img' : ''), text: agent.avatar ? '' : (agent.glyph || '◇') },
    agent.avatar ? h('img', { src: agent.avatar, alt: '' }) : null
  ),
  h('div', { class: 'agent-meta' },
    h('div', { class: 'agent-name' },
      h('span', { text: agent.short || agent.name }),
      showRole ? h('small', { text: (agent.title || ROLE_LABEL[agent.role] || '').replace(/^执行者\s*·?\s*/, '') }) : null
    ),
    h('div', { class: 'agent-model', text: agent.model || '未绑定模型' })
  ),
  /* 团队会话编的是成员，单独会话编的是这条会话本身（名称 + 单独对话提示词）；
     两种模式都必须有入口，只是打开的面板不同。 */
  h('button', {
    class: 'agent-edit',
    title: conversationIsTeam() ? '编辑成员' : '编辑会话资料',
    onclick: (e) => {
      e.stopPropagation()
      if (conversationIsTeam()) editAgent(agent.id)
      else openConversationProfile()
    }
  }, '✎')
  )
}

export function select (id) {
  /* 点成员就是「跟这位说话」，先离开直连会话 */
  if (superChatActive()) leaveSuperChat()
  /* 单独会话只有这一位：点它不该取消选中，保持高亮与编辑目标稳定 */
  state.activeAgentId = conversationIsTeam()
    ? (state.activeAgentId === id ? null : id)
    : id
  bus.emit('active:agent', state.activeAgentId)
  bus.emit('roster:changed')
  const input = $('#input')
  if (input) input.focus()
}

/* ------------------------------------------------------------- 编辑器 */

function blankAgent () {
  const provider = (state.providers.providers || [])[0] || {}
  const boss = state.roster.agents.find((a) => a.role === 'commander')
  return {
    id: uid('agent'),
    name: '新成员',
    title: '执行者',
    role: 'executor',
    reportsTo: boss ? boss.id : null,
    glyph: '○',
    short: '',
    avatar: '',
    bio: '',
    traits: [],
    traitNote: '',
    color: '#8b9cff',
    providerId: provider.id || '',
    model: (provider.models && provider.models[0]) || '',
    temperature: 0.7,
    enabled: true,
    prompt: '你是一个可靠的执行者。接到任务后直接产出结果。',
    /* 单独会话的提示词：与上面的团队角色提示词完全独立，留空由 llm.js 的默认值兜底 */
    soloPrompt: '',
    skills: [],
    context: { notes: '', historyLimit: 16 }
  }
  /* 默认权限在创建时就落到成员身上，之后可在设置页随时改 */
  return applyDefaultPerms(agent)
}

export function addAgent (role = 'executor') {
  const agent = blankAgent()
  agent.role = role
  agent.title = ROLE_LABEL[role]
  editAgent(null, agent)
}

/* 会话资料：单独 / 插件会话里，顶栏「编辑」改的是这条会话本身——
   会话名称 + 这位助手的单独对话提示词。团队会话没有这两项，
   它的编辑入口改的是编制里的成员（openMemberProfile）。 */
export function openConversationProfile () {
  const agent = soloAgent()
  if (!agent) { toast('这条会话还没有绑定助手', 'warn'); return }
  const plugin = state.conversationMode === 'plugin'

  const titleInput = h('input', {
    class: 'input',
    value: String(state.conversationTitle || ''),
    placeholder: '留空时按第一句话自动命名'
  })

  const promptArea = h('textarea', {
    class: 'textarea',
    placeholder: '留空就用内置默认提示词：直接回答、先结论后依据、不编造。'
  })
  promptArea.value = agent.soloPrompt || ''

  openModal({
    title: '会话资料',
    sub: plugin ? 'CONVERSATION · 插件制作' : 'CONVERSATION · 单独会话',
    width: 660,
    render: (body) => {
      body.append(
        field('会话名称', titleInput, '显示在顶栏；留空时按第一句话自动命名。'),
        field('当前助手', h('div', { class: 'conv-current' },
          h('span', { class: 'conv-current-name', text: agent.name }),
          h('span', { class: 'conv-current-model', text: agent.model || '未绑定模型' }),
          h('button', {
            class: 'btn ghost',
            style: { marginLeft: 'auto', height: '28px', padding: '0 12px', fontSize: '12px' },
            onclick: () => openMemberProfile(agent.id)
          }, '编辑助手资料…')
        ), '一对一对话只属于你和这一位；改名字、头像、简介走右边的「编辑助手资料」。'),
        field('单独对话提示词', promptArea,
          '只在这条一对一对话里生效。团队会话读的是另一份「角色提示词」，两边严格分开、互不影响。'),
        h('div', { class: 'btn-row', style: { marginTop: '18px' } },
          h('button', { class: 'btn', onclick: () => {
            agent.soloPrompt = promptArea.value
            const title = titleInput.value.trim()
            state.conversationTitle = title
            bus.emit('conversation:title', title)
            persist.roster()
            persist.session()
            saveProjectSessionNow()
            saveProjectsNow()
            bus.emit('roster:changed')
            toast('会话资料已保存', 'ok')
            closeModal()
          } }, '保存'),
          h('button', { class: 'btn ghost', onclick: () => closeModal() }, '取消')
        )
      )
    }
  })
}

/* 成员名片：成员窗口里的「资料」入口，聚焦头像 / 简介 / 性格。
   团队会话从这里改成员；单独会话从这里改这位助手，职位与汇报关系不显示。 */
export function openMemberProfile (id) {
  const source = agentById(id)
  if (!source) return

  const draft = JSON.parse(JSON.stringify(source))
  const teamMode = conversationIsTeam()

  openModal({
    title: draft.short || draft.name,
    sub: teamMode ? 'MEMBER PROFILE · 成员资料' : 'PROFILE · 助手资料',
    width: 620,
    render: (body) => {
      const preview = h('span', { class: 'ava', style: { width: '72px', height: '72px', fontSize: '26px' } })
      const paint = () => {
        preview.textContent = ''
        preview.style.setProperty('--agent-color', draft.color || 'var(--accent)')
        if (draft.avatar) preview.append(h('img', { src: draft.avatar, alt: '' }))
        else preview.textContent = draft.glyph || (draft.name || '◇').slice(0, 1)
      }
      paint()

      const nameInput = h('input', {
        class: 'input',
        value: draft.name || '',
        oninput: (e) => { draft.name = e.target.value; paint() }
      })

      const shortInput = h('input', {
        class: 'input',
        maxlength: '6',
        value: draft.short || '',
        placeholder: '消息里显示',
        oninput: (e) => { draft.short = e.target.value }
      })

      const bioArea = h('textarea', {
        class: 'textarea',
        placeholder: '一句话介绍它：擅长什么、负责哪块、说话什么风格。',
        oninput: (e) => { draft.bio = e.target.value }
      })
      bioArea.value = draft.bio || ''

      const traitWrap = h('div', { class: 'trait-chips' })
      const paintTraits = () => {
        traitWrap.textContent = ''
        for (const trait of TRAIT_PRESETS) {
          const on = (draft.traits || []).includes(trait)
          traitWrap.append(h('button', {
            class: 'trait-chip' + (on ? ' on' : ''),
            onclick: () => {
              const set = new Set(draft.traits || [])
              if (set.has(trait)) set.delete(trait)
              else set.add(trait)
              draft.traits = [...set]
              paintTraits()
            }
          }, trait))
        }
      }
      paintTraits()

      const traitNote = h('input', {
        class: 'input',
        value: draft.traitNote || '',
        placeholder: '也可以自己补一句，例如：说话像老兵，不爱绕弯子',
        oninput: (e) => { draft.traitNote = e.target.value }
      })

      body.append(
        h('div', { class: 'avatar-row' },
          preview,
          h('div', { class: 'avatar-actions' },
            h('div', { class: 'label-main', text: '头像' }),
            h('div', { class: 'hint', style: { marginTop: '2px' }, text: '会出现在左栏、消息头和这个成员的对话里' }),
            h('div', { class: 'btn-row', style: { marginTop: '7px' } },
              h('button', { class: 'btn ghost', onclick: async () => {
                try {
                  const url = await pickAvatar(96)
                  if (url) { draft.avatar = url; paint() }
                } catch (err) { toast(err.message, 'err') }
              } }, '上传头像'),
              draft.avatar
                ? h('button', { class: 'btn ghost', onclick: () => { delete draft.avatar; paint() } }, '清除')
                : null
            )
          )
        ),
        h('div', { class: 'field-row' },
          field('名称', nameInput),
          field('简称', shortInput, '列表与消息里显示')
        ),
        teamMode
          ? null
          : h('div', { class: 'hint', style: { margin: '-2px 0 10px' }, text: '单独会话不显示职位：这里改的是它的名字、简介与说话风格，保存后左栏和已发出的消息都会立刻更新。' }),
        field('简介', bioArea, teamMode
          ? '显示在这个成员的对话空态里，也会写进它的提示词。'
          : '显示在这条对话的空态里，也会写进它的提示词。'),
        field('性格特征', h('div', {}, traitWrap, h('div', { style: { marginTop: '8px' } }, traitNote)),
          '会写进提示词，影响说话方式与判断倾向。'),
        h('div', { class: 'btn-row', style: { marginTop: '18px', flexWrap: 'wrap' } },
          h('button', { class: 'btn', onclick: () => {
            if (!draft.name.trim()) { toast('名称不能为空', 'err'); return }
            const idx = state.roster.agents.findIndex((a) => a.id === draft.id)
            if (idx >= 0) state.roster.agents[idx] = draft
            persist.roster()
            bus.emit('roster:changed')
            closeModal()
            toast('资料已保存', 'ok')
          } }, '保存'),
          h('button', { class: 'btn ghost', onclick: () => {
            closeModal()
            setTimeout(() => editAgent(draft.id), 60)
          } }, '完整设置'),
          h('button', { class: 'btn ghost', onclick: () => closeModal() }, '取消')
        )
      )
    }
  })
}

export function editAgent (id, preset = null) {
  const isNew = !id
  const draft = isNew ? JSON.parse(JSON.stringify(preset || blankAgent())) : JSON.parse(JSON.stringify(agentById(id)))
  /* 职位是团队概念：单独会话里不展示、也不写入默认头衔，
     避免出现「这条会话只有一个人，却是副指挥」的矛盾。 */
  const teamMode = conversationIsTeam()

  openModal({
    title: isNew ? '新增成员' : `编辑 · ${draft.name}`,
    sub: 'AGENT PROFILE',
    width: 720,
    render: (body) => {
      const providers = state.providers.providers || []
      const provider = providers.find((p) => p.id === draft.providerId)

      const nameInput = h('input', { class: 'input', value: draft.name, oninput: (e) => { draft.name = e.target.value } })
      const shortInput = h('input', { class: 'input', maxlength: '6', value: draft.short || '', placeholder: '消息里显示的简称', oninput: (e) => { draft.short = e.target.value } })
      const titleInput = h('input', { class: 'input', value: draft.title || '', oninput: (e) => { draft.title = e.target.value } })
      const glyphInput = h('input', { class: 'input', value: draft.glyph || '◇', maxlength: '4', oninput: (e) => { draft.glyph = e.target.value; paintAvatar() } })
      const colorInput = h('input', { class: 'input', type: 'color', value: draft.color || '#8b9cff', oninput: (e) => { draft.color = e.target.value; paintAvatar() } })

      const avatarPreview = h('span', { class: 'ava', style: { width: '54px', height: '54px', fontSize: '21px' } })
      const paintAvatar = () => {
        avatarPreview.textContent = ''
        avatarPreview.style.setProperty('--agent-color', draft.color || 'var(--accent)')
        if (draft.avatar) avatarPreview.append(h('img', { src: draft.avatar, alt: '' }))
        else avatarPreview.textContent = draft.glyph || '◇'
      }
      paintAvatar()

      const avatarRow = h('div', { class: 'avatar-row' },
        avatarPreview,
        h('div', { class: 'avatar-actions' },
          h('div', { class: 'label-main', text: '头像' }),
          h('div', { class: 'hint', style: { marginTop: '2px' }, text: '上传后会等比裁成方形存进配置；不传就用右边的字形' }),
          h('div', { class: 'btn-row', style: { marginTop: '7px' } },
            h('button', { class: 'btn ghost', onclick: async () => {
              try {
                const url = await pickAvatar(96)
                if (url) { draft.avatar = url; paintAvatar() }
              } catch (err) { toast(err.message, 'err') }
            } }, '上传头像'),
            draft.avatar ? h('button', { class: 'btn ghost', onclick: () => { delete draft.avatar; paintAvatar() } }, '清除') : null
          )
        ),
        h('div', { class: 'avatar-glyph' }, field('字形', glyphInput, '无头像时作为头像'))
      )

      const traitWrap = h('div', { class: 'trait-chips' })
      const paintTraits = () => {
        traitWrap.textContent = ''
        for (const trait of TRAIT_PRESETS) {
          const on = (draft.traits || []).includes(trait)
          traitWrap.append(h('button', {
            class: 'trait-chip' + (on ? ' on' : ''),
            onclick: () => {
              const set = new Set(draft.traits || [])
              if (set.has(trait)) set.delete(trait)
              else set.add(trait)
              draft.traits = [...set]
              paintTraits()
            }
          }, trait))
        }
      }
      paintTraits()

      const traitNote = h('input', { class: 'input', value: draft.traitNote || '', placeholder: '也可以自己补一句，例如：说话像老兵，不爱绕弯子', oninput: (e) => { draft.traitNote = e.target.value } })

      const roleSelect = h('select', { class: 'select', onchange: (e) => { draft.role = e.target.value; refreshBoss() } },
        ...ROLE_ORDER.map((r) => h('option', { value: r, selected: draft.role === r }, ROLE_LABEL[r]))
      )

      const bossWrap = h('div', {})
      const refreshBoss = () => {
        bossWrap.textContent = ''
        const candidates = state.roster.agents.filter((a) => a.id !== draft.id && RANK[a.role] < RANK[draft.role])
        const select = h('select', { class: 'select', onchange: (e) => { draft.reportsTo = e.target.value || null } },
          h('option', { value: '' }, '无（顶层）'),
          ...candidates.map((a) => h('option', { value: a.id, selected: draft.reportsTo === a.id }, `${a.name} · ${a.title || ROLE_LABEL[a.role]}`))
        )
        if (draft.role === 'commander') {
          bossWrap.append(field('汇报对象', h('div', { class: 'hint', text: '总指挥直接向用户负责，没有上级。' })))
        } else {
          bossWrap.append(field('汇报对象', select, '决定接受谁的派单。'))
        }
      }
      refreshBoss()

      const providerSelect = h('select', { class: 'select', onchange: (e) => {
        draft.providerId = e.target.value
        const p = providers.find((x) => x.id === draft.providerId)
        draft.model = (p && p.models && p.models[0]) || ''
        if (modelInput) modelInput.value = draft.model
        if (datalist) {
          datalist.textContent = ''
          for (const m of (p && p.models) || []) datalist.append(h('option', { value: m }))
        }
      } },
      ...providers.map((p) => h('option', { value: p.id, selected: draft.providerId === p.id }, `${p.name}${p.apiKey || p.kind === 'ollama' ? '' : '（未配置 Key）'}`))
      )

      const datalist = h('datalist', { id: `models-${draft.id}` })
      for (const m of (provider && provider.models) || []) datalist.append(h('option', { value: m }))

      const modelInput = h('input', {
        class: 'input',
        value: draft.model || '',
        list: `models-${draft.id}`,
        oninput: (e) => { draft.model = e.target.value }
      })

      const tempInput = h('input', {
        class: 'input',
        type: 'number',
        min: '0',
        max: '2',
        step: '0.1',
        value: String(draft.temperature ?? 0.7),
        oninput: (e) => { draft.temperature = Number(e.target.value) }
      })

      /* 两套提示词：团队读「角色提示词」，单独会话读「单独对话提示词」。
         两个独立字段，运行时按会话模式二选一，永不互相回退。 */
      const teamPromptArea = h('textarea', {
        class: 'textarea',
        placeholder: '描述这个成员在编制里是谁、负责什么、怎么和上下级配合…',
        oninput: (e) => { draft.prompt = e.target.value }
      })
      teamPromptArea.value = draft.prompt || ''

      const soloPromptArea = h('textarea', {
        class: 'textarea',
        placeholder: '留空就用内置默认提示词：直接回答、先结论后依据、不编造。',
        oninput: (e) => { draft.soloPrompt = e.target.value }
      })
      soloPromptArea.value = draft.soloPrompt || ''

      const copyTeamPrompt = h('button', {
        class: 'btn ghost',
        style: { marginTop: '6px', height: '26px', padding: '0 10px', fontSize: '12px' },
        onclick: () => {
          const src = String(draft.prompt || '').trim()
          if (!src) { toast('团队里的角色提示词还是空的', 'warn'); return }
          draft.soloPrompt = src
          soloPromptArea.value = src
          toast('已复制一份，之后两份各自独立', 'ok')
        }
      }, '沿用团队提示词')

      const dutyArea = h('textarea', {
        class: 'textarea',
        placeholder: '例如：负责技术方案与架构评审；或：负责资料检索与事实核对。',
        oninput: (e) => { draft.duty = e.target.value }
      })
      dutyArea.value = draft.duty || ''

      const notesArea = h('textarea', { class: 'textarea', oninput: (e) => {
        draft.context = draft.context || { notes: '', historyLimit: 16 }
        draft.context.notes = e.target.value
      } })
      notesArea.value = (draft.context && draft.context.notes) || ''

      const skillList = h('div', {})
      for (const skill of state.skills) {
        const checked = (draft.skills || []).includes(skill.id)
        skillList.append(h('label', { class: 'checkline' },
          h('input', { type: 'checkbox', checked, onchange: (e) => {
            const set = new Set(draft.skills || [])
            if (e.target.checked) set.add(skill.id)
            else set.delete(skill.id)
            draft.skills = [...set]
          } }),
          h('span', {}, h('b', { text: skill.name }), h('small', { text: skill.desc || skill.id }))
        ))
      }

      body.append(
        avatarRow,
        teamMode
          ? h('div', { class: 'field-row-3' },
            field('名称', nameInput),
            field('简称', shortInput, '列表与消息里显示'),
            field('头衔', titleInput)
          )
          : h('div', { class: 'field-row' },
            field('名称', nameInput),
            field('简称', shortInput, '列表与消息里显示')
          ),
        h('div', { class: 'field-row-3' },
          teamMode ? field('职级', roleSelect) : null,
          field('颜色', colorInput),
          field('温度', tempInput, '0 克制 · 1 发散')
        ),
        teamMode
          ? bossWrap
          : h('div', { class: 'hint', style: { margin: '-2px 0 10px' }, text: '当前是单独会话：不显示职位、职级与汇报关系。下面两份提示词是分开的——「单独对话提示词」只在这里生效，「角色提示词」只在团队会话里生效，互不影响。' }),
        h('div', { class: 'field-row' },
          field('模型供应商', providerSelect),
          field('模型', modelInput, '可直接输入供应商支持的任意模型名')
        ),
        datalist,
        field('性格特征', h('div', {}, traitWrap, h('div', { style: { marginTop: '8px' } }, traitNote)),
          '会写进提示词，影响说话方式与判断倾向。'),
        field('职责范围', dutyArea, teamMode
          ? '写进团队编制，所有成员都会知道这个成员负责什么。留空时按头衔与技能推导。'
          : '写进它的提示词，说明它擅长与负责的范围；单独会话里这只是背景，不是职位。'),
        teamMode
          ? field('角色提示词（团队）', teamPromptArea,
            '只在团队会话里生效。写清这个成员在编制里的职责、协作方式与边界；支持 {{name}} / {{title}} / {{duty}} / {{project}} 等变量。')
          : field('单独对话提示词', h('div', {}, soloPromptArea, copyTeamPrompt),
            '只在这条一对一对话里生效；留空用内置默认提示词。团队那份「角色提示词」不会带进来。'),
        teamMode
          ? field('单独对话提示词', h('div', {}, soloPromptArea, copyTeamPrompt),
            '只在一对一对话里生效，与上面的角色提示词互不影响；留空用内置默认提示词。')
          : field('角色提示词（团队）', teamPromptArea,
            '只在团队会话里生效，单独会话读的是上面那份；支持 {{name}} / {{title}} / {{duty}} / {{project}} 等变量。'),
        field('专属上下文', notesArea, '只喂给这个成员的背景资料，不与其他成员共享。'),
        field('专属技能', skillList, '技能文件位于 app/skills/ 或 config/skills/，改文件即生效。'),
        h('div', { class: 'btn-row', style: { marginTop: '18px' } },
          h('button', { class: 'btn', onclick: () => {
            if (!draft.name.trim()) { toast('名称不能为空', 'err'); return }
            if (teamMode) {
              draft.title = draft.title || ROLE_LABEL[draft.role]
              if (draft.role === 'commander') draft.reportsTo = null
            }
            if (isNew) state.roster.agents.push(draft)
            else {
              const idx = state.roster.agents.findIndex((a) => a.id === draft.id)
              if (idx >= 0) state.roster.agents[idx] = draft
            }
            persist.roster()
            bus.emit('roster:changed')
            toast(isNew ? (teamMode ? '成员已加入编制' : '已保存') : (teamMode ? '成员已更新' : '资料已保存'), 'ok')
            closeModal()
          } }, isNew && teamMode ? '加入编制' : '保存'),
          h('button', { class: 'btn ghost', onclick: () => closeModal() }, '取消'),
          isNew ? null : h('button', { class: 'btn danger', style: { marginLeft: 'auto' }, onclick: () => {
            state.roster.agents = state.roster.agents.filter((a) => a.id !== draft.id)
            for (const a of state.roster.agents) if (a.reportsTo === draft.id) a.reportsTo = null
            persist.roster()
            bus.emit('roster:changed')
            closeModal()
            toast('成员已移除')
          } }, '移除')
        )
      )
    }
  })
}
