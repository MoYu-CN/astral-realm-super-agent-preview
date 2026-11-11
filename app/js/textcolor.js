/* textcolor.js — 从 C:\DSHwork\message-text-color 移植的消息文字染色引擎
 *
 * 保留原插件的完整配置能力：
 *   - 默认颜色 / 单色 / 炫彩渐变
 *   - 24 个单色、自定义十六进制颜色
 *   - 9 套炫彩预设、色相偏移、速度、往复/单向/静止、色带宽度
 *   - 5 组作用范围（助手回复 / 规划状态 / 工具与任务 / 我的消息 / 输入区）
 *
 * 只替换宿主选择器与配置存储；不再依赖 DSH/React 运行时。
 */

import { state, persist } from './core.js'

const STYLE_ID = 'astral-message-text-color-style'
const ROOT_CLASS = 'astral-text-color-on'

export const SOLID_CHOICES = [
  '#dc2626', '#e11d48', '#db2777', '#c026d3', '#9333ea', '#7c3aed',
  '#4f46e5', '#2563eb', '#0284c7', '#0891b2', '#0d9488', '#059669',
  '#16a34a', '#65a30d', '#ca8a04', '#d97706', '#ea580c', '#b45309',
  '#a16207', '#78716c', '#475569', '#334155', '#be123c', '#a21caf'
]

export const RAINBOW_PRESETS = [
  { id: 'spectrum', stops: ['#ef4444', '#f59e0b', '#eab308', '#22c55e', '#3b82f6', '#a855f7'] },
  { id: 'aurora', stops: ['#22d3ee', '#34d399', '#60a5fa', '#a78bfa', '#2dd4bf'] },
  { id: 'sunset', stops: ['#f97316', '#f43f5e', '#a855f7', '#f59e0b', '#ef4444'] },
  { id: 'neon', stops: ['#22d3ee', '#a3e635', '#f472b6', '#7c3aed', '#22d3ee'] },
  { id: 'pastel', stops: ['#f9a8d4', '#fcd34d', '#86efac', '#93c5fd', '#c4b5fd'] },
  { id: 'deepsea', stops: ['#0ea5e9', '#14b8a6', '#6366f1', '#0891b2', '#38bdf8'] },
  { id: 'sakura', stops: ['#fb7185', '#fda4af', '#f0abfc', '#fecdd3', '#fb7185'] },
  { id: 'mars', stops: ['#e9d196', '#b8721f', '#f16b2f', '#b2399d', '#f8e4e0'] },
  { id: 'saturn', stops: ['#e9d196', '#b8721f', '#f19992', '#b27b90', '#f8e4e0'] }
]

export const PRESET_NAMES = {
  spectrum: '光谱', aurora: '极光', sunset: '落日', neon: '霓虹',
  pastel: '柔彩', deepsea: '星空蓝', sakura: '樱花',
  mars: '火星橙', saturn: '土星灰'
}

/* Astral 中对应的五块作用范围。assistant 会排除 reasoning，
   这样“助手回复”和“规划/状态提示”可以独立开关。 */
export const SCOPES = [
  {
    key: 'assistant',
    label: '助手回复',
    hint: '正文段落、标题、列表、表格；代码块始终排除',
    roots: ['.msg.agent .md', '.msg.handoff .handoff-md', '.msg.handoff .handoff-preview'],
    self: false,
    /* 折叠后的摘要预览是一行纯文本，没有可着色的子节点，必须给根节点本身染色 */
    selfRoots: ['.msg.handoff .handoff-preview'],
    excludeReasoning: true
  },
  {
    key: 'reasoning',
    label: '规划与状态',
    hint: '「正在编排任务…」、中断与状态提示（Astral 没有独立思维链）',
    roots: ['.msg.agent .md-pending', '.msg.agent .msg-note'],
    self: true
  },
  {
    key: 'tools',
    label: '工具与任务',
    hint: '派单标题、任务指令、任务状态与进度文字',
    roots: ['.msg.plan'],
    self: false
  },
  {
    key: 'user',
    label: '我的消息',
    hint: '气泡里的文字；气泡底色保留',
    roots: ['.msg.user .user-text'],
    self: true
  },
  {
    key: 'composer',
    label: '输入区',
    hint: '输入框和下方提示文字；默认关闭',
    roots: ['#input', '.composer-hints'],
    self: true
  }
]

