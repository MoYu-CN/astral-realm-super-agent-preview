'use strict'

/**
 * 星界 · 探子（只读采集层）
 *
 * 职责只有一个：在**用户明确指定的项目目录**里，快速扫一遍文本文件，
 * 产出一份可编辑的摘要（digest），交给超级智能体整理成权重图。
 *
 * 边界（很重要）：
 *   - 只读，绝不创建 / 改写 / 移动任何文件；
 *   - 不跟随符号链接、不越出根目录（每个文件都做 realpath 校验）；
 *   - 跳过 node_modules / .git / dist / build / vendor / 隐藏目录等噪音；
 *   - 单文件、总字节、文件数、递归深度都有硬上限，避免大仓库卡死；
 *   - 不扫描 Desktop / Downloads / Documents 等个人目录：调用方必须显式给 rootPath。
 *
 * 工作聊天记录这类敏感来源**不在本模块内**：它们走独立的「观察」通道，
 * 需要用户显式授权并把内容写进来，探子不会自己去翻。
 */

const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'vendor', '.workbuddy', 'coverage',
  '.next', 'out', '__pycache__', '.venv', 'venv', 'target', 'bin', 'obj'
])

const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.rst',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte',
  '.json', '.yml', '.yaml', '.toml', '.ini',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.cs', '.php',
  '.css', '.scss', '.less', '.html', '.htm', '.sql', '.sh', '.bat', '.ps1'
])

const MAX_FILES = 60
const MAX_FILE_BYTES = 256 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024
const MAX_DEPTH = 6
const EXCERPT_CHARS = 320

function clamp (value, lo, hi) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo
}

function inside (root, target) {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/* 拒绝把「整个桌面 / 下载 / 文档」当项目目录扫；它们下面的具体项目目录仍允许。
   个人目录整理属于高风险操作，探子只做项目范围内的只读扫描。 */
const PERSONAL_DIRS = new Set([
  'desktop', 'downloads', 'documents', 'pictures', 'music', 'videos', 'appdata', 'library'
])
function personalRoot (root) {
  const home = os.homedir()
  if (!home) return false
  const rel = path.relative(path.resolve(home), path.resolve(root))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
  const parts = rel.split(path.sep).filter(Boolean)
  return parts.length === 1 && PERSONAL_DIRS.has(parts[0].toLowerCase())
}

function buildDigest (root, files, byExt, scanned, skipped, truncated) {
  const lines = [
    '# 探子扫描 · ' + path.basename(root),
    '',
    `共 ${scanned} 个文本文件，跳过 ${skipped} 项（依赖目录 / 非文本 / 超长 / 符号链接）。`,
    '类型：' + (Object.keys(byExt).length
      ? Object.entries(byExt).sort((a, b) => b[1] - a[1]).map(([ext, n]) => ext + ' ' + n).join(' · ')
      : '无'),
    truncated ? '注意：已触及扫描上限，下面是代表性样本，不是全量。' : '',
    '',
    '## 文件摘录',
    ''
  ]
  const shown = files.slice(0, 40)
  for (const file of shown) {
    lines.push('### ' + file.path)
    const excerpt = String(file.excerpt || '').replace(/\r/g, '').trim()
    lines.push(excerpt ? excerpt.slice(0, 220) : '（空或无法读取）')
    lines.push('')
  }
  if (files.length > shown.length) lines.push(`…另有 ${files.length - shown.length} 个文件未展开。`)
  lines.push('')
  lines.push('## 交给超级智能体')
  lines.push('请基于以上摘录整理成 JSON：{"nodes":[{"name":"项目名","summary":"一句话","events":[{"prefix":"S","summary":"要点"}]}]}')
  lines.push('节点名用真实项目/模块名，事件只写可复用的要点，不要编造未提供的内容。')
  return lines.filter((line) => line !== '').join('\n').replace(/\n{3,}/g, '\n\n')
}

async function scan (input = {}) {
  const root = String(input.rootPath || '').trim()
  if (!root) return { ok: false, error: '需要显式指定项目目录（探子不会扫描个人目录）' }
  let realRoot
  try {
    realRoot = await fsp.realpath(root)
  } catch {
    return { ok: false, error: '目录不存在或不可读：' + root }
  }
  let rootStat
  try {
    rootStat = await fsp.stat(realRoot)
  } catch {
    return { ok: false, error: '目录不可读：' + root }
  }
  if (!rootStat.isDirectory()) return { ok: false, error: '不是目录：' + root }
  if (personalRoot(realRoot)) {
    return { ok: false, error: '出于隐私考虑，探子不扫描整个桌面 / 下载 / 文档等个人目录；请指定具体项目目录' }
  }

  const maxFiles = clamp(input.maxFiles || MAX_FILES, 1, 200)
  const files = []
  const byExt = {}
  let scanned = 0
  let skipped = 0
  let totalBytes = 0

  async function walk (dir, depth) {
    if (depth > MAX_DEPTH || files.length >= maxFiles || totalBytes >= MAX_TOTAL_BYTES) return
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (files.length >= maxFiles || totalBytes >= MAX_TOTAL_BYTES) break
      const name = entry.name
      if (name.startsWith('.')) { skipped += 1; continue }
      const full = path.join(dir, name)
      if (entry.isSymbolicLink()) { skipped += 1; continue }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) { skipped += 1; continue }
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(name).toLowerCase()
      if (!TEXT_EXT.has(ext)) { skipped += 1; continue }
      let real
      try {
        real = await fsp.realpath(full)
      } catch {
        skipped += 1
        continue
      }
      if (!inside(realRoot, real)) { skipped += 1; continue }
      let stat
      try {
        stat = await fsp.stat(real)
      } catch {
        skipped += 1
        continue
      }
      if (stat.size > MAX_FILE_BYTES) { skipped += 1; continue }
      let text
      try {
        text = await fsp.readFile(real, 'utf8')
      } catch {
        skipped += 1
        continue
      }
      scanned += 1
      totalBytes += Buffer.byteLength(text)
      byExt[ext] = (byExt[ext] || 0) + 1
      files.push({
        path: path.relative(realRoot, real).split(path.sep).join('/'),
        ext,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        excerpt: String(text).slice(0, EXCERPT_CHARS).replace(/\r/g, '').trim()
      })
    }
  }

  await walk(realRoot, 0)
  const truncated = files.length >= maxFiles || totalBytes >= MAX_TOTAL_BYTES
  return {
    ok: true,
    root: realRoot,
    files,
    digest: buildDigest(realRoot, files, byExt, scanned, skipped, truncated),
    stats: { scanned, skipped, byExt, bytes: totalBytes, truncated }
  }
}

module.exports = { scan }
