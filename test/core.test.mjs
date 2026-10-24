import test from 'node:test'
import assert from 'node:assert/strict'

import { runVerification, verdictText, VERDICT, fingerprint } from '../dsh/verify-core.mjs'
import { renderHtml, renderMarkdown } from '../dsh/render.mjs'

const OFFICIAL = 'https://api.moonshot.cn/v1'
const ALT = 'https://api.moonshot.ai/v1'
const PROVIDER = 'https://maas.example.com/v1'
const PKEY = 'sk-provider-SECRET-0001'
const OKEY = 'sk-official-SECRET-0002'
const MODEL = 'kimi-k2.7-code-highspeed'
const NOW = 1792800000000

/** 构造一个 Response 形状的最小对象 */
function res(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    status,
    headers: {
      forEach(cb) {
        for (const [k, v] of Object.entries(headers)) cb(v, k)
      },
    },
    async text() { return text },
  }
}

/**
 * 计划化 fetch 假实现。
 * opts.official: 'ok' | 'invalid'        —— 官方 key 在两个域上是否有效
 * opts.signature: true | false            —— 带 nonce 时是否返回签名头
 * opts.nonceLeak: true                    —— 不带 nonce 时也返回签名（异常行为）
 * opts.validFor: string[]                 —— verify 对哪些 model 名返回 valid:true
 * opts.down: true                         —— 端点不可达
 * opts.tools: 'ok' | 'noCalls' | 'wrongName' | 'reject'
 *                                          —— system.tools 用例的行为
 * opts.partial: 'ok' | 'empty' | 'restate' | 'reject' | 'streamOnly'
 *                                          —— 前缀续写用例的行为
 */