export const DEFAULT_TEXT_COLOR = {
  mode: 'rainbow',
  lastMode: 'rainbow',
  color: '#e11d48',
  rainbow: {
    preset: 'spectrum',
    customStops: ['#ef4444', '#f59e0b', '#eab308', '#22c55e', '#3b82f6', '#a855f7'],
    hue: 0,
    speed: 7,
    motion: 'alternate',
    width: 300
  },
  applyTo: { assistant: true, reasoning: true, tools: true, user: true, composer: false }
}

/* 深空（主题 id: astral）第一次打开时使用的默认炫彩。
   星空蓝是内置预设；customStops 保留同值作为旧配置迁移兜底。
   用户保存过 textColor 后仍以保存值为准。 */
export const DEFAULT_TEXT_COLOR_ASTRAL = {
  mode: 'rainbow',
  lastMode: 'rainbow',
  color: '#e11d48',
  rainbow: {
    preset: 'deepsea',
    customStops: ['#0ea5e9', '#14b8a6', '#6366f1', '#0891b2', '#38bdf8'],
    hue: 0,
    speed: 7,
    motion: 'alternate',
    width: 300
  },
  applyTo: { assistant: true, reasoning: true, tools: true, user: true, composer: false }
}

export const DEFAULT_TEXT_COLOR_EMBER = {
  mode: 'rainbow',
  lastMode: 'rainbow',
  color: '#e11d48',
  rainbow: {
    preset: 'mars',
    customStops: ['#e9d196', '#b8721f', '#f16b2f', '#b2399d', '#f8e4e0'],
    hue: 0,
    speed: 7,
    motion: 'alternate',
    width: 300
  },
  applyTo: { assistant: true, reasoning: true, tools: true, user: true, composer: false }
}

export const DEFAULT_TEXT_COLOR_SATURN = {
  mode: 'rainbow',
  lastMode: 'rainbow',
  color: '#e11d48',
  rainbow: {
    preset: 'saturn',
    customStops: ['#e9d196', '#b8721f', '#f19992', '#b27b90', '#f8e4e0'],
    hue: 0,
    speed: 7,
    motion: 'alternate',
    width: 300
  },
  applyTo: { assistant: true, reasoning: true, tools: true, user: true, composer: false }
}

const THEME_TEXT_COLOR_DEFAULTS = {
  astral: DEFAULT_TEXT_COLOR_ASTRAL,
  ember: DEFAULT_TEXT_COLOR_EMBER,
  saturn: DEFAULT_TEXT_COLOR_SATURN,
  /* 浅色主题：预设本身就要在浅底上站得住 */
  daybreak: DEFAULT_TEXT_COLOR_ASTRAL,   /* 星空蓝，冷调浅色正好配 */
  apricot: {
    ...DEFAULT_TEXT_COLOR_EMBER,
    rainbow: { ...DEFAULT_TEXT_COLOR_EMBER.rainbow, preset: 'sunset', customStops: ['#f97316', '#f43f5e', '#a855f7', '#f59e0b', '#ef4444'] }
  },
  skyline: {
    ...DEFAULT_TEXT_COLOR_ASTRAL,
    rainbow: { ...DEFAULT_TEXT_COLOR_ASTRAL.rainbow, preset: 'aurora', customStops: ['#22d3ee', '#34d399', '#60a5fa', '#a78bfa', '#2dd4bf'] }
  }
}

function themeTextColorDefault () {
  const themeId = state.settings.theme || 'astral'
  let preset = THEME_TEXT_COLOR_DEFAULTS[themeId]
  if (!preset && Array.isArray(state.themes)) {
    const theme = state.themes.find((item) => item.id === themeId)
    const name = theme && theme.name ? String(theme.name) : ''
    if (/土星/.test(name)) preset = DEFAULT_TEXT_COLOR_SATURN
    else if (/火星/.test(name)) preset = DEFAULT_TEXT_COLOR_EMBER
    else if (/深空|星空/.test(name)) preset = DEFAULT_TEXT_COLOR_ASTRAL
  }
  return clone(preset || DEFAULT_TEXT_COLOR)
}

