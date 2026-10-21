#!/usr/bin/env node
/**
 * cnki-cli — 知网检索与 PDF 下载命令行工具
 *
 * 零依赖：只用 Node 内置模块。Node 22+ 自带全局 WebSocket 与 fetch。
 * 驱动系统上已装的 Edge / Chrome（CDP 协议），不下载额外浏览器。
 *
 * 用法：
 *   node cnki.js search "日本文学" --limit 10
 *   node cnki.js download 1-3 --out D:\文献
 *   node cnki.js status
 *   node cnki.js login              # 打开浏览器让你手动登录
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, renameSync, rmSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

// ---------------- 常量 ----------------

const PORT = 9333
const HOME = path.join(os.homedir(), '.cnki-cli')
const PROFILE = path.join(HOME, 'profile')
const STATE = path.join(HOME, 'last-search.json')
const DEFAULT_OUT = path.join(process.cwd(), '知网下载')
/** 系统下载目录，setDownloadBehavior 不生效时的兜底位置。 */
const SYS_DL = path.join(os.homedir(), 'Downloads')

const SEARCH_URL = (kw, extra = '') =>
  `https://kns.cnki.net/kns8s/defaultresult/index?kw=${encodeURIComponent(kw)}&korder=SU${extra}`

// ---------------- 小工具 ----------------

function die(msg, code = 1) {
  process.stderr.write(msg + '\n')
  process.exit(code)
}

function clean(s, n = 90) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n)
}

function findBrowser() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const cands = [
    [pf86, 'Microsoft\\Edge\\Application\\msedge.exe'],
    [pf, 'Microsoft\\Edge\\Application\\msedge.exe'],
    [pf, 'Google\\Chrome\\Application\\chrome.exe'],
    [pf86, 'Google\\Chrome\\Application\\chrome.exe'],
    [process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'],
  ]
  for (const [base, rel] of cands) {
    if (!base) continue
    const p = path.join(base, rel)
    if (existsSync(p)) return p
  }
  return null
}

/** 解析 "1" / "3-5" / "0" / "1,4,7" 成 0 基序号数组。0 = 全部。 */
function parseRange(spec, total) {
  const s = String(spec || '').trim()
  if (!s) return [0]
  if (s === '0' || s === 'all') return [...Array(total).keys()]
  const out = new Set()
  for (const part of s.split(',')) {
    const m = part.trim().match(/^(\d+)\s*-\s*(\d+)$/)
    if (m) {
      const a = Math.max(1, +m[1])
      const b = Math.min(total, +m[2])
      for (let i = a; i <= b; i++) out.add(i - 1)
    } else if (/^\d+$/.test(part.trim())) {
      const i = +part.trim()
      if (i >= 1 && i <= total) out.add(i - 1)
    }
  }
  return [...out].sort((a, b) => a - b)
}

// ---------------- CDP 客户端 ----------------