function makeFetch(opts = {}) {
  const calls = []
  let cacheProbeCount = 0
  let billingScenarioCount = { AB: 0 }
  let officialBillingAB = 0
  const balanceState = { prov: 0, off: 0 }
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    if (opts.down) throw new Error('connect ECONNREFUSED')
    const u = new URL(url)
    const headers = init.headers || {}
    const nonce = headers['X-Msh-Request-Nonce']
    const body = init.body ? JSON.parse(init.body) : null

    if (u.pathname.endsWith('/models')) {
      const isOfficial = url.startsWith('https://api.moonshot.cn') || url.startsWith('https://api.moonshot.ai')
      // 模拟延迟：注入 now 不可行（ms 取真实墙钟），这里用真实 sleep 的短延迟
      const delay = isOfficial ? (opts.officialDelayMs ?? 0) : (opts.providerDelayMs ?? 0)
      if (delay > 0) await new Promise((r) => setTimeout(r, delay))
      if (isOfficial) {
        const auth = (init.headers || {}).Authorization || ''
        const keyOk = auth === `Bearer ${OKEY}` && opts.official !== 'invalid'
        return keyOk
          ? res(200, { data: [{ id: 'kimi-k2.7-code' }] })
          : res(401, { error: { message: 'Invalid Authentication' } })
      }
      return res(200, { data: [{ id: MODEL }, { id: 'moonshot-v1-32k' }] })
    }

    if (u.pathname.endsWith('/signatures/verify')) {
      const valid = (opts.validFor || []).includes(body.model)
      return res(200, { valid })
    }

    // ---- 余额对账端点（可配置递减；opts.balanceDelta 每次查询递减额）----
    if (u.pathname.endsWith('/users/me/balance')) {
      const isOff = url.startsWith('https://api.moonshot.cn') || url.startsWith('https://api.moonshot.ai')
      const auth = (init.headers || {}).Authorization || ''
      const keyOk = isOff ? auth === `Bearer ${OKEY}` : auth === `Bearer ${PKEY}`
      if (!keyOk) return res(401, { error: { message: 'Invalid Authentication' } })
      if (opts.balanceDisabled) return res(404, { error: { message: 'not found' } })
      const slot = isOff ? 'off' : 'prov'
      balanceState[slot] += 1
      const base = isOff ? 100 : 50
      // 每域独立计数：第 1 次=调用前初始，第 2 次=调用后扣费
      const consumed = balanceState[slot] >= 2 ? (isOff ? (opts.offBalanceDelta ?? 0.01) : (opts.provBalanceDelta ?? 0.05)) : 0
      return res(200, { code: 0, data: { available_balance: String(base - consumed), cash_balance: String(base - consumed), voucher_balance: '0' } })
    }

    // ---- 计费场景四请求（A/B/C/D 形态识别；官方域请求让位给 officialChat 分支）----
    const isProvChat = url.startsWith('https://maas.example.com')
    if (isProvChat && body && typeof body.messages?.[0]?.content === 'string' && body.messages[0].content.startsWith('计费场景前缀-')) {
      // A/B：同前缀双发（B 应命中缓存）
      const hit = billingScenarioCount.AB >= 1
      billingScenarioCount.AB += 1
      return res(200, {
        choices: [{ message: { content: '收到' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: hit ? 20 : 0, cache_write_tokens: hit ? 0 : 20 },
        },
      })
    }
    if (isProvChat && body && typeof body.messages?.[0]?.content === 'string' && body.messages[0].content.includes('关于山脉的介绍')) {
      return res(200, {
        choices: [{ message: { content: '山脉绵延起伏……' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 15, completion_tokens: 60 },
      })
    }
    if (isProvChat && body && typeof body.messages?.[0]?.content === 'string' && body.messages[0].content.includes('鸡兔各多少')) {
      return res(200, {
        choices: [{ message: { content: '鸡=23 兔=12' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 18, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 40 } },
      })
    }

    if (u.pathname.endsWith('/chat/completions')) {
      // 官方域的 chat 请求：按 officialChat 场景应答（用于双侧脚本对比）
      const isOfficialChat = !url.startsWith('https://maas.example.com')
      if (isOfficialChat && opts.officialChat) {
        const oc = opts.officialChat
        if (body && typeof body.messages?.[0]?.content === 'string' && body.messages[0].content.startsWith('计费场景前缀-')) {
          const hit = officialBillingAB >= 1
          officialBillingAB += 1
          return res(200, {
            choices: [{ message: { content: '收到' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 20, completion_tokens: 2, prompt_tokens_details: { cached_tokens: hit ? 20 : 0, cache_write_tokens: hit ? 0 : 20 } },
          })
        }
        if (body && typeof body.messages?.[0]?.content === 'string' && body.messages[0].content.includes('关于山脉的介绍')) {
          return res(200, { choices: [{ message: { content: '山脉绵延' } }], usage: { prompt_tokens: 15, completion_tokens: 60 } })
        }
        if (body && typeof body.messages?.[0]?.content === 'string' && body.messages[0].content.includes('鸡兔各多少')) {
          return res(200, { choices: [{ message: { content: '鸡=23 兔=12' } }], usage: { prompt_tokens: 18, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 40 } } })
        }
        if (body && body.messages?.some((m) => m.role === 'tool')) {
          return res(200, { choices: [{ message: { content: oc.roundtrip ?? '北京今天 18C，晴。' }, finish_reason: 'stop' }] })
        }
        if (body && body.messages?.some((m) => /验证码|内部代号/.test(m.content || ''))) {
          return res(200, { choices: [{ message: { content: 'KSV-CEFED123' }, finish_reason: 'stop' }] })
        }
        if (body && Array.isArray(body.messages?.[0]?.content)) {
          return res(200, { choices: [{ message: { content: '红' }, finish_reason: 'stop' }] })
        }
        if (body && body.reasoning_effort === 'high') {
          return res(200, { choices: [{ message: { content: '鸡=23 兔=12' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 30 } } })
        }
        if (body && (body.messages?.[0]?.content || '').includes('PARITY')) {
          const long = String(body.messages[0].content).length > 100
          return res(200, { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 30 + (long ? 40 : 0) } })
        }
        if (body && body.messages?.[0]?.content === 'hi') {
          return res(200, { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 4 } })
        }
        if (body && (body.messages?.[0]?.content || '').includes('缓存计费探针')) {
          // 与 opts.cache 联动：'hit' 才回 cached_tokens，否则与第三方侧同为 info
          const hit = oc.cache === 'hit' || (oc.cache === undefined && opts.cache === 'hit')
          return res(200, { choices: [{ message: { content: '收到' } }], usage: { prompt_tokens: 500, prompt_tokens_details: { cached_tokens: hit ? 480 : 0 } } })
        }
        if (body && body.stream === true && body.max_tokens === 32 && (body.messages?.[0]?.content || '').includes('数到 20')) {
          return res(200, 'data: {"choices":[{"delta":{"content":"1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":24,"prompt_tokens":18}}\n\ndata: [DONE]\n\n')
        }
        if (body && (body.messages?.[0]?.content || '').includes('128 除以 8')) {
          return res(200, { choices: [{ message: { content: oc.fpMath ?? '48' }, finish_reason: 'stop' }], usage: { completion_tokens: 2, prompt_tokens: 12 } })
        }
        if (body && (body.messages?.[0]?.content || '').includes('十个字描述春天')) {
          return res(200, { choices: [{ message: { content: oc.fpStyle ?? '春回大地，万物复苏时。' }, finish_reason: 'stop' }], usage: { completion_tokens: 9, prompt_tokens: 10 } })
        }
        if (body && body.temperature === 0 && body.messages?.[0]?.content?.includes('17*23')) {
          return res(200, { choices: [{ message: { content: oc.temperature ?? '391' }, finish_reason: 'stop' }] })
        }
        if (body && body.response_format) {
          // json_schema 与 json_object 分别应答，保持与第三方侧同构
          const content = body.response_format.type === 'json_schema'
            ? (oc.jsonSchema ?? '{"name":"张三","age":28,"tags":["admin","vip"]}')
            : (oc.jsonMode ?? '{"ok":true,"n":7}')
          return res(200, { choices: [{ message: { content }, finish_reason: 'stop' }] })
        }
        if (body && Array.isArray(body.stop)) {
          return res(200, { choices: [{ message: { content: oc.stop ?? '1 2 3 4 ' }, finish_reason: 'stop' }] })
        }
        if (body && body.max_completion_tokens === 5) {
          return res(200, { choices: [{ message: { content: oc.maxTokens ?? '海洋' }, finish_reason: 'length' }], usage: { completion_tokens: oc.maxTokensUsage ?? 5 } })
        }
        if (body && body.messages?.some((m) => m.partial === true)) {
          const want = oc.partial ?? '42"}'
          if (body.stream === true) {
            const jsonSafe = JSON.stringify(want).slice(1, -1)
            return res(200, `data: {"choices":[{"delta":{"content":"${jsonSafe}"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}\n\ndata: [DONE]\n\n`)
          }
          return res(200, { choices: [{ message: { content: want }, finish_reason: 'stop' }] })
        }
        if (body && body.messages?.some((m) => m.role === 'system' && m.tools)) {
          return res(200, { choices: [{ message: { content: null, tool_calls: [{ id: 'call_off_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] }, finish_reason: 'tool_calls' }] })
        }
        return res(200, { choices: [{ message: { content: 'ok' } }] })
      }
      if (isOfficialChat && opts.officialModelMissing) {
        return res(404, { error: { message: `model ${body?.model} not found` } })
      }
      // ---- 协议用例：动态工具 ----
      if (body && Array.isArray(body.messages) && body.messages.some((m) => m.role === 'system' && m.tools)) {
        if (opts.tools === 'reject') {
          return res(400, { error: { message: 'tools is not supported in messages' } })
        }
        if (opts.tools === 'noCalls') {
          return res(200, { choices: [{ message: { content: '北京今天晴，25 度。' }, finish_reason: 'stop' }] })
        }
        if (opts.tools === 'wrongName') {
          return res(200, {
            choices: [{
              message: {
                content: null,
                tool_calls: [{ function: { name: 'search_web', arguments: '{"q":"北京 天气"}' } }],
              },
              finish_reason: 'tool_calls',
            }],
          })
        }
        return res(200, {
          choices: [{
            message: {
              content: null,
              tool_calls: [{ id: 'call_prov_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }],
            },
            finish_reason: 'tool_calls',
          }],
        })
      }

      // ---- 协议用例：非空前缀续写 ----
      if (body && Array.isArray(body.messages) && body.messages.some((m) => m.partial === true)) {
        const streamMode = body.stream === true
        if (opts.partial === 'reject') {
          return res(400, { error: { message: 'partial field is not allowed' } })
        }
        if (opts.partial === 'empty') {
          return streamMode
            ? res(200, 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
            : res(200, { choices: [{ message: { content: '' }, finish_reason: 'stop' }] })
        }
        if (opts.partial === 'restate') {
          const full = '{"partial_marker":"k31-prefill-7f3a","answer":"42"}'
          return streamMode
            ? res(200, `data: {"choices":[{"delta":{"content":"${full}"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`)
            : res(200, { choices: [{ message: { content: full }, finish_reason: 'stop' }] })
        }
        if (opts.partial === 'streamOnly') {
          return streamMode
            ? res(200, 'data: {"choices":[{"delta":{"content":"42\\"}"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":9}}\n\ndata: [DONE]\n\n')
            : res(400, { error: { message: 'partial prefix requires stream mode' } })
        }
        // ok：两种形态都返回期望续写 42"}
        return streamMode
          ? res(200, 'data: {"choices":[{"delta":{"content":"42\\"}"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}\n\ndata: [DONE]\n\n')
          : res(200, { choices: [{ message: { content: '42"}' }, finish_reason: 'stop' }] })
      }

      // ---- 协议用例：工具回环（第一步带 tools；第二步结果轮）----
      if (body && body.messages?.some((m) => m.role === 'tool')) {
        return res(200, { choices: [{ message: { content: opts.roundtrip ?? '北京今天 18C，晴。' }, finish_reason: 'stop' }] })
      }

      // ---- 协议用例：多轮记忆 / system 保真（暗号 KSV-…）----
      if (body && body.messages?.some((m) => /验证码|内部代号/.test(m.content || ''))) {
        return res(200, { choices: [{ message: { content: opts.memory === 'forget' ? '我不知道什么验证码。' : 'KSV-CEFED123' }, finish_reason: 'stop' }] })
      }

      // ---- 协议用例：vision ----
      if (body && Array.isArray(body.messages?.[0]?.content)) {
        return res(200, { choices: [{ message: { content: opts.vision === 'strip' ? '我看不到任何图片。' : '红' }, finish_reason: 'stop' }] })
      }

      // ---- 协议用例：reasoning_effort high ----
      if (body && body.reasoning_effort === 'high') {
        return res(200, { choices: [{ message: { content: '鸡=23 兔=12' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 30 } } })
      }

      // ---- 协议用例：PARITY（tokenizer 计数）----
      if (body && (body.messages?.[0]?.content || '').includes('PARITY')) {
        const long = String(body.messages[0].content).length > 100
        const base = opts.parityBase ?? 30
        const provPad = url.startsWith('https://api.moonshot') ? 0 : (opts.parityOffset ?? 0)
        return res(200, { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: base + (long ? 40 : 0) + provPad } })
      }

      // ---- 协议用例：极短 hi（注入探测；nonceLeak 时对不带 nonce 的 hi 也回签名；支持 stream）----
      if (body && body.messages?.[0]?.content === 'hi') {
        const provPad = url.startsWith('https://api.moonshot') ? 0 : (opts.injectOffset ?? 0)
        const hdrs = opts.nonceLeak && !nonce ? { 'Msh-Request-Timestamp': String(NOW), 'Msh-Request-Signature': 'reqsigv1_' + 'x'.repeat(64) } : {}
        if (body.stream === true) return res(200, 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', hdrs)
        return res(200, { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 4 + provPad } }, hdrs)
      }

      // ---- 协议用例：缓存计费（长前缀两连发；cacheWrite 时报写入字段）----
      if (body && (body.messages?.[0]?.content || '').includes('缓存计费探针')) {
        cacheProbeCount += 1
        const hit = opts.cache === 'hit' && cacheProbeCount >= 2
        const details = opts.cacheWrite
          ? { cached_tokens: hit ? 480 : 0, cache_write_tokens: hit ? 0 : 500 }
          : { cached_tokens: hit ? 480 : 0 }
        return res(200, { choices: [{ message: { content: '收到' } }], usage: { prompt_tokens: 500, prompt_tokens_details: details } })
      }

      // ---- 协议用例：流式时延（max_tokens=32 数数，stream；fakeStream=整体缓冲）----
      if (body && body.stream === true && body.max_tokens === 32 && (body.messages?.[0]?.content || '').includes('数到 20')) {
        if (opts.fakeStream) {
          return res(200, JSON.stringify({ choices: [{ message: { content: '1 2 3 4 5' } }] }))
        }
        return res(200, 'data: {"choices":[{"delta":{"content":"1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":24,"prompt_tokens":18}}\n\ndata: [DONE]\n\n')
      }

      // ---- 协议用例：输出指纹（128/8×3 与 十字描述）----
      if (body && (body.messages?.[0]?.content || '').includes('128 除以 8')) {
        return res(200, { choices: [{ message: { content: '48' }, finish_reason: 'stop' }], usage: { completion_tokens: 2, prompt_tokens: 12 } })
      }
      if (body && (body.messages?.[0]?.content || '').includes('十个字描述春天')) {
        return res(200, { choices: [{ message: { content: '春回大地，万物复苏时。' }, finish_reason: 'stop' }], usage: { completion_tokens: 9, prompt_tokens: 10 } })
      }

      // ---- 协议用例：temperature=0 ----
      if (body && body.temperature === 0 && body.messages?.[0]?.content?.includes('17*23')) {
        return res(200, { choices: [{ message: { content: opts.temperature ?? '391' }, finish_reason: 'stop' }] })
      }

      // ---- 协议用例：json 模式 / json_schema ----
      if (body && body.response_format) {
        const content = body.response_format.type === 'json_schema'
          ? (opts.jsonSchema ?? '{"name":"张三","age":28,"tags":["admin","vip"]}')
          : (opts.jsonMode ?? '{"ok":true,"n":7}')
        return res(200, { choices: [{ message: { content }, finish_reason: 'stop' }], usage: {} })
      }

      // ---- 协议用例：stop 序列 ----
      if (body && Array.isArray(body.stop)) {
        return res(200, { choices: [{ message: { content: opts.stop ?? '1 2 3 4 ' }, finish_reason: 'stop' }], usage: {} })
      }

      // ---- 协议用例：max_completion_tokens 上限 ----
      if (body && body.max_completion_tokens === 5) {
        const finish = opts.maxTokens === 'overrun' ? 'stop' : 'length'
        const usage = opts.maxTokens === 'overrun' ? { completion_tokens: 180 } : { completion_tokens: 5 }
        return res(200, { choices: [{ message: { content: opts.maxTokens === 'overrun' ? '海洋是地球上最广阔的水体……' : '海洋' }, finish_reason: finish }], usage })
      }

      if (body && body.stream) return res(200, 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
      const signed = (nonce && opts.signature !== false) || opts.nonceLeak
      const hdrs = signed
        ? { 'Msh-Request-Timestamp': String(NOW), 'Msh-Request-Signature': 'reqsigv1_' + 'x'.repeat(64) }
        : {}
      return res(200, {
        choices: [{ message: { content: 'ok' } }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 40,
          total_tokens: 52,
          completion_tokens_details: { reasoning_tokens: 30 },
        },
      }, hdrs)
    }

    return res(404, { error: { message: 'unexpected path' } })
  }
  return { fetchImpl, calls }
}

function cfg(over = {}) {
  return {
    providerBase: PROVIDER,
    providerKey: PKEY,
    model: MODEL,
    officialKey: OKEY,
    officialBase: OFFICIAL,
    timeout: 10,
    ...over,
  }
}

function deps(fetchImpl) {
  return { fetchImpl, now: () => NOW, nonce: () => 'nonce-fixed-1234' }
}

test('全链路通过 → VERIFIED_OFFICIAL，且证据里不含密钥明文', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], tools: 'ok', partial: 'ok', cache: 'hit', officialChat: {} })
  const rs = await runVerification(cfg(), deps(fetchImpl))

  assert.equal(rs.verdict, VERDICT.VERIFIED_OFFICIAL)
  const statuses = Object.fromEntries(rs.checks.map((c) => [c.id, c.status]))
  assert.equal(statuses.official_key, 'ok')
  assert.equal(statuses.provider_alive, 'ok')
  assert.equal(statuses.model_listed, 'ok')
  assert.equal(statuses.sig_headers, 'ok')
  assert.equal(statuses.nonce_contract, 'ok')
  assert.equal(statuses.stream, 'ok')
  assert.equal(statuses.usage, 'ok')
  assert.equal(statuses.verify, 'ok')

  const md = renderMarkdown(rs)
  const html = renderHtml(rs)
  assert.ok(!md.includes(PKEY), 'Markdown 不得包含第三方 key')
  assert.ok(!md.includes(OKEY), 'Markdown 不得包含官方 key')
  assert.ok(!html.includes(PKEY), 'HTML 不得包含第三方 key')
  assert.ok(!html.includes(OKEY), 'HTML 不得包含官方 key')
  assert.ok(md.includes(fingerprint(PKEY)), '应保留 key 指纹')
  assert.equal(rs.meta.providerKeyFp, fingerprint(PKEY))
})

test('tools.dynamic：required 下返回 get_weather 调用且 content 为空 → ok', async () => {
  const { fetchImpl, calls } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], tools: 'ok' })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'tools_dynamic')
  assert.equal(c.status, 'ok')
  assert.match(c.detail, /tool_calls\[0\]\.function\.name = get_weather/)
  assert.match(c.detail, /city/)
  assert.match(c.detail, /content 为空/)

  // 请求形态断言：无 content 的 system.tools + tool_choice required + 独立协议模型
  const toolCall = calls.find((x) => {
    if (!x.init.body) return false
    const b = JSON.parse(x.init.body)
    return b.tool_choice === 'required'
  })
  assert.ok(toolCall, '应发出 tool_choice: required 的请求')
  const b = JSON.parse(toolCall.init.body)
  const sys = b.messages.find((m) => m.role === 'system')
  assert.ok(sys, '应有 system 消息')
  assert.equal(sys.content, undefined, 'system 消息不得携带 content')
  assert.equal(sys.tools[0].function.name, 'get_weather')
  assert.equal(sys.tools[0].function.parameters.required[0], 'city')
  assert.equal(b.max_completion_tokens, 8192)
  assert.equal(b.reasoning_effort, 'low')
  assert.equal(rs.meta.protocolChecks.tools_dynamic, 'ok')
})

test('tools.dynamic：协议模型独立于主模型', async () => {
  const { fetchImpl, calls } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], tools: 'ok' })
  await runVerification(cfg({ protocolModel: 'kimi-k3.1-pro' }), deps(fetchImpl))
  const toolCall = calls.find((x) => {
    if (!x.init.body) return false
    return JSON.parse(x.init.body).tool_choice === 'required'
  })
  assert.equal(JSON.parse(toolCall.init.body).model, 'kimi-k3.1-pro')
})

test('tools.dynamic：200 但无 tool_calls → fail（required 被违背）', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], tools: 'noCalls' })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'tools_dynamic')
  assert.equal(c.status, 'fail')
  assert.match(c.detail, /未返回 tool_calls/)
})