/* ------------------------------------------------------------ color math */

function clamp (value, lo, hi) { return Math.min(hi, Math.max(lo, value)) }

export function parseHex (hex) {
  const raw = String(hex === undefined || hex === null ? '' : hex).trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{3}$/.test(raw) && !/^[0-9a-fA-F]{6}$/.test(raw)) return null
  const full = raw.length === 3 ? raw[0] + raw[0] + raw[1] + raw[1] + raw[2] + raw[2] : raw
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
}

export function toHex (rgb) {
  return '#' + rgb.map((channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, '0')).join('')
}

function toHsl (rgb) {
  const r = rgb[0] / 255
  const g = rgb[1] / 255
  const b = rgb[2] / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let hue = 0
  if (delta !== 0) {
    if (max === r) hue = ((g - b) / delta) % 6
    else if (max === g) hue = (b - r) / delta + 2
    else hue = (r - g) / delta + 4
    hue *= 60
    if (hue < 0) hue += 360
  }
  const lightness = (max + min) / 2
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1))
  return [hue, saturation * 100, lightness * 100]
}

function fromHsl (hue, saturation, lightness) {
  const s = clamp(saturation, 0, 100) / 100
  const l = clamp(lightness, 0, 100) / 100
  const channel = (offset) => {
    const k = (offset + hue / 30) % 12
    const a = s * Math.min(l, 1 - l)
    return (l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))) * 255
  }
  return [channel(0), channel(8), channel(4)]
}

export function solidColor (hex, scheme) {
  const rgb = parseHex(hex)
  if (rgb === null) return hex
  const hsl = toHsl(rgb)
  if (scheme === 'dark') return toHex(fromHsl(hsl[0], clamp(hsl[1], 35, 90), clamp(Math.max(hsl[2], 62), 0, 88)))
  return toHex(fromHsl(hsl[0], clamp(hsl[1], 35, 92), clamp(Math.min(hsl[2], 52), 18, 100)))
}

function stopColor (hex, scheme, hueShift) {
  const rgb = parseHex(hex)
  if (rgb === null) return hex
  const hsl = toHsl(rgb)
  const hue = ((hsl[0] + hueShift) % 360 + 360) % 360
  if (scheme === 'dark') return toHex(fromHsl(hue, clamp(hsl[1], 40, 95), clamp(hsl[2], 55, 86)))
  return toHex(fromHsl(hue, clamp(hsl[1], 40, 95), clamp(hsl[2], 32, 68)))
}

const CUSTOM_PRESET_KEY = 'textColorPresets'
const CUSTOM_PRESET_MAX = 24
const CUSTOM_PRESET_NAME_MAX = 24

function validCustomStops (value) {
  if (!Array.isArray(value)) return null
  const stops = value
    .map((hex) => parseHex(hex))
    .filter((rgb) => rgb !== null)
    .slice(0, 12)
    .map((rgb) => toHex(rgb))
  return stops.length >= 2 ? stops : null
}

/**
 * 用户从「自定义炫彩条」保存的预设。
 * 存放在 appearance.textColorPresets，与内置 RAINBOW_PRESETS 分开；
 * 配置中的 rainbow.preset 可以直接引用这里的 saved_* id。
 */
export function getCustomRainbowPresets () {
  const appearance = state.settings.appearance || (state.settings.appearance = {})
  const source = Array.isArray(appearance[CUSTOM_PRESET_KEY]) ? appearance[CUSTOM_PRESET_KEY] : []
  const seen = new Set()
  const presets = []
  for (const item of source) {
    if (!item || typeof item !== 'object') continue
    const id = String(item.id || '')
    if (!/^saved_[a-z0-9_]+$/.test(id) || seen.has(id)) continue
    const name = String(item.name || '').trim().slice(0, CUSTOM_PRESET_NAME_MAX)
    const stops = validCustomStops(item.stops)
    if (!name || !stops) continue
    seen.add(id)
    presets.push({ id, name, stops })
    if (presets.length >= CUSTOM_PRESET_MAX) break
  }
  appearance[CUSTOM_PRESET_KEY] = presets
  return presets
}

