/**
 * 报告渲染：Markdown（留档/邮件）与自包含 HTML（可直接打开或归档）。
 * 两者都不含密钥明文，只有 sha256 指纹。
 */
import { VERDICT, STATUS_MARK, verdictText } from './verify-core.mjs'

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const VERDICT_COLOR = {
  VERIFIED_OFFICIAL: '#0f7a48',
  VERIFIED_ALIAS: '#a35c00',
  NOT_VERIFIED: '#b42318',
  INSUFFICIENT: '#5b5b66',
  ENDPOINT_ERROR: '#b42318',
  COMPARE_ALIGNED: '#0f7a48',
  COMPARE_DIVERGENT: '#a35c00',
}

const fmtTime = (iso) => {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}

/** 综合分析：把结论、协议、延迟三个维度拼成给采购/接入方看的行动建议。 */
function analysisBlocks(rs) {
  const m = rs.meta
  const blocks = []
  const pc = m.protocolChecks || {}
  const byId = Object.fromEntries(rs.checks.map((c) => [c.id, c.status]))
  const failures = rs.checks.filter((c) => c.status === 'fail')
  const warns = rs.checks.filter((c) => c.status === 'warn')

  // 维度 1：路由可信度
  if (rs.verdict === 'VERIFIED_OFFICIAL') {
    blocks.push(['路由可信度：已证实',
      '官方回源校验通过，该端点确实把请求转给了 Kimi 官方且模型名未被替换。'])
  } else if (rs.verdict === 'VERIFIED_ALIAS') {
    blocks.push(['路由可信度：已证实但模型名被改写',
      '端点存在别名映射，非偷换模型；计价、限速与上下文长度须按官方真实模型口径重核。'])
  } else if (rs.verdict === 'NOT_VERIFIED') {
    blocks.push(['路由可信度：未证实',
      '签名无法由官方确认。不能以「Kimi 官方」为前提做任何评估，需先排查转发与签名来源。'])
  } else if (rs.verdict === 'INSUFFICIENT') {
    blocks.push(['路由可信度：未知（证据不足）',
      '这不是失败也不是造假，只是缺少判定证据。补齐官方 key 与签名响应头后重测即可。'])
  } else {
    blocks.push(['路由可信度：未取得',
      '端点本次不可达，全部维度均未测得。'])
  }

  // 维度 2：协议兼容性（16 个脚本 + 双侧一致性）
  {
    const names = {
      tools_dynamic: '动态工具', partial_nonempty: '前缀续写', temperature_zero: '确定性',
      json_mode: 'JSON 模式', stop_sequence: '截断控制', max_tokens_cap: '长度上限',
      tools_roundtrip: '工具回环', tokenizer_parity: 'Tokenizer 指纹', multi_turn_memory: '多轮记忆',
      system_fidelity: 'System 保真', json_schema_strict: 'Schema 约束', context_inject: '注入探测',
      cache_billing: '缓存计费', reasoning_effort: '思考深度', vision_probe: '多模态', identity_probe: '自报身份',
      latency_stream: '流式时延', output_fingerprint: '输出指纹', billing_parity: '计费一致性',
    }
    const order = Object.keys(names)
    const covered = order.filter((k) => pc[k])
    if (covered.length) {
      const label = (v) => v === 'ok' ? '通过' : v === 'warn' ? '注意' : v === 'fail' ? '失败' : '未对比'
      const brief = covered.map((k) => `${names[k]} ${label(pc[k])}`).join(' / ')
      // info = 仅观察/未对比（无官方 key 或观察信号），不算「未按规格工作」
      const issues = covered.filter((k) => pc[k] === 'fail' || pc[k] === 'warn').map((k) => names[k])
      const unverified = covered.filter((k) => pc[k] === 'info' || pc[k] === 'skip').map((k) => names[k])
      const disagree = (m.protocolTimings || []).filter((t) => t.agree === false)
      let extra = ''
      if (disagree.length) extra += ` 与官方侧行为不一致：${disagree.map((t) => t.title).join('、')}。`
      let text = ''
      if (issues.length) text += `以下能力在本端点未按规格工作：${issues.join('、')}。若业务依赖这些协议特性，须供应商修复后再接入；若不依赖，可按实测形态适配。`
      else text += `${covered.length} 个协议脚本全部按规格工作。`
      if (unverified.length) text += ` 未对比/仅观察（需官方 key 或观察信号）：${unverified.join('、')}。`
      blocks.push([`协议兼容性（${covered.length} 项）：${brief}`, text + extra])
    }
  }

  // 维度 3：延迟（逐脚本）
  if (m.latency && m.latency.summary && m.latency.summary.compared) {
    const su = m.latency.summary
    const pct = su.officialMedian > 0 ? `（+${Math.round((su.providerMedian / su.officialMedian - 1) * 100)}%）` : ''
    blocks.push([`延迟对比（逐脚本，${su.compared} 个可对比）：官方中位 ${su.officialMedian}ms vs 第三方中位 ${su.providerMedian}ms`,
      `第三方较官方${su.deltaMs >= 0 ? '高' : '低'} ${Math.abs(su.deltaMs)}ms ${pct}。每个协议脚本同参数在两侧各执行一遍，逐脚本用时见第四节表格；差异含网关转发与建连开销，方向性可信但非吞吐结论。`])
  } else {
    blocks.push(['延迟对比：未测',
      '本次未提供官方 key、官方 key 无效或官方侧模型不可用。想逐脚本比较两侧用时，填入有效官方 key 后重跑。'])
  }

  // 行动建议
  const advice = []
  if (rs.verdict === 'VERIFIED_OFFICIAL' && failures.length === 0) {
    advice.push('路由与协议均未见问题：可进入小规模试用，用真实业务负载验证时延与稳定性。')
  }
  if (rs.verdict === 'VERIFIED_ALIAS') advice.push('先与供应商确认别名映射的官方口径（计价/限速/上下文），再谈接入。')
  if (rs.verdict === 'NOT_VERIFIED') advice.push('把本报告发给供应商要求解释签名校验结果；修复前不要投产。')
  if (rs.verdict === 'INSUFFICIENT') advice.push('补齐官方 key 重跑一次，成本是一次 /models 请求。')
  const scriptAdvice = {
    tools_dynamic: '动态工具：让供应商修复 system.tools + tool_choice: required 的透传（无 content 的 system 消息不应被当作空消息拒收）。',
    partial_nonempty: '前缀续写：该端点未按 partial 前缀续写，prefill 类业务不可用，须修复或改架构。',
    temperature_zero: '确定性：temperature=0 两次输出不一致，输出一致性存疑，需供应商解释。',
    json_mode: 'JSON 模式：response_format 未生效，结构化输出业务不可用，须修复。',
    stop_sequence: '截断控制：stop 序列未被透传，需供应商修复。',
    max_tokens_cap: '长度上限：max_completion_tokens 未被遵守，超长输出会直接放大成本，须修复。',
    tools_roundtrip: '工具回环：tool 结果消息被拒或未被模型读取，agent 式业务（调用→执行→回传→作答）无法闭环，须修复。',
    tokenizer_parity: 'Tokenizer 指纹：两侧 token 计数不一致——恒定差是网关注入隐藏前缀；随长度放大则强烈怀疑模型被替换。要求供应商解释差值。',
    multi_turn_memory: '多轮记忆：早期轮次信息丢失（截断/摘要/改写），多轮业务在此端点不可靠，须修复或确认上下文管理策略。',
    system_fidelity: 'System 保真：system 消息被剥离/降级/改写，人设与规则类约束不可靠，须修复。',
    json_schema_strict: 'Schema 约束：json_schema strict 未生效（结构化输出止步于 json_object），需供应商修复或确认支持范围。',
    context_inject: '注入探测：极短请求的静态开销两侧不一致，网关疑似注入隐藏 system prompt 或 tools——会改变模型行为并增加计费，要求供应商披露。',
    reasoning_effort: '思考深度：reasoning_effort 被拒，思考深度控制不可用；注意其连带影响其他脚本的 low 设置。',
    latency_stream: '流式时延：端点返回伪流式（整体缓冲）或流式形态异常，TTFT 失真、打字机效果不可用，须修复。',
    billing_parity: '计费一致性：两侧对同一请求的 token 计数不同，账单不可直接采信——与供应商对齐计量口径后再结算。',
  }
  for (const [id, text] of Object.entries(scriptAdvice)) {
    if (pc[id] === 'fail') advice.push(text)
  }
  if (byId.tools_dynamic === 'warn') advice.push('动态工具未证实：让供应商确认 system.tools 与 tool_choice 的透传路径。')
  if (pc.temperature_zero === 'warn') advice.push('确定性：temperature=0 被端点拒绝或输出不稳定，让供应商确认采样参数的透传与放行策略。')
  if (byId.usage === 'warn') advice.push('响应无 usage 字段：token 计量只能本地估算，不能作为验收与结算依据。')
  if (warns.length === 0 && failures.length === 0 && rs.verdict === 'VERIFIED_OFFICIAL') {
    // 全绿，无需额外
  } else if (advice.length === 0) {
    advice.push('按证据清单逐项与供应商核对「注意」项后再决定。')
  }
  return { blocks, advice, failures, warns }
}