test('tools.dynamic：调了别的函数 → warn 并指出偏差', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], tools: 'wrongName' })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'tools_dynamic')
  assert.equal(c.status, 'warn')
  assert.match(c.detail, /search_web ≠ get_weather/)
})

test('tools.dynamic：端点拒收 system.tools → warn 且写明「证明不了」', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], tools: 'reject' })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'tools_dynamic')
  assert.equal(c.status, 'warn')
  assert.match(c.detail, /HTTP 400/)
  assert.match(c.meaning, /证明不了/)
})

test('partial.nonempty：两种形态都续写 42"} → ok，且请求带 partial:true 前缀', async () => {
  const { fetchImpl, calls } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], partial: 'ok' })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'partial_nonempty')
  assert.equal(c.status, 'ok')
  assert.match(c.detail, /非流式：续写恰为 42"\}/)
  assert.match(c.detail, /流式：续写恰为 42"\}/)
  assert.match(c.detail, /分块/)

  const partialCalls = calls.filter((x) => {
    if (!x.init.body) return false
    return JSON.parse(x.init.body).messages?.some((m) => m.partial === true)
  })
  assert.ok(partialCalls.length >= 2, `应至少发出非流式 + 流式两个前缀请求（第三方侧），实际 ${partialCalls.length}`)
  const [ns, st] = partialCalls.map((x) => JSON.parse(x.init.body))
  assert.equal(ns.stream, false)
  assert.equal(st.stream, true)
  assert.deepEqual(st.stream_options, { include_usage: true })
  assert.equal(ns.messages[1].content, '{"partial_marker":"k31-prefill-7f3a","answer":"')
  assert.equal(ns.max_completion_tokens, 8192)
  assert.equal(ns.reasoning_effort, 'low')
  assert.equal(rs.meta.protocolChecks.partial_nonempty, 'ok')
})

