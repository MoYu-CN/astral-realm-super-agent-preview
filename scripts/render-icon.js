'use strict'
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const ROOT = path.join(__dirname, '..')
const svg = fs.readFileSync(path.join(ROOT, 'app', 'assets', 'astral-meteor.svg'), 'utf8')
const size = 1024
const out = path.join(ROOT, 'app', 'assets', 'astral-icon.png')
const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:transparent;overflow:hidden}svg{width:${size}px;height:${size}px;display:block}</style></head><body>${svg}</body></html>`
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: size,
      height: size,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: { offscreen: false, backgroundThrottling: false }
    })
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    await new Promise((resolve) => setTimeout(resolve, 800))
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
    fs.writeFileSync(out, image.toPNG())
    console.log('wrote', out, image.getSize())
    win.destroy()
  } catch (err) {
    console.error(err)
    app.exit(1)
  }
  app.quit()
})