export function saveCustomRainbowPreset (name, stops) {
  const cleanStops = validCustomStops(stops)
  if (!cleanStops) return null
  const appearance = state.settings.appearance || (state.settings.appearance = {})
  const presets = getCustomRainbowPresets()
  if (presets.length >= CUSTOM_PRESET_MAX) return null
  const rawName = String(name || '').trim().slice(0, CUSTOM_PRESET_NAME_MAX) || '我的炫彩'
  let uniqueName = rawName
  let suffix = 2
  while (presets.some((preset) => preset.name.toLowerCase() === uniqueName.toLowerCase())) {
    uniqueName = `${rawName} ${suffix++}`.slice(0, CUSTOM_PRESET_NAME_MAX)
  }
  const id = `saved_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const preset = { id, name: uniqueName, stops: cleanStops }
  presets.push(preset)
  appearance[CUSTOM_PRESET_KEY] = presets
  persist.settings()
  return preset
}

export function deleteCustomRainbowPreset (id) {
  const appearance = state.settings.appearance || (state.settings.appearance = {})
  const presets = getCustomRainbowPresets()
  const next = presets.filter((preset) => preset.id !== id)
  if (next.length === presets.length) return false
  appearance[CUSTOM_PRESET_KEY] = next
  persist.settings()
  return true
}

function presetStops (id) {
  const saved = getCustomRainbowPresets().find((preset) => preset.id === id)
  if (saved) return saved.stops
  return (RAINBOW_PRESETS.find((preset) => preset.id === id) || RAINBOW_PRESETS[0]).stops
}

function presetId (value) {
  if (value === 'custom') return 'custom'
  if (RAINBOW_PRESETS.some((preset) => preset.id === value)) return value
  if (getCustomRainbowPresets().some((preset) => preset.id === value)) return value
  return 'spectrum'
}

const LEGACY_THEME_PRESET_MIGRATIONS = [
  { name: '星空蓝', id: 'deepsea' },
  { name: '火星橙', id: 'mars' },
  { name: '土星灰', id: 'saturn' }
]

function sameStops (left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  return left.every((hex, index) => String(hex).toLowerCase() === String(right[index]).toLowerCase())
}

/**
 * 把用户在旧版本里保存的三套主题预设迁移成内置预设。
 * 只有名称和色块都完全一致才迁移；当前正在使用旧 saved_* id 时，
 * 同时把配置切到对应内置 id，视觉颜色不变。
 */
export function migrateLegacyThemePresets () {
  const appearance = state.settings.appearance || (state.settings.appearance = {})
  const presets = getCustomRainbowPresets()
  if (!presets.length) return false
  const next = []
  let changed = false
  for (const preset of presets) {
    const target = LEGACY_THEME_PRESET_MIGRATIONS.find((item) => item.name === preset.name &&
      sameStops(preset.stops, presetStops(item.id)))
    if (!target) {
      next.push(preset)
      continue
    }
    changed = true
    if (appearance.textColor && appearance.textColor.rainbow &&
      appearance.textColor.rainbow.preset === preset.id) {
      appearance.textColor.rainbow.preset = target.id
    }
  }
  if (changed) {
    appearance[CUSTOM_PRESET_KEY] = next
    persist.settings()
  }
  return changed
}

export function normalizeCustomStops (value) {
  const source = Array.isArray(value) ? value : []
  const stops = source
    .map((hex) => parseHex(hex))
    .filter((rgb) => rgb !== null)
    .slice(0, 12)
    .map((rgb) => toHex(rgb))
  if (stops.length < 2) return [...RAINBOW_PRESETS[0].stops]
  return stops
}

/** 当前炫彩条的原始色块：预设用预设色，custom 用用户自己的色块。 */
export function effectiveRainbowStops (config = getTextColorConfig()) {
  return config.rainbow.preset === 'custom'
    ? [...config.rainbow.customStops]
    : [...presetStops(config.rainbow.preset)]
}

/* ------------------------------------------------------------ config */

function numeric (value, fallback, lo, hi) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? clamp(parsed, lo, hi) : fallback
}

function normalize (raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const rainbow = source.rainbow && typeof source.rainbow === 'object' ? source.rainbow : {}
  const applyTo = source.applyTo && typeof source.applyTo === 'object' ? source.applyTo : {}
  const rgb = parseHex(source.color)
  const mode = source.mode === 'solid' || source.mode === 'rainbow' ? source.mode : 'off'
  const lastMode = mode !== 'off'
    ? mode
    : (source.lastMode === 'solid' || source.lastMode === 'rainbow' ? source.lastMode : 'rainbow')
  const motion = rainbow.motion === 'loop' || rainbow.motion === 'still' ? rainbow.motion : 'alternate'
  return {
    mode,
    lastMode,
    color: rgb === null ? DEFAULT_TEXT_COLOR.color : toHex(rgb),
    rainbow: {
      preset: presetId(rainbow.preset),
      customStops: normalizeCustomStops(rainbow.customStops),
      hue: Math.round(numeric(rainbow.hue, DEFAULT_TEXT_COLOR.rainbow.hue, 0, 350) / 5) * 5,
      speed: numeric(rainbow.speed, DEFAULT_TEXT_COLOR.rainbow.speed, 1, 24),
      motion,
      width: Math.round(numeric(rainbow.width, DEFAULT_TEXT_COLOR.rainbow.width, 120, 800) / 10) * 10
    },
    applyTo: {
      assistant: applyTo.assistant !== false,
      reasoning: applyTo.reasoning !== false,
      tools: applyTo.tools !== false,
      user: applyTo.user !== false,
      composer: applyTo.composer === true
    }
  }
}

function clone (value) { return JSON.parse(JSON.stringify(value)) }

export function getTextColorConfig () {
  const appearance = state.settings.appearance || (state.settings.appearance = {})
  let raw = appearance.textColor
  if (!raw || typeof raw !== 'object') {
    const base = themeTextColorDefault()
    /* 兼容上一版只有一个 messageTextColor 布尔开关的配置。 */
    if (appearance.messageTextColor === false) {
      base.mode = 'off'
      base.lastMode = 'rainbow'
    }
    raw = base
  }
  const config = normalize(raw)
  appearance.textColor = config
  return config
}

function saveConfig (config) {
  const appearance = state.settings.appearance || (state.settings.appearance = {})
  appearance.textColor = config
  persist.settings()
  applyTextColor()
  for (const listener of listeners) listener(config)
}

const listeners = new Set()
export function subscribeTextColor (listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setTextColorConfig (patch = {}) {
  const current = getTextColorConfig()
  const next = {
    ...current,
    ...patch,
    rainbow: { ...current.rainbow, ...(patch.rainbow || {}) },
    applyTo: { ...current.applyTo, ...(patch.applyTo || {}) }
  }
  if (patch.mode === 'off') {
    next.lastMode = current.mode === 'off' ? current.lastMode : current.mode
  } else if (patch.mode === 'solid' || patch.mode === 'rainbow') {
    next.lastMode = patch.mode
  }
  const config = normalize(next)
  saveConfig(config)
  return config
}

export function setTextColorEnabled (enabled) {
  const current = getTextColorConfig()
  if (enabled) return setTextColorConfig({ mode: current.mode === 'off' ? (current.lastMode || 'rainbow') : current.mode })
  return setTextColorConfig({ mode: 'off' })
}

export function resetTextColorConfig () {
  const config = normalize(clone(themeTextColorDefault()))
  saveConfig(config)
  return config
}

/* ------------------------------------------------------------ CSS */

const PAINT = ':is(p,span,div,li,ul,ol,h1,h2,h3,h4,h5,h6,td,th,dt,dd,blockquote,a,summary,label,strong,em,b,i,small,time,figcaption,caption,mark)'
const OPAQUE = ':is(pre,pre *,code,code *,kbd,kbd *,samp,samp *)'
const DECORATION = ':not([aria-hidden="true"]):not([aria-hidden="true"] *):not([class*="avatar"]):not([class*="avatar"] *)'
const EXCLUDE = ':not(.msg-actions):not(.msg-actions *):not(.plan-task-actions):not(.plan-task-actions *):not(.plan-status):not(.plan-status *):not(.md-image):not(.md-image *):not(.image-thumb):not(.image-thumb *)' + DECORATION

export function isDarkTheme () {
  const theme = state.themes.find((entry) => entry.id === (state.settings.theme || 'astral')) || state.themes[0]
  const bg = theme && theme.tokens && theme.tokens['--bg-0']
  const rgb = parseHex(bg)
  if (!rgb) return true
  const luminance = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
  return luminance < 0.56
}

export function currentScheme () {
  return isDarkTheme() ? 'dark' : 'light'
}

function enabledScopes (config) {
  return SCOPES.filter((scope) => config.applyTo[scope.key] === true)
}

const FOLDED_TARGET = {
  assistant: '.msg.agent.folded .msg-fold-bar-text',
  reasoning: '.msg.agent.folded .msg-fold-bar-text',
  tools: '.msg.plan.folded .msg-fold-bar-text, .msg.tool.folded .msg-fold-bar-text',
  user: '.msg.user.folded .msg-fold-bar-text'
}

function scopeTargets (scope) {
  const out = []
  const reasoningExclude = scope.excludeReasoning ? ':not(.md-pending):not(.md-pending *)' : ''
  const selfRoots = Array.isArray(scope.selfRoots) ? scope.selfRoots : []
  for (const root of scope.roots) {
    const base = `.${ROOT_CLASS} ${root}`
    const self = (scope.self || selfRoots.includes(root))
      ? `${base}${EXCLUDE}${reasoningExclude}`
      : null
    if (self) out.push(self)
    out.push(`${base} ${PAINT}${EXCLUDE}${reasoningExclude}`)
  }
  const folded = FOLDED_TARGET[scope.key]
  if (folded) out.push(`.${ROOT_CLASS} ${folded}${EXCLUDE}`)
  return out
}

function paintSelectors (config) {
  const out = []
  for (const scope of enabledScopes(config)) out.push(...scopeTargets(scope))
  return [...new Set(out)].join(',\n')
}

function opaqueSelectors (config) {
  const out = []
  for (const scope of enabledScopes(config)) {
    for (const root of scope.roots) out.push(`.${ROOT_CLASS} ${root} ${OPAQUE}`)
  }
  return [...new Set(out)].join(',\n')
}

function gradientEnd (width) {
  const safe = Math.max(width, 120)
  return Math.round((100 * safe) / (safe - 100) * 100) / 100
}

function stopsFor (config, scheme) {
  if (config.rainbow.preset === 'custom') return config.rainbow.customStops
  return presetStops(config.rainbow.preset).map((hex) => stopColor(hex, scheme, config.rainbow.hue))
}

function animationValue (config) {
  if (config.rainbow.motion === 'still') return null
  const easing = config.rainbow.motion === 'loop' ? 'linear' : 'ease-in-out'
  const direction = config.rainbow.motion === 'loop' ? 'normal' : 'alternate'
  const name = config.rainbow.motion === 'loop' ? 'astral-text-color-run' : 'astral-text-color-ping'
  return `${name} ${config.rainbow.speed}s ${easing} infinite ${direction}`
}

function keyframes (config) {
  return [
    '@keyframes astral-text-color-ping { from { background-position: 0% 50%; } to { background-position: 100% 50%; } }',
    `@keyframes astral-text-color-run { from { background-position: 0% 50%; } to { background-position: ${gradientEnd(config.rainbow.width)}% 50%; } }`
  ].join('\n')
}

function gradientDeclarations (config, scheme) {
  const ring = stopsFor(config, scheme)
  const lines = [
    `background-image: linear-gradient(100deg, ${ring.concat([ring[0]]).join(', ')});`,
    `background-size: ${config.rainbow.width}% 100%;`,
    'background-repeat: repeat-x;',
    '-webkit-background-clip: text;',
    'background-clip: text;',
    'background-clip: text, padding-box;',
    '-webkit-text-fill-color: transparent;'
  ]
  const animation = animationValue(config)
  if (animation) lines.push(`animation: ${animation};`)
  return lines.join('\n')
}

function restoreDeclarations () {
  return 'background-image: none !important; animation: none !important; -webkit-text-fill-color: currentColor !important;'
}

export function previewStyle (config = getTextColorConfig()) {
  if (config.mode === 'off') return {}
  const scheme = currentScheme()
  if (config.mode === 'solid') return { color: solidColor(config.color, scheme) }
  const ring = stopsFor(config, scheme)
  const style = {
    backgroundImage: `linear-gradient(100deg, ${ring.concat([ring[0]]).join(', ')})`,
    backgroundSize: `${config.rainbow.width}% 100%`,
    backgroundRepeat: 'repeat-x',
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    WebkitTextFillColor: 'transparent'
  }
  const animation = animationValue(config)
  if (animation && !document.body.classList.contains('reduced-motion')) style.animation = animation
  return style
}

export function buildTextColorCss (config = getTextColorConfig()) {
  if (config.mode === 'off') return ''
  const scopes = enabledScopes(config)
  if (!scopes.length) return ''
  const scheme = currentScheme()
  const targets = paintSelectors(config)
  if (!targets) return ''
  const rules = []

  if (config.mode === 'solid') {
    rules.push(`${targets} { color: ${solidColor(config.color, scheme)}; }`)
    return rules.join('\n')
  }

  rules.push(keyframes(config))
  rules.push(`${targets} { ${gradientDeclarations(config, scheme)} }`)
  const opaque = opaqueSelectors(config)
  if (opaque) rules.push(`${opaque} { ${restoreDeclarations()} }`)
  /* 被排除的装饰/控件如果处在已染色的祖先里，会继承透明填充，显式恢复。 */
  /* 启动动画整棵子树豁免：它本来就全是 aria-hidden 的装饰层，
     被这条规则强制 animation:none 会把分层入场全部掐掉。
     品牌图标同理：aria-hidden 装饰元素，但落地后有 brandIn 入场动画。 */
  rules.push(`.${ROOT_CLASS} :is(.plan-status,.plan-status *,.msg-actions,.msg-actions *,.plan-task-actions,.plan-task-actions *,.md-image,.md-image *,.image-thumb,.image-thumb *,[aria-hidden="true"],[aria-hidden="true"] *,[class*="avatar"],[class*="avatar"] *):not(.splash):not(.splash *):not(.brand-mark) { ${restoreDeclarations()} }`)
  const reduced = targets.split(',\n').map((selector) => `body.reduced-motion ${selector}`).join(',\n')
  rules.push(`@media (prefers-reduced-motion: reduce) { ${targets} { animation: none !important; } }`)
  rules.push(`${reduced} { animation: none !important; }`)
  return rules.join('\n')
}

let mountedStyle = null
let observer = null

export function applyTextColor () {
  const config = getTextColorConfig()
  const style = mountedStyle || document.getElementById(STYLE_ID)
  if (!style) return
  const css = buildTextColorCss(config)
  style.textContent = css
  document.documentElement.classList.toggle(ROOT_CLASS, Boolean(css))
}

export function mountMessageTextColor () {
  migrateLegacyThemePresets()
  if (!mountedStyle) {
    mountedStyle = document.getElementById(STYLE_ID)
    if (!mountedStyle) {
      mountedStyle = document.createElement('style')
      mountedStyle.id = STYLE_ID
      document.head.append(mountedStyle)
    }
  }
  applyTextColor()
  if (!observer && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => applyTextColor())
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'class'] })
  }
}