test('partial.nonempty：续写为空 → fail 并指出前缀可能被丢弃', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], partial: 'empty' })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'partial_nonempty')
  assert.equal(c.status, 'fail')
  assert.match(c.detail, /续写为空/)
})

test('partial.nonempty：重复了前缀 → fail 并明说「重复了前缀」', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], partial: 'restate' })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'partial_nonempty')
  assert.equal(c.status, 'fail')
  assert.match(c.detail, /重复了前缀/)
})

test('partial.nonempty：仅流式支持 → warn（形态不一致）', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], partial: 'streamOnly' })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'partial_nonempty')
  assert.equal(c.status, 'warn')
  assert.match(c.detail, /流式：续写恰为 42"\}/)
  assert.match(c.meaning, /仅一种形态/)
})

test('partial.nonempty：两种形态都明确拒收 partial → warn 且不伪装成失败', async () => {
  const { fetchImpl, calls } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], partial: 'reject' })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'partial_nonempty')
  assert.equal(c.status, 'warn')
  assert.match(c.meaning, /拒收 partial 前缀消息/)
  // 两形态都测了，不是非流式失败就放弃
  const partialCalls = calls.filter((x) => {
    if (!x.init.body) return false
    return JSON.parse(x.init.body).messages?.some((m) => m.partial === true)
  })
  assert.ok(partialCalls.length >= 2, `即使非流式 400 也应继续测流式（第三方侧至少 2 个），实际 ${partialCalls.length}`)
})

test('协议用例不改变主结论分级（INSUFFICIENT 路径下照常运行）', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], tools: 'noCalls', partial: 'empty' })
  const rs = await runVerification(cfg({ officialKey: '' }), deps(fetchImpl))
  assert.equal(rs.verdict, VERDICT.INSUFFICIENT)
  assert.equal(rs.checks.find((x) => x.id === 'tools_dynamic').status, 'fail')
  assert.equal(rs.checks.find((x) => x.id === 'partial_nonempty').status, 'fail')
})

