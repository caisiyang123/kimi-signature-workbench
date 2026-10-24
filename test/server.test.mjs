import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* ---------------------------------------------------------------------------
 * 本机没有宿主依赖 @deepseek-ai/schemastery（profile 里的符号链接已失效），
 * 因此测试前生成一个最小桩件，让服务端入口能被真实 import 并执行 apply()。
 * 桩件只提供 Schema.object / Schema.string().required()，不做校验——
 * 目的是验证路由、存储与响应，不验证 Schemastery 本身。
 * 该目录不进 files 白名单，不会被 pnpm pack 打进产物。
 * ------------------------------------------------------------------------- */
const stubDir = new URL('../node_modules/@deepseek-ai/schemastery/', import.meta.url)
mkdirSync(stubDir, { recursive: true })
writeFileSync(new URL('package.json', stubDir), JSON.stringify({
  name: '@deepseek-ai/schemastery', version: '0.0.0-local-stub', type: 'module', main: 'index.js',
}))
writeFileSync(new URL('index.js', stubDir), `
const string = () => { const d = { type: 'string' }; d.required = () => ({ ...d, required: true }); return d }
const object = (dict) => ({ type: 'object', dict })
export default { string, object }
`)

const OFFICIAL = 'https://api.moonshot.cn/v1'
const PKEY = 'sk-provider-SECRET-9f3a'
const OKEY = 'sk-official-SECRET-7d21'
const MODEL = 'kimi-k2.7-code-highspeed'
const NOW = 1792800000000

function res(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    status,
    headers: { forEach(cb) { for (const [k, v] of Object.entries(headers)) cb(v, k) } },
    async text() { return text },
  }
}

function mockFetch() {
  return async (url, init = {}) => {
    const u = new URL(url)
    const headers = init.headers || {}
    const body = init.body ? JSON.parse(init.body) : null
    if (u.pathname.endsWith('/models')) {
      const isOfficial = url.startsWith('https://api.moonshot.cn') || url.startsWith('https://api.moonshot.ai')
      if (isOfficial) return res(200, { data: [{ id: 'kimi-k2.7-code' }] })
      return res(200, { data: [{ id: MODEL }] })
    }
    if (u.pathname.endsWith('/signatures/verify')) return res(200, { valid: true })
    if (u.pathname.endsWith('/chat/completions')) {
      if (body && body.stream) return res(200, 'data: {"choices":[]}\n\n')
      const signed = headers['X-Msh-Request-Nonce']
      return res(200, {
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
      }, signed ? {
        'Msh-Request-Timestamp': String(NOW),
        'Msh-Request-Signature': 'reqsigv1_' + 'y'.repeat(64),
      } : {})
    }
    return res(404, { error: { message: 'unexpected' } })
  }
}

async function boot({ withSessionHome } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ksv-test-'))
  let fakeHome = null
  if (withSessionHome) {
    // 构造 harness storages/workspace.json：会话 session-test-1 -> root 本身
    fakeHome = mkdtempSync(join(tmpdir(), 'ksv-home-'))
    mkdirSync(join(fakeHome, 'storages'), { recursive: true })
    writeFileSync(join(fakeHome, 'storages', 'workspace.json'), JSON.stringify({
      tables: { workspaces: { 'ws-1': { path: root, sessionIds: ['session-test-1'] } } },
    }))
    process.env.DSH_HOME = fakeHome
  }
  const routes = new Map()
  const mod = await import('../dsh/index.js')
  const ctx = {
    connection: {
      fetch: {
        register(def) {
          routes.set(def.path, def)
          return () => routes.delete(def.path)
        },
      },
    },
  }
  mod.apply(ctx, { root })
  const call = async (name, { method = 'GET', query = '', body } = {}) => {
    const def = routes.get(`/api/kimi-signature-workbench/${name}`)
    assert.ok(def, `未注册路由 ${name}`)
    const url = `http://localhost/api/kimi-signature-workbench/${name}${query}`
    const req = new Request(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return def.fetch(req)
  }
  return { root, call, routes, mod }
}

test('服务端注册了全部接口', async () => {
  const { routes } = await boot()
  for (const name of ['health', 'verify', 'reports', 'report']) {
    assert.ok(routes.has(`/api/kimi-signature-workbench/${name}`), `缺少 ${name}`)
  }
  const paths = [...routes.keys()]
  assert.ok(paths.every((p) => p.startsWith('/api/kimi-signature-workbench/')), '接口必须在自己路径前缀下')
})

test('health 返回工作台标识', async () => {
  const { call } = await boot()
  const r = await call('health')
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.ok, true)
  assert.equal(j.workbench, 'kimi-signature-workbench')
})

