/* i18n.js — 界面语言层
 *
 * 设计目标：
 *   1. 中文是源语言；英文等语言通过 locale JSON 覆盖，缺词自动回退中文；
 *   2. 内置 zh-CN / en-US，其他语言可放入 config/locales/<code>.json，
 *      或在运行时调用 Astral.i18n.registerLocale(code, meta, messages)；
 *   3. 静态界面由 DOM 本地化器处理，动态文案可用 t()；
 *   4. 聊天正文、Markdown、代码、用户输入不进入翻译。
 */

const BASE = 'zh-CN'
const TEXT_SKIP = [
  '.md', '.msg-body', '.user-text', '.plan-brief', '.plan-task .what',
  '.tool-pre', '.ro-md', '.ro-text', '.preview-text', '.file-preview-text',
  'pre', 'code', 'textarea', 'script', 'style', '[contenteditable="true"]',
  '[data-i18n-skip]'
].join(',')
const ATTR_SKIP = 'pre, code, script, style, [data-i18n-skip]'
const ATTRS = ['placeholder', 'title', 'aria-label', 'aria-description', 'alt']

let current = BASE
let locales = []
let byCode = new Map()
const listeners = new Set()
const originals = new WeakMap()
const translatedValues = new WeakMap()
const attrOriginals = new WeakMap()
let observer = null
let applying = false

function normalizeLocale (item) {
  if (!item || typeof item !== 'object') return null
  const code = String(item.code || '').trim()
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(code)) return null
  return {
    code,
    name: String(item.name || item.nativeName || code),
    nativeName: String(item.nativeName || item.name || code),
    dir: item.dir === 'rtl' ? 'rtl' : 'ltr',
    title: String(item.title || ''),
    messages: item.messages && typeof item.messages === 'object' ? { ...item.messages } : {}
  }
}

function normalizeLocales (list) {
  const next = []
  const seen = new Set()
  for (const raw of Array.isArray(list) ? list : []) {
    const item = normalizeLocale(raw)
    if (!item || seen.has(item.code)) continue
    seen.add(item.code)
    next.push(item)
  }
  if (!seen.has(BASE)) next.unshift(normalizeLocale({ code: BASE, name: '简体中文', nativeName: '简体中文' }))
  next.sort((a, b) => (a.code === BASE ? -1 : b.code === BASE ? 1 : a.code.localeCompare(b.code)))
  return next
}

function dictFor (code = current) {
  const item = byCode.get(code)
  return item ? item.messages : {}
}

function lookup (source, code = current) {
  if (!source) return source
  return dictFor(code)[source] || ''
}

function interpolate (text, vars) {
  return String(text).replace(/\{(\w+)\}/g, (_m, key) =>
    vars && Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : `{${key}}`)
}

function isSkipped (element, selector) {
  return Boolean(element && element.closest && element.closest(selector))
}

function setText (node, value) {
  if (node.nodeValue !== value) node.nodeValue = value
}

function localizeTextNode (node, force = false) {
  const parent = node.parentElement
  if (!parent || isSkipped(parent, TEXT_SKIP)) return
  const currentValue = node.nodeValue || ''
  const last = translatedValues.get(node)
  let source = currentValue
  if (force || (last !== undefined && currentValue === last)) {
    source = originals.has(node) ? originals.get(node) : currentValue
  } else if (last === undefined) {
    originals.set(node, currentValue)
  }

  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(source)
  const lead = match ? match[1] : ''
  const core = match ? match[2] : source
  const trail = match ? match[3] : ''
  if (!core.trim()) return

  let next = core
  if (current !== BASE) next = lookup(core) || core
  if (next === core) {
    if (current === BASE && originals.has(node)) setText(node, source)
    translatedValues.delete(node)
    return
  }
  if (!originals.has(node)) originals.set(node, source)
  const value = `${lead}${next}${trail}`
  setText(node, value)
  translatedValues.set(node, value)
}