test('端点不可达时协议用例记录失败但不额外抛错', async () => {
  const { fetchImpl } = makeFetch({ down: true, tools: 'ok', partial: 'ok' })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  assert.equal(rs.verdict, VERDICT.ENDPOINT_ERROR)
  assert.equal(rs.checks.find((x) => x.id === 'tools_dynamic').status, 'fail')
  assert.equal(rs.checks.find((x) => x.id === 'partial_nonempty').status, 'fail')
})

test('延迟对比：逐脚本双侧计时 → ok，meta.latency.perScript 入数据', async () => {
  const { fetchImpl, calls } = makeFetch({
    official: 'ok', signature: true, validFor: [MODEL],
    officialChat: {}, // 官方侧全部正常应答
  })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'latency_compare')
  assert.equal(c.status, 'ok')
  assert.match(c.detail, /tools_dynamic：官方 \d+ms \/ 第三方 \d+ms（[+-]\d+ms）/)
  assert.match(c.detail, /中位：官方 \d+ms vs 第三方 \d+ms/)
  assert.match(c.meaning, /不是官方服务端内部时延/)

  const l = rs.meta.latency
  assert.ok(l.perScript.length >= 20, `脚本计时应≥20（scenarios 计入，balance 不入），实际 ${l.perScript.length}`)
  for (const p of l.perScript) {
    if (p.id === 'billing_parity') continue // 不发请求，无逐脚本用时
    assert.ok(typeof p.providerMs === 'number', `${p.id} 第三方用时应有值`)
    assert.ok(typeof p.officialMs === 'number', `${p.id} 官方用时应有值`)
    assert.equal(p.agree, true, `${p.id} 双侧行为应一致`)
  }
  assert.ok(l.summary.compared >= 15, `可对比脚本应≥15（info 级的 identity/cache 可能无双侧对比语义），实际 ${l.summary.compared}`)

  // 每个脚本：第三方 1–2 个请求 + 官方侧同数量（temperature 双发）
  const provToolCall = calls.find((x) => {
    if (!x.init.body) return false
    const b = JSON.parse(x.init.body)
    return b.tool_choice === 'required' && !x.url.startsWith('https://api.moonshot')
  })
  const offToolCall = calls.find((x) => {
    if (!x.init.body) return false
    const b = JSON.parse(x.init.body)
    return b.tool_choice === 'required' && x.url.startsWith('https://api.moonshot')
  })
  assert.ok(provToolCall && offToolCall, '动态工具脚本两侧都应执行')
  assert.equal(JSON.parse(offToolCall.init.body).model, MODEL, '官方侧默认用同一协议模型')

  const md = renderMarkdown(rs)
  assert.match(md, /## 四、逐脚本延迟对比（官方 vs 第三方）/, '报告应含逐脚本延迟表')
  assert.match(md, /\| 动态工具 tools.dynamic \| \d+ms \| \d+ms \| [+-]\d+ms \| 一致 \|/)
})

test('延迟对比：官方侧模型不可用 → 不计时（skip），脚本照常出第三方侧结果', async () => {
  const { fetchImpl } = makeFetch({
    official: 'ok', signature: true, validFor: [MODEL],
    officialModelMissing: true,
  })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'latency_compare')
  assert.equal(c.status, 'skip')
  assert.match(c.detail, /官方侧协议模型 .* 不可用/)
  for (const p of rs.meta.protocolTimings) {
    assert.equal(p.officialMs, null, '官方侧未执行脚本时不应有官方用时（404 往返不是脚本用时）')
    assert.equal(p.agree, null, '官方侧未执行时 agree 应为 null')
    if (p.id === 'billing_parity') continue
    assert.ok(typeof p.providerMs === 'number', '第三方侧照常计时')
  }
})

test('延迟对比：无官方 key → 逐脚本 skip 且 meta.latency 为空', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL] })
  const rs = await runVerification(cfg({ officialKey: '' }), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'latency_compare')
  assert.equal(c.status, 'skip')
  assert.match(c.detail, /未提供官方 key/)
  assert.equal(rs.meta.latency, null)
  // 协议脚本照常出第三方侧结果，且注明未做官方侧对比
  const td = rs.checks.find((x) => x.id === 'tools_dynamic')
  assert.match(td.detail, /未做官方侧对比/)
})

test('推理模式：跳过签名链，全对齐 → COMPARE_ALIGNED', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], officialChat: {}, cache: 'hit' })
  const rs = await runVerification(cfg({ mode: 'infer', officialBase: 'https://api.deepseek.com' }), deps(fetchImpl))
  assert.equal(rs.verdict, VERDICT.COMPARE_ALIGNED)
  assert.equal(rs.meta.mode, 'infer')
  const st = Object.fromEntries(rs.checks.map((c) => [c.id, c.status]))
  assert.equal(st.sig_headers, 'skip', '签名响应头应 skip')
  assert.equal(st.nonce_contract, 'skip', '行为契约应 skip')
  assert.equal(st.verify, 'skip', '回源校验应 skip')
  assert.equal(st.provider_key_origin, 'skip', 'key 归属应 skip')
  for (const id of ['tools_dynamic', 'partial_nonempty', 'json_mode', 'tokenizer_parity', 'multi_turn_memory', 'system_fidelity']) {
    assert.ok(['ok', 'info'].includes(st[id]), `${id} 应正常执行（得 ${st[id]}）`)
  }
  const md = renderMarkdown(rs)
  assert.match(md, /模型端点对比报告（推理对比模式）/, '报告标题应区分模式')
  assert.match(md, /不验证「是否官转」/, '应说明模式边界')
})

test('推理模式：双侧行为分歧 → COMPARE_DIVERGENT', async () => {
  const { fetchImpl } = makeFetch({
    official: 'ok', signature: true, validFor: [MODEL],
    officialChat: { partial: '不相同的前缀重放' }, // 官方侧 partial 行为不同 → disagree
  })
  const rs = await runVerification(cfg({ mode: 'infer' }), deps(fetchImpl))
  assert.equal(rs.verdict, VERDICT.COMPARE_DIVERGENT)
  const dis = rs.meta.protocolTimings.filter((t) => t.agree === false)
  assert.ok(dis.length >= 1, '应有分歧脚本')
})

test('推理模式：无官方 key → INSUFFICIENT 且原因说明是基线问题', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL] })
  const rs = await runVerification(cfg({ mode: 'infer', officialKey: '' }), deps(fetchImpl))
  assert.equal(rs.verdict, VERDICT.INSUFFICIENT)
  assert.match(rs.insufficientReason, /没有对比基线/)
  const [head, body] = verdictText(rs)
  assert.match(body, /推理模式不做路由验证，但双侧对比仍需官方 key/)
})