export function renderMarkdown(rs) {
  const [head, body] = verdictText(rs)
  const m = rs.meta
  const flat = String(body).replace(/\s*\n+\s*/g, ' ')
  const L = []
  const A = (s = '') => L.push(s)

  A(m.mode === 'infer' ? '# 模型端点对比报告（推理对比模式）' : '# Kimi 请求签名验证报告')
  A('')
  A('| 项 | 值 |')
  A('|---|---|')
  A(`| **结论** | **${head}** —— ${flat} |`)
  A(`| 结论代码 | \`${rs.verdict}\` |`)
  A(`| 校验时间 | ${fmtTime(m.startedAt)} |`)
  A(`| 耗时 | ${(m.elapsedMs / 1000).toFixed(1)} s |`)
  A(`| 第三方端点 | \`${m.providerBase}\` |`)
  A(`| 模型 | \`${m.model}\` |`)
  A(`| 第三方 key 指纹 | \`${m.providerKeyFp}\` |`)
  A(`| 官方 key 指纹 | \`${m.officialKeyFp}\` |`)
  A(`| 官方校验域 | \`${m.officialBase}\` |`)
  A('')
  A('> 报告不含任何密钥明文。指纹为 sha256 前 10 位，仅用于多次校验之间的比对。')
  A('')
  A('## 一、证据清单')
  A('')
  A('| # | 校验项 | 结果 | 观测值 | 说明 |')
  A('|---|---|---|---|---|')
  rs.checks.forEach((c, i) => {
    const detail = String(c.detail || '').replace(/\|/g, '\\|')
    const meaning = String(c.meaning || '').replace(/\|/g, '\\|')
    A(`| ${i + 1} | ${c.title} | ${STATUS_MARK[c.status] || c.status} | ${detail} | ${meaning} |`)
  })
  A('')
  A('## 二、签名链细节')
  A('')
  A('| 项 | 值 |')
  A('|---|---|')
  A(`| nonce | \`${m.nonce}\` |`)
  A(`| timestamp | \`${m.timestamp}\` |`)
  A(`| signature | \`${m.signaturePrefix}\`（共 ${m.signatureLength} 字符） |`)
  if (m.usage && Object.keys(m.usage).length) A(`| usage | \`${JSON.stringify(m.usage)}\` |`)
  A('')
  if (m.verifyRaw && Object.keys(m.verifyRaw).length) {
    A('官方 verify 原始返回：')
    A('')
    A('```json')
    A(JSON.stringify(m.verifyRaw, null, 2))
    A('```')
    A('')
  }
  A('## 三、这个结论能说明什么')
  A('')
  if (rs.verdict === VERDICT.COMPARE_ALIGNED || rs.verdict === VERDICT.COMPARE_DIVERGENT) {
    A('- 本报告为**推理对比模式**：不验证「是否官转」（第三方自部署推理是合法形态）。')
    A('- 双侧对比的是协议行为、tokenizer 计数、输出指纹与逐脚本延迟——一致性高说明第三方推理与官方口径对齐。')
    A('- **不能证明**权重、量化版本或训练细节相同；分歧项见证据清单与根因分析。')
  } else if (rs.verdict === VERDICT.VERIFIED_OFFICIAL || rs.verdict === VERDICT.VERIFIED_ALIAS) {
    A('- **能证明**：Kimi 官方在该时间点以该模型接受了这个 nonce，代理层没有把请求转给其它服务。')
    A('- **不能证明**：请求最终成功、响应内容完整未被二次改写、以及权重/量化版本一致。')
    A('- **不能证明**：temperature、max_tokens 等其它参数未被篡改——它们不在签名覆盖范围内。')
  } else if (rs.verdict === VERDICT.NOT_VERIFIED) {
    A('- 签名无法由官方确认，因此**不能**对外声称「已验证为 Kimi 官方」。')
    A('- **不能证明**该端点与 Kimi 官方之间存在任何可确认的转发关系——本次没有取得这类证据。')
    A('- 需要排查：第三方端点是否真的转发、是否改写模型名、是否自行生成签名头。')
  } else {
    A('- 本次**没有取得足以判定的证据**，结论是「未知」，不是「失败」也不是「造假」。')
    A('- **不能证明**该端点是否转发到官方；补齐官方 key 与签名响应头后可重新校验。')
  }
  A('')
  A('## 四、逐脚本延迟对比（官方 vs 第三方）')
  A('')
  if (m.latency && Array.isArray(m.latency.perScript) && m.latency.perScript.some((p) => p.officialMs != null)) {
    A('| 测试脚本 | 官方用时 | 第三方用时 | 差值 | 双侧行为 |')
    A('|---|---|---|---|---|')
    for (const p of m.latency.perScript) {
      const off = p.officialMs != null ? `${p.officialMs}ms` : '—'
      const prov = p.providerMs != null ? `${p.providerMs}ms` : '—'
      const delta = (p.officialMs != null && p.providerMs != null)
        ? `${p.providerMs >= p.officialMs ? '+' : ''}${p.providerMs - p.officialMs}ms`
        : '—'
      const agree = p.agree === true ? '一致' : p.agree === false ? '不一致' : '未对比'
      // 流式时延脚本：附量化明细（总耗时/分块/输出量）
      const extra = p.id === 'latency_stream' && p.providerMetrics
        ? `（总 ${p.providerMetrics.totalMs}ms，${p.providerMetrics.chunks} 分块${p.providerMetrics.completionTokens != null ? `，${p.providerMetrics.completionTokens} tok` : ''}${p.officialMetrics ? `；官方 总 ${p.officialMetrics.totalMs}ms，${p.officialMetrics.chunks} 分块` : ''}）`
        : ''
      A(`| ${p.title} | ${off} | ${prov} | ${delta} | ${agree}${extra} |`)
    }
    A('')
    if (m.latency.summary) {
      const su = m.latency.summary
      A(`可对比 ${su.compared} 个脚本；中位：官方 ${su.officialMedian}ms vs 第三方 ${su.providerMedian}ms（第三方${su.deltaMs >= 0 ? '高' : '低'} ${Math.abs(su.deltaMs)}ms）。`)
      A('')
      if (m.latency.providerModel !== m.latency.officialModel) {
        A('> 注意：两侧模型名不同（第三方 ' + m.latency.providerModel + ' vs 官方 ' + m.latency.officialModel + '），用时差包含模型差异本身。')
        A('')
      }
    }
    A('> 每个脚本同参数在两侧各执行一遍（只差端点与 key）。差异包含网关转发、地域路由与建连，不是官方服务端内部时延；方向性可信，但不是吞吐结论。')
  } else {
    A('本次未测（未提供官方 key、官方 key 无效或官方侧模型不可用）。填入有效官方 key 后重跑，即可获得逐脚本对比。')
  }
  A('')
  A('## 四B、计费一致性')
  A('')
  {
    const b = m.scripts && m.protocolChecks && rs.meta && null
    const billing = (m.latency && m.latency.perScript) ? null : null
    // 从 meta 直接拿 billing 数据（evaluate 的 billing 对象在 check.detail 里，此处从 meta.billing 拿）
    const bl = m.billing
    if (bl && bl.prices) {
      A(`单价基准：${bl.prices.label}`)
      A(`- 单价：输入 ${bl.prices.in} / 缓存命中 ${bl.prices.cached ?? '—'} / 输出 ${bl.prices.out}${bl.prices.thinkOut != null ? ` / 思考输出 ${bl.prices.thinkOut}` : ''}${bl.prices.cacheWrite != null ? (bl.prices.cacheWrite1h != null ? ` / 缓存写入5m ${bl.prices.cacheWrite}（1h 档 ${bl.prices.cacheWrite1h}）` : ` / 缓存写入 ${bl.prices.cacheWrite}`) : ''} 元/百万 token${bl.prices.tiers ? `；本次样本命中档位：${bl.prices.tiers}` : ''}${bl.usedCacheWrite ? '；写入费按官方默认 TTL 5min 档计（usage 无法区分实际 TTL）' : ''}`)
      A(`- 来源：${bl.prices.source === 'builtin' ? '官方定价页（2026-10-24 采集）' : bl.prices.source}${bl.usedThinkOut ? '；含思考模式输出价' : ''}`)
      A(`- 规则：${bl.prices.note || '—'}`)
      A('')
      A('| 侧 | 输入 tokens | 缓存命中 | 输出 tokens | 按官方价折算 |')
      A('|---|---|---|---|---|')
      A(`| 第三方（本次合计） | ${bl.provider.promptTokens} | ${bl.provider.cachedTokens} | ${bl.provider.completionTokens} | ¥${bl.provider.officialPriceCost?.toFixed(6) ?? '—'} |`)
      A(`| 官方侧（本次合计） | ${bl.official.promptTokens} | ${bl.official.cachedTokens} | ${bl.official.completionTokens} | ¥${bl.official.officialPriceCost?.toFixed(6) ?? '—'} |`)
      A('')
      A(`配对样本 ${bl.paired ?? bl.samples} 对${bl.avgPromptDelta != null ? `；逐请求输入 token 差均值 ${bl.avgPromptDelta.toFixed(1)}` : ''}。金额为「同一用量按官方单价计」的等价成本：模式一下你的实际支出取决于第三方报价，与官方价的差额即网关毛利/折扣；模式二下价格差含网关成本，仅供参考。`)
      A('')
      A('**计费场景矩阵**（billing.scenarios：四个维度各一对双侧请求，逐项配对比对）')
      A('')
      A('| 场景 | 测什么 |')
      A('|---|---|')
      A('| A 未命中+写入 | 随机新前缀首写：prompt_tokens / cache_write_tokens |')
      A('| B 缓存命中 | 同前缀二发：cached_tokens（命中后不收写入费） |')
      A('| C 输出计价 | 中长输出：completion_tokens |')
      A('| D 思考输出 | high effort：reasoning_tokens（计入输出计费） |')
      A('')
    } else {
      A('本次未生成计费对比（无 usage 样本或未匹配单价）。')
    }
    A('')
    // 余额差对账（billing.balance）
    const bb = m.billingBalance
    if (bb) {
      A('**余额差对账**（billing.balance：调用前后 `GET /users/me/balance` 差值 = 本次实际扣费）')
      A('')
      const fmtB = (x) => (x == null ? '—' : Number(x).toFixed(4))
      if (bb.provider && !bb.provider.skip) {
        A(`- 第三方：余额 ${bb.provider.before} → ${bb.provider.after}，实际扣费 ¥${fmtB(bb.provider.delta)}`)
      } else if (bb.provider) {
        A(`- 第三方：${bb.provider.skip}`)
      }
      if (bb.official && !bb.official.skip) {
        A(`- 官方：余额 ${bb.official.before} → ${bb.official.after}，实际扣费 ¥${fmtB(bb.official.delta)}`)
      } else if (bb.official) {
        A(`- 官方：${bb.official.skip}`)
      }
      A('- 边界：官方结算有延迟（实时消耗延迟、当日账单次日 7:00 更新）——差为 0 不代表免费，只代表未结算；最终以控制台 fee-detail 明细为准')
      A('')
    }
  }
  A('## 五、问题根因分析')
  A('')
  {
    const issues = m.scriptIssues || []
    if (!issues.length) {
      A('本次协议脚本全部通过（或在双侧行为一致），无需根因分析。')
    } else {
      A(`共 ${issues.length} 个脚本未按规格工作。以下逐项给出「原始证据 → 具体根因」，根因只陈述可观测证据支持的结论。`)
      A('')
      for (const it of issues) {
        A(`### ${it.title}`)
        A('')
        A('**原始证据**：')
        A('')
        A('```')
        A(it.evidence)
        A('```')
        A('')
        A(`**具体根因**：${it.cause}`)
        A('')
      }
    }
  }
  A('')
  A('## 六、综合分析与建议')
  A('')
  const an = analysisBlocks(rs)
  for (const [title, text] of an.blocks) {
    A(`- **${title}** —— ${text}`)
  }
  A('')
  if (an.advice.length) {
    A('**建议动作：**')
    A('')
    an.advice.forEach((s, i) => A(`${i + 1}. ${s}`))
    A('')
  }
  A(`本次证据：${rs.checks.length} 项，其中失败 ${an.failures.length} 项、注意 ${an.warns.length} 项。失败项是必须处理的问题；注意项是证据不充分或形态偏差，需要与供应商确认。`)
  A('')
  A('## 七、附录：测试脚本原文')
  A('')
  A('> 报告所有结论均可复现。以下为每个协议脚本发给**第三方端点**的 curl 原文（Authorization 一律隐去；发给官方侧的请求除 URL 与 key 外完全相同）。工具回环脚本附第二步动态请求体。')
  A('')
  for (const sc of (m.scripts || [])) {
    A(`### ${sc.title}`)
    A('')
    if (sc.note) A(`${sc.note}`)
    A('')
    A('```bash')
    A(sc.curl)
    A('```')
    A('')
    if (sc.followUpCurl) {
      A('第二步（工具结果回传，`tool_call_id` 以第一步实际返回为准）：')
      A('')
      A('```bash')
      A(sc.followUpCurl)
      A('```')
      A('')
    }
  }
  A('## 八、未覆盖的维度')
  A('')
  A('- 签名机制不覆盖响应体完整性校验，需另做一致性对比。')
  A('- 未测量队列与预填充拆分、reasoning token 独立时延、多轮与缓存命中场景。')
  A('- 本机出口网络的耗时不能当作服务端内部时延。')
  A('- 签名不防重放、无有效期窗口，防重放与时效需由调用方自行控制。')
  A('- 逐脚本延迟是单次测量（非多轮中位），抖动敏感；下单决策前应重跑 2–3 次取稳定值。')
  A('')
  A('---')
  A('生成工具：DSH 工作台「模型端点签名核验」')
  return L.join('\n')
}