test('verify 全链路：出结论、写报告、响应里不含密钥', async () => {
  const { call, root } = await boot()
  const realFetch = globalThis.fetch
  globalThis.fetch = mockFetch()
  try {
    const r = await call('verify', {
      method: 'POST',
      body: { providerBase: 'https://maas.example.com/v1', providerKey: PKEY, model: MODEL, officialKey: OKEY, timeout: 10 },
    })
    assert.equal(r.status, 200)
    const j = await r.json()
    assert.equal(j.verdict, 'VERIFIED_OFFICIAL')
    assert.equal(j.saved, true)
    assert.match(j.reportId, /^\d{8}-\d{6}-[0-9a-f]{4}$/)
    assert.equal(j.checks.length >= 10, true)

    const raw = JSON.stringify(j)
    assert.ok(!raw.includes(PKEY), '响应不得包含第三方 key')
    assert.ok(!raw.includes(OKEY), '响应不得包含官方 key')

    const stored = readFileSync(join(root, 'reports', `${j.reportId}.json`), 'utf8')
    assert.ok(!stored.includes(PKEY), '落盘报告不得包含第三方 key')
    assert.ok(!stored.includes(OKEY), '落盘报告不得包含官方 key')
    assert.ok(stored.includes('sha256:'), '落盘报告应保留指纹')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('verify 参数校验：必填、协议前缀、超时范围', async () => {
  const { call } = await boot()
  const cases = [
    { body: { providerBase: '', providerKey: PKEY, model: MODEL }, match: /三项必填/ },
    { body: { providerBase: 'maas.example.com/v1', providerKey: PKEY, model: MODEL }, match: /http/ },
    { body: { providerBase: 'https://x/v1', providerKey: PKEY, model: MODEL, timeout: 999 }, match: /5–120/ },
  ]
  for (const c of cases) {
    const r = await call('verify', { method: 'POST', body: c.body })
    assert.equal(r.status, 400)
    assert.match((await r.json()).error, c.match)
  }
})

test('reports 列出已存报告；report 可下载 md / html / json', async () => {
  const { call } = await boot()
  const realFetch = globalThis.fetch
  globalThis.fetch = mockFetch()
  let id
  try {
    const v = await (await call('verify', {
      method: 'POST',
      body: { providerBase: 'https://maas.example.com/v1', providerKey: PKEY, model: MODEL, officialKey: OKEY },
    })).json()
    id = v.reportId
  } finally {
    globalThis.fetch = realFetch
  }

  const list = await (await call('reports')).json()
  assert.equal(list.items.length, 1)
  assert.equal(list.items[0].id, id)
  assert.equal(list.items[0].verdict, 'VERIFIED_OFFICIAL')

  const md = await call('report', { query: `?id=${id}&format=md` })
  assert.equal(md.status, 200)
  assert.match(md.headers.get('content-type'), /text\/markdown/)
  assert.match(md.headers.get('content-disposition'), /attachment/)
  const mdText = await md.text()
  assert.match(mdText, /Kimi 请求签名验证报告/)
  assert.ok(!mdText.includes(PKEY) && !mdText.includes(OKEY), '下载的 Markdown 不得含密钥')

  const html = await call('report', { query: `?id=${id}&format=html` })
  assert.match(html.headers.get('content-type'), /text\/html/)
  assert.match(await html.text(), /<!doctype html>/)

  const json = await call('report', { query: `?id=${id}&format=json` })
  assert.equal((await json.json()).verdict, 'VERIFIED_OFFICIAL')
})

test('report 非法 ID 返回 400，不存在的 ID 返回 404', async () => {
  const { call } = await boot()
  assert.equal((await call('report', { query: '?id=../../etc/passwd' })).status, 400)
  assert.equal((await call('report', { query: '?id=20261024-120000-abcd' })).status, 404)
})

test('price-models：按厂商列出全部收录型号', async () => {
  const { call } = await boot()
  const k = await (await call('price-models', { query: '?base=https://api.moonshot.cn/v1' })).json()
  assert.equal(k.found, true)
  assert.match(k.vendor, /Kimi 官方/)
  const keys = k.models.map((m) => m.key)
  assert.ok(keys.includes('kimi-k3.1-pro'))
  assert.ok(keys.includes('kimi-k3.1-pro-highspeed'))
  assert.ok(keys.includes('kimi-k2.7-code'))
  assert.ok(keys.length === 7, `Kimi 应 7 个型号（实际 ${keys.length}）`)
  const z = await (await call('price-models', { query: '?base=https://open.bigmodel.cn/api/paas/v4' })).json()
  assert.equal(z.found, true)
  assert.ok(z.models.length === 5, `GLM 应 5 个型号（实际 ${z.models.length}）`)
  const x = await (await call('price-models', { query: '?base=https://unknown.example/v1' })).json()
  assert.equal(x.found, false)
})

test('price-lookup：不同模型返回不同单价（k3.1 vs k2.7 vs k2.5）', async () => {
  const { call } = await boot()
  const a = await (await call('price-lookup', { query: '?base=https://api.moonshot.cn/v1&model=kimi-k3.1-pro' })).json()
  const b = await (await call('price-lookup', { query: '?base=https://api.moonshot.cn/v1&model=kimi-k2.7-code' })).json()
  const c = await (await call('price-lookup', { query: '?base=https://api.moonshot.cn/v1&model=kimi-k2.5' })).json()
  assert.notEqual(a.in, b.in, 'k3.1 与 k2.7 输入价应不同')
  assert.notEqual(b.in, c.in, 'k2.7 与 k2.5 输入价应不同')
  assert.equal(a.cacheWrite, 13)
  assert.equal(b.cacheWrite, null)  // K2 无写入价
  assert.equal(c.in, 4)
})

test('price-lookup：按厂商+模型返回官方单价（含写价）', async () => {
  const { call } = await boot()
  const k = await (await call('price-lookup', { query: '?base=https://api.moonshot.cn/v1&model=kimi-k2.7-code-highspeed' })).json()
  assert.equal(k.found, true)
  assert.equal(k.modelKey, 'kimi-k2.7-code-highspeed')
  assert.equal(k.in, 13)
  assert.equal(k.cached, 1.3)
  assert.equal(k.cacheWrite, null)         // K2 系列官方未列写入价
  assert.equal(k.cacheWrite1h, null)
  assert.equal(k.out, 54)
  // K3.1 双 TTL 档
  const k3 = await (await call('price-lookup', { query: '?base=https://api.moonshot.cn/v1&model=kimi-k3.1-pro' })).json()
  assert.equal(k3.cacheWrite, 13)
  assert.equal(k3.cacheWrite1h, 26)
  const k3h = await (await call('price-lookup', { query: '?base=https://api.moonshot.cn/v1&model=kimi-k3.1-pro-highspeed' })).json()
  assert.equal(k3h.cacheWrite, 26)
  assert.equal(k3h.cacheWrite1h, 52)
  assert.match(k.source, /platform\.kimi\.com/)
  // DeepSeek 返回峰谷双档之一
  const d = await (await call('price-lookup', { query: '?base=https://api.deepseek.com&model=deepseek-flash' })).json()
  assert.equal(d.found, true)
  assert.ok([2, 1].includes(d.in), '峰 2 或闲 1')
  // 未收录厂商
  const x = await (await call('price-lookup', { query: '?base=https://unknown.example/v1&model=m' })).json()
  assert.equal(x.found, false)
})

test('price-lookup：百炼按模型命中并带思考价', async () => {
  const { call } = await boot()
  const q = await (await call('price-lookup', { query: '?base=https://dashscope.aliyuncs.com/compatible-mode/v1&model=qwen-plus' })).json()
  assert.equal(q.found, true)
  assert.equal(q.in, 0.8)
  assert.equal(q.thinkOut, 8)
})

test('verify：自填单价带写入价，billing 按其折算', async () => {
  const { call, root } = await boot()
  const realFetch = globalThis.fetch
  globalThis.fetch = mockFetch()
  let id
  try {
    const v = await (await call('verify', {
      method: 'POST',
      body: {
        providerBase: 'https://maas.example.com/v1', providerKey: PKEY, model: MODEL, officialKey: OKEY,
        customPrices: { in: 10, out: 50, cached: 1, cacheWrite: 10, cacheWrite1h: 20 },
      },
    })).json()
    id = v.reportId
    const b = v.checks.find((c) => c.id === 'billing_parity')
    assert.match(b.detail, /面板自填/)
    assert.match(b.detail, /写入5m 10\/写入1h 20|缓存写入 10/)
    assert.equal(v.meta.billing.prices.cacheWrite, 10)
    assert.equal(v.meta.billing.prices.cacheWrite1h, 20)
  } finally {
    globalThis.fetch = realFetch
  }
  assert.ok(id, '应产出报告')
})

test('sync-report：把最新报告写进会话工作区，返回 markdown', async () => {
  const { call, root } = await boot({ withSessionHome: true })
  const realFetch = globalThis.fetch
  globalThis.fetch = mockFetch()
  let id
  try {
    const v = await (await call('verify', {
      method: 'POST',
      body: { providerBase: 'https://maas.example.com/v1', providerKey: PKEY, model: MODEL, officialKey: OKEY },
    })).json()
    id = v.reportId
  } finally { globalThis.fetch = realFetch }

  const sr = await (await call('sync-report', { method: 'POST', body: { sessionId: 'session-test-1', reportId: id } })).json()
  assert.equal(sr.synced, true)
  assert.match(sr.filename, /kimi-report-.*\.md/)
  assert.ok(sr.markdown.includes('Kimi 请求签名验证报告'), 'markdown 应为完整报告')
  // 文件确实写进了会话工作区（= root/reports/）
  const written = join(root, 'reports', sr.filename)
  assert.ok(existsSync(written), '报告应写入会话工作区 reports/')
  const content = readFileSync(written, 'utf8')
  assert.ok(content.includes('验证报告') || content.includes('对比报告'), '文件内容为报告正文')
  assert.ok(!content.includes(PKEY), '同步文件不含密钥')
  // 不存在的会话
  const nf = await call('sync-report', { method: 'POST', body: { sessionId: 'session-nope' } })
  assert.equal(nf.status, 404)
  delete process.env.DSH_HOME
})

test('报告落盘目录在配置的 root 下（不写工作区外）', async () => {
  const { call, root } = await boot()
  const realFetch = globalThis.fetch
  globalThis.fetch = mockFetch()
  try {
    await call('verify', {
      method: 'POST',
      body: { providerBase: 'https://maas.example.com/v1', providerKey: PKEY, model: MODEL, officialKey: OKEY },
    })
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(existsSync(join(root, 'reports')), true)
})

test('keys：初始未保存 → GET 返回 saved:false', async () => {
  const { call } = await boot()
  const r = await call('keys')
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.saved, false)
  assert.equal(j.providerKey, '')
})

test('keys：POST 保存 → 0600 权限 → GET 回读一致', async () => {
  const { call, root } = await boot()
  const post = await call('keys', { method: 'POST', body: { providerKey: PKEY, officialKey: OKEY } })
  assert.equal(post.status, 200)
  assert.equal((await post.json()).saved, true)

  const keysFile = join(root, 'keys.json')
  assert.equal(existsSync(keysFile), true, 'keys.json 应落在 root 下')
  const stat = await import('node:fs').then((fs) => fs.statSync(keysFile))
  assert.equal(stat.mode & 0o777, 0o600, '权限必须 0600')

  const got = await (await call('keys')).json()
  assert.equal(got.saved, true)
  assert.equal(got.providerKey, PKEY)
  assert.equal(got.officialKey, OKEY)
  assert.ok(got.savedAt)

  // keys.json 不在 reports 目录里
  assert.equal(existsSync(join(root, 'reports', 'keys.json')), false)
})

test('keys：POST 空内容 → 400；DELETE → 清除', async () => {
  const { call, root } = await boot()
  assert.equal((await call('keys', { method: 'POST', body: {} })).status, 400)

  await call('keys', { method: 'POST', body: { providerKey: PKEY } })
  const del = await call('keys', { method: 'DELETE' })
  assert.equal(del.status, 200)
  assert.equal((await del.json()).saved, false)
  assert.equal(existsSync(join(root, 'keys.json')), false)

  // 再删一次不报错（幂等）
  assert.equal((await call('keys', { method: 'DELETE' })).status, 200)
})

test('keys：保存过 key 后生成的报告仍不含明文 key', async () => {
  const { call, root } = await boot()
  await call('keys', { method: 'POST', body: { providerKey: PKEY, officialKey: OKEY } })
  const realFetch = globalThis.fetch
  globalThis.fetch = mockFetch()
  let id
  try {
    const v = await (await call('verify', {
      method: 'POST',
      body: { providerBase: 'https://maas.example.com/v1', providerKey: PKEY, model: MODEL, officialKey: OKEY },
    })).json()
    id = v.reportId
  } finally {
    globalThis.fetch = realFetch
  }
  const report = readFileSync(join(root, 'reports', `${id}.json`), 'utf8')
  assert.ok(!report.includes(PKEY), '报告不得含第三方 key')
  assert.ok(!report.includes(OKEY), '报告不得含官方 key')
})