/**
 * Kimi 请求签名校验 —— 纯逻辑核心
 *
 * 判定第三方端点是否真把请求交给 Kimi 官方 API、且未偷换模型：
 *   1) 用第三方 key 打第三方端点，带 X-Msh-Request-Nonce
 *   2) 读响应头 Msh-Request-Timestamp / Msh-Request-Signature
 *   3) 用官方 key 回源 POST /v1/signatures/verify 校验
 *
 * 全部副作用通过注入的 fetchImpl 发生，便于单测。
 * 安全约定：key 只存在于入参与内存，不落盘、不入报告，报告只留 sha256 指纹。
 */

import { createHash } from 'node:crypto'
import { PROTOCOL_SCRIPTS, median, scriptCurl, parseSse, codeFromNonce, diagnoseScript, lookupOfficialPrices } from './protocol-scripts.mjs'


export const DEFAULT_OFFICIAL_BASE = 'https://api.moonshot.cn/v1'
export const OFFICIAL_BASE_ALT = 'https://api.moonshot.ai/v1'

export const VERDICT = {
  VERIFIED_OFFICIAL: 'VERIFIED_OFFICIAL',
  VERIFIED_ALIAS: 'VERIFIED_ALIAS',
  NOT_VERIFIED: 'NOT_VERIFIED',
  INSUFFICIENT: 'INSUFFICIENT',
  ENDPOINT_ERROR: 'ENDPOINT_ERROR',
  COMPARE_ALIGNED: 'COMPARE_ALIGNED',
  COMPARE_DIVERGENT: 'COMPARE_DIVERGENT',
}

export const VERDICT_TEXT = {
  VERIFIED_OFFICIAL: [
    '官方签名校验通过',
    'Kimi 官方已确认在该时间点以请求中的模型名接受了本次 nonce。可以认定该端点确实转发到了 Kimi 官方 API，且模型名未被替换。',
  ],
  VERIFIED_ALIAS: [
    '通过，但模型名被改写',
    '签名只有改用官方模型名后才校验通过，说明第三方端点存在别名映射。这不等于偷换模型，但计价、限速、上下文长度须按官方对应的真实模型重新确认。',
  ],
  NOT_VERIFIED: [
    '校验未通过',
    '签名无法由 Kimi 官方确认。可能原因：签名非官方签发、路由到了其它服务、或模型被替换。不能再用「Kimi 官方」作为前提做评估。',
  ],
  INSUFFICIENT: [
    '无法判定（证据不足）',
    '缺少官方 key 或缺少签名响应头，无法回源校验。这不等于验证失败，也不等于端点造假——只能说明目前拿不到判定所需的证据。',
  ],
  ENDPOINT_ERROR: [
    '端点不可用',
    '第三方端点在本次校验中不可达或持续返回错误，未取得任何有效证据。',
  ],
  COMPARE_ALIGNED: [
    '双侧对齐（推理对比模式）',
    '第三方推理与官方 API 在全部协议脚本上行为一致：参数透传、消息保真、tokenizer 计数、输出指纹均对齐。这不证明权重相同，但说明第三方推理质量与官方口径对齐，可按对比结果评估接入。',
  ],
  COMPARE_DIVERGENT: [
    '双侧存在分歧（推理对比模式）',
    '第三方推理与官方 API 在部分脚本上行为不一致（见证据清单与根因分析）。分歧不代表造假——自部署推理本就可能与官方服务有实现差异；按分歧项评估对业务的影响。',
  ],
}

export const STATUS_MARK = { ok: '通过', warn: '注意', fail: '失败', skip: '跳过', info: '信息' }

/** key 指纹：可追溯、不可还原，用于多次校验之间比对同一把 key。 */
export function fingerprint(secret) {
  if (!secret) return '无'
  return 'sha256:' + createHash('sha256').update(secret).digest('hex').slice(0, 10)
}

function shortText(text, limit = 220) {
  if (!text) return ''
  const t = String(text).split(/\s+/).join(' ')
  return t.length <= limit ? t : t.slice(0, limit) + '…'
}

function errorMessage(body) {
  try {
    const j = JSON.parse(body)
    if (j && j.error && j.error.message) return String(j.error.message).slice(0, 200)
  } catch {
    /* 非 JSON */
  }
  return shortText(body, 160)
}

function newCheck(id, title, status, detail, meaning = '') {
  return { id, title, status, detail, meaning }
}

/** 单次 HTTP 请求，返回 {status, headers, text, ms, error}。headers 键为小写。 */
async function request(fetchImpl, method, url, { headers = {}, body, timeout = 30 } = {}) {
  const init = { method, headers: { 'Content-Type': 'application/json', ...headers }, cache: 'no-store' }
  if (body !== undefined) init.body = JSON.stringify(body)
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(timeout * 1000)
  const t0 = Date.now()
  try {
    const res = await fetchImpl(url, init)
    const text = await res.text()
    const lowered = {}
    res.headers.forEach((v, k) => { lowered[String(k).toLowerCase()] = v })
    return { status: res.status, headers: lowered, text, ms: Date.now() - t0, error: null }
  } catch (e) {
    return { status: 0, headers: {}, text: '', ms: Date.now() - t0, error: `${e.name || 'Error'}: ${e.message}` }
  }
}

function aliasCandidates(model) {
  const out = []
  if (model.endsWith('-highspeed')) out.push(model.slice(0, -'-highspeed'.length))
  if (model.endsWith('-preview')) out.push(model.slice(0, -'-preview'.length))
  if (model.includes('-')) out.push(model.slice(0, model.lastIndexOf('-')))
  return [...new Set(out)].filter((m) => m && m !== model)
}

