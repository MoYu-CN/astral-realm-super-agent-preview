/* starmap3d.js — 记忆星图的三维渲染
 *
 * 纯 Canvas 2D 手写透视投影，不引第三方 3D 库：
 *   世界坐标 → 绕 Y 轴偏航 → 绕 X 轴俯仰 → 沿 Z 平移相机距离 → 透视除法。
 * 星星用离屏 sprite（光晕 + 四长四短衍射光芒 + 亮核），以 lighter 叠加，
 * 再按深度排序绘制，近大远小、近亮远暗。
 *
 * 交互：拖拽旋转、滚轮推拉、点击星体后相机飞到它的三维位置并居中；
 * 「总览」复位到能看见整张星图的全景机位。
 */
(function (global) {
  'use strict'

  const TAU = Math.PI * 2
  const FOCAL = 1000
  const NEAR = 26
  const MIN_DIST = 230
  const MAX_DIST = 2600
  /* 全景机位：能装下整张星图；点击星体后收窄到 FOCUS_DIST */
  const HOME = { yaw: -0.62, pitch: 0.3, dist: 1180, tx: 0, ty: 0, tz: 0 }
  const FOCUS_DIST = 380
  /* sprite 半宽等于 3.2 个星体半径，光芒贴到边缘 */
  const EXT = 3.2
  const SPRITE_PX = 192

  function clamp (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
  function easeInOut (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2 }

  function hexA (hex, a) {
    const h = String(hex).replace('#', '')
    const n = h.length === 3
      ? [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)]
      : [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
    return 'rgba(' + n[0] + ',' + n[1] + ',' + n[2] + ',' + a + ')'
  }

  /* 一根衍射光芒：中间亮、两端透明的细长菱形 */
  function spike (g, cx, cy, len, halfWidth, angle, color, strength) {
    g.save()
    g.translate(cx, cy)
    g.rotate(angle)
    const grad = g.createLinearGradient(-len, 0, len, 0)
    grad.addColorStop(0, hexA(color, 0))
    grad.addColorStop(0.42, hexA(color, strength * 0.55))
    grad.addColorStop(0.5, hexA(color, strength))
    grad.addColorStop(0.58, hexA(color, strength * 0.55))
    grad.addColorStop(1, hexA(color, 0))
    g.fillStyle = grad
    g.beginPath()
    g.moveTo(-len, 0)
    g.quadraticCurveTo(0, -halfWidth, len, 0)
    g.quadraticCurveTo(0, halfWidth, -len, 0)
    g.closePath()
    g.fill()
    g.restore()
  }

  function makeSprite (color, ring) {
    const c = document.createElement('canvas')
    c.width = c.height = SPRITE_PX
    const g = c.getContext('2d')
    const cx = SPRITE_PX / 2
    g.globalCompositeOperation = 'lighter'

    /* 外层光晕：从核心到边缘多段衰减，模拟大气散射 */
    const halo = g.createRadialGradient(cx, cx, 0, cx, cx, cx)
    halo.addColorStop(0, hexA(color, 0.92))
    halo.addColorStop(0.05, hexA(color, 0.62))
    halo.addColorStop(0.13, hexA(color, 0.26))
    halo.addColorStop(0.3, hexA(color, 0.085))
    halo.addColorStop(0.62, hexA(color, 0.022))
    halo.addColorStop(1, hexA(color, 0))
    g.fillStyle = halo
    g.fillRect(0, 0, SPRITE_PX, SPRITE_PX)

    /* 衍射光芒：四长（0° / 90°）+ 四短（45°） */
    const len = cx * 0.94
    spike(g, cx, cx, len, cx * 0.052, 0, color, 0.5)
    spike(g, cx, cx, len, cx * 0.052, Math.PI / 2, color, 0.5)
    spike(g, cx, cx, len * 0.62, cx * 0.036, Math.PI / 4, color, 0.3)
    spike(g, cx, cx, len * 0.62, cx * 0.036, -Math.PI / 4, color, 0.3)

    /* 亮核：偏白，带一点本色 */
    const core = g.createRadialGradient(cx, cx, 0, cx, cx, cx * 0.2)
    core.addColorStop(0, 'rgba(255,255,255,0.98)')
    core.addColorStop(0.28, hexA(color, 0.92))
    core.addColorStop(0.62, hexA(ring || color, 0.4))
    core.addColorStop(1, hexA(ring || color, 0))
    g.fillStyle = core
    g.beginPath()
    g.arc(cx, cx, cx * 0.2, 0, TAU)
    g.fill()

    return c
  }

  function project (p, cam, w, h, out) {
    const x = p.x - cam.tx
    const y = p.y - cam.ty
    const z = p.z - cam.tz
    const cy = Math.cos(cam.yaw)
    const sy = Math.sin(cam.yaw)
    const x1 = x * cy - z * sy
    const z1 = x * sy + z * cy
    const cp = Math.cos(cam.pitch)
    const sp = Math.sin(cam.pitch)
    const y1 = y * cp - z1 * sp
    const z2 = y * sp + z1 * cp
    const zc = z2 + cam.dist
    if (zc < NEAR) { out.ok = false; return out }
    const s = FOCAL / zc
    out.ok = true
    out.x = w / 2 + x1 * s
    out.y = h / 2 - y1 * s
    out.z = zc
    out.s = s
    return out
  }

  function create (opts) {
    const canvas = opts.canvas
    const tip = opts.tip
    const onSelect = opts.onSelect || function () {}
    const onFocusChange = opts.onFocusChange || function () {}

    const ctx = canvas.getContext('2d')
    const view = { w: 0, h: 0, dpr: 1 }
    const cam = Object.assign({}, HOME)
    let tween = null
    let graph = { nodes: [], edges: [], mode: 'concept' }
    let focusId = null
    let hoverId = null
    let dragging = false
    let dragMoved = 0
    let lastX = 0
    let lastY = 0
    let raf = 0
    let active = false
    let clock = 0
    let tipNodes = null
    let edgeLabelCount = 0

    /* 远景色场：固定在天球上的小点，用来产生旋转视差 */
    const dust = []
    for (let i = 0; i < 260; i++) {
      const u = (i + 0.5) / 260
      const phi = Math.acos(1 - 2 * u)
      const theta = i * 2.399963
      const r = 2100 + (i % 7) * 260
      dust.push({
        x: r * Math.sin(phi) * Math.cos(theta),
        y: r * Math.cos(phi),
        z: r * Math.sin(phi) * Math.sin(theta),
        a: 0.1 + ((i * 37) % 23) / 100,
        r: 0.7 + ((i * 13) % 9) / 10
      })
    }

    const sprites = new Map()
    function spriteFor (node) {
      const color = node.color || '#cfd8ff'
      const ring = node.ring || color
      const key = color + '|' + ring
      let s = sprites.get(key)
      if (!s) { s = makeSprite(color, ring); sprites.set(key, s) }
      return s
    }

    function resize () {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(2, global.devicePixelRatio || 1)
      view.w = Math.max(1, rect.width)
      view.h = Math.max(1, rect.height)
      view.dpr = dpr
      canvas.width = Math.round(view.w * dpr)
      canvas.height = Math.round(view.h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      /* 画布尺寸变了，全景机位要重新取景，否则「总览」会装不下 */
      if (graph.nodes.length) {
        home = fitPose()
        /* 视图刚从隐藏变为可见（或刚换图）时画布是 0×0，取景会算歪；
           等拿到真实尺寸再落位一次，之后用户自己的视角就不再干预 */
        if (needHome && view.w > 40) {
          Object.assign(cam, home)
          needHome = false
        }
      }
      draw()
    }

    function nodeById (id) {
      for (const n of graph.nodes) if (n.id === id) return n
      return null
    }

    function neighbours (id) {
      const set = new Set([id])
      for (const e of graph.edges) {
        if (e.from === id) set.add(e.to)
        if (e.to === id) set.add(e.from)
      }
      return set
    }

    const proj = { ok: false, x: 0, y: 0, z: 0, s: 1 }
    const order = []

    /* 全景机位按当前图自动取景：以节点重心为初始目标点，
       交替做「缩放到画布 86% × 84%」与「平移到画面中心」，
       直到包围盒既装得下又居中。包围盒把星体半径与标签高度也算进去，避免光芒被裁。 */
    function bboxOf (pose) {
      const o = { ok: false, x: 0, y: 0, z: 0, s: 1 }
      let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity
      for (const n of graph.nodes) {
        project(n, pose, view.w, view.h, o)
        if (!o.ok) continue
        const rad = (n.r || 10) * o.s
        const minor = n.kind === 'event' || n.kind === 'knowledge-item'
        /* 标签宽度也占版面，取景时一并算进去，否则边缘节点的字会被裁 */
        const labelW = minor || !n.label ? 0 : Math.min(150, String(n.label).length * 6.8)
        const halfW = Math.max(rad * 1.1, labelW / 2)
        if (o.x - halfW < x0) x0 = o.x - halfW
        if (o.x + halfW > x1) x1 = o.x + halfW
        if (o.y - rad - 14 < y0) y0 = o.y - rad - 14
        if (o.y + rad > y1) y1 = o.y + rad
      }
      if (!isFinite(x0) || !isFinite(y0)) return null
      if (!isFinite(x1) || !isFinite(y1)) return null
      return { x0: x0, x1: x1, y0: y0, y1: y1, w: x1 - x0, h: y1 - y0 }
    }

    /* 全景机位不能只顾「画面装得下」，还得保证没有节点落到相机背后：
       单星位图的邻居环绕中心，贴太近时远侧那半圈会被 project() 判为不可见，
       连线和线上的百分比就都画不出来。 */
    function depthFloor (pose) {
      let minZ2 = 0
      const sy = Math.sin(pose.yaw)
      const cy = Math.cos(pose.yaw)
      const sp = Math.sin(pose.pitch)
      const cp = Math.cos(pose.pitch)
      for (const n of graph.nodes) {
        const x = n.x - pose.tx
        const y = n.y - pose.ty
        const z = n.z - pose.tz
        const z1 = x * sy + z * cy
        minZ2 = Math.min(minZ2, y * sp + z1 * cp)
      }
      return Math.max(MIN_DIST, NEAR + 60 - minZ2)
    }

    function fitPose () {
      let cx = 0; let cy = 0; let cz = 0
      for (const n of graph.nodes) { cx += n.x; cy += n.y; cz += n.z }
      const total = Math.max(1, graph.nodes.length)
      cx /= total; cy /= total; cz /= total
      const pose = { yaw: HOME.yaw, pitch: HOME.pitch, dist: HOME.dist, tx: cx, ty: cy, tz: cz }
      for (let i = 0; i < 10; i++) {
        const box = bboxOf(pose)
        if (!box) break
        const k = Math.min((view.w * 0.86) / Math.max(24, box.w), (view.h * 0.84) / Math.max(24, box.h))
        pose.dist = clamp(pose.dist / k, depthFloor(pose), MAX_DIST)
        const s = FOCAL / pose.dist
        const dxs = view.w / 2 - (box.x0 + box.x1) / 2
        const dys = view.h / 2 - (box.y0 + box.y1) / 2
        const cyw = Math.cos(pose.yaw)
        const syw = Math.sin(pose.yaw)
        const cpi = Math.cos(pose.pitch)
        const spi = Math.sin(pose.pitch)
        /* 相机右向量与上向量（世界坐标），把屏幕位移换算成平移量 */
        const rx = cyw; const rz = -syw
        const ux = -spi * syw; const uy = cpi; const uz = -spi * cyw
        const a = -dxs / s
        const b = dys / s
        pose.tx += rx * a + ux * b
        pose.ty += uy * b
        pose.tz += rz * a + uz * b
        if (Math.abs(k - 1) < 0.01 && Math.abs(dxs) < 2 && Math.abs(dys) < 2) break
      }
      return pose
    }

    let home = Object.assign({}, HOME)
    let needHome = true

    function collect () {
      order.length = 0
      for (const n of graph.nodes) {
        project(n, cam, view.w, view.h, proj)
        if (!proj.ok) continue
        order.push({ n: n, x: proj.x, y: proj.y, z: proj.z, s: proj.s })
      }
      order.sort((a, b) => b.z - a.z)
      return order
    }

    function drawDust () {
      ctx.globalCompositeOperation = 'lighter'
      ctx.fillStyle = '#cdd8ff'
      for (const d of dust) {
        project(d, cam, view.w, view.h, proj)
        if (!proj.ok) continue
        ctx.globalAlpha = d.a
        ctx.beginPath()
        ctx.arc(proj.x, proj.y, d.r, 0, TAU)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    function drawEdges (litSet) {
      const a = { ok: false, x: 0, y: 0, z: 0, s: 1 }
      const b = { ok: false, x: 0, y: 0, z: 0, s: 1 }
      ctx.globalCompositeOperation = 'lighter'
      for (const e of graph.edges) {
        const na = nodeById(e.from)
        const nb = nodeById(e.to)
        if (!na || !nb) continue
        /* 权重边默认不画：星图先讲结构，聚焦某颗星时再把它的相关度亮出来。
           否则项目一多，满屏都是百分比，反而看不出结构。 */
        const weightEdge = e.kind === 'weight'
        /* 单星位图里权重边就是主体，不聚焦也要画出来 */
        if (weightEdge && !litSet && graph.mode !== 'node') continue
        project(na, cam, view.w, view.h, a)
        project(nb, cam, view.w, view.h, b)
        if (!a.ok || !b.ok) continue
        const lit = litSet && (litSet.has(e.from) && litSet.has(e.to))
        const dimmed = litSet && !lit
        /* 深度归一到相机距离：目标平面附近为 1，越远越淡，但不至于看不见 */
        const depth = clamp(1.75 - 0.75 * (((a.z + b.z) / 2) / cam.dist), 0.34, 1)
        const alpha = (lit ? 0.9 : 0.34) * depth * (dimmed ? 0.3 : 1)
        ctx.globalAlpha = alpha
        ctx.strokeStyle = weightEdge ? '#7fe0cd' : (e.kind === 'dashed' ? '#ffcf6b' : '#9fb0ff')
        ctx.lineWidth = lit ? (weightEdge ? 1.4 : 1.7) : 1
        ctx.setLineDash(weightEdge ? [] : (e.kind === 'dashed' ? [5, 6] : []))
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }

    /* 连线上的相关度：只在两端都被点亮时画，压在星体之上、名字之下。
       位置取边中点并沿法线偏一点，避免正好压在线上看不清。 */
    function drawEdgeLabels (litSet, placed) {
      /* 单星位图：所有权重线都标百分比，不必先聚焦 */
      const showAll = graph.mode === 'node'
      if (!litSet && !showAll) return
      const a = { ok: false, x: 0, y: 0, z: 0, s: 1 }
      const b = { ok: false, x: 0, y: 0, z: 0, s: 1 }
      ctx.globalCompositeOperation = 'source-over'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = '600 10px "PingFang SC","Microsoft YaHei",system-ui,sans-serif'
      for (const e of graph.edges) {
        if (e.percent === undefined || e.percent === null) continue
        if (!showAll && (!litSet.has(e.from) || !litSet.has(e.to))) continue
        const na = nodeById(e.from)
        const nb = nodeById(e.to)
        if (!na || !nb) continue
        project(na, cam, view.w, view.h, a)
        project(nb, cam, view.w, view.h, b)
        if (!a.ok || !b.ok) continue
        const text = e.label || (e.percent + '%')
        const w = ctx.measureText(text).width + 11
        const h = 15
        let x = (a.x + b.x) / 2
        let y = (a.y + b.y) / 2
        const dx = b.x - a.x
        const dy = b.y - a.y
        const len = Math.hypot(dx, dy) || 1
        /* 中点若压在星体上，沿连线退到四分之一处再画 */
        const nearStar = (px, py) => order.some((item) => Math.hypot(item.x - px, item.y - py) < item.n.r * item.s * 1.15)
        if (nearStar(x, y)) {
          x = a.x + dx * 0.28
          y = a.y + dy * 0.28
        }
        x += (-dy / len) * 9
        y += (dx / len) * 9
        ctx.globalAlpha = 0.94
        ctx.beginPath()
        ctx.roundRect(x - w / 2, y - h / 2, w, h, 5)
        ctx.fillStyle = 'rgba(6,10,22,0.84)'
        ctx.fill()
        ctx.strokeStyle = 'rgba(127,224,205,0.42)'
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.fillStyle = '#dff7f1'
        ctx.fillText(text, x, y + 0.5)
        placed.push({ x: x - w / 2, y: y - h / 2, w: w, h: h })
        edgeLabelCount += 1
      }
      ctx.globalAlpha = 1
    }

    function labelOf (item, litSet) {
      const n = item.n
      const minor = n.kind === 'event' || n.kind === 'knowledge-item'
      const isFocus = focusId === n.id
      const isHover = hoverId === n.id
      if (minor && !isHover && !isFocus) return null
      if (litSet && litSet.size && !litSet.has(n.id) && !isFocus) return null
      if (item.s * n.r < 3.2) return null
      return n.label || ''
    }

    function draw () {
      const w = view.w
      const h = view.h
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      const litSet = hoverId ? neighbours(hoverId) : (focusId ? neighbours(focusId) : null)
      drawDust()
      drawEdges(litSet)

      const list = collect()
      ctx.globalCompositeOperation = 'lighter'
      for (const item of list) {
        const n = item.n
        const isLit = litSet && litSet.has(n.id)
        const dim = litSet && !isLit
        const twinkle = 1 + 0.055 * Math.sin(clock * 1.5 + (n.phase || 0))
        const size = clamp(2 * EXT * n.r * item.s * twinkle, 5, 720)
        const depth = clamp(1 - item.z / (cam.dist * 2.2), 0.34, 1)
        let alpha = 0.55 + 0.45 * depth
        if (dim) alpha *= 0.2
        if (focusId === n.id) alpha = 1

        ctx.globalAlpha = alpha
        ctx.drawImage(spriteFor(n), item.x - size / 2, item.y - size / 2, size, size)
      }
      ctx.globalAlpha = 1

      /* 聚焦环：贴着星体的一圈缓慢转动的虚线 */
      if (focusId) {
        const f = list.find((i) => i.n.id === focusId)
        if (f) {
          const rr = Math.max(16, f.n.r * f.s * 1.55)
          ctx.globalCompositeOperation = 'lighter'
          ctx.globalAlpha = 0.55
          ctx.strokeStyle = '#c0a0ff'
          ctx.lineWidth = 1.2
          ctx.setLineDash([4, 7])
          ctx.lineDashOffset = -clock * 9
          ctx.beginPath()
          ctx.arc(f.x, f.y, rr, 0, TAU)
          ctx.stroke()
          ctx.setLineDash([])
          ctx.globalAlpha = 1
        }
      }

      /* 连线上先写相关度（聚焦时才有），后面的星体名字会避开这些标签 */
      const placed = []
      edgeLabelCount = 0
      drawEdgeLabels(litSet, placed)

      /* 标签：先描深色边再填字，避免压在星芒上看不清；位置冲突时让位 */
      ctx.globalCompositeOperation = 'source-over'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.lineJoin = 'round'
      for (const item of list) {
        const text = labelOf(item, litSet)
        if (!text) continue
        const n = item.n
        const size = n.kind === 'event' || n.kind === 'knowledge-item' ? 10 : 13
        const dim = litSet && !litSet.has(n.id)
        ctx.font = (size === 13 ? '500 13px ' : '400 10px ') + '"PingFang SC","Microsoft YaHei",system-ui,sans-serif'
        const w = ctx.measureText(text).width + 8
        const above = item.y - Math.max(10, n.r * item.s) - 13
        const below = item.y + Math.max(10, n.r * item.s) + 13
        const important = focusId === n.id || hoverId === n.id
        const fits = (y) => !placed.some((r) => Math.abs(r.x - (item.x - w / 2)) < (r.w + w) / 2 - 2 && Math.abs(r.y - (y - 9)) < 20)
        /* 默认放星体上方；撞了改放下方；都撞就只保留当前高亮的那颗 */
        let y = above
        let box = { x: item.x - w / 2, y: y - 9, w: w, h: 18 }
        if (!important && !fits(above)) {
          if (fits(below)) { y = below; box = { x: item.x - w / 2, y: y - 9, w: w, h: 18 } }
          else continue
        }
        placed.push(box)
        ctx.globalAlpha = dim ? 0.2 : (important ? 1 : 0.88)
        ctx.strokeStyle = 'rgba(4,6,14,0.92)'
        ctx.lineWidth = 4
        ctx.strokeText(text, item.x, y)
        ctx.fillStyle = important ? '#ffffff' : '#dfe5ff'
        ctx.fillText(text, item.x, y)
      }
      ctx.globalAlpha = 1
    }

    function hitTest (clientX, clientY) {
      const rect = canvas.getBoundingClientRect()
      const mx = clientX - rect.left
      const my = clientY - rect.top
      let best = null
      let bestZ = Infinity
      for (const item of collect()) {
        const reach = Math.max(13, item.n.r * item.s * 1.45)
        const d = Math.hypot(item.x - mx, item.y - my)
        if (d <= reach && item.z < bestZ) { best = item; bestZ = item.z }
      }
      return best
    }

    function showTip (item, clientX, clientY) {
      if (!tip) return
      if (!item) { tip.classList.add('hidden'); return }
      if (!tipNodes) {
        tip.innerHTML = '<b></b><span></span><em></em>'
        tipNodes = [tip.children[0], tip.children[1], tip.children[2]]
      }
      const n = item.n
      const hint = n.record ? '点击飞到此处并预览记录' : n.info ? '点击飞到此处并查看档案' : '点击飞到此处'
      tipNodes[0].textContent = n.label || ''
      tipNodes[1].textContent = n.meta || ''
      tipNodes[2].textContent = hint
      const stage = canvas.parentElement.getBoundingClientRect()
      tip.style.left = clamp(clientX - stage.left + 14, 10, stage.width - 232) + 'px'
      tip.style.top = clamp(clientY - stage.top + 12, 10, stage.height - 82) + 'px'
      tip.classList.remove('hidden')
    }

    function startTween (to, dur) {
      tween = { from: Object.assign({}, cam), to: to, t0: performance.now(), dur: dur }
      kick()
    }

    function tick () {
      raf = 0
      if (!active) return
      const now = performance.now()
      clock = now / 1000
      if (tween) {
        const t = clamp((now - tween.t0) / tween.dur, 0, 1)
        const e = easeInOut(t)
        let dy = tween.to.yaw - tween.from.yaw
        dy = ((dy + Math.PI) % TAU + TAU) % TAU - Math.PI
        cam.yaw = tween.from.yaw + dy * e
        cam.pitch = tween.from.pitch + (tween.to.pitch - tween.from.pitch) * e
        cam.dist = tween.from.dist + (tween.to.dist - tween.from.dist) * e
        cam.tx = tween.from.tx + (tween.to.tx - tween.from.tx) * e
        cam.ty = tween.from.ty + (tween.to.ty - tween.from.ty) * e
        cam.tz = tween.from.tz + (tween.to.tz - tween.from.tz) * e
        if (t >= 1) tween = null
      }
      draw()
      raf = global.requestAnimationFrame(tick)
    }

    function kick () {
      if (!raf) raf = global.requestAnimationFrame(tick)
    }

    /* ---- 交互 ---- */

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      dragging = true
      dragMoved = 0
      lastX = e.clientX
      lastY = e.clientY
      tween = null
      canvas.setPointerCapture(e.pointerId)
      canvas.classList.add('grabbing')
    })

    canvas.addEventListener('pointermove', (e) => {
      if (dragging) {
        const dx = e.clientX - lastX
        const dy = e.clientY - lastY
        dragMoved += Math.abs(dx) + Math.abs(dy)
        cam.yaw -= dx * 0.0052
        cam.pitch = clamp(cam.pitch + dy * 0.0052, -1.18, 1.18)
        lastX = e.clientX
        lastY = e.clientY
        kick()
        return
      }
      const hit = hitTest(e.clientX, e.clientY)
      const id = hit ? hit.n.id : null
      if (id !== hoverId) {
        hoverId = id
        canvas.style.cursor = id ? 'pointer' : 'grab'
        kick()
      }
      showTip(hit, e.clientX, e.clientY)
    })

    function endDrag () {
      dragging = false
      canvas.classList.remove('grabbing')
    }

    canvas.addEventListener('pointerup', (e) => {
      const moved = dragMoved
      endDrag()
      if (moved > 6) return
      const hit = hitTest(e.clientX, e.clientY)
      if (!hit) return
      select(hit.n)
    })
    canvas.addEventListener('pointercancel', endDrag)
    canvas.addEventListener('pointerleave', () => {
      endDrag()
      hoverId = null
      showTip(null)
      kick()
    })

    /* 拉远到接近全景时解除聚焦：此时已能看见大半星图，
       再挂着「聚焦 xx」的徽标会名不副实 */
    function relaxFocus () {
      if (!focusId) return
      if (cam.dist < home.dist * 0.82) return
      focusId = null
      onFocusChange(null)
    }

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault()
      tween = null
      cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.0011), MIN_DIST, MAX_DIST)
      relaxFocus()
      kick()
    }, { passive: false })

    function select (node) {
      focusId = node.id
      /* 有相关度连线的星体不能贴太近：相机退到「最远邻居之外」，
         否则那颗邻居落到相机背后，连线和线上的百分比都画不出来。 */
      let reach = 0
      for (const edge of graph.edges) {
        if (edge.kind !== 'weight') continue
        if (edge.from !== node.id && edge.to !== node.id) continue
        const other = nodeById(edge.from === node.id ? edge.to : edge.from)
        if (!other) continue
        reach = Math.max(reach, Math.hypot(other.x - node.x, other.y - node.y, other.z - node.z))
      }
      const wanted = Math.max(MIN_DIST, FOCUS_DIST + node.r * 1.4,
        reach ? Math.min(MAX_DIST, reach + 220) : 0)
      startTween({
        yaw: cam.yaw,
        pitch: clamp(cam.pitch, -1.18, 1.18),
        dist: wanted,
        tx: node.x,
        ty: node.y,
        tz: node.z
      }, 720)
      onFocusChange(node)
      onSelect(node)
      kick()
    }

    const api = {
      setGraph (g) {
        graph = g || { nodes: [], edges: [], mode: 'concept' }
        /* 每颗星给一个固定相位，闪烁不同步，看起来才像星空 */
        for (const n of graph.nodes) {
          if (n.phase === undefined) {
            let h = 0
            for (let i = 0; i < String(n.id).length; i++) h = (h * 31 + String(n.id).charCodeAt(i)) % 628
            n.phase = h / 100
          }
        }
        focusId = null
        hoverId = null
        tween = null
        needHome = true
        resize()
        onFocusChange(null)
      },
      overview () {
        focusId = null
        hoverId = null
        startTween(Object.assign({}, home), 780)
        onFocusChange(null)
      },
      focus (id) {
        const n = nodeById(id)
        if (n) select(n)
      },
      zoom (factor) {
        tween = null
        cam.dist = clamp(cam.dist / factor, MIN_DIST, MAX_DIST)
        relaxFocus()
        kick()
      },
      resize: resize,
      start () { if (!active) { active = true; clock = performance.now() / 1000; kick() } },
      stop () { active = false; if (raf) { global.cancelAnimationFrame(raf); raf = 0 } },
      /* 每颗星当前投影到的屏幕坐标，供自检核对取景是否装得下 */
      nodesScreen () {
        return collect().map((i) => ({ id: i.n.id, x: i.x, y: i.y, rad: i.n.r * i.s, z: i.z }))
      },
      /* 只读观测口，供自检与调试读取相机/焦点状态 */
      inspect () {
        let focusScreen = null
        if (focusId) {
          const f = order.find((i) => i.n.id === focusId)
          if (f) focusScreen = { x: f.x, y: f.y }
        }
        return {
          yaw: cam.yaw,
          pitch: cam.pitch,
          dist: cam.dist,
          target: { x: cam.tx, y: cam.ty, z: cam.tz },
          home: { dist: home.dist, target: { x: home.tx, y: home.ty, z: home.tz } },
          focus: focusId,
          focusScreen: focusScreen,
          size: { w: view.w, h: view.h },
          nodes: graph.nodes.length,
          edges: graph.edges.length,
          weightEdges: graph.edges.filter((e) => e.kind === 'weight').length,
          edgeLabels: edgeLabelCount,
          mode: graph.mode,
          visible: order.length,
          frame: clock
        }
      }
    }

    const ro = new ResizeObserver(() => resize())
    ro.observe(canvas.parentElement)
    resize()
    return api
  }

  global.AstralStarMap = { create: create, HOME: HOME, FOCUS_DIST: FOCUS_DIST }
})(window)
