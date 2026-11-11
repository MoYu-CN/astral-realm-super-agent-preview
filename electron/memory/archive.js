'use strict'

/**
 * 星界 · 封存档案（P0 雏形）
 * 旧文件不删除：复制进封存目录 + 登记清单，只提供只读回查，不提供任何写方法。
 */

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

function createArchive ({ configDir, archiveDir, db } = {}) {
  if (!db) throw new Error('createArchive 需要 db 句柄')
  if (!configDir && !archiveDir) throw new Error('createArchive 需要 configDir 或 archiveDir')
  const root = archiveDir || path.join(configDir, 'archive')
  fs.mkdirSync(root, { recursive: true })

  function register ({ sourcePath, kind, period, projectHint } = {}) {
    if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('封存源文件不存在')
    const id = randomUUID()
    const dest = path.join(root, id + path.extname(sourcePath))
    fs.copyFileSync(sourcePath, dest)
    const archivedAt = new Date().toISOString()
    db.prepare(
      'INSERT INTO archive_manifest (id, path, kind, period, archived_at, project_hint) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, dest, kind || null, period || null, archivedAt, projectHint || null)
    return { id, path: dest, archivedAt }
  }

  function read (id) {
    if (!id) throw new Error('封存回查需要 id')
    const row = db.prepare('SELECT * FROM archive_manifest WHERE id = ?').get(id)
    if (!row) throw new Error('封存记录不存在：' + id)
    if (!fs.existsSync(row.path)) throw new Error('封存文件缺失：' + row.path)
    return { ...row, content: fs.readFileSync(row.path, 'utf8') }
  }

  function list (filter = {}) {
    const rows = db.prepare('SELECT * FROM archive_manifest ORDER BY archived_at DESC').all()
    return rows.filter((r) => {
      if (filter.kind && r.kind !== filter.kind) return false
      if (filter.projectHint && r.project_hint !== filter.projectHint) return false
      return true
    })
  }

  return { root, register, read, list }
}

module.exports = { createArchive }
