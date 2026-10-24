import Schema from '@deepseek-ai/schemastery'
import { mkdir, readFile, readdir, rename, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { runVerification, verdictText, VERDICT_TEXT } from './verify-core.mjs'
import { lookupOfficialPrices, listPricedModels } from './protocol-scripts.mjs'

const PKG_VERSION = (() => {
  try {
    const here = import.meta.url
    const pkgUrl = new URL('../package.json', here)
    return JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()
import { renderHtml, renderMarkdown } from './render.mjs'

export const name = 'kimi-signature-workbench'
export const inject = ['connection']

export const Config = Schema.object({
  root: Schema.string().required(),
})

const API = '/api/kimi-signature-workbench/'
const REPORT_KEEP = 60

function reportId() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `${stamp}-${Math.random().toString(16).slice(2, 6)}`
}

const safeId = (id) => typeof id === 'string' && /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/.test(id)

/** 只落盘可公开的报告内容：校验项与指纹，绝不含 key。 */
function toRecord(rs) {
  return {
    verdict: rs.verdict,
    insufficientReason: rs.insufficientReason || '',
    checks: rs.checks,
    meta: rs.meta,
  }
}

export function apply(ctx, config) {
  const root = config.root
  const reportsDir = join(root, 'reports')
  const keysPath = join(root, 'keys.json')

  const route = (path, methods, handler) =>
    ctx.connection.fetch.register({
      path: API + path,
      methods,
      requestBody: 'buffered',
      async fetch(req) {
        try {
          return await handler(req)
        } catch (e) {
          return Response.json(
            { error: e && e.message ? e.message : String(e) },
            { status: 400, headers: { 'cache-control': 'no-store' } },
          )
        }
      },
    })

  const noStore = { 'cache-control': 'no-store' }

  route('health', ['GET'], async () =>
    Response.json({ ok: true, workbench: name, version: PKG_VERSION }, { headers: noStore }))

  // ---- 可选记住 key（用户显式勾选后启用） ----
  // 存储在本机 profile 数据目录 keys.json，权限 0600，原子写入。
  // 明确边界：明文存储；能接触到本机或其备份的人即可读取。报告与日志永不包含 key。
  route('keys', ['GET', 'POST', 'DELETE'], async (req) => {
    if (req.method === 'GET') {
      try {
        const j = JSON.parse(await readFile(keysPath, 'utf8'))
        return Response.json({
          saved: true,
          providerKey: typeof j.providerKey === 'string' ? j.providerKey : '',
          officialKey: typeof j.officialKey === 'string' ? j.officialKey : '',
          savedAt: j.savedAt || null,
        }, { headers: noStore })
      } catch {
        return Response.json({ saved: false, providerKey: '', officialKey: '', savedAt: null }, { headers: noStore })
      }
    }
    if (req.method === 'DELETE') {
      try {
        const { unlink } = await import('node:fs/promises')
        await unlink(keysPath)
      } catch { /* 文件不存在视为已清除 */ }
      return Response.json({ saved: false }, { headers: noStore })
    }
    // POST：覆盖式保存
    const body = await req.json()
    const providerKey = String(body.providerKey || '')
    const officialKey = String(body.officialKey || '')
    if (!providerKey && !officialKey) {
      return Response.json({ error: '至少需要一把 key 才能保存' }, { status: 400, headers: noStore })
    }
    const savedAt = new Date().toISOString()
    await mkdir(root, { recursive: true })
    const tmp = `${keysPath}.tmp`
    await writeFile(tmp, `${JSON.stringify({ providerKey, officialKey, savedAt }, null, 2)}\n`, 'utf8', { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, keysPath)
    return Response.json({ saved: true, savedAt }, { headers: noStore })
  })

  // 按官方 Base URL + 模型名查询官方单价（面板自动填价用）
  route('price-lookup', ['GET'], async (req) => {
    const url = new URL(req.url)
    const base = url.searchParams.get('base') || ''
    const model = url.searchParams.get('model') || ''
    const ref = lookupOfficialPrices(base, model)
    if (!ref) {
      return Response.json({ found: false, note: '官方 Base URL 不在已收录的五家（Kimi/DeepSeek/智谱/MiniMax/百炼）之列' }, { headers: noStore })
    }
    const p = ref.resolve({ prompt_tokens: 0 })
    return Response.json({
      found: true,
      label: ref.label,
      source: ref.source,
      note: ref.note,
      modelKey: ref.modelKey,
      in: p.in,
      out: p.out,
      cached: p.cached ?? null,
      cacheWrite: p.cacheWrite ?? null,        // 5min TTL 档（官方默认）
      cacheWrite1h: p.cacheWrite1h ?? null,   // 1h TTL 档（K3 系列，1h=2×5m）
      thinkOut: p.thinkOut ?? null,
    }, { headers: noStore })
  })

  // 列出官方 Base URL 下已收录的可选型号（计价模型选择器）
  route('price-models', ['GET'], async (req) => {
    const url = new URL(req.url)
    const base = url.searchParams.get('base') || ''
    const r = listPricedModels(base)
    if (!r) {
      return Response.json({ found: false, note: '该官方 Base URL 不在已收录的五家之列；可直接在「协议测试模型」填任意型号' }, { headers: noStore })
    }
    return Response.json({ found: true, vendor: r.vendor, models: r.models }, { headers: noStore })
  })

  // 会话同步：把报告写进会话工作区，让对话 Agent 能读到（工作台数据目录会话不可见）
  route('sync-report', ['POST'], async (req) => {
    const body = await req.json()
    const sessionId = String(body.sessionId || '').trim()
    const reportId = String(body.reportId || '').trim()
    if (!sessionId) return Response.json({ error: '缺少 sessionId' }, { status: 400, headers: noStore })

    // 会话工作区定位：读 harness 注册表（storages/workspace.json）找该会话的 folder
    const { getWorkspaceFolder } = await import('./session-store.mjs')
    const dshHome = process.env.DSH_HOME
      || (typeof config === 'object' && config.dshHome)
      || null
    const folder = await getWorkspaceFolder(sessionId, dshHome)
    if (!folder) {
      return Response.json({ error: `未找到会话 ${sessionId} 的工作区（可能会话已关闭）` }, { status: 404, headers: noStore })
    }
    const workspaceDir = join(folder, 'reports')
    await mkdir(workspaceDir, { recursive: true })

    // 找报告：指定 id 或最新
    let id = reportId
    if (!id) {
      const files = (await readdir(reportsDir).catch(() => [])).filter((f) => f.endsWith('.json')).sort()
      if (!files.length) return Response.json({ error: '还没有任何报告，先跑一次校验' }, { status: 404, headers: noStore })
      id = files[files.length - 1].replace(/\.json$/, '')
    }
    let stored
    try {
      stored = JSON.parse(await readFile(join(reportsDir, `${id}.json`), 'utf8'))
    } catch {
      return Response.json({ error: `报告 ${id} 不存在` }, { status: 404, headers: noStore })
    }
    const rs = { verdict: stored.verdict, insufficientReason: stored.insufficientReason, checks: stored.checks, meta: stored.meta }
    const md = renderMarkdown(rs)
    const filename = `kimi-report-${id}.md`
    await writeFile(join(workspaceDir, filename), md, 'utf8')
    return Response.json({
      synced: true,
      reportId: id,
      filename,
      markdown: md,
      markdownHead: md.slice(0, 4000),
    }, { headers: noStore })
  })

  route('verify', ['POST'], async (req) => {
    const body = await req.json()
    const providerBase = String(body.providerBase || '').trim()
    const providerKey = String(body.providerKey || '').trim()
    const model = String(body.model || '').trim()
    const officialKey = String(body.officialKey || '').trim()
    const timeout = Number(body.timeout) || 30

    if (!providerBase || !providerKey || !model) {
      return Response.json({ error: '第三方端点、第三方 key、模型 ID 三项必填' }, { status: 400, headers: noStore })
    }
    if (!/^https?:\/\//i.test(providerBase)) {
      return Response.json({ error: '第三方端点需要以 http:// 或 https:// 开头' }, { status: 400, headers: noStore })
    }
    if (timeout < 5 || timeout > 120) {
      return Response.json({ error: '超时需在 5–120 秒之间' }, { status: 400, headers: noStore })
    }

    const rs = await runVerification({
      providerBase,
      providerKey,
      model,
      protocolModel: String(body.protocolModel || '').trim() || model,
      officialProtocolModel: String(body.officialProtocolModel || '').trim(),
      officialKey,
      officialBase: String(body.officialBase || '').trim() || undefined,
      mode: body.mode === 'infer' ? 'infer' : 'relay',
      // 单价优先级：未手改（priceAuto）→ 官方 resolve（含写价/思考价/分档）；
      // 手改（customPrices）→ 平铺单价。二者都不传则 verify-core 自查表。
      customPrices: (() => {
        const pa = body.priceAuto
        if (pa && typeof pa === 'object' && pa.base && pa.model) {
          const ref = lookupOfficialPrices(String(pa.base), String(pa.model))
          if (ref) return { __autoRef: ref }
        }
        const cp = body.customPrices
        if (!cp || typeof cp !== 'object') return undefined
        const inP = Number(cp.in), outP = Number(cp.out), cachedP = Number(cp.cached)
        if (!(inP > 0) || !(outP > 0)) return undefined
        const w5 = Number(cp.cacheWrite), w1 = Number(cp.cacheWrite1h)
        return {
          label: '面板自填单价', in: inP, out: outP, cached: cachedP > 0 ? cachedP : inP,
          cacheWrite: w5 > 0 ? w5 : undefined, cacheWrite1h: w1 > 0 ? w1 : undefined,
        }
      })(),
      timeout,
    })

    // 落盘（无密钥），失败不影响本次结果
    const id = reportId()
    let saved = false
    try {
      await mkdir(reportsDir, { recursive: true })
      await writeFile(join(reportsDir, `${id}.json`), JSON.stringify({ id, createdAt: rs.meta.startedAt, ...toRecord(rs) }), 'utf8')
      saved = true
      const files = (await readdir(reportsDir)).filter((f) => f.endsWith('.json')).sort()
      for (const old of files.slice(0, Math.max(0, files.length - REPORT_KEEP))) {
        try {
          const { unlink } = await import('node:fs/promises')
          await unlink(join(reportsDir, old))
        } catch { /* 忽略清理失败 */ }
      }
    } catch {
      saved = false
    }

    const [head, text] = verdictText(rs)
    return Response.json({
      reportId: id,
      saved,
      verdict: rs.verdict,
      verdictTitle: head,
      verdictText: text,
      checks: rs.checks,
      meta: rs.meta,
    }, { headers: noStore })
  })

  route('reports', ['GET'], async () => {
    let files = []
    try {
      files = (await readdir(reportsDir)).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, 20)
    } catch {
      files = []
    }
    const items = []
    for (const f of files) {
      try {
        const j = JSON.parse(await readFile(join(reportsDir, f), 'utf8'))
        items.push({
          id: j.id,
          createdAt: j.createdAt,
          verdict: j.verdict,
          verdictTitle: (VERDICT_TEXT[j.verdict] || ['', ''])[0],
          providerBase: j.meta?.providerBase,
          model: j.meta?.model,
        })
      } catch { /* 跳过损坏文件 */ }
    }
    return Response.json({ items }, { headers: noStore })
  })

  route('report', ['GET'], async (req) => {
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    const format = url.searchParams.get('format') || 'json'
    if (!safeId(id)) return Response.json({ error: '报告 ID 非法' }, { status: 400, headers: noStore })

    let stored
    try {
      stored = JSON.parse(await readFile(join(reportsDir, `${id}.json`), 'utf8'))
    } catch {
      return Response.json({ error: '报告不存在或已过期' }, { status: 404, headers: noStore })
    }

    const rs = { verdict: stored.verdict, insufficientReason: stored.insufficientReason, checks: stored.checks, meta: stored.meta }
    const filename = `kimi-verify-${id}`

    if (format === 'md') {
      return new Response(renderMarkdown(rs), {
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}.md"`,
          ...noStore,
        },
      })
    }
    if (format === 'html') {
      return new Response(renderHtml(rs), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}.html"`,
          ...noStore,
        },
      })
    }
    return Response.json(rs, { headers: noStore })
  })
}