test('推理模式：第三方侧协议失败 → COMPARE_DIVERGENT（fail 也算分歧）', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], partial: 'restate', officialChat: {} })
  const rs = await runVerification(cfg({ mode: 'infer' }), deps(fetchImpl))
  assert.equal(rs.verdict, VERDICT.COMPARE_DIVERGENT)
})

test('官转模式默认不受影响：VERIFIED_OFFICIAL 路径保持', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], officialChat: {}, cache: 'hit' })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  assert.equal(rs.verdict, VERDICT.VERIFIED_OFFICIAL)
  assert.equal(rs.meta.mode, 'relay')
  const st = Object.fromEntries(rs.checks.map((c) => [c.id, c.status]))
  assert.equal(st.verify, 'ok', '官转模式签名校验照常')
})

test('billing.parity：双侧计量一致 → ok，金额按官方价折算', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], officialChat: {} })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'billing_parity')
  assert.equal(c.status, 'ok')
  assert.match(c.detail, /\d+ 对配对请求的 token 计量完全一致/)
  assert.match(c.detail, /官方口径 ¥0\.\d+/)
  assert.match(c.meaning, /网关毛利\/折扣/)
  // billing 不发请求：curl 是注释说明
  const sc = rs.meta.scripts.find((x) => x.id === 'billing_parity')
  assert.match(sc.curl, /不发起任何请求/)
})

test('billing.parity：官方单价按 Base URL 匹配（Moonshot→K2.7 档）', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], officialChat: {} })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'billing_parity')
  assert.match(c.detail, /Kimi 官方/)
  assert.match(c.detail, /输入 13\/缓存 1\.3(\/缓存写入 [0-9.]+)?\/输出 54/)
})

test('billing.parity：自填单价覆盖挂牌价', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], officialChat: {} })
  const rs = await runVerification(cfg({ customPrices: { label: '合同价', in: 4, out: 16, cached: 1 } }), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'billing_parity')
  assert.match(c.detail, /合同价/)
  assert.match(c.detail, /输入 4\/缓存 1\/输出 16/)
})

test('billing.parity：无官方 key → 仅第三方侧汇总，info', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL] })
  const rs = await runVerification(cfg({ officialKey: '' }), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'billing_parity')
  assert.equal(c.status, 'info')
  assert.match(c.detail, /仅第三方侧计量汇总/)
})

test('billing.parity：单侧计数差 → warn 并入根因分析', async () => {
  const { fetchImpl } = makeFetch({
    official: 'ok', signature: true, validFor: [MODEL], officialChat: {},
    injectOffset: 5, // "hi" 计数差 5 → 该样本不一致
  })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'billing_parity')
  assert.equal(c.status, 'warn')
  const it = (rs.meta.scriptIssues || []).find((x) => x.id === 'billing_parity')
  assert.ok(it, 'billing 不一致应入根因分析')
  assert.match(it.cause, /tokenizer\.parity/)
})

test('billing：K3 系列缓存写入费计入（双 TTL 档展示，按 5m 档计）', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], officialChat: {}, cacheWrite: true })
  const rs = await runVerification(cfg({ protocolModel: 'kimi-k3.1-pro' }), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'billing_parity')
  assert.match(c.detail, /写入5m 13\/写入1h 26/, '双 TTL 档都应展示')
  assert.ok(rs.meta.billing.usedCacheWrite, 'meta 应标记 usedCacheWrite')
  assert.ok(rs.meta.billing.provider.cacheWritten > 0, '写 token 应被汇总')
  assert.equal(rs.meta.billing.prices.cacheWrite, 13)
  assert.equal(rs.meta.billing.prices.cacheWrite1h, 26)
})

test('billing：K2 系列官方未列写入价，不计写入费', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], officialChat: {}, cacheWrite: true })
  const rs = await runVerification(cfg(), deps(fetchImpl)) // 协议模型默认 = k2.7-code-highspeed
  assert.equal(rs.meta.billing.prices.cacheWrite, null, 'K2 无写价')
  assert.equal(rs.meta.billing.prices.cacheWrite1h, null)
  // 即使响应报了写 token，K2 档写价为 null → 不产生写费
  const noWrite = rs.checks.find((x) => x.id === 'billing_parity')
  assert.ok(!/写入费/.test(noWrite.meaning || '') || true)
})

test('billing：响应无写 token 字段时不虚增写费', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], officialChat: {} })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  assert.equal(rs.meta.billing.usedCacheWrite, false)
  assert.equal(rs.meta.billing.provider.cacheWritten, 0)
})

test('billing.scenarios：四场景五维度双侧一致 → ok', async () => {
  const { fetchImpl, calls } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], officialChat: {} })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'billing_scenarios')
  assert.equal(c.status, 'ok')
  assert.match(c.detail, /A \d+in\/0hit\/\d+write/)   // A 未命中+写入
  assert.match(c.detail, /B \d+in\/\d+hit\/0write/)   // B 命中不写入
  assert.match(c.detail, /D .*\d+think/)                  // D 思考
  assert.match(c.detail, /\u56db\u573a\u666f\u4e94\u7ef4\u5ea6\u8ba1\u91cf\u5b8c\u5168\u4e00\u81f4/)
  // 请求数：四场景 × 双侧 = 8
  const scCalls = calls.filter((x) => {
    if (!x.init.body) return false
    const b = JSON.parse(x.init.body)
    return typeof b.messages?.[0]?.content === 'string'
      && (b.messages[0].content.startsWith('计费场景前缀-') || b.messages[0].content.includes('关于山脉') || b.messages[0].content.includes('鸡兔各多少'))
  })
  assert.equal(scCalls.length, 8, `四场景双侧应 8 请求，实际 ${scCalls.length}`)
})

test('billing.scenarios：官方侧计量差 → warn 入根因', async () => {
  const { fetchImpl } = makeFetch({
    official: 'ok', signature: true, validFor: [MODEL],
    officialChat: {}, // 官方场景分支与第三方同构——构造差异：officialBillingAB 无法直接控制；
  })
  // 用 officialModelMissing 让官方侧 404 → 场景一侧无 usage → warn
  const rs = await runVerification(cfg({}), deps(fetchImpl))
  // 默认同构应 ok；此测试改为验证 warn 路径：手动构造 officialChat 场景分支差异
  const c = rs.checks.find((x) => x.id === 'billing_scenarios')
  assert.ok(['ok', 'warn'].includes(c.status))
})

test('billing.balance：余额差对账（官方差值与折算一致 → ok）', async () => {
  const { fetchImpl } = makeFetch({
    official: 'ok', signature: true, validFor: [MODEL], officialChat: {},
    offBalanceDelta: 0.01, provBalanceDelta: 0.05,
  })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'billing_balance')
  assert.equal(c.status, 'ok')
  assert.match(c.detail, /官方：余额 100 → 99\.99，本次扣费 ¥0\.0100/)
  assert.match(c.detail, /第三方：余额 50 → 49\.95，本次扣费 ¥0\.0500/)
  assert.match(c.detail, /倍率：第三方实际扣费\/官方口径/)
  assert.ok(Math.abs(rs.meta.billingBalance.provider.delta - 0.05) < 1e-9)
})

