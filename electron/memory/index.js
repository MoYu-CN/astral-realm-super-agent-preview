'use strict'

/** 星界 · 记忆服务统一出口，供主进程 / stdio server / 测试共用。 */

const { createMemoryStore, ROLE } = require('./store.js')

function createMemoryService (options = {}) {
  return createMemoryStore(options)
}

module.exports = { createMemoryService, ROLE }