function localizeAttributes (element, force = false) {
  if (!element || element.nodeType !== 1 || isSkipped(element, ATTR_SKIP)) return
  let store = attrOriginals.get(element)
  for (const attr of ATTRS) {
    if (!element.hasAttribute(attr)) continue
    const value = element.getAttribute(attr)
    if (!value) continue
    if (!store) {
      store = new Map()
      attrOriginals.set(element, store)
    }
    const record = store.get(attr)
    let source = value
    if (force || (record && value === record.translated)) source = record ? record.source : value
    else if (!record) store.set(attr, { source, translated: '' })
    const core = source.trim()
    if (!core) continue
    const next = current === BASE ? core : (lookup(core) || core)
    if (next === core) {
      if (current === BASE && record && record.source !== value) element.setAttribute(attr, source)
      continue
    }
    const translated = source.replace(core, next)
    if (translated !== value) element.setAttribute(attr, translated)
    store.set(attr, { source, translated })
  }
}

function localizeTree (root, force = false) {
  if (!root) return
  if (root.nodeType === 3) {
    localizeTextNode(root, force)
    return
  }
  if (root.nodeType !== 1 && root.nodeType !== 9) return
  if (root.nodeType === 1) localizeAttributes(root, force)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) localizeTextNode(walker.currentNode, force)
  for (const element of root.querySelectorAll('*')) localizeAttributes(element, force)
}

function setDocumentMeta () {
  const meta = byCode.get(current)
  document.documentElement.lang = current
  document.documentElement.dir = (meta && meta.dir) || 'ltr'
  if (meta && meta.title) document.title = meta.title
}

export function currentLocale () {
  return current
}

export function localeTag () {
  return current
}

export function availableLocales () {
  return locales.map((item) => ({
    code: item.code,
    name: item.name,
    nativeName: item.nativeName,
    dir: item.dir
  }))
}

export function t (source, vars = {}) {
  const next = current === BASE ? source : (lookup(source) || source)
  return interpolate(next, vars)
}

export function translateText (source) {
  return t(source)
}

export function setLocale (code) {
  const next = byCode.has(code) ? code : BASE
  if (next === current && byCode.has(current)) {
    setDocumentMeta()
    return current
  }
  current = next
  setDocumentMeta()
  applying = true
  try {
    localizeTree(document.body, true)
  } finally {
    applying = false
  }
  for (const listener of [...listeners]) {
    try { listener(current) } catch (err) { console.error('[i18n]', err) }
  }
  return current
}

export function setLocales (list) {
  locales = normalizeLocales(list)
  byCode = new Map(locales.map((item) => [item.code, item]))
  if (!byCode.has(current)) current = BASE
  return availableLocales()
}

export function registerLocale (meta, messages = {}) {
  const item = normalizeLocale({ ...meta, messages })
  if (!item) throw new Error('无效的语言代码')
  const index = locales.findIndex((entry) => entry.code === item.code)
  if (index >= 0) locales[index] = item
  else locales.push(item)
  byCode.set(item.code, item)
  locales = normalizeLocales(locales)
  if (item.code === current) {
    applying = true
    try { localizeTree(document.body, true) } finally { applying = false }
  }
  return availableLocales()
}

export function onLocaleChange (listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function installObserver () {
  if (observer || typeof MutationObserver === 'undefined') return
  observer = new MutationObserver((records) => {
    if (applying || current === BASE) return
    for (const record of records) {
      if (record.type === 'attributes') {
        localizeAttributes(record.target)
        continue
      }
      for (const node of record.addedNodes) {
        if (node.nodeType === 3) localizeTextNode(node)
        else if (node.nodeType === 1) localizeTree(node)
      }
    }
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ATTRS
  })
}

export function initI18n (list, code) {
  setLocales(list)
  setLocale(code || BASE)
  installObserver()
  return current
}

/* 供插件/外部语言包使用的稳定接口。 */
export const i18n = {
  t,
  translateText,
  currentLocale,
  localeTag,
  availableLocales,
  setLocale,
  setLocales,
  registerLocale,
  onLocaleChange
}