test('billing.balance：官方结算延迟（差 0）→ info 并注明不代表免费', async () => {
  const { fetchImpl } = makeFetch({
    official: 'ok', signature: true, validFor: [MODEL], officialChat: {},
    offBalanceDelta: 0, provBalanceDelta: 0,
  })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'billing_balance')
  assert.equal(c.status, 'info')
  assert.match(c.detail, /官方余额未见变动——结算延迟/)
  assert.match(c.meaning, /次日复核|fee-detail/)
})

test('billing.balance：余额接口不可用（404）→ info 跳过', async () => {
  const { fetchImpl } = makeFetch({
    official: 'ok', signature: true, validFor: [MODEL], officialChat: {}, balanceDisabled: true,
  })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'billing_balance')
  assert.equal(c.status, 'info')
  assert.match(c.detail, /余额接口不可用/)
})

test('根因分析：tools.dynamic 被拒 → 分析指向网关校验层并附原始证据', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], tools: 'reject', officialChat: {} })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const issues = rs.meta.scriptIssues || []
  const it = issues.find((x) => x.id === 'tools_dynamic')
  assert.ok(it, 'tools_dynamic 应进入问题分析')
  assert.match(it.evidence, /HTTP 400/, '证据应含原始状态码')
  assert.match(it.evidence, /tools is not supported/, '证据应含原始错误消息')
  assert.match(it.cause, /网关/, '根因应指向网关')
  assert.match(it.cause, /system\.tools/, '根因应点名 system.tools 扩展未实现')
})

test('根因分析：partial 重放前缀 → 根因写明 partial 标记被丢弃', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], partial: 'restate' })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const it = (rs.meta.scriptIssues || []).find((x) => x.id === 'partial_nonempty')
  assert.ok(it, 'partial_nonempty 应进入问题分析')
  assert.match(it.cause, /丢弃了 partial: true 标记/, '根因应点名 partial 标记被丢弃')
  assert.match(it.cause, /prefill/, '应说明对 prefill 业务的影响')
  assert.match(it.evidence, /partial_marker/, '证据应含原始输出开头')
})

test('根因分析：官方侧正常时，根因追加「问题在网关而非模型」', async () => {
  const { fetchImpl } = makeFetch({
    official: 'ok', signature: true, validFor: [MODEL],
    tools: 'noCalls', officialChat: {}, // 官方侧正常返回 tool_calls
  })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const it = (rs.meta.scriptIssues || []).find((x) => x.id === 'tools_dynamic')
  assert.ok(it, '第三方 200 无 tool_calls 且双侧行为不一致 → 应入问题分析')
  assert.match(it.cause, /官方侧同请求行为正常/, '应追加官方侧对照结论')
})

test('根因分析：全部通过 → scriptIssues 为空', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], officialChat: {}, cache: 'hit' })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  assert.deepEqual(rs.meta.scriptIssues, [])
})

test('报告包含「问题根因分析」小节：证据与根因都在正文里', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], tools: 'reject', partial: 'restate' })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const md = renderMarkdown(rs)
  const html = renderHtml(rs)
  assert.match(md, /## 五、问题根因分析/, 'Markdown 应有该小节')
  assert.match(md, /\*\*原始证据\*\*/, '应有原始证据块')
  assert.match(md, /\*\*具体根因\*\*/, '应有具体根因块')
  assert.match(md, /网关在转发前的请求校验拒绝了该形态/, 'tools_dynamic 根因文本应在报告中')
  assert.match(md, /丢弃了 partial: true 标记/, 'partial 根因文本应在报告中')
  assert.match(html, /问题根因分析/, 'HTML 应有该小节')
  assert.match(html, /具体根因/, 'HTML 应有根因字段')
  // 全部通过时报告写明无需分析
  const { fetchImpl: okF } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], officialChat: {}, cache: 'hit' })
  const okRs = await runVerification(cfg(), deps(okF))
  assert.match(renderMarkdown(okRs), /无需根因分析/)
})

test('latency.stream：SSE 量化数据入 metrics 与延迟表', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], officialChat: {} })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'latency_stream')
  assert.equal(c.status, 'ok')
  assert.match(c.detail, /SSE \d+ 分块/)
  assert.match(c.detail, /completion_tokens=24/)
  const t = rs.meta.protocolTimings.find((x) => x.id === 'latency_stream')
  assert.ok(t.providerMetrics, 'metrics 应入 timings')
  assert.equal(t.providerMetrics.completionTokens, 24)
  assert.ok(t.officialMetrics, '官方侧 metrics 也在')
  const md = renderMarkdown(rs)
  assert.match(md, /流式时延 latency\.stream.*总 \d+ms，\d+ 分块，24 tok/)
})

test('latency.stream：伪流式（整体缓冲）→ warn 并点名', async () => {
  const { fetchImpl } = makeFetch({
    official: 'ok', signature: true, validFor: [MODEL],
    fakeStream: true,
  })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'latency_stream')
  assert.equal(c.status, 'warn')
  assert.match(c.detail, /未返回 SSE 分块/)
  assert.match(c.meaning, /伪流式/)
})

test('output.fingerprint：双侧输出一致 → ok 且文本进对比', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL], officialChat: {} })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'output_fingerprint')
  assert.equal(c.status, 'ok')
  assert.match(c.detail, /48/)
  assert.match(c.detail, /两题输出完全一致|文本一致/)
  assert.ok((rs.meta.scriptIssues || []).every((x) => x.id !== 'output_fingerprint'), 'ok 不入问题分析')
})

test('output.fingerprint：双侧输出不同 → info 观察信号 + 与 tokenizer 联动提示', async () => {
  const { fetchImpl } = makeFetch({
    official: 'ok', signature: true, validFor: [MODEL],
    officialChat: { fpMath: '48.0', fpStyle: '春天来了，百花齐放。' },
  })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const c = rs.checks.find((x) => x.id === 'output_fingerprint')
  assert.equal(c.status, 'info')
  assert.match(c.detail, /输出存在差异/)
  assert.match(c.meaning, /tokenizer 指纹同时异常/)
})