export function renderHtml(rs, { standalone = true } = {}) {
  const [head, body] = verdictText(rs)
  const m = rs.meta
  const color = VERDICT_COLOR[rs.verdict] || '#5b5b66'
  const rows = rs.checks.map((c, i) => `<tr>
    <td class="num">${i + 1}</td>
    <td>${esc(c.title)}</td>
    <td><span class="pill s-${esc(c.status)}">${esc(STATUS_MARK[c.status] || c.status)}</span></td>
    <td class="mono">${esc(c.detail)}</td>
    <td class="muted">${esc(c.meaning || '')}</td>
  </tr>`).join('')
  const usageRow = m.usage && Object.keys(m.usage).length
    ? `<tr><th>usage</th><td class="mono">${esc(JSON.stringify(m.usage))}</td></tr>` : ''
  const verifyBlock = m.verifyRaw && Object.keys(m.verifyRaw).length
    ? `<h2>官方 verify 原始返回</h2><pre>${esc(JSON.stringify(m.verifyRaw, null, 2))}</pre>` : ''

  const perScriptRows = (m.latency && Array.isArray(m.latency.perScript) && m.latency.perScript.length)
    ? m.latency.perScript.map((p) => {
      const extra = p.id === 'latency_stream' && p.providerMetrics
        ? `<br><span class="muted">总 ${p.providerMetrics.totalMs}ms，${p.providerMetrics.chunks} 分块${p.providerMetrics.completionTokens != null ? `，${p.providerMetrics.completionTokens} tok` : ''}${p.officialMetrics ? `；官方 总 ${p.officialMetrics.totalMs}ms，${p.officialMetrics.chunks} 分块` : ''}</span>` : ''
      return `<tr>
    <td>${esc(p.title)}</td>
    <td class="mono">${p.officialMs != null ? `${p.officialMs}ms` : '—'}</td>
    <td class="mono">${p.providerMs != null ? `${p.providerMs}ms` : '—'}</td>
    <td class="mono">${(p.officialMs != null && p.providerMs != null) ? `${p.providerMs >= p.officialMs ? '+' : ''}${p.providerMs - p.officialMs}ms` : '—'}</td>
    <td>${p.agree === true ? '一致' : p.agree === false ? '不一致' : '未对比'}${extra}</td>
  </tr>`
    }).join('\n  ') : ''
  const hasLatency = m.latency && Array.isArray(m.latency.perScript) && m.latency.perScript.some((p) => p.officialMs != null)
  const latencyBlock = hasLatency
    ? `<h2>逐脚本延迟对比（官方 vs 第三方）</h2>
<table class="ev"><thead><tr><th>测试脚本</th><th>官方用时</th><th>第三方用时</th><th>差值</th><th>双侧行为</th></tr></thead>
<tbody>${perScriptRows}</tbody></table>
${m.latency.summary ? `<p class="muted">可对比 ${m.latency.summary.compared} 个脚本；中位：官方 ${m.latency.summary.officialMedian}ms vs 第三方 ${m.latency.summary.providerMedian}ms（第三方${m.latency.summary.deltaMs >= 0 ? '高' : '低'} ${Math.abs(m.latency.summary.deltaMs)}ms）。</p>` : ''}
<p class="muted">每个脚本同参数在两侧各执行一遍（只差端点与 key）。差异包含网关转发、地域路由与建连，不是官方服务端内部时延；方向性可信，但不是吞吐结论。</p>`
    : '<h2>逐脚本延迟对比（官方 vs 第三方）</h2><p class="muted">本次未测（未提供官方 key、官方 key 无效或官方侧模型不可用）。填入有效官方 key 后重跑即可。</p>'

  const scriptsBlock = (m.scripts || []).length
    ? `<h2>附录：测试脚本原文</h2>
<p class="muted">报告所有结论均可复现。以下为每个协议脚本发给第三方端点的 curl 原文（Authorization 一律隐去；发给官方侧的请求除 URL 与 key 外完全相同）。工具回环脚本附第二步动态请求体。</p>
${m.scripts.map((sc) => `<h3 style="font-size:14px;margin:18px 0 6px">${esc(sc.title)}</h3>
${sc.note ? `<p class="muted" style="margin:0 0 8px">${esc(sc.note)}</p>` : ''}
<pre>${esc(sc.curl)}</pre>
${sc.followUpCurl ? `<p class="muted" style="margin:8px 0 6px">第二步（工具结果回传，tool_call_id 以第一步实际返回为准）：</p><pre>${esc(sc.followUpCurl)}</pre>` : ''}`).join('\n')}`
    : ''

  const an = analysisBlocks(rs)
  const analysisBlock = `<h2>综合分析与建议</h2>
<ul class="bounds">
  ${an.blocks.map(([t, s]) => `<li><b>${esc(t)}</b> —— ${esc(s)}</li>`).join('\n  ')}
</ul>
${an.advice.length ? `<h3 style="font-size:14px;margin:18px 0 8px">建议动作</h3>
<ol style="color:var(--text2);padding-left:22px;font-size:13.5px">
  ${an.advice.map((s) => `<li style="margin:5px 0">${esc(s)}</li>`).join('\n  ')}
</ol>` : ''}
<p class="muted">本次证据：${rs.checks.length} 项，其中失败 ${an.failures.length} 项、注意 ${an.warns.length} 项。失败项是必须处理的问题；注意项是证据不充分或形态偏差，需要与供应商确认。</p>`

  const issuesBlock = (m.scriptIssues || []).length
    ? `<h2>问题根因分析</h2>
<p class="muted">共 ${(m.scriptIssues || []).length} 个脚本未按规格工作。逐项给出「原始证据 → 具体根因」，根因只陈述可观测证据支持的结论。</p>
${m.scriptIssues.map((it) => `<h3 style="font-size:14px;margin:18px 0 6px">${esc(it.title)}</h3>
<p class="muted" style="margin:0 0 6px">原始证据</p>
<pre>${esc(it.evidence)}</pre>
<p style="margin:8px 0 0;color:var(--text2);font-size:13.5px"><b>具体根因</b>：${esc(it.cause)}</p>`).join('\n')}`
    : ''

  const inner = `
<div class="verdict" style="border-left-color:${color}">
  <div class="k">结论</div>
  <div class="t" style="color:${color}">${esc(head)}</div>
  <p>${esc(body)}</p>
</div>
<h2>校验对象</h2>
<table class="kv">
  <tr><th>结论代码</th><td class="mono">${esc(rs.verdict)}</td></tr>
  <tr><th>校验时间</th><td>${esc(fmtTime(m.startedAt))}</td></tr>
  <tr><th>耗时</th><td>${(m.elapsedMs / 1000).toFixed(1)} s</td></tr>
  <tr><th>第三方端点</th><td class="mono">${esc(m.providerBase)}</td></tr>
  <tr><th>模型</th><td class="mono">${esc(m.model)}</td></tr>
  <tr><th>第三方 key 指纹</th><td class="mono">${esc(m.providerKeyFp)}</td></tr>
  <tr><th>官方 key 指纹</th><td class="mono">${esc(m.officialKeyFp)}</td></tr>
  <tr><th>官方校验域</th><td class="mono">${esc(m.officialBase)}</td></tr>
  <tr><th>nonce</th><td class="mono">${esc(m.nonce)}</td></tr>
  <tr><th>timestamp</th><td class="mono">${esc(m.timestamp)}</td></tr>
  <tr><th>signature</th><td class="mono">${esc(m.signaturePrefix)}（共 ${m.signatureLength} 字符）</td></tr>
  ${usageRow}
</table>
<h2>证据清单</h2>
<table class="ev"><thead><tr><th>#</th><th>校验项</th><th>结果</th><th>观测值</th><th>说明</th></tr></thead>
<tbody>${rows}</tbody></table>
${verifyBlock}
${latencyBlock}
${issuesBlock}
${analysisBlock}
${scriptsBlock}
<h2>边界与未覆盖维度</h2>
<ul class="bounds">
  <li>签名只证明「Kimi 官方在该时刻以该模型接受了此 nonce」，<b>不证明</b>请求成功、响应内容完整未被改写、权重或量化版本一致。</li>
  <li>temperature、max_tokens 等参数不在签名覆盖范围内，被篡改不会导致 valid:false。</li>
  <li>未测量：队列与预填充拆分、reasoning token 独立时延、多轮与缓存命中场景。</li>
  <li>本机出口网络耗时不能当作服务端内部时延。</li>
  <li>签名不防重放、无有效期窗口，防重放与时效需由调用方自行控制。</li>
  <li>逐脚本延迟是单次测量（非多轮中位），抖动敏感；下单决策前应重跑 2–3 次取稳定值。</li>
</ul>
<p class="foot">报告不含任何密钥明文；指纹为 sha256 前 10 位，仅用于多次校验之间比对。</p>`

  if (!standalone) return inner

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kimi 请求签名验证报告 · ${esc(head)}</title>
<style>
:root{--bg:#f7f7f9;--surface:#fff;--border:#e4e4e9;--text:#16161d;--text2:#4a4a57;--muted:#75757f}
*{box-sizing:border-box}
body{margin:0;padding:48px 24px;background:var(--bg);color:var(--text);
font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
.wrap{max-width:1000px;margin:0 auto}
h1{font-size:24px;letter-spacing:-.02em;margin:0 0 4px}
h2{font-size:15px;font-weight:600;margin:32px 0 12px}
.verdict{background:var(--surface);border:1px solid var(--border);border-left:4px solid #5b5b66;
border-radius:12px;padding:24px;margin:20px 0 24px}
.verdict .k{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
.verdict .t{font-size:22px;font-weight:650;letter-spacing:-.02em;margin-bottom:8px}
.verdict p{margin:0;color:var(--text2);max-width:72ch}
table{width:100%;border-collapse:collapse;font-size:13.5px;background:var(--surface);
border:1px solid var(--border);border-radius:12px;overflow:hidden}
.kv th{width:190px;text-align:left;font-weight:400;color:var(--muted);padding:10px 16px;
background:#f9fafb;border-bottom:1px solid var(--border)}
.kv td{padding:10px 16px;border-bottom:1px solid var(--border)}
.kv tr:last-child th,.kv tr:last-child td{border-bottom:0}
.ev th{text-align:left;font-weight:500;color:var(--muted);padding:10px 12px;
border-bottom:1px solid var(--border);font-size:12.5px}
.ev td{padding:11px 12px;border-bottom:1px solid var(--border);vertical-align:top}
.ev tr:last-child td{border-bottom:0}
.ev td.num{color:var(--muted);width:34px;font-variant-numeric:tabular-nums}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;word-break:break-all}
.muted{color:var(--muted)}
.pill{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:500;white-space:nowrap}
.s-ok{background:#e7f8ef;color:#0f7a48}.s-warn{background:#fef4e2;color:#a35c00}
.s-fail{background:#fdeaea;color:#b42318}.s-skip,.s-info{background:#f0f0f4;color:#5b5b66}
pre{background:#16161d;color:#e4e4e9;padding:16px;border-radius:12px;overflow:auto;
font-size:12.5px;line-height:1.6;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.bounds{color:var(--text2);padding-left:20px;font-size:13.5px}
.bounds li{margin:6px 0}.bounds b{color:var(--text)}
.foot{color:var(--muted);font-size:12.5px;margin-top:32px;border-top:1px solid var(--border);padding-top:14px}
</style></head><body><div class="wrap">
<h1>Kimi 请求签名验证报告</h1>
<div class="muted" style="font-size:13px">${esc(fmtTime(m.startedAt))} · 耗时 ${(m.elapsedMs / 1000).toFixed(1)} s</div>
${inner}
</div></body></html>`
}