/** 安全截断：报告观测值里出现的参数/续写文本，避免长内容刷屏。 */
function clip(text, limit = 160) {
  const t = String(text ?? '')
  return t.length <= limit ? t : `${t.slice(0, limit)}…(${t.length} 字符)`
}

/**
 * 执行一次完整校验。
 * @param {object} cfg {providerBase, providerKey, model, officialKey?, officialBase?, timeout?}
 * @param {object} deps {fetchImpl?, now?, nonce?}
 */
export async function runVerification(cfg, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch
  const now = deps.now || (() => Date.now())
  const nonce = deps.nonce ? deps.nonce() : (globalThis.crypto?.randomUUID?.() || String(Math.random()).slice(2))

  const providerBase = String(cfg.providerBase || '').replace(/\/+$/, '')
  const providerKey = String(cfg.providerKey || '')
  const model = String(cfg.model || '')
  const officialKey = String(cfg.officialKey || '')
  const officialBase = String(cfg.officialBase || DEFAULT_OFFICIAL_BASE).replace(/\/+$/, '')
  const timeout = Math.min(120, Math.max(5, Number(cfg.timeout) || 30))
  // 对比模式：relay=官转验证（签名回源）；infer=第三方推理 vs 官方（不做路由验证）
  const mode = cfg.mode === 'infer' ? 'infer' : 'relay'
  const INFER = mode === 'infer'

  const startedAt = new Date(now())
  const checks = []
  const step = (id, title, status, detail, meaning = '') =>
    checks.push(newCheck(id, title, status, detail, meaning))

  // ---- 1/2. 官方 key 有效性（中国站 + 国际站） ----
  let officialOk = false
  const officialStatus = {}
  if (officialKey) {
    for (const base of [officialBase, OFFICIAL_BASE_ALT]) {
      const r = await request(fetchImpl, 'GET', `${base}/models`, {
        headers: { Authorization: `Bearer ${officialKey}` }, timeout,
      })
      officialStatus[base] = r.status
      if (r.status === 200) officialOk = true
    }
  }
  if (!officialKey) {
    step('official_key', INFER ? '官方基线 key 有效性' : '官方 key 有效性', 'skip', '未提供官方 key',
      INFER
        ? '推理对比模式：没有官方 key 就没有对比基线，双侧对比全部跳过，只出第三方侧单侧结果'
        : '没有官方 key 就无法回源校验签名，结论只能是「无法判定」')
  } else if (officialOk) {
    step('official_key', INFER ? '官方基线 key 有效性' : '官方 key 有效性', 'ok', '官方域返回 200，key 可用',
      INFER ? '官方基线可用，全部协议脚本将双侧执行并对比' : '具备回源校验的前提条件')
  } else {
    const detail = Object.entries(officialStatus)
      .map(([b, s]) => `${b.replace('https://', '')} → HTTP ${s}`).join('；')
    step('official_key', INFER ? '官方基线 key 有效性' : '官方 key 有效性', 'fail', detail,
      INFER
        ? '这把 key 在官方域无效：无法作为对比基线，双侧对比将全部跳过。请填有效的官方 key'
        : '这把 key 在 Kimi 官方域无效，可能是第三方签发的 key。签名校验无法进行。')
  }

  // ---- 2.5 余额基线采集（billing.balance 余额差对账用）----
  // Kimi 官方：GET /v1/users/me/balance；第三方网关多为 OpenAI 兼容同款端点，404 则跳过。
  const getBalance = async (base, key) => {
    try {
      const r = await request(fetchImpl, 'GET', `${base}/users/me/balance`, {
        headers: { Authorization: `Bearer ${key}` }, timeout,
      })
      if (r.status !== 200) return { ok: false, status: r.status }
      const j = JSON.parse(r.text)
      const num = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v))
      const total = num(j?.data?.available_balance ?? j?.available_balance)
      if (total == null) return { ok: false, status: 200, raw: shortText(r.text, 80) }
      return { ok: true, total, cash: num(j?.data?.cash_balance ?? j?.cash_balance), voucher: num(j?.data?.voucher_balance ?? j?.voucher_balance) }
    } catch (e) {
      return { ok: false, status: 0, error: String(e.message || e) }
    }
  }
  const provBalanceBefore = (officialKey || providerKey) ? await getBalance(providerBase, providerKey) : { ok: false, status: 0 }
  const offBalanceBefore = (officialKey && officialOk) ? await getBalance(officialBase, officialKey) : { ok: false, status: 0 }

  // ---- 3/4. 第三方端点连通性与模型清单 ----
  const modelsRes = await request(fetchImpl, 'GET', `${providerBase}/models`, {
    headers: { Authorization: `Bearer ${providerKey}` }, timeout,
  })
  let modelListed = null
  if (modelsRes.error) {
    step('provider_alive', '第三方端点连通性', 'fail', modelsRes.error, '端点不可达，后续校验无法进行')
  } else if (modelsRes.status === 200) {
    let ids = []
    try {
      const j = JSON.parse(modelsRes.text)
      ids = Array.isArray(j?.data) ? j.data.map((d) => d?.id).filter(Boolean) : []
    } catch {
      ids = []
    }
    modelListed = ids.includes(model)
    step('provider_alive', '第三方端点连通性', 'ok', 'HTTP 200，OpenAI 兼容（/models 可读）',
      '协议形态正确，可按 OpenAI 兼容配置')
    if (modelListed) {
      step('model_listed', '模型 ID 是否在端点清单中', 'ok', `${model} 已在 /models 中`, '')
    } else {
      const kimi = ids.filter((m) => String(m).toLowerCase().includes('kimi')).slice(0, 6)
      step('model_listed', '模型 ID 是否在端点清单中', 'warn',
        `${model} 不在 /models 清单中；清单内 kimi 相关：${kimi.join('、') || '（无 kimi 相关模型）'}`,
        '模型名可能有别名映射，签名校验时需注意 model 字段')
    }
  } else {
    step('provider_alive', '第三方端点连通性', 'fail',
      `HTTP ${modelsRes.status} ${errorMessage(modelsRes.text)}`, '端点返回非 200，无法继续')
  }

  // ---- 5. 第三方 key 是否被官方域认可（仅 relay 模式适用）----
  let providerKeyIsOfficial = false
  if (INFER) {
    step('provider_key_origin', '第三方 key 的归属', 'skip', '推理对比模式不适用',
      '第三方推理服务用自部署权重与自有 key，本来就不是官方 key——这是正常形态，无需检查')
  } else if (providerKey && modelsRes.status === 200) {
    const r = await request(fetchImpl, 'GET', `${officialBase}/models`, {
      headers: { Authorization: `Bearer ${providerKey}` }, timeout,
    })
    providerKeyIsOfficial = r.status === 200
    if (r.status === 200) {
      step('provider_key_origin', '第三方 key 的归属', 'warn', '该 key 在官方域也返回 200',
        '这把 key 疑似官方 key 直接使用，需确认是否为转售/共享')
    } else {
      step('provider_key_origin', '第三方 key 的归属', 'info',
        `官方域 HTTP ${r.status}（${errorMessage(r.text) || '拒绝'}）`,
        'key 由第三方签发，不是 Kimi 官方 key —— 这是正常形态，但意味着必须靠签名回源才能证明路由')
    }
  }

  // ---- 6. 签名链：带 nonce ----
  const chatUrl = `${providerBase}/chat/completions`
  const payload = {
    model,
    messages: [{ role: 'user', content: '签名校验，请只回复 ok' }],
    max_tokens: 64,
  }
  const signed = await request(fetchImpl, 'POST', chatUrl, {
    headers: { Authorization: `Bearer ${providerKey}`, 'X-Msh-Request-Nonce': nonce },
    body: payload,
    timeout,
  })
  const sig = signed.headers['msh-request-signature'] || ''
  const tsRaw = signed.headers['msh-request-timestamp'] || ''
  const ts = Number.parseInt(tsRaw, 10) || null
  let usage = {}
  try { usage = JSON.parse(signed.text)?.usage || {} } catch { usage = {} }

  if (INFER) {
    step('sig_headers', '签名响应头（带 nonce）', 'skip', '推理对比模式不适用',
      '签名验证只对「声称官转」的服务有意义；第三方自部署推理本就不是官方路由，不做该检查')
  } else if (signed.error) {
    step('sig_headers', '签名响应头（带 nonce）', 'fail', signed.error, '网关不可达')
  } else if (signed.status !== 200) {
    step('sig_headers', '签名响应头（带 nonce）', 'fail',
      `HTTP ${signed.status} ${errorMessage(signed.text)}`, '模型调用失败，无法取签名')
  } else if (!sig || !ts) {
    step('sig_headers', '签名响应头（带 nonce）', 'fail',
      '未返回 Msh-Request-Signature / Msh-Request-Timestamp',
      '签名未透传或被剥离 → 无法证明该请求由 Kimi 官方处理（证明不了 ≠ 一定是假的）')
  } else {
    step('sig_headers', '签名响应头（带 nonce）', 'ok',
      `已返回 signature（${sig.length} 字符，前缀 ${sig.slice(0, 9)}）与 timestamp`,
      '具备回源校验条件')
  }

  // ---- 7. 时钟偏差 ----
  if (ts) {
    const drift = now() - ts
    if (Math.abs(drift) <= 120000) {
      step('clock_drift', '时间戳与本地时钟偏差', 'ok',
        `${drift} ms（签名锚定服务端时间，不取本地时间）`, '')
    } else {
      step('clock_drift', '时间戳与本地时钟偏差', 'warn', `${drift} ms，偏差较大`,
        '签名绑定服务端接受请求的毫秒时间戳；偏差大不影响校验，但说明本机时钟或链路过慢')
    }
  }

  // ---- 8. 行为契约：不带 nonce 不应给签名 ----
  const plain = await request(fetchImpl, 'POST', chatUrl, {
    headers: { Authorization: `Bearer ${providerKey}` },
    body: { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 },
    timeout,
  })
  if (INFER) {
    step('nonce_contract', '行为契约（不带 nonce）', 'skip', '推理对比模式不适用', '')
  } else if (plain.error || plain.status !== 200) {
    step('nonce_contract', '行为契约（不带 nonce）', 'skip',
      `对照请求失败 HTTP ${plain.status || plain.error}`, '无法观察该行为')
  } else if (plain.headers['msh-request-signature']) {
    step('nonce_contract', '行为契约（不带 nonce）', 'warn', '未携带 nonce 仍返回签名',
      '与官方规格不符（官方仅在携带 nonce 时签发），需进一步排查')
  } else {
    step('nonce_contract', '行为契约（不带 nonce）', 'ok',
      '未携带 nonce 时不返回签名，与官方规格一致',
      '弱正向信号：说明签名以 nonce 为触发条件。但不构成签名来源证明')
  }

  // ---- 9. 流式支持 ----
  const streamRes = await request(fetchImpl, 'POST', chatUrl, {
    headers: { Authorization: `Bearer ${providerKey}` },
    body: { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8, stream: true },
    timeout,
  })
  if (streamRes.error || streamRes.status !== 200) {
    step('stream', '流式（SSE）支持', 'skip', `HTTP ${streamRes.status || streamRes.error}`, '未测到流式能力')
  } else if (streamRes.text.trimStart().startsWith('data:')) {
    step('stream', '流式（SSE）支持', 'ok', `返回 data: 分块，首包 ${streamRes.ms} ms`,
      '可测 TTFT；注意该耗时为含网络的总耗时')
  } else {
    step('stream', '流式（SSE）支持', 'warn', '请求 stream=true 但未返回 SSE 分块',
      '可能不支持流式或返回被缓冲')
  }

  // ---- 10. token 计量口径 ----
  if (usage && Object.keys(usage).length) {
    const reasoning = usage?.completion_tokens_details?.reasoning_tokens
    let text = `prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`
    if (reasoning !== undefined && reasoning !== null) {
      text += `，其中 reasoning=${reasoning}`
      step('usage', 'Token 计量来源', 'ok', `${text}（服务端 usage）`,
        'completion_tokens 含 reasoning_tokens；算成本或 TPOT 时不能把输出量当成纯正文')
    } else {
      step('usage', 'Token 计量来源', 'ok', `${text}（服务端 usage）`, '服务端返回真实 usage，非本地估算')
    }
  } else if (signed.status === 200) {
    step('usage', 'Token 计量来源', 'warn', '响应未包含 usage 字段',
      'token 计数只能本地估算，不能作为验收数据')
  }

  // ---- 12+. 协议测试脚本（18 个）：每个在第三方与官方两侧各执行一遍 ----
  const protocolModel = String(cfg.protocolModel || '').trim() || model
  const officialProtocolModel = String(cfg.officialProtocolModel || '').trim() || protocolModel
  const protocolChecks = {}
  const protocolTimings = []
  const scripts = []
  const scriptIssues = []
  let officialModelMissingCount = 0
  const officialReady = !!(officialKey && officialOk)
  const officialWhyNot = !officialKey ? '未提供官方 key' : '官方 key 在官方域无效'

  const scriptCtx = { nonce }
  const billingSamples = [] // 每脚本双侧 usage 汇总（billing.parity 数据源，零新增请求）
  const extractUsage = (r) => {
    try {
      const u = JSON.parse(r.text)?.usage
      if (!u || typeof u.prompt_tokens !== 'number') return null
      const details = u.prompt_tokens_details || {}
      return {
        prompt_tokens: u.prompt_tokens,
        completion_tokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0,
        cached: details.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0,
        cacheWritten: details.cache_write_tokens ?? details.cache_creation_tokens ?? u.cache_write_tokens ?? 0,
        reasoning: u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? 0,
      }
    } catch { return null }
  }
  const runScriptSide = async (def, base, key, modelName, sideTag) => {
    const runs = def.runs(modelName, scriptCtx)
    const resps = []
    for (const one of runs) {
      resps.push(await request(fetchImpl, 'POST', `${base}/chat/completions`, {
        headers: { Authorization: `Bearer ${key}`, Accept: one.accept || 'application/json' },
        body: one.body,
        timeout,
      }))
    }
    // 动态链：脚本可依据第一步响应构造后续请求（如工具结果回环）
    if (def.followUp && resps.length && !resps[resps.length - 1].error) {
      const followBody = def.followUp(runs[0].body, resps[resps.length - 1])
      if (followBody) {
        resps.push(await request(fetchImpl, 'POST', `${base}/chat/completions`, {
          headers: { Authorization: `Bearer ${key}`, Accept: followBody.accept || 'application/json' },
          body: followBody.body,
          timeout,
        }))
      }
    }
    // 计费样本：每脚本取首个 200 响应的 usage（避免多请求脚本重复计）
    if (!def.id.startsWith('billing_')) {
      const ok = resps.find((r) => !r.error && r.status === 200)
      const u = ok ? extractUsage(ok) : null
      const slot = billingSamples.find((x) => x.id === def.id) || (billingSamples.push({ id: def.id }), billingSamples[billingSamples.length - 1])
      slot[sideTag] = u
    }
    return resps
  }

  const billingDef = PROTOCOL_SCRIPTS.find((d) => d.id === 'billing_parity')
  for (const def of PROTOCOL_SCRIPTS) {
    if (def.id === 'billing_parity') continue // 最后统一执行（依赖全部样本）
    if (!protocolModel) {
      step(def.id, def.title, 'skip', '未指定协议测试模型', '')
      protocolChecks[def.id] = 'skip'
      continue
    }
    const provResps = await runScriptSide(def, providerBase, providerKey, protocolModel, 'provider')
    let pv = def.evaluate(provResps, scriptCtx)
    const provMs = median(provResps.map((r) => (r.error ? null : r.ms)))

    let offResps = null
    let ov = null
    let officialNote = ''
    if (officialReady) {
      offResps = await runScriptSide(def, officialBase, officialKey, officialProtocolModel, 'official')
      const modelMissing = offResps.some((r) => r.status === 404 || (r.status === 400 && /model/i.test(String(r.text || ''))))
      if (modelMissing) {
        officialNote = `官方侧模型名 ${officialProtocolModel} 不可用，未做官方侧对比`
        officialModelMissingCount += 1
      } else {
        ov = def.evaluate(offResps, scriptCtx)
      }
    } else {
      officialNote = `${officialWhyNot}，未做官方侧对比`
    }
    // 跨侧对比钩子：tokenizer.parity / context.inject 这类「单侧 info、对比才有结论」的脚本
    let compareOverride = null
    const ovExecuted = !!ov // 官方侧是否真正执行（不受合并影响）
    const ovStatusSnapshot = ov ? ov.status : null
    const ovMetricsSnapshot = ov ? (ov.metrics || null) : null
    if (def.compare && provResps && offResps && ov) {
      const cmp = def.compare(provResps, offResps)
      pv = { ...pv, detail: `${pv.detail}；对比：${cmp.detail}`, meaning: cmp.meaning }
      compareOverride = cmp.status
      ov = null // 已合并进单侧行，不再重复输出官方行
    }
    // 官方侧只有真正执行了脚本才计官方用时；模型 404 的往返时间不是脚本用时
    const offMs = offResps && ovExecuted ? median(offResps.map((r) => (r.error ? null : r.ms))) : null

    const detailParts = [`第三方：${pv.detail}`]
    let status = compareOverride || pv.status
    let meaning = pv.meaning || ''
    if (ov) {
      detailParts.push(`官方：${ov.detail}`)
      if (ov.status === pv.status) {
        detailParts.push('双侧行为一致')
      } else {
        detailParts.push(`行为不一致（第三方=${pv.status}，官方=${ov.status}）`)
        meaning += ' 官方侧与第三方行为不一致——端点可能未透传该特性，或路由到了不同的模型/版本。'
        if (pv.status === 'ok') status = 'warn'
      }
    }
    detailParts.push(`用时：第三方 ${provMs != null ? `${provMs}ms` : '不可达'}${offMs != null ? `，官方 ${offMs}ms` : ''}`)
    if (officialNote) detailParts.push(officialNote)
    step(def.id, def.title, status, detailParts.join('；'), meaning)

    protocolChecks[def.id] = status
    protocolTimings.push({
      id: def.id,
      title: def.title,
      providerMs: provMs,
      officialMs: offMs,
      providerStatus: pv.status,
      officialStatus: ovStatusSnapshot,
      agree: compareOverride ? compareOverride === 'ok' : (ov ? ov.status === pv.status : null),
      providerMetrics: pv.metrics || null,
      officialMetrics: ovMetricsSnapshot || null,
    })
    scripts.push({
      id: def.id,
      title: def.title,
      note: def.note || '',
      url: `${providerBase}/chat/completions`,
      curl: scriptCurl(`${providerBase}/chat/completions`, def.runs(protocolModel, scriptCtx)[0].body, timeout),
      ...(def.followUp
        ? {
          followUpCurl: (() => {
            // 静态可复现近似体：tool_call_id 以 <第一步返回的 id> 占位
            const firstBody = def.runs(protocolModel, scriptCtx)[0].body
            const fake = { choices: [{ message: { tool_calls: [{ id: '<第一步返回的 tool_call_id>', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] } }] }
            const fu = def.followUp(firstBody, fake)
            return fu ? scriptCurl(`${providerBase}/chat/completions`, fu.body, timeout) : null
          })(),
        }
        : {}),
    })
    // 有问题的脚本：基于原始响应做根因分析，随报告交付。
    // info 级（自报身份/缓存计费/多模态探测等观察信号）不算问题，不入分析。
    const isProblem = (pv.status === 'fail' || pv.status === 'warn') || (ov && ov.status !== pv.status && pv.status !== 'info')
    if (isProblem) {
      scriptIssues.push(diagnoseScript(def, provResps, offResps, ov, scriptCtx))
    }
  }

  // ---- 19. 计费一致性（最后执行：汇总全部脚本的双侧 usage）----
  if (billingDef) {
    // 单价：面板自填优先；否则按官方 Base URL 查表
    const customPrices = cfg.customPrices || null
    let priceRef = null
    if (customPrices && customPrices.__autoRef) {
      // 面板未手改：直接用官方 resolve（含写价/思考价/峰谷/分档），与自查表同源
      priceRef = customPrices.__autoRef
    } else if (customPrices) {
      // 面板自填：平铺单价包装成统一 resolve 接口
      priceRef = {
        label: customPrices.label || '面板自填单价',
        source: '面板自填',
        note: customPrices.cacheWrite != null ? '缓存写入按面板自填 5m 档计（1h 档仅存档展示）' : '',
        modelKey: 'custom',
        resolve: () => ({
          in: customPrices.in, out: customPrices.out, cached: customPrices.cached,
          cacheWrite: customPrices.cacheWrite ?? null, cacheWrite1h: customPrices.cacheWrite1h ?? null,
          tier: '',
        }),
      }
    } else {
      // 单价档与「实际计费模型」对齐：协议脚本样本用协议模型；主链路（签名链）用主模型。
      // 两者不同型号时在标签注明，金额按协议模型档折算（样本主体来自协议脚本）。
      const protoRef = lookupOfficialPrices(officialBase, protocolModel)
      const mainRef = lookupOfficialPrices(officialBase, model)
      priceRef = protoRef
      if (protoRef && mainRef && protoRef.modelKey !== mainRef.modelKey) {
        const mainSample = mainRef.resolve({ prompt_tokens: 0 })
        priceRef = { ...protoRef, label: `${protoRef.label}；按协议模型 ${protocolModel}（${protoRef.modelKey}）计，主模型 ${model}（${mainRef.modelKey}）为输入 ${mainSample.in}/输出 ${mainSample.out}——如按主模型计费请自填单价` }
      }
    }
    scriptCtx.now = now
    scriptCtx.billingSamples = billingSamples.filter((x) => x.provider || x.official)
    scriptCtx.billingPrices = priceRef
    const provEvals = billingDef.evaluate([], scriptCtx)
    scriptCtx.billingResult = provEvals.billing || null
    // compare 语义：有官方侧样本时出计量一致性判定
    const hasPaired = scriptCtx.billingSamples.some((x) => x.provider && x.official)
    let bStatus = provEvals.status
    let bDetail = provEvals.detail
    let bMeaning = provEvals.meaning
    if (hasPaired) {
      const cmp = billingDef.compare([], [], scriptCtx)
      bStatus = cmp.status
      bDetail = `${provEvals.detail}；${cmp.detail}`
      bMeaning = cmp.meaning
    } else if (!officialReady) {
      bDetail = `${provEvals.detail}；未提供官方 key，仅第三方侧计量汇总`
    }
    step(billingDef.id, billingDef.title, bStatus, bDetail, bMeaning)
    protocolChecks[billingDef.id] = bStatus
    // billing 不发请求、无逐脚本延迟语义；仅在官方侧确实执行过（有配对可能）时入表，
    // 且不参与"官方模型全缺失"的计数（那是对协议脚本的判定）
    if (hasPaired || officialReady) {
      protocolTimings.push({
        id: billingDef.id, title: billingDef.title,
        providerMs: null, officialMs: null,
        providerStatus: bStatus, officialStatus: bStatus,
        agree: bStatus === 'ok' ? true : (bStatus === 'warn' ? false : null),
      })
    }
    scripts.push({
      id: billingDef.id, title: billingDef.title,
      note: billingDef.note || '',
      url: `${providerBase}/chat/completions`,
      curl: (() => {
        if (!priceRef) return '# billing.parity 不发起任何请求：数据来自本次全部协议脚本的 usage 汇总。\n# 单价：未匹配（需自填）。'
        const p0 = priceRef.resolve({ prompt_tokens: 0 }, now())
        const src = priceRef.source === '面板自填' ? '面板自填' : priceRef.source
        return `# billing.parity 不发起任何请求：数据来自本次全部协议脚本的 usage 汇总。\n# 单价（${src}）：输入 ${p0.in} / 缓存命中 ${p0.cached ?? '—'} / 输出 ${p0.out}${p0.thinkOut != null ? ` / 思考输出 ${p0.thinkOut}` : ''} 元/MTok。\n# 计费规则：${priceRef.note || '—'}`
      })(),
    })
    if (bStatus === 'warn') {
      scriptIssues.push({
        id: billingDef.id, title: billingDef.title,
        evidence: scriptCtx.billingSamples.map((x) => `${x.id}: 第三方 ${x.provider ? `${x.provider.prompt_tokens}in/${x.provider.completion_tokens}out` : '—'} vs 官方 ${x.official ? `${x.official.prompt_tokens}in/${x.official.completion_tokens}out` : '—'}`).join('；'),
        cause: '两侧对同一请求的 token 计数存在差异：若 tokenizer.parity 也异常，强烈怀疑底层模型不同（计数口径不同）；若 tokenizer 一致而计数不同，则计量字段被改写——账单不可直接采信，需与供应商对齐口径后重新结算。',
      })
    }
  }

  // ---- 20. 余额差对账 billing.balance ----
  // 官方/第三方各自：调用前余额 - 调用后余额 = 本次实际扣费，与 usage 折算金额比对。
  // 如实边界：官方结算有延迟（实时消耗延迟、当日账单次日 7:00 更新）——差为 0 不代表免费，只代表未结算。
  {
    const fmt2 = (x) => (x == null ? '—' : x.toFixed(4))
    const readSide = async (base, key, before) => {
      if (!key) return { skip: '未提供 key' }
      const after = await getBalance(base, key)
      if (!before.ok) return { skip: `余额接口不可用（HTTP ${before.status}）` }
      if (!after.ok) return { skip: `调用后余额接口不可用（HTTP ${after.status}）` }
      const delta = before.total - after.total
      return { before: before.total, after: after.total, delta }
    }
    const off = await readSide(officialBase, officialKey, offBalanceBefore)
    const prov = await readSide(providerBase, providerKey, provBalanceBefore)
    const parts = []
    let status = 'info'
    let meaning = ''
    if (prov.skip) {
      parts.push(`第三方：${prov.skip}`)
    } else {
      parts.push(`第三方：余额 ${prov.before} → ${prov.after}，本次扣费 ¥${fmt2(prov.delta)}`)
    }
    if (off.skip) {
      parts.push(`官方：${off.skip}`)
    } else {
      parts.push(`官方：余额 ${off.before} → ${off.after}，本次扣费 ¥${fmt2(off.delta)}`)
      const officialCost = scriptCtx.billingResult?.official?.officialPriceCost
      if (off.delta === 0) {
        parts.push('官方余额未见变动——结算延迟（官方：实时消耗有延迟，当日账单次日 7:00 更新）；差为 0 不代表免费')
        meaning = '余额差法受官方结算延迟限制：未结算时段的对账需次日复核，或以控制台 fee-detail 明细为准'
      } else if (officialCost != null && officialCost > 0) {
        const ratio = off.delta / officialCost
        if (ratio >= 0.8 && ratio <= 1.25) {
          status = 'ok'
          parts.push(`官方实际扣费 ¥${fmt2(off.delta)} 与 usage 折算 ¥${fmt2(officialCost)} 一致（±25% 内）`)
          meaning = '官方自身计费与响应 usage 字段自洽：usage 可作为对账依据'
        } else {
          status = 'warn'
          parts.push(`官方实际扣费 ¥${fmt2(off.delta)} 与 usage 折算 ¥${fmt2(officialCost)} 偏差 ${(100 * (ratio - 1)).toFixed(0)}%`)
          meaning = '实际扣费与 usage 折算明显不符：可能含未计入的附加费（如联网搜索按次计费）、代金券抵扣规则或延迟结算——以控制台 fee-detail 明细为准'
        }
      } else {
        parts.push('官方侧 usage 折算金额缺失，无法与余额差比对')
      }
      // 第三方差值（若可得）与官方口径的比值即"网关对你实际计费的倍率"
      if (!prov.skip && prov.delta > 0 && officialCost != null && officialCost > 0) {
        parts.push(`倍率：第三方实际扣费/官方口径 ≈ ${(prov.delta / officialCost).toFixed(2)}×`)
      }
    }
    scriptCtx.billingBalance = {
      provider: prov.skip ? { skip: prov.skip } : { before: prov.before, after: prov.after, delta: prov.delta },
      official: off.skip ? { skip: off.skip } : { before: off.before, after: off.after, delta: off.delta },
    }
    step('billing_balance', '余额对账 billing.balance', status, parts.join('；'),
      meaning || '余额差对账：调用前后余额差 vs usage 折算金额（官方结算有延迟，当日未结算时差为 0）')
    protocolChecks.billing_balance = status
    scripts.push({
      id: 'billing_balance', title: '余额对账 billing.balance',
      note: '调用前后各查一次 GET /users/me/balance，差值即本次实际扣费。官方无逐笔账单 API，这是唯一的自动对账途径。',
      url: `${officialBase}/users/me/balance`,
      curl: `# 余额差对账（轻量 GET，两侧各 2 次）：\ncurl -sS "${officialBase}/users/me/balance" -H "Authorization: Bearer <key 已隐去>"\n# 调用前、调用后各一次，差值 = 本次实际扣费；与 usage×单价 折算比对。\n# 边界：官方结算有延迟（当日账单次日 7:00 更新），差为 0 可能只是未结算。`,
    })
  }

  // ---- 延迟对比：逐脚本（同脚本同参数，只差端点与 key），不是总用时 ----
  let latency = null
  {
    const rows = protocolTimings.filter((p) => p.providerMs != null && p.officialMs != null)
    if (!officialKey) {
      step('latency_compare', '延迟对比（每脚本：官方 vs 第三方）', 'skip',
        '未提供官方 key，官方侧延迟不可测',
        '填入官方 key 后，每个协议脚本会在两侧各执行一遍并逐脚本对比用时')
    } else if (!officialReady) {
      step('latency_compare', '延迟对比（每脚本：官方 vs 第三方）', 'skip',
        '官方 key 在官方域无效，官方侧不可测', '换有效官方 key 后重跑')
    } else if (!rows.length && officialModelMissingCount > 0 && officialModelMissingCount === protocolTimings.filter((t) => t.id !== 'billing_parity').length) {
      step('latency_compare', '延迟对比（每脚本：官方 vs 第三方）', 'skip',
        `官方侧协议模型 ${officialProtocolModel} 不可用（HTTP 404），官方侧无法执行脚本`,
        '请核对「官方协议模型」字段填的是官方真实模型名，改对后重跑即可获得逐脚本对比')
    } else if (!rows.length) {
      step('latency_compare', '延迟对比（每脚本：官方 vs 第三方）', 'fail',
        `官方侧 ${protocolTimings.length} 个脚本全部不可测（请求失败）`,
        '无逐脚本对比数据；可能是官方侧限流或网络问题，建议稍后重跑')
    } else {
      const offMed = median(rows.map((r) => r.officialMs))
      const provMed = median(rows.map((r) => r.providerMs))
      const detail = rows
        .map((p) => `${p.id}：官方 ${p.officialMs}ms / 第三方 ${p.providerMs}ms（${p.providerMs >= p.officialMs ? '+' : ''}${p.providerMs - p.officialMs}ms）`)
        .join('；')
      step('latency_compare', '延迟对比（每脚本：官方 vs 第三方）', 'ok',
        `${detail}。可对比 ${rows.length}/${protocolTimings.length} 个脚本；中位：官方 ${offMed}ms vs 第三方 ${provMed}ms（第三方${provMed >= offMed ? '高' : '低'} ${Math.abs(provMed - offMed)}ms）`,
        '逐脚本对比同参数请求在两侧的用时；差异包含网关转发、地域路由与建连，不是官方服务端内部时延；方向性可信，非吞吐结论')
      latency = {
        perScript: protocolTimings,
        providerModel: protocolModel,
        officialModel: officialProtocolModel,
        summary: { compared: rows.length, officialMedian: offMed, providerMedian: provMed, deltaMs: provMed - offMed },
      }
    }
  }

  // ---- 11. 官方回源校验 ----
  let verifiedAsIs = null
  let verifiedAlias = null
  let aliasUsed = null
  const verifyRaw = {}

  const doVerify = async (m) => {
    const r = await request(fetchImpl, 'POST', `${officialBase}/signatures/verify`, {
      headers: { Authorization: `Bearer ${officialKey}` },
      body: { nonce, timestamp: ts, model: m, signature: sig },
      timeout,
    })
    let parsed
    try { parsed = JSON.parse(r.text) } catch { parsed = { _raw: shortText(r.text) } }
    return { status: r.status, body: parsed }
  }

  if (INFER) {
    step('verify', '官方签名校验', 'skip', '推理对比模式不适用',
      '模式二不验证「是否官转」——第三方自部署推理是合法形态，重点在双侧质量对比（见协议脚本与延迟表）')
  } else if (!(officialKey && officialOk && sig && ts)) {
    step('verify', '官方签名校验', 'skip', '缺少官方 key 或缺少签名头，无法回源校验',
      '结论为「无法判定」（INSUFFICIENT），不是「验证失败」')
  } else {
    const first = await doVerify(model)
    verifyRaw.as_is = first.body
    if (first.status === 200 && first.body?.valid === true) {
      verifiedAsIs = true
      step('verify', '官方签名校验', 'ok', `valid: true（model=${model}）`,
        'Kimi 官方在该时刻以该模型接受了此 nonce —— 路由与模型名均未被替换')
    } else {
      verifiedAsIs = false
      step('verify', '官方签名校验', 'warn',
        `HTTP ${first.status}，valid=${first.body?.valid}（model=${model}）`,
        '原样模型名未通过，检查是否存在别名映射')
      const cands = aliasCandidates(model)
      for (const cand of cands.slice(0, 3)) {
        const r = await doVerify(cand)
        verifyRaw[`alias_${cand}`] = r.body
        if (r.status === 200 && r.body?.valid === true) {
          verifiedAlias = true
          aliasUsed = cand
          step('verify_alias', '别名映射探测', 'warn',
            `以 ${cand} 校验通过 → 原请求模型名 ${model} 被改写为 ${cand}`,
            `属别名映射而非偷换模型，但计价/限速/上下文长度须按官方 ${cand} 口径重新确认`)
          break
        }
      }
      if (!verifiedAlias) {
        step('verify_alias', '别名映射探测', 'fail',
          `候选模型名均未通过（尝试：${cands.slice(0, 3).join('、') || '无'}）`,
          '签名与模型名不匹配，或签名并非 Kimi 官方签发')
      }
    }
  }

  // ---- 结论 ----
  const providerDown = checks.some((c) => c.id === 'provider_alive' && c.status === 'fail')
  let verdict
  let insufficientReason = ''
  if (providerDown) {
    verdict = VERDICT.ENDPOINT_ERROR
  } else if (INFER) {
    // 模式二：推理对比。结论只看双侧一致性与功能结果，不涉及签名。
    if (!(officialKey && officialOk)) {
      verdict = VERDICT.INSUFFICIENT
      insufficientReason = !officialKey
        ? '未提供官方 key，没有对比基线（推理模式不做路由验证，但双侧对比仍需官方 key）'
        : '官方 key 在官方域无效，无法作为对比基线'
    } else {
      const protocolFail = checks.some((c) => c.status === 'fail' && !['provider_alive', 'sig_headers', 'nonce_contract', 'verify', 'verify_alias', 'provider_key_origin'].includes(c.id))
      const disagree = (protocolTimings || []).some((t) => t.agree === false)
      verdict = (protocolFail || disagree) ? VERDICT.COMPARE_DIVERGENT : VERDICT.COMPARE_ALIGNED
    }
  } else if (!(officialKey && officialOk)) {
    verdict = VERDICT.INSUFFICIENT
    insufficientReason = !officialKey
      ? '未提供官方 key，缺少回源校验所需凭证'
      : '提供的官方 key 在 Kimi 官方域无效（HTTP 401），无法调用校验接口'
  } else if (!(sig && ts)) {
    verdict = VERDICT.INSUFFICIENT
    insufficientReason = '第三方端点未返回签名响应头，没有可提交校验的签名'
  } else if (verifiedAsIs) {
    verdict = VERDICT.VERIFIED_OFFICIAL
  } else if (verifiedAlias) {
    verdict = VERDICT.VERIFIED_ALIAS
  } else {
    verdict = VERDICT.NOT_VERIFIED
  }

  return {
    verdict,
    insufficientReason,
    checks,
    meta: {
      startedAt: startedAt.toISOString(),
      elapsedMs: now() - startedAt.getTime(),
      mode,
      providerBase,
      model,
      providerKeyFp: fingerprint(providerKey),
      officialKeyFp: fingerprint(officialKey),
      officialBase,
      nonce,
      timestamp: ts,
      signaturePrefix: sig ? `${sig.slice(0, 20)}…` : '无',
      signatureLength: sig.length,
      usage,
      verifyRaw,
      providerKeyIsOfficial,
      modelListed,
      protocolModel,
      officialProtocolModel,
      protocolChecks,
      protocolTimings,
      latency,
      scripts,
      scriptIssues,
      billing: scriptCtx.billingResult || null,
      billingBalance: scriptCtx.billingBalance || null,
    },
  }
}

export function verdictText(rs) {
  const [head, body] = VERDICT_TEXT[rs.verdict]
  const reason = rs.insufficientReason
  if (rs.verdict === VERDICT.INSUFFICIENT && reason) {
    return [head, `${body}本次具体原因：${reason}。`]
  }
  return [head, body]
}