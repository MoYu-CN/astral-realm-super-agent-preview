'use strict'

/**
 * intake/secret-box.js — 渠道密钥（Token / Secret / AESKey）
 *
 * 和 providers 里的 API Key 一样走 Electron safeStorage（Windows 下是 DPAPI），
 * 落盘只有密文。拿不到 safeStorage 时退化成 base64 并标记 plain，
 * 界面会显示「未加密」——不能假装加密了。
 */

const fs = require('node:fs')
const path = require('node:path')

function loadElectron () {
  try {
    /* 纯 Node 环境下没有 electron，测试用内存箱代替 */
    return require('electron')
  } catch {
    return null
  }
}

function createSecretBox ({ configDir }) {
  const file = path.join(configDir, 'intake-secrets.json')
  let data = { version: 1, plain: false, boxes: {} }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object') data = { version: 1, plain: false, boxes: {}, ...parsed }
  } catch { /* 第一次运行 */ }

  const electron = loadElectron()
  const safeStorage = electron && electron.safeStorage
  function available () {
    try { return Boolean(safeStorage && safeStorage.isEncryptionAvailable()) } catch { return false }
  }

  function save () {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  }

  return {
    encrypted () { return available() && !data.plain },
    get (id) {
      const raw = data.boxes[String(id)]
      if (!raw) return {}
      try {
        const json = available() && !data.plain
          ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
          : Buffer.from(raw, 'base64').toString('utf8')
        return JSON.parse(json)
      } catch { return {} }
    },
    set (id, value) {
      const json = JSON.stringify(value || {})
      if (!json || json === '{}') {
        delete data.boxes[String(id)]
      } else if (available()) {
        data.boxes[String(id)] = safeStorage.encryptString(json).toString('base64')
        data.plain = false
      } else {
        data.boxes[String(id)] = Buffer.from(json, 'utf8').toString('base64')
        data.plain = true
      }
      save()
    },
    status () {
      return { encrypted: available() && !data.plain, file }
    }
  }
}

module.exports = { createSecretBox }
