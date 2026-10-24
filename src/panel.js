window.__ModuleLoader__.load({ id: 'dsh-kimi-signature-workbench', factory: (require) => {
  const React = require('react')
  const { useState, useEffect, useRef, useCallback } = React
  const h = React.createElement
  const CSS = __CSS__

  const API = '/api/kimi-signature-workbench/'
  const LS_KEY = 'ksv-form-v1'

  const VERDICT_META = {
    VERIFIED_OFFICIAL: { label: '通过', tone: 'ok', hint: '可认定路由到 Kimi 官方、模型未被替换' },
    VERIFIED_ALIAS: { label: '别名映射', tone: 'warn', hint: '通过，但模型名被改写，口径需重核' },
    NOT_VERIFIED: { label: '未通过', tone: 'bad', hint: '不能对外声称已验证为 Kimi 官方' },
    INSUFFICIENT: { label: '无法判定', tone: 'muted', hint: '证据不足，不等于失败或造假' },
    ENDPOINT_ERROR: { label: '端点不可用', tone: 'bad', hint: '未取得任何有效证据' },
    COMPARE_ALIGNED: { label: '双侧对齐', tone: 'ok', hint: '第三方推理与官方 API 行为一致（不证明权重相同）' },
    COMPARE_DIVERGENT: { label: '双侧分歧', tone: 'warn', hint: '第三方推理与官方存在行为差异，按分歧项评估' },
  }

  // 官方 Base URL 预设（推理对比模式可换厂商）
  const OFFICIAL_PRESETS = [
    { label: 'Kimi 官方', base: 'https://api.moonshot.cn/v1' },
    { label: 'DeepSeek', base: 'https://api.deepseek.com' },
    { label: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4' },
    { label: 'MiniMax', base: 'https://api.minimaxi.com/v1' },
    { label: '阿里百炼', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  ]
  const STATUS_LABEL = { ok: '通过', warn: '注意', fail: '失败', skip: '跳过', info: '信息' }

  function loadForm() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
      return {
        providerBase: typeof raw.providerBase === 'string' ? raw.providerBase : '',
        model: typeof raw.model === 'string' ? raw.model : 'kimi-k2.7-code-highspeed',
        protocolModel: typeof raw.protocolModel === 'string' ? raw.protocolModel : '',
        officialProtocolModel: typeof raw.officialProtocolModel === 'string' ? raw.officialProtocolModel : '',
        officialBase: typeof raw.officialBase === 'string' ? raw.officialBase : 'https://api.moonshot.cn/v1',
        mode: raw.mode === 'infer' ? 'infer' : 'relay',
        priceModel: typeof raw.priceModel === 'string' ? raw.priceModel : '',
        priceIn: raw.priceIn || '', priceCached: raw.priceCached || '', priceWrite5m: raw.priceWrite5m || '', priceWrite1h: raw.priceWrite1h || '', priceOut: raw.priceOut || '',
        timeout: Number(raw.timeout) >= 5 ? Number(raw.timeout) : 30,
      }
    } catch {
      return { providerBase: '', model: 'kimi-k2.7-code-highspeed', protocolModel: '', officialProtocolModel: '', officialBase: 'https://api.moonshot.cn/v1', mode: 'relay', priceModel: '', priceIn: '', priceCached: '', priceWrite5m: '', priceWrite1h: '', priceOut: '', timeout: 30 }
    }
  }

  // 只持久化非敏感字段：端点、模型、协议测试模型、超时。两把 key 永不写入存储。
  function saveForm(v) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        providerBase: v.providerBase, model: v.model,
        protocolModel: v.protocolModel, officialProtocolModel: v.officialProtocolModel,
        officialBase: v.officialBase, mode: v.mode,
        priceModel: v.priceModel,
        priceIn: v.priceIn, priceCached: v.priceCached, priceWrite5m: v.priceWrite5m, priceWrite1h: v.priceWrite1h, priceOut: v.priceOut,
        timeout: v.timeout,
      }))
    } catch { /* 隐私模式等场景忽略 */ }
  }

  function apply(ctx) {
    const STYLE_ID = 'dsh-kimi-signature-workbench-style'
    ctx.effect(() => {
      const tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    })

    function Panel({ service, entry, conversation } = {}) {
      const saved = useRef(loadForm())
      const [providerBase, setProviderBase] = useState(saved.current.providerBase)
      const [model, setModel] = useState(saved.current.model)
      const [protocolModel, setProtocolModel] = useState(saved.current.protocolModel)
      const [officialProtocolModel, setOfficialProtocolModel] = useState(saved.current.officialProtocolModel)
      const [officialBase, setOfficialBase] = useState(saved.current.officialBase)
      const [mode, setMode] = useState(saved.current.mode)
      const [priceNotice, setPriceNotice] = useState('')
      const [priceModel, setPriceModel] = useState(saved.current.priceModel || '')
      const [priceModelList, setPriceModelList] = useState(null) // { vendor, models } | null
      const [priceIn, setPriceIn] = useState(saved.current.priceIn || '')
      const [priceCached, setPriceCached] = useState(saved.current.priceCached || '')
      const [priceWrite5m, setPriceWrite5m] = useState(saved.current.priceWrite5m || '')
      const [priceWrite1h, setPriceWrite1h] = useState(saved.current.priceWrite1h || '')
      const [priceOut, setPriceOut] = useState(saved.current.priceOut || '')
      const [timeout, setTimeoutSec] = useState(saved.current.timeout)
      const [providerKey, setProviderKey] = useState('')
      const [officialKey, setOfficialKey] = useState('')
      const [showKeys, setShowKeys] = useState(false)
      const [rememberKeys, setRememberKeys] = useState(false)
      const [keysSavedAt, setKeysSavedAt] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [result, setResult] = useState(null)
      const [chatOpen, setChatOpen] = useState(true)
      const [history, setHistory] = useState([])
      const [host, setHost] = useState(() => (service && service.getSnapshot ? service.getSnapshot() : null))
      const timer = useRef(null)

      useEffect(() => {
        if (!service || !service.subscribe) return undefined
        const off = service.subscribe(() => setHost(service.getSnapshot()))
        return off
      }, [service])

      // 官方单价自动带出：模型/官方 Base URL 变化时查询；手改过（priceTouched）则尊重手填
      const [priceTouched, setPriceTouched] = useState(false)
      const priceQueried = useRef('')
      const autoFillPrices = useCallback(async () => {
        if (priceTouched) return
        // 单价跟「计价模型」走：下拉选了谁就用谁；没选则跟随协议测试模型（=主模型兜底）
        const m = priceModel.trim() || protocolModel.trim() || model.trim()
        const b = officialBase.trim()
        if (!m || !b) return
        const key = `${b}|${m}`
        if (priceQueried.current === key) return
        priceQueried.current = key
        try {
          const r = await fetch(`${API}price-lookup?base=${encodeURIComponent(b)}&model=${encodeURIComponent(m)}`, { credentials: 'same-origin', cache: 'no-store' })
          if (!r.ok) return
          const j = await r.json()
          if (j.found) {
            setPriceIn(String(j.in))
            setPriceCached(String(j.cached ?? j.in))
            setPriceWrite5m(j.cacheWrite != null ? String(j.cacheWrite) : '')
            setPriceWrite1h(j.cacheWrite1h != null ? String(j.cacheWrite1h) : '')
            setPriceOut(String(j.out))
            setPriceNotice(`已按 ${j.modelKey || m} 自动填入官方价（输入 ${j.in}/缓存 ${j.cached ?? '—'}${j.cacheWrite != null ? (j.cacheWrite1h != null ? `/写入5m ${j.cacheWrite}·1h ${j.cacheWrite1h}` : `/写入 ${j.cacheWrite}`) : ''}/输出 ${j.out}${j.thinkOut != null ? `/思考 ${j.thinkOut}` : ''}）——可手改`)
            if (timer.current) clearTimeout(timer.current)
            timer.current = setTimeout(() => setPriceNotice(''), 5000)
          } else {
            setPriceNotice(j.note || '未收录该厂商单价，请手填')
            if (timer.current) clearTimeout(timer.current)
            timer.current = setTimeout(() => setPriceNotice(''), 5000)
          }
        } catch { /* 查询失败不阻塞 */ }
      }, [priceModel, protocolModel, model, officialBase, priceTouched])

      // 官方 Base URL 变化 → 拉取该厂商可选型号，重置计价模型为空（跟随协议模型）
      useEffect(() => {
        let cancelled = false
        ;(async () => {
          try {
            const r = await fetch(`${API}price-models?base=${encodeURIComponent(officialBase.trim())}`, { credentials: 'same-origin', cache: 'no-store' })
            if (!r.ok) return
            const j = await r.json()
            if (cancelled) return
            setPriceModelList(j.found ? j : null)
            setPriceModel((cur) => (cur && j.found && j.models.some((x) => x.key === cur) ? cur : ''))
          } catch { /* 清单加载失败不阻塞 */ }
        })()
        return () => { cancelled = true }
      }, [officialBase])

      const loadHistory = useCallback(async () => {
        try {
          const r = await fetch(`${API}reports`, { credentials: 'same-origin', cache: 'no-store' })
          if (!r.ok) return
          const j = await r.json()
          setHistory(Array.isArray(j.items) ? j.items : [])
        } catch { /* 历史读取失败不影响主流程 */ }
      }, [])

      useEffect(() => {
        autoFillPrices()
      }, [autoFillPrices])

      useEffect(() => {
        loadHistory()
        // 已保存的 key 回填（用户此前显式勾选过「记住」）
        ;(async () => {
          try {
            const r = await fetch(`${API}keys`, { credentials: 'same-origin', cache: 'no-store' })
            if (!r.ok) return
            const j = await r.json()
            if (j.saved) {
              if (j.providerKey) setProviderKey(j.providerKey)
              if (j.officialKey) setOfficialKey(j.officialKey)
              setRememberKeys(true)
              setKeysSavedAt(j.savedAt || null)
            }
          } catch { /* 回填失败不阻塞首屏 */ }
        })()
        return () => { if (timer.current) clearTimeout(timer.current) }
      }, [loadHistory])

      /** 校验成功后按用户意愿同步保存/清除（只在此时写，不在每次击键时写）。 */
      const syncKeys = async () => {
        try {
          if (rememberKeys) {
            const r = await fetch(`${API}keys`, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ providerKey: providerKey.trim(), officialKey: officialKey.trim() }),
            })
            if (r.ok) setKeysSavedAt(new Date().toISOString())
          } else if (keysSavedAt) {
            await fetch(`${API}keys`, { method: 'DELETE', credentials: 'same-origin' })
            setKeysSavedAt(null)
          }
        } catch { /* 保存失败不影响校验结果 */ }
      }

      async function clearSavedKeys() {
        try {
          await fetch(`${API}keys`, { method: 'DELETE', credentials: 'same-origin' })
        } catch { /* 忽略网络失败 */ }
        setKeysSavedAt(null)
        setRememberKeys(false)
        setProviderKey('')
        setOfficialKey('')
        setNotice('已清除本机保存的 key，并清空输入框。')
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setNotice(''), 2600)
      }

      const sid = service && service.currentSession ? service.currentSession() : null
      const owned = sid && host && host.state && host.state.sessionBindings &&
        host.state.sessionBindings[sid] === (entry && entry.id) ? sid : null

      async function run() {
        if (busy) return
        setError('')
        setNotice('')
        if (!providerBase.trim() || !providerKey.trim() || !model.trim()) {
          setError('第三方端点、第三方 key、模型 ID 三项必填。')
          return
        }
        if (!/^https?:\/\//i.test(providerBase.trim())) {
          setError('第三方端点需要以 http:// 或 https:// 开头。')
          return
        }
        setBusy(true)
        saveForm({ providerBase, model, protocolModel, officialProtocolModel, officialBase, mode, priceModel, priceIn, priceCached, priceWrite5m, priceWrite1h, priceOut, timeout })
        try {
          const r = await fetch(`${API}verify`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              providerBase: providerBase.trim(),
              providerKey: providerKey.trim(),
              model: model.trim(),
              protocolModel: protocolModel.trim(),
              officialProtocolModel: officialProtocolModel.trim(),
              officialBase: officialBase.trim(),
              mode,
              customPrices: (priceIn && priceOut) ? {
                in: Number(priceIn), out: Number(priceOut),
                cached: Number(priceCached) || Number(priceIn),
                cacheWrite: Number(priceWrite5m) > 0 ? Number(priceWrite5m) : undefined,
                cacheWrite1h: Number(priceWrite1h) > 0 ? Number(priceWrite1h) : undefined,
              } : undefined,
              // 自动价（未手改）时带上完整官方档（含写价/思考价），服务端据此构建 resolve
              priceAuto: !priceTouched ? { base: officialBase.trim(), model: priceModel.trim() || protocolModel.trim() || model.trim() } : undefined,
              officialKey: officialKey.trim(),
              timeout,
            }),
          })
          const j = await r.json()
          if (!r.ok) throw new Error(j.error || '校验失败')
          setResult(j)
          loadHistory()
          void syncKeys()
        } catch (e) {
          setError(e.message || '校验失败')
        } finally {
          setBusy(false)
        }
      }

      /** 无导航下载：fetch 二进制 → blob → a[download]。Electron 里 a.href 跨源点击会导航出大白屏，
       * blob 方式把 URL 变成同源 blob:，download 属性必然生效，界面零跳转。 */
      async function downloadBlob(url, filename) {
        const r = await fetch(url, { credentials: 'same-origin' })
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          throw new Error(j.error || `下载失败（HTTP ${r.status}）`)
        }
        const blob = await r.blob()
        const objectUrl = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = objectUrl
        a.download = filename
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
      }

      async function download(fmt) {
        if (!result || !result.reportId) return
        try {
          const id = encodeURIComponent(result.reportId)
          const mime = fmt === 'md' ? 'text/markdown' : fmt === 'html' ? 'text/html' : 'application/json'
          await downloadBlob(`${API}report?id=${id}&format=${fmt}`, `kimi-verify-${result.reportId}.${fmt}`, mime)
          setNotice(`已开始下载 kimi-verify-${result.reportId}.${fmt}`)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => setNotice(''), 2400)
        } catch (e) {
          setError(e.message || '下载失败')
        }
      }

      async function copyJson() {
        if (!result) return
        try {
          await navigator.clipboard.writeText(JSON.stringify({
            verdict: result.verdict, checks: result.checks, meta: result.meta,
          }, null, 2))
          setNotice('已复制本次证据 JSON（不含密钥）')
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => setNotice(''), 2600)
        } catch {
          setError('复制失败，可改用下载 JSON。')
        }
      }

      // 按需会话：只在用户主动要求 AI 解读时才创建/恢复本工作台会话并填入草稿
      async function ensureDraft(text, okMessage) {
        setChatOpen(true)
        setError('')
        try {
          let target = owned
          if (!target) {
            if (!ctx.uiWorkspace || !ctx.uiWorkspace.pickDirectory) throw new Error('当前宿主未提供目录选择器')
            const folder = await ctx.uiWorkspace.pickDirectory()
            if (!folder) return
            target = await ctx.desktopWorkbenches.ensureSession({ folder })
            if (!target) return
          }
          if (!ctx.desktopWorkbenches.ownsSession(target)) throw new Error('请先打开当前工作台会话')
          const source = ctx.uiSession.current.getSnapshot()
          if (source.key !== target) throw new Error('会话尚在切换，请稍后重试')
          const actions = source.props && source.props.inputActions
          if (!actions || !actions.setDraft) throw new Error('原生会话输入尚未就绪')
          const current = (source.hooks && source.hooks.input && source.hooks.input.getSnapshot() &&
            source.hooks.input.getSnapshot().draft) || ''
          // 会话绑定：把最新报告同步进会话工作区（Agent 可直接读 reports/ 下的 md）
          let reportNote = ''
          try {
            const sr = await fetch(`${API}sync-report`, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId: target, reportId: result && result.reportId }),
            })
            if (sr.ok) {
              const sj = await sr.json()
              reportNote = `\n\n（已把最新报告同步到会话工作区 ${sj.filename}；报告结论：${sj.reportId}——如需逐项数据可读取该文件。）`
            }
          } catch { /* 同步失败不阻塞提问 */ }
          actions.setDraft(current ? `${current}\n\n${text}${reportNote}` : `${text}${reportNote}`)
          setNotice(okMessage || '已将问题与报告同步填入右侧对话草稿，请检查后发送。')
        } catch (e) {
          setError(e.message || '无法创建会话')
        }
      }

      async function askAgent() {
        const v = VERDICT_META[result && result.verdict] || { label: '未校验' }
        return ensureDraft(result
          ? `本次校验结论：${result.verdictTitle}（${result.verdict}）。请结合证据清单解释这个结论能说明什么、不能说明什么，并指出还需要补测哪些维度。`
          : `我准备核验第三方模型端点是否转发到 Kimi 官方 API，当前尚未校验（${v.label}）。请说明这套签名校验的原理、需要准备什么、以及结果该怎么解读。`)
      }

      /** 快捷解读按钮：把预置问题填进右侧对话草稿。 */
      async function askDraft(question) {
        return ensureDraft(question)
      }

      const field = (label, hint, input) =>
        h('label', { className: 'ksv-field' },
          h('span', { className: 'ksv-label' }, label),
          input,
          hint ? h('span', { className: 'ksv-hint' }, hint) : null)

      /** 计费单价格子：上方名称、中间输入、下方一行含义说明。 */
      const priceCell = (name, meaning, value, onChange, aria) =>
        h('label', { className: 'ksv-price-cell' },
          h('span', { className: 'ksv-price-name' }, name),
          h('input', {
            className: 'ksv-input ksv-mono ksv-price-input', type: 'number', min: 0, step: '0.01',
            value, placeholder: '—', 'aria-label': aria,
            onChange: (e) => onChange(e.target.value),
          }),
          h('span', { className: 'ksv-price-meaning' }, meaning))

      const form =
        h('section', { className: 'ksv-card' },
          h('div', { className: 'ksv-card-head' },
            h('h2', null, '校验对象'),
            h('p', { className: 'ksv-sub' }, '两把 key 只用于本次校验：不写磁盘、不进报告、不写入浏览器存储。')),
          h('div', { className: 'ksv-grid' },
            h('div', { className: 'ksv-span2' },
              field('第三方端点 Base URL',
                '填到 /v1 为止，不要带 /chat/completions',
                h('input', {
                  className: 'ksv-input ksv-mono', value: providerBase, spellCheck: false,
                  placeholder: 'https://maas.example.com/v1',
                  onChange: (e) => setProviderBase(e.target.value),
                  'aria-label': '第三方端点 Base URL',
                }))),
            field('模型 ID', '必须与端点 /models 中的 ID 一致',
              h('input', {
                className: 'ksv-input ksv-mono', value: model, spellCheck: false,
                onChange: (e) => setModel(e.target.value), 'aria-label': '模型 ID',
              })),
            h('div', { className: 'ksv-span2' },
              field('对比模式',
                mode === 'relay'
                  ? '模式一：验证「是否真的官转」——签名回源校验 + 双侧对比（Kimi 专属）'
                  : '模式二：第三方推理 vs 官方对比——不做路由验证（DeepSeek/GLM 等开源模型用这个）',
                h('div', { className: 'ksv-inline', role: 'radiogroup', 'aria-label': '对比模式' },
                  h('button', {
                    type: 'button', className: `ksv-btn ${mode === 'relay' ? 'ksv-primary' : ''}`,
                    onClick: () => setMode('relay'), 'aria-pressed': mode === 'relay' ? 'true' : 'false',
                  }, '官转验证'),
                  h('button', {
                    type: 'button', className: `ksv-btn ${mode === 'infer' ? 'ksv-primary' : ''}`,
                    onClick: () => setMode('infer'), 'aria-pressed': mode === 'infer' ? 'true' : 'false',
                  }, '推理对比')))),
            h('div', { className: 'ksv-span2' },
              field('官方 Base URL（对比基线）',
                mode === 'infer' ? '第三方推理将与这个官方端点对比（DeepSeek/GLM/MiniMax/百炼任选）' : 'Kimi 官方域，用于回源校验与对比',
                h('div', { className: 'ksv-inline', style: { flexWrap: 'wrap', gap: '6px' } },
                  h('input', {
                    className: 'ksv-input ksv-mono', style: { flex: '1 1 260px' },
                    value: officialBase, spellCheck: false,
                    onChange: (e) => setOfficialBase(e.target.value), 'aria-label': '官方 Base URL',
                  }),
                  OFFICIAL_PRESETS.map((pr) => h('button', {
                    type: 'button', key: pr.base,
                    className: `ksv-btn ${officialBase === pr.base ? 'ksv-primary' : 'ksv-ghost'}`,
                    style: { height: '32px', padding: '0 10px', fontSize: '12.5px' },
                    onClick: () => setOfficialBase(pr.base),
                    title: pr.base,
                  }, pr.label))))),
            field('协议测试模型', '18 个协议脚本用的第三方侧模型；留空则用主模型',
              h('input', {
                className: 'ksv-input ksv-mono', value: protocolModel, spellCheck: false,
                placeholder: '如 kimi-k3.1-pro（留空用主模型）',
                onChange: (e) => setProtocolModel(e.target.value), 'aria-label': '协议测试模型',
              })),
            field('官方协议模型', '同脚本打官方侧用的模型；留空则与协议测试模型相同',
              h('input', {
                className: 'ksv-input ksv-mono', value: officialProtocolModel, spellCheck: false,
                placeholder: '留空用协议测试模型',
                onChange: (e) => setOfficialProtocolModel(e.target.value), 'aria-label': '官方协议模型',
              })),
            field('单请求超时（秒）', '5–120',
              h('input', {
                className: 'ksv-input', type: 'number', min: 5, max: 120, value: timeout,
                onChange: (e) => setTimeoutSec(Number(e.target.value) || 30), 'aria-label': '单次请求超时（秒）',
              })),
            h('div', { className: 'ksv-span2' },
              h('span', { className: 'ksv-label' }, '计费单价（元/百万 token）'),
              h('div', { className: 'ksv-inline', style: { flexWrap: 'wrap', gap: '6px', marginTop: '4px' } },
                h('span', { className: 'ksv-hint', style: { alignSelf: 'center' } }, '计价模型：'),
                priceModelList && priceModelList.models && priceModelList.models.length
                  ? h('select', {
                      className: 'ksv-input ksv-mono', style: { flex: '1 1 240px', height: '34px' },
                      value: priceModel,
                      onChange: (e) => { setPriceTouched(false); priceQueried.current = ''; setPriceModel(e.target.value) },
                      'aria-label': '计价模型（单价跟随此模型）',
                      title: priceModelList.vendor,
                    },
                      h('option', { value: '' }, `跟随协议测试模型（${priceModelList.vendor} 未选择时）`),
                      priceModelList.models.map((mo) => h('option', { key: mo.key, value: mo.key }, mo.label)))
                  : h('span', { className: 'ksv-hint' }, '该厂商未收录型号清单——单价将跟随协议测试模型')),
              h('div', { className: 'ksv-price-grid', role: 'group', 'aria-label': '计费单价格栅' },
                priceCell('输入（未命中）', '首次处理的输入部分，与缓存命中部分分开计价', priceIn, (v) => { setPriceTouched(true); setPriceIn(v) }, '输入单价'),
                priceCell('缓存命中', '命中上下文缓存的输入部分，大幅折扣；命中后不再收写入费', priceCached, (v) => { setPriceTouched(true); setPriceCached(v) }, '缓存命中单价'),
                priceCell('缓存写入 5m', '写入 5min TTL 档，仅按实际写入 token 收（Kimi K3 系列等）', priceWrite5m, (v) => { setPriceTouched(true); setPriceWrite5m(v) }, '缓存写入5m单价'),
                priceCell('缓存写入 1h', '写入 1 小时 TTL 档（=2×5m）；长会话更高命中更划算', priceWrite1h, (v) => { setPriceTouched(true); setPriceWrite1h(v) }, '缓存写入1h单价'),
                priceCell('输出', '输出 token 单价；思考（reasoning）token 计入输出量', priceOut, (v) => { setPriceTouched(true); setPriceOut(v) }, '输出单价')),
              h('div', { className: 'ksv-inline', style: { marginTop: '6px' } },
                priceTouched
                  ? h('button', {
                      type: 'button', className: 'ksv-btn ksv-ghost', style: { height: '32px', padding: '0 10px', fontSize: '12.5px' },
                      onClick: () => { setPriceTouched(false); priceQueried.current = ''; autoFillPrices() },
                      title: '放弃手填，恢复按模型自动匹配官方价',
                    }, '恢复官方价')
                  : null,
                h('span', { className: 'ksv-hint' }, priceNotice || '按所选模型自动填入官方价；手改即锁定。无该项的厂商（如 K2 无写入价）对应格子自动留空'))),
            h('div', { className: 'ksv-span2' },
              field('第三方 key', '端点自己签发的 key',
                h('input', {
                  className: 'ksv-input ksv-mono', type: showKeys ? 'text' : 'password',
                  value: providerKey, autoComplete: 'off', spellCheck: false,
                  placeholder: 'sk-…', onChange: (e) => setProviderKey(e.target.value),
                  'aria-label': '第三方 key',
                }))),
            h('div', { className: 'ksv-span2' },
              field('官方 key', 'platform.kimi.com 生成；仅用于回源校验，不给也能跑但结论会是「无法判定」',
                h('input', {
                  className: 'ksv-input ksv-mono', type: showKeys ? 'text' : 'password',
                  value: officialKey, autoComplete: 'off', spellCheck: false,
                  placeholder: 'sk-…', onChange: (e) => setOfficialKey(e.target.value),
                  'aria-label': '官方 key',
                }))),
            h('div', { className: 'ksv-span2 ksv-inline' },
              h('label', { className: 'ksv-check' },
                h('input', { type: 'checkbox', checked: showKeys, onChange: (e) => setShowKeys(e.target.checked) }),
                h('span', null, '显示密钥明文（仅本机屏幕）')),
              h('label', { className: 'ksv-check', title: '明文存放在本机 profile 数据目录 keys.json（权限 0600）。能接触本机或备份的人即可读取；报告与日志永不包含 key。' },
                h('input', {
                  type: 'checkbox', checked: rememberKeys,
                  onChange: (e) => setRememberKeys(e.target.checked),
                  'aria-label': '记住 key（明文保存到本机）',
                }),
                h('span', null, '记住 key，下次不用重输（明文存本机）')),
              keysSavedAt
                ? h('button', { className: 'ksv-btn ksv-ghost', onClick: clearSavedKeys, 'aria-label': '清除保存的 key' }, '清除已保存的 key')
                : null),
            h('div', { className: 'ksv-span2 ksv-actions' },
              h('button', {
                className: 'ksv-btn ksv-primary', onClick: run, disabled: busy,
                'aria-busy': busy ? 'true' : 'false',
              }, busy ? '校验中…' : '开始校验'),
              busy
                ? h('span', { className: 'ksv-busy' }, h('span', { className: 'ksv-spin' }), '正在运行 18 个协议脚本（双侧）与签名链，约 45–130 秒')
                : h('span', { className: 'ksv-hint' }, '一次校验会发起 45–75 次网络请求（18 个协议脚本 × 双侧 + 签名链）；token 消耗约 3–5K（有官方 key 时翻倍）'),
              h('span', { className: 'ksv-flex' }),
              h('button', { className: 'ksv-btn', onClick: askAgent }, '让 Agent 解读'))))

      const verdictCard = result && (() => {
        const meta = VERDICT_META[result.verdict] || { label: result.verdict, tone: 'muted', hint: '' }
        const m = result.meta || {}
        return h('section', { className: `ksv-card ksv-verdict ksv-tone-${meta.tone}` },
          h('div', { className: 'ksv-verdict-top' },
            h('div', null,
              h('div', { className: 'ksv-eyebrow' }, '结论'),
              h('h2', { className: 'ksv-verdict-title' }, result.verdictTitle),
              h('p', { className: 'ksv-sub' }, meta.hint)),
            h('div', { className: 'ksv-verdict-badge' }, meta.label)),
          h('p', { className: 'ksv-verdict-text' }, result.verdictText),
          h('div', { className: 'ksv-actions' },
            h('button', { className: 'ksv-btn ksv-primary', onClick: () => download('md') }, '下载 Markdown'),
            h('button', { className: 'ksv-btn', onClick: () => download('html') }, '下载 HTML'),
            h('button', { className: 'ksv-btn', onClick: () => download('json') }, '下载 JSON'),
            h('button', { className: 'ksv-btn ksv-ghost', onClick: () => setResult(null) }, '收起结果'),
            result.saved === false ? h('span', { className: 'ksv-hint' }, '本次报告未能落盘，仍可下载') : null),
          h('div', { className: 'ksv-kv' },
            row('端点', m.providerBase), row('模型', m.model),
            row('官方校验域', m.officialBase),
            row('非密指纹', `${m.providerKeyFp} / ${m.officialKeyFp}`),
            row('nonce', m.nonce), row('timestamp', m.timestamp),
            row('signature', `${m.signaturePrefix}（${m.signatureLength} 字符）`),
            m.latency && m.latency.summary && m.latency.summary.compared
              ? row('延迟对比', `逐脚本 ${m.latency.summary.compared} 项可对比；中位 官方 ${m.latency.summary.officialMedian}ms vs 第三方 ${m.latency.summary.providerMedian}ms（${m.latency.summary.deltaMs >= 0 ? '高' : '低'} ${Math.abs(m.latency.summary.deltaMs)}ms），明细见证据表`)
              : row('延迟对比', '未测（无官方 key 或官方侧不可用）')))
      })()

      function row(k, v) {
        return h('div', { className: 'ksv-kv-row' },
          h('span', { className: 'ksv-kv-k' }, k),
          h('span', { className: 'ksv-kv-v ksv-mono' }, v === undefined || v === null ? '—' : String(v)))
      }

      const evidence = result && h('section', { className: 'ksv-card' },
        h('div', { className: 'ksv-card-head' },
          h('h2', null, '证据清单'),
          h('p', { className: 'ksv-sub' }, `${result.checks.length} 项，均为可复核的观测值，不是推断。`)),
        h('div', { className: 'ksv-table-wrap' },
          h('table', { className: 'ksv-table' },
            h('thead', null, h('tr', null,
              h('th', { className: 'ksv-num' }, '#'), h('th', null, '校验项'),
              h('th', null, '结果'), h('th', null, '观测值'), h('th', null, '说明'))),
            h('tbody', null, result.checks.map((c, i) => h('tr', { key: c.id + i },
              h('td', { className: 'ksv-num' }, i + 1),
              h('td', { className: 'ksv-strong' }, c.title),
              h('td', null, h('span', { className: `ksv-pill ksv-p-${c.status}` }, STATUS_LABEL[c.status] || c.status)),
              h('td', { className: 'ksv-mono ksv-detail' }, c.detail),
              h('td', { className: 'ksv-muted' }, c.meaning || '')))))),
        result.meta && result.meta.verifyRaw && Object.keys(result.meta.verifyRaw).length
          ? h('details', { className: 'ksv-details' },
            h('summary', null, '官方 verify 原始返回'),
            h('pre', { className: 'ksv-pre' }, JSON.stringify(result.meta.verifyRaw, null, 2)))
          : null)

      const boundary = result && h('section', { className: 'ksv-card ksv-bounds' },
        h('h2', null, '边界与未覆盖维度'),
        h('ul', null,
          h('li', null, '签名只证明「Kimi 官方在该时刻以该模型接受了此 nonce」，', h('b', null, '不证明'),
            '请求成功、响应内容完整未被改写、权重或量化版本一致。'),
          h('li', null, 'temperature、max_tokens 等参数不在签名覆盖范围内，被篡改不会导致 valid:false。'),
          h('li', null, '未测量：队列与预填充拆分、reasoning token 独立时延、多轮与缓存命中场景。'),
          h('li', null, '本机出口网络耗时不能当作服务端内部时延。'),
          h('li', null, '签名不防重放、无有效期窗口，防重放与时效需由调用方自行控制。')))

      // 侧栏内容改为两张紧凑卡（并入主列，不再独立成列）
      const side = h('div', { className: 'ksv-inlinecards' },
        h('section', { className: 'ksv-card ksv-card-flat' },
          h('div', { className: 'ksv-card-head' },
            h('h2', null, '结论分级'),
            h('p', { className: 'ksv-sub' }, '只有「通过」才能对外声称已路由到官方')),
          h('div', { className: 'ksv-legend ksv-legend-flat' },
            Object.entries(VERDICT_META).map(([k, v]) => h('span', { className: 'ksv-legend-item', key: k, title: v.hint },
              h('span', { className: `ksv-pill ksv-p-${v.tone === 'ok' ? 'ok' : v.tone === 'warn' ? 'warn' : v.tone === 'bad' ? 'fail' : 'skip'}` }, v.label))))),
        h('section', { className: 'ksv-card ksv-card-flat' },
          h('div', { className: 'ksv-card-head' },
            h('h2', null, '最近报告'),
            history.length === 0
              ? h('p', { className: 'ksv-sub' }, '还没有报告；完成一次校验后出现在这里')
              : h('p', { className: 'ksv-sub' }, '本机留档，不含密钥 · 点击打开')),
          history.length > 0
            ? h('div', { className: 'ksv-history ksv-history-flat' },
              history.map((it) => {
                const vm = VERDICT_META[it.verdict] || { label: it.verdict, tone: 'muted' }
                return h('button', {
                  className: 'ksv-history-row', key: it.id,
                  onClick: () => {
                    void (async () => {
                      try {
                        await downloadBlob(`${API}report?id=${encodeURIComponent(it.id)}&format=md`, `kimi-verify-${it.id}.md`)
                        setNotice(`已开始下载历史报告 ${it.id}`)
                        if (timer.current) clearTimeout(timer.current)
                        timer.current = setTimeout(() => setNotice(''), 2400)
                      } catch (e) {
                        setError(e.message || '下载失败')
                      }
                    })()
                  },
                  title: '下载该报告（Markdown），不离开当前界面',
                },
                  h('span', { className: 'ksv-history-main' },
                    h('span', { className: 'ksv-history-title' }, it.verdictTitle || vm.label),
                    h('span', { className: 'ksv-muted ksv-history-model' }, it.model || '')),
                  h('span', { className: `ksv-pill ksv-p-${vm.tone === 'ok' ? 'ok' : vm.tone === 'warn' ? 'warn' : vm.tone === 'bad' ? 'fail' : 'skip'}` }, vm.label))
              }))
            : null))

      // 顶部快捷解读（预置问题，一键填入右侧原生对话草稿）
      const quickAsks = result
        ? [
            ['解读本次结论', `本次校验结论：${result.verdictTitle}（${result.verdict}）。请结合证据清单解释这个结论能说明什么、不能说明什么，并指出还需要补测哪些维度。`],
            ['解读根因分析', '请逐项解释本次报告「问题根因分析」里每个失败/注意脚本的具体根因，并说明哪些是网关问题、哪些需要供应商修复。'],
            ['解读计费', '请解读本次报告的计费一致性（billing）结果：两侧计量是否一致、金额折算口径、以及如果我要对账应该怎么做。'],
            ['解读延迟', '请解读逐脚本延迟对比结果：哪些脚本差异最大、差异包含哪些开销、以及这对接入决策意味着什么。'],
          ]
        : [
            ['测试逻辑是什么', '请介绍这个「模型端点签名核验」工作台的完整测试逻辑：官转验证（签名回源）与推理对比两种模式各测什么、20 个协议脚本分别覆盖什么维度。'],
            ['怎么验证官转', '我要验证一个第三方端点是否真的转发到 Kimi 官方 API。请说明签名回源校验的原理（nonce → 签名头 → 官方验证）、为什么它不可伪造、以及 tokenizer 指纹如何佐证。'],
            ['报告怎么读', '请说明报告的结构：证据清单、根因分析、逐脚本延迟、计费一致性各节分别回答什么问题，「通过/注意/失败/未对比」各代表什么。'],
          ]

      const chatColumn = conversation
        ? h('aside', {
            className: `ksv-chat${chatOpen ? '' : ' ksv-chat-collapsed'}`,
            'aria-label': '工作台对话',
          },
            h('div', { className: 'ksv-chat-head' },
              h('span', { className: 'ksv-chat-title' }, '对话'),
              h('span', { className: 'ksv-hint' }, '解读报告 · 追问测试逻辑'),
              h('span', { className: 'ksv-flex' }),
              h('button', {
                className: 'ksv-btn ksv-ghost', style: { height: '30px', padding: '0 10px', fontSize: '12px' },
                onClick: () => setChatOpen((v) => !v),
                'aria-expanded': chatOpen ? 'true' : 'false',
                'aria-label': chatOpen ? '收起对话' : '展开对话',
              }, chatOpen ? '收起 →' : '← 展开')),
            // 宿主注入的原生对话树（display:contents 容器）：业务面板与对话同屏
            conversation)
        : null

      return h('div', { className: `ksv-root${chatOpen ? '' : ' ksv-nochat'}` },
        h('header', { className: 'ksv-head', 'data-window-drag': true },
          h('div', { className: 'ksv-brand' },
            h('span', { className: 'ksv-logo' }, '◇'),
            h('span', null, '模型端点签名核验')),
          h('span', { className: 'ksv-badge' }, 'Kimi 请求签名 · 回源校验'),
          h('span', { className: 'ksv-flex' }),
          conversation && h('button', {
            className: 'ksv-btn ksv-ghost', onClick: () => setChatOpen((v) => !v),
            'aria-expanded': chatOpen ? 'true' : 'false',
          }, chatOpen ? '收起对话' : '展开对话'),
          h('button', {
            className: 'ksv-btn ksv-ghost', onClick: () => { setResult(null); setError(''); setNotice('') },
            title: '清空当前结果与输入框密钥',
          }, '重置')),
        h('div', { className: 'ksv-main' },
          h('div', { className: 'ksv-cols' },
            error ? h('div', { className: 'ksv-alert', role: 'alert' }, error,
              h('button', { className: 'ksv-link', onClick: () => setError('') }, '关闭')) : null,
            notice ? h('div', { className: 'ksv-toast', role: 'status' }, notice) : null,
            h('div', { className: 'ksv-main-col' },
              conversation && h('div', { className: 'ksv-quickasks' },
                h('span', { className: 'ksv-hint' }, '快捷解读：'),
                quickAsks.map(([label, question]) => h('button', {
                  key: label, type: 'button', className: 'ksv-btn ksv-ghost ksv-qa',
                  onClick: () => askDraft(question),
                  title: question.slice(0, 80) + '…',
                }, label))),
              form,
              verdictCard,
              evidence,
              boundary,
              side)),
          // 宿主原生对话列：customFrame 下由宿主经 conversation prop 注入
          chatColumn,
          !conversation && h('aside', { className: 'ksv-chat ksv-chat-fallback' },
            h('div', { className: 'ksv-chat-head' }, h('span', { className: 'ksv-chat-title' }, '对话')),
            h('div', { className: 'ksv-chat-empty' },
              h('p', null, '宿主未注入原生对话列（可能当前处于非会话视图）。'),
              h('p', { className: 'ksv-hint' }, '点击顶部「在会话里解读」创建工作台会话后，对话将出现在这里。')))))
    }

    ctx.effect(() => ctx.desktopWorkbenches.register({
      title: '模型端点签名核验',
      panelTitle: 'Kimi 请求签名核验',
      repository: 'https://github.com/caisiyang123/kimi-signature-workbench',
      description: '输入第三方端点与两把 key，回源校验请求签名，判定是否真的转发到 Kimi 官方、有没有偷换模型，并产出可读报告。',
      category: '开发工具',
      customFrame: true,
    }, Panel))
  }

  return { apply, inject: ['desktopWorkbenches', 'uiSession', 'uiWorkspace'] }
}})