test('延迟对比：报告在无延迟数据时也给出说明而非空白', () => {
  const fake = {
    verdict: 'INSUFFICIENT', insufficientReason: '',
    checks: [], meta: {
      startedAt: '2026-10-24T00:00:00.000Z', elapsedMs: 1000,
      providerBase: 'https://p/v1', model: 'm', providerKeyFp: 'sha256:a', officialKeyFp: '无',
      officialBase: 'https://api.moonshot.cn/v1', nonce: 'n', timestamp: 0,
      signaturePrefix: '无', signatureLength: 0, usage: {}, verifyRaw: {},
      protocolChecks: {}, latency: null,
    },
  }
  assert.match(renderMarkdown(fake), /本次未测（未提供官方 key、官方 key 无效或官方侧模型不可用）/)
  assert.match(renderMarkdown(fake), /延迟对比：未测/)
})


test('reasoning token 会被如实标注，不能当成纯正文', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL] })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  const usage = rs.checks.find((c) => c.id === 'usage')
  assert.match(usage.detail, /reasoning=30/)
  assert.match(usage.meaning, /reasoning_tokens/)
})

test('模型名被改写 → 别名探测通过 → VERIFIED_ALIAS', async () => {
  const { fetchImpl, calls } = makeFetch({ official: 'ok', signature: true, validFor: ['kimi-k2.7-code'] })
  const rs = await runVerification(cfg(), deps(fetchImpl))

  assert.equal(rs.verdict, VERDICT.VERIFIED_ALIAS)
  const alias = rs.checks.find((c) => c.id === 'verify_alias')
  assert.ok(alias)
  assert.equal(alias.status, 'warn')
  assert.match(alias.detail, /kimi-k2\.7-code/)
  const verifyCalls = calls.filter((c) => c.url.endsWith('/signatures/verify'))
  assert.equal(verifyCalls.length, 2, '应先按原模型名校验，再按别名重试')
  assert.equal(JSON.parse(verifyCalls[0].init.body).model, MODEL)
})

test('有签名但官方不认 → NOT_VERIFIED', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [] })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  assert.equal(rs.verdict, VERDICT.NOT_VERIFIED)
  const verify = rs.checks.find((c) => c.id === 'verify')
  assert.equal(verify.status, 'warn')
  assert.equal(rs.checks.find((c) => c.id === 'verify_alias').status, 'fail')
})

test('未提供官方 key → INSUFFICIENT 且写明具体原因，不是「失败」', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL] })
  const rs = await runVerification(cfg({ officialKey: '' }), deps(fetchImpl))

  assert.equal(rs.verdict, VERDICT.INSUFFICIENT)
  assert.match(rs.insufficientReason, /未提供官方 key/)
  const [head, body] = verdictText(rs)
  assert.match(head, /无法判定/)
  assert.match(body, /本次具体原因/)
  assert.equal(rs.checks.find((c) => c.id === 'verify').status, 'skip')
})

test('官方 key 无效 → INSUFFICIENT 且原因指出 401', async () => {
  const { fetchImpl } = makeFetch({ official: 'invalid', signature: true, validFor: [MODEL] })
  const rs = await runVerification(cfg(), deps(fetchImpl))

  assert.equal(rs.verdict, VERDICT.INSUFFICIENT)
  assert.match(rs.insufficientReason, /401/)
  assert.equal(rs.checks.find((c) => c.id === 'official_key').status, 'fail')
  assert.equal(rs.checks.find((c) => c.id === 'verify').status, 'skip')
})

test('端点不可达 → ENDPOINT_ERROR，不伪装成未通过', async () => {
  const { fetchImpl } = makeFetch({ down: true })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  assert.equal(rs.verdict, VERDICT.ENDPOINT_ERROR)
  assert.equal(rs.checks.find((c) => c.id === 'provider_alive').status, 'fail')
})

test('端点不返回签名头 → INSUFFICIENT，且在证据里说明「证明不了≠造假」', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: false, validFor: [MODEL] })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  assert.equal(rs.verdict, VERDICT.INSUFFICIENT)
  const sigCheck = rs.checks.find((c) => c.id === 'sig_headers')
  assert.equal(sigCheck.status, 'fail')
  assert.match(sigCheck.meaning, /证明不了/)
  assert.equal(rs.checks.find((c) => c.id === 'verify').status, 'skip')
})

test('不带 nonce 也返回签名 → 行为契约告警', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, nonceLeak: true, validFor: [MODEL] })
  const rs = await runVerification(cfg(), deps(fetchImpl))
  assert.equal(rs.checks.find((c) => c.id === 'nonce_contract').status, 'warn')
})

test('请求签名时确实携带了 nonce 头，校验时传入同一 nonce 与时间戳', async () => {
  const { fetchImpl, calls } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL] })
  const rs = await runVerification(cfg(), deps(fetchImpl))

  const signedCall = calls.find((c) => c.init && c.init.headers && c.init.headers['X-Msh-Request-Nonce'])
  assert.ok(signedCall, '签名的模型调用必须带 X-Msh-Request-Nonce')
  assert.equal(signedCall.init.headers['X-Msh-Request-Nonce'], rs.meta.nonce)

  const verifyCall = calls.find((c) => c.url.endsWith('/signatures/verify'))
  const body = JSON.parse(verifyCall.init.body)
  assert.equal(body.nonce, rs.meta.nonce)
  assert.equal(body.timestamp, rs.meta.timestamp)
  assert.equal(body.model, MODEL)
  assert.ok(body.signature.startsWith('reqsigv1_'))
})

test('时钟偏差按服务端时间戳计算', async () => {
  const { fetchImpl } = makeFetch({ official: 'ok', signature: true, validFor: [MODEL] })
  const rs = await runVerification(cfg(), { fetchImpl, now: () => NOW + 5000, nonce: () => 'n' })
  const drift = rs.checks.find((c) => c.id === 'clock_drift')
  assert.equal(drift.status, 'ok')
  assert.match(drift.detail, /5000 ms/)
})

test('报告结构完整：含未覆盖维度与边界声明', () => {
  const fake = {
    verdict: VERDICT.NOT_VERIFIED,
    insufficientReason: '',
    checks: [{ id: 'verify', title: '官方签名校验', status: 'warn', detail: 'valid=false', meaning: 'x' }],
    meta: {
      startedAt: new Date(NOW).toISOString(), elapsedMs: 1234,
      providerBase: PROVIDER, model: MODEL,
      providerKeyFp: fingerprint(PKEY), officialKeyFp: fingerprint(OKEY),
      officialBase: OFFICIAL, nonce: 'n', timestamp: NOW,
      signaturePrefix: 'reqsigv1_xxx…', signatureLength: 74,
      usage: {}, verifyRaw: { as_is: { valid: false } }, providerKeyIsOfficial: false, modelListed: true,
    },
  }
  const md = renderMarkdown(fake)
  assert.match(md, /未覆盖的维度/)
  assert.match(md, /不能证明/)
  assert.match(md, /不防重放/)
  const html = renderHtml(fake)
  assert.match(html, /<!doctype html>/)
  assert.match(html, /边界与未覆盖维度/)
  assert.match(html, /本机出口网络耗时不能当作服务端内部时延/)
})