class CDP {
  constructor(ws) {
    this.ws = ws
    this.n = 0
    this.pending = new Map()
    this.listeners = []
    ws.addEventListener('message', (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id)
        clearTimeout(timer)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`CDP ${msg.error.message}`))
        else resolve(msg.result)
      } else if (msg.method) {
        for (const fn of this.listeners) {
          try {
            fn(msg)
          } catch {}
        }
      }
    })
  }

  send(method, params = {}, sessionId) {
    const id = ++this.n
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时：${method}`))
        }
      }, 60000)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify(payload))
    })
  }

  on(fn) {
    this.listeners.push(fn)
  }

  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

// ---------------- 浏览器启动 / 连接 ----------------

async function portAlive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1200),
    })
    return r.ok
  } catch {
    return false
  }
}

async function ensureBrowser({ headless = false } = {}) {
  if (!(await portAlive(PORT))) {
    const exe = findBrowser()
    if (!exe) {
      die(
        '找不到 Edge 或 Chrome。\n' +
          '请先安装 Microsoft Edge，或用 --browser 指定可执行文件路径。',
      )
    }
    mkdirSync(PROFILE, { recursive: true })
    const args = [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=msEdgeFirstRunExperience,msImplicitSignin',
      '--disable-popup-blocking',
      'about:blank',
    ]
    if (headless) args.unshift('--headless=new')
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
    child.unref()

    for (let i = 0; i < 120; i++) {
      if (await portAlive(PORT)) break
      await sleep(150)
    }
    if (!(await portAlive(PORT))) die('浏览器已启动但调试端口没起来，请重试。')
  }

  let ver
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      ver = await r.json()
      break
    } catch {
      await sleep(200)
    }
  }
  if (!ver?.webSocketDebuggerUrl) die('拿不到浏览器调试地址。')

  const ws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('WebSocket 连接超时')), 15000)
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(t)
        res()
      },
      { once: true },
    )
    ws.addEventListener(
      'error',
      (e) => {
        clearTimeout(t)
        rej(new Error('WebSocket 连接失败'))
      },
      { once: true },
    )
  })
  return new CDP(ws)
}

async function newPage(cdp, url = 'about:blank') {
  const { targetId } = await cdp.send('Target.createTarget', { url })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Runtime.enable', {}, sessionId)
  return { targetId, sessionId }
}

// ---------------- 页面操作 ----------------

/**
 * 在页面里跑脚本。
 * 统一把返回值 JSON.stringify 后带回，避免对象序列化丢失。
 */
async function evalJs(cdp, sessionId, fnSrc, arg) {
  const argStr = arg === undefined ? '' : JSON.stringify(arg)
  const expr =
    `(() => { try { const r = (${fnSrc})(${argStr}); ` +
    `return JSON.stringify({ ok: 1, v: r === undefined ? null : r }) } ` +
    `catch (e) { return JSON.stringify({ ok: 0, e: String((e && e.message) || e) }) } })()`
  const res = await cdp.send(
    'Runtime.evaluate',
    { expression: expr, returnByValue: true, awaitPromise: true },
    sessionId,
  )
  if (res.exceptionDetails) {
    throw new Error('页面脚本异常：' + (res.exceptionDetails.text || '').slice(0, 160))
  }
  const raw = res.result?.value
  if (typeof raw !== 'string') return raw ?? null
  let j
  try {
    j = JSON.parse(raw)
  } catch {
    return raw
  }
  if (j.ok === 0) throw new Error('页面脚本抛错：' + j.e)
  return j.v
}

async function goto(cdp, sessionId, url, waitMs = 3500) {
  await cdp.send('Page.navigate', { url }, sessionId)
  await sleep(waitMs)
}

/** 验证码探测。返回描述字符串或 null。 */
const CAPTCHA_JS = `() => {
  const tip = [...document.querySelectorAll('div,span,p')]
    .map(e => (e.innerText || '').trim())
    .find(t => /请依次点击|向右滑动|拖动下方/.test(t) && t.length < 90)
  if (tip && !/验证成功/.test(tip)) return String(tip).slice(0, 60)
  if (document.querySelector('#tCaptchaDyMainWrap')) return '腾讯滑块'
  if (document.querySelector('.verifybox')) return 'kns 滑块'
  return null
}`

/**
 * 若出现验证码，提示用户在可见窗口里手动通过，然后轮询等待。
 * 超时返回 false。
 */
async function handleCaptcha(cdp, sessionId, timeoutSec = 180) {
  let tip
  try {
    tip = await evalJs(cdp, sessionId, CAPTCHA_JS)
  } catch {
    return true
  }
  if (!tip) return true

  process.stderr.write(`\n[验证码] 出现「${tip}」\n`)
  process.stderr.write(`        请在浏览器窗口里手动完成，最长等待 ${timeoutSec} 秒…\n`)

  const t0 = Date.now()
  while (Date.now() - t0 < timeoutSec * 1000) {
    await sleep(2000)
    try {
      const still = await evalJs(cdp, sessionId, CAPTCHA_JS)
      if (!still) {
        process.stderr.write('[验证码] 已通过\n')
        return true
      }
    } catch {
      return true
    }
  }
  return false
}

// ---------------- 检索 ----------------

const EXTRACT_JS = `() => {
  const rows = [...document.querySelectorAll('table.result-table-list tbody tr')]
  const out = []
  for (const tr of rows) {
    const a = tr.querySelector('td.name a') || tr.querySelector('a.fz14') || tr.querySelector('a')
    if (!a) continue
    const title = (a.innerText || '').trim()
    if (!title) continue
    const tds = [...tr.querySelectorAll('td')].map(td => (td.innerText || '').trim())
    const author = tds.find(x => /[;；]/.test(x) && x.length < 80) || ''
    const date = tds.find(x => /^\\d{4}-\\d{2}-\\d{2}$/.test(x)) || ''
    out.push({ title, href: a.href, author, date })
  }
  return out
}`

async function doSearch(cdp, keyword, limit) {
  const { sessionId } = await newPage(cdp)
  await goto(cdp, sessionId, SEARCH_URL(keyword), 4500)
  if (!(await handleCaptcha(cdp, sessionId))) {
    throw new Error('验证码未在限时内通过')
  }
  // 等结果行出现
  for (let i = 0; i < 30; i++) {
    const n = await evalJs(
      cdp,
      sessionId,
      `() => document.querySelectorAll('table.result-table-list tbody tr').length`,
    )
    if (n > 0) break
    await sleep(800)
  }
  let rows = await evalJs(cdp, sessionId, EXTRACT_JS)
  if (!Array.isArray(rows)) rows = []
  return { rows: rows.slice(0, limit), sessionId }
}

// ---------------- 下载 ----------------

const PDF_HREF_JS = `() => {
  const as = [...document.querySelectorAll('a')]
    .filter(x => /^(PDF下载|PDF 下载)$/.test(((x.innerText || '').trim())))
  const vis = as.filter(a => a.offsetParent)
  return vis.length ? vis[0].href : null
}`

const IFRAME_JS = `(href) => {
  document.querySelectorAll('iframe[data-cnki-dl]').forEach(f => f.remove())
  const f = document.createElement('iframe')
  f.setAttribute('data-cnki-dl', '1')
  f.style.display = 'none'
  f.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-downloads')
  f.src = href
  document.body.appendChild(f)
  return { ok: 1 }
}`

function snapshotDir(dir) {
  const m = {}
  try {
    for (const f of readdirSync(dir)) {
      try {
        m[f] = statSync(path.join(dir, f)).size
      } catch {}
    }
  } catch {}
  return m
}

/**
 * 等目录里出现新文件且写完。
 * Windows 上 Chromium 先写 <guid>.tmp 再改名，所以 .tmp 也要接受，
 * 用「大小稳定 + %PDF 文件头」判定完成。
 */
async function waitNewFile(dir, before, timeoutSec = 120) {
  const t0 = Date.now()
  let cand = null
  let last = -1
  while (Date.now() - t0 < timeoutSec * 1000) {
    await sleep(1500)
    const cur = snapshotDir(dir)
    const fresh = Object.keys(cur).filter(
      (f) => !(f in before) && !/\.(part|crdownload)$/i.test(f) && !f.startsWith('Unconfirmed'),
    )
    if (!fresh.length) continue
    fresh.sort(
      (a, b) =>
        statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs,
    )
    cand = fresh[0]
    const sz = cur[cand] ?? 0
    if (sz > 0 && sz === last) {
      const full = path.join(dir, cand)
      try {
        const head = readFileSync(full).subarray(0, 4).toString('latin1')
        if (head === '%PDF') return full
      } catch {}
    }
    last = sz
  }
  return cand ? path.join(dir, cand) : null
}

/**
 * 让浏览器把下载文件直接放到指定目录。
 * 不做这一步，文件会落到系统「下载」目录，目标目录永远等不到新文件。
 */
async function setDownloadDir(cdp, dir) {
  mkdirSync(dir, { recursive: true })
  try {
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: dir,
      eventsEnabled: true,
    })
  } catch {
    // 老版本 Chromium 只认 Page 级
    try {
      await cdp.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: dir,
      })
    } catch {}
  }
}

async function downloadOne(cdp, item, outDir, idx) {
  const { sessionId } = await newPage(cdp, item.href)
  await sleep(4200)

  if (!(await handleCaptcha(cdp, sessionId))) {
    return { ok: false, reason: '验证码未通过' }
  }

  let href = null
  for (let i = 0; i < 12; i++) {
    href = await evalJs(cdp, sessionId, PDF_HREF_JS)
    if (href) break
    await sleep(900)
  }
  if (!href) return { ok: false, reason: '无 PDF 下载按钮（多为该刊未授权）' }

  const before = snapshotDir(outDir)
  const beforeSys = snapshotDir(SYS_DL)
  await evalJs(cdp, sessionId, IFRAME_JS, href)

  // 主看目标目录；有些环境不认 setDownloadBehavior，退回系统下载目录
  let got = await waitNewFile(outDir, before, 90)
  if (!got) got = await waitNewFile(SYS_DL, beforeSys, 45)
  if (!got) return { ok: false, reason: '触发后目录无新文件（未授权或收录空缺）' }

  const size = statSync(got).size
  if (size < 1024) {
    try {
      rmSync(got)
    } catch {}
    return { ok: false, reason: `文件异常（${size} B）` }
  }

  const want = `${clean(item.title)}${item.author ? '_' + clean(item.author, 40) : ''}.pdf`
  let dest = path.join(outDir, want)
  if (existsSync(dest)) {
    const base = dest.replace(/\.pdf$/i, '')
    let n = 1
    while (existsSync(`${base}_${n}.pdf`)) n++
    dest = `${base}_${n}.pdf`
  }
  try {
    renameSync(got, dest)
  } catch {
    // 跨盘符 rename 会失败，退回复制
    try {
      copyFileSync(got, dest)
      try {
        rmSync(got)
      } catch {}
    } catch {
      dest = got
    }
  }
  return { ok: true, path: dest, size }
}

// ---------------- 命令 ----------------

async function cmdSearch(args) {
  const kw = args._[0]
  if (!kw) die('用法：cnki search <关键词> [--limit N]')
  const limit = Number(args.limit || 20)
  const cdp = await ensureBrowser()
  try {
    const { rows } = await doSearch(cdp, kw, limit)
    if (!rows.length) {
      console.log(`检索「${kw}」：0 条（可能被验证码或反爬拦下，试 cnki login）`)
      return
    }
    if (args.json) {
      console.log(JSON.stringify(rows, null, 2))
    } else {
      console.log(`检索「${kw}」：${rows.length} 条\n`)
      rows.forEach((r, i) => {
        console.log(`${i + 1}. ${r.title}`)
        console.log(`   ${r.author || '-'} | ${r.date || '-'}`)
      })
    }
    mkdirSync(HOME, { recursive: true })
    writeFileSync(STATE, JSON.stringify(rows, null, 2), 'utf8')
  } finally {
    cdp.close()
  }
}

async function cmdDownload(args) {
  let rows = []
  try {
    rows = JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    die('没有上次检索结果。先跑 cnki search "<关键词>"。')
  }
  if (!Array.isArray(rows) || !rows.length) die('上次检索结果为空，重新 search。')

  const picks = parseRange(args._[0] || '1', rows.length)
  if (!picks.length) die(`序号超出范围（共 ${rows.length} 条）`)

  const outDir = path.resolve(args.out || DEFAULT_OUT)
  mkdirSync(outDir, { recursive: true })

  const cdp = await ensureBrowser()
  await setDownloadDir(cdp, outDir)
  let ok = 0
  console.log(`下载 ${picks.length} 篇 → ${outDir}\n`)
  try {
    for (let k = 0; k < picks.length; k++) {
      const item = rows[picks[k]]
      console.log(`[${k + 1}/${picks.length}] ${item.title.slice(0, 50)}`)
      const r = await downloadOne(cdp, item, outDir, k)
      if (r.ok) {
        ok++
        console.log(`    ✔ ${Math.round(r.size / 1024)} KB → ${path.basename(r.path)}`)
      } else {
        console.log(`    ✘ ${r.reason}`)
      }
      if (k < picks.length - 1) await sleep(8000)
    }
  } finally {
    cdp.close()
  }
  console.log(`\n完成：成功 ${ok}/${picks.length}`)
  process.exitCode = ok > 0 ? 0 : 2
}

async function cmdStatus() {
  const exe = findBrowser()
  console.log('运行时：Node ' + process.version)
  console.log('浏览器：' + (exe || '❌ 未找到 Edge / Chrome'))
  console.log('用户数据：' + PROFILE)
  console.log('下载目录：' + DEFAULT_OUT)

  if (!exe) return

  const cdp = await ensureBrowser()
  try {
    const { sessionId } = await newPage(cdp)
    await goto(cdp, sessionId, 'https://kns.cnki.net/kns8s/defaultresult/index?kw=test', 4500)
    const st = await evalJs(
      cdp,
      sessionId,
      `() => {
        const b = (document.body && document.body.innerText) || ''
        return {
          head: b.slice(0, 100).replace(/\\s+/g, ' ').trim(),
          rows: document.querySelectorAll('table.result-table-list tbody tr').length,
          captcha: !!(document.querySelector('.verifybox') || document.querySelector('#tCaptchaDyMainWrap')),
        }
      }`,
    )
    console.log('\n知网：' + (st?.captcha ? '⚠ 当前出现验证码' : '✔ 无验证码'))
    console.log('结果行数：' + (st?.rows ?? 0))
    console.log('页面首行：' + (st?.head || '-'))
  } catch (e) {
    console.log('\n页面探测失败：' + String(e.message || e).slice(0, 120))
  } finally {
    cdp.close()
  }
}

async function cmdLogin() {
  const cdp = await ensureBrowser()
  const { sessionId } = await newPage(cdp, 'https://kns.cnki.net/')
  console.log('已打开知网首页。请在浏览器窗口里完成登录（机构登录或账号登录）。')
  console.log('登录状态会保存在：' + PROFILE)
  console.log('完成后直接关掉窗口即可建，下次 search / download 会复用。')
  // 保持连接一小会儿，让用户看到窗口
  await sleep(3000)
  cdp.close()
}

// ---------------- 入口 ----------------

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        out[key] = next
        i++
      } else {
        out[key] = true
      }
    } else {
      out._.push(a)
    }
  }
  return out
}

async function main() {
  const argv = process.argv.slice(3)
  const cmd = process.argv[2]
  const args = parseArgs(argv)

  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(`cnki-cli — 知网检索与 PDF 下载

用法：
  cnki search <关键词> [--limit N] [--json]
  cnki download <序号> [--out 目录]
  cnki status
  cnki login

序号写法：
  1        第 1 篇
  3-5      第 3 到第 5 篇
  1,4,7    第 1、4、7 篇
  0        全部（受 --limit 与合规上限约束）

示例：
  cnki search "日本文学" --limit 10
  cnki download 3
  cnki download 1-5 --out D:\\文献

注意：首次运行需要手动过一次验证码并登录（cnki login），之后复用同一浏览器资料。`)
    return
  }

  if (cmd === 'search') return cmdSearch(args)
  if (cmd === 'download') return cmdDownload(args)
  if (cmd === 'status') return cmdStatus(args)
  if (cmd === 'login') return cmdLogin(args)
  die(`未知命令：${cmd}。用 cnki --help 看用法。`)
}

main().catch((e) => {
  die('出错了：' + String(e?.message || e))
})
