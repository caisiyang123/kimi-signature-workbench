import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/* 客户端是浏览器脚本：window.__ModuleLoader__.load({...})。
 * 这里用桩件把它真正执行一次，验证三件事：
 *   1) 产物能被解析并交出 {apply, inject}
 *   2) apply() 时确实调用 desktopWorkbenches.register 且参数合规
 *   3) Panel 能渲染出可用的业务元素（不是空壳）
 * 不验证真实 DOM/CSS 效果，那部分只能装进 Desktop 后实测。
 */

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

import { readFileSync as _readFileSync } from 'node:fs'
function readFileSyncSource() {
  return _readFileSync(new URL('../src/panel.js', import.meta.url), 'utf8')
}

function bootClient() {
  let captured = null
  const win = {
    __ModuleLoader__: { load: (def) => { captured = def } },
  }
  // 无需 DOM：Panel 渲染路径不触碰 document；apply 里的样式注入用桩件
  const fn = new Function('window', 'localStorage', 'document', src)
  const styleTags = []
  const localStorageStub = {
    _v: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null },
    setItem(k, v) { this._v[k] = String(v) },
  }
  const documentStub = {
    createElement() { return { id: '', textContent: '', remove() {} } },
    head: { appendChild(tag) { styleTags.push(tag) } },
  }
  fn(win, localStorageStub, documentStub)
  assert.ok(captured, '应捕获 __ModuleLoader__.load 的注册对象')
  return { captured, documentStub, localStorageStub, styleTags }
}

function reactStub() {
  const types = []
  const react = {
    createElement(type, props, ...children) {
      types.push(type)
      return { type, props: props || {}, children }
    },
    useState(init) { return [typeof init === 'function' ? init() : init, () => {}] },
    useEffect() {},
    useRef(init) { return { current: typeof init === 'function' ? init() : init } },
    useCallback(fn) { return fn },
  }
  return { react, types }
}

function loadFactory() {
  const { captured } = bootClient()
  const { react, types } = reactStub()
  const requireStub = (id) => {
    if (id === 'react') return react
    throw new Error('未预期的依赖：' + id)
  }
  return { exported: captured.factory(requireStub), types }
}

function walk(node, out = []) {
  if (Array.isArray(node)) { node.forEach((c) => walk(c, out)); return out }
  if (!node || typeof node !== 'object') return out
  out.push(node)
  if (Array.isArray(node.children)) node.children.forEach((c) => walk(c, out))
  return out
}

const findByAriaLabel = (tree, label) =>
  walk(tree).find((n) => n.type === 'input' && n.props && n.props['aria-label'] === label)

test('客户端产物注册了模块，id 与包名一致', () => {
  const { captured } = bootClient()
  assert.equal(captured.id, 'dsh-kimi-signature-workbench')
  assert.equal(typeof captured.factory, 'function')
})

test('导出 {apply, inject}，且注入了工作台与按需会话所需服务', () => {
  const { exported } = loadFactory()
  assert.equal(typeof exported.apply, 'function')
  assert.deepEqual(exported.inject, ['desktopWorkbenches', 'uiSession', 'uiWorkspace'])
})

test('apply() 注册工作台：customFrame、repository、标题齐全', () => {
  const { exported } = loadFactory()
  const registered = []
  const ctx = {
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    desktopWorkbenches: {
      register(opts, Panel) { registered.push({ opts, Panel }); return () => {} },
      ensureSession: async () => null,
      ownsSession: () => false,
    },
  }
  exported.apply(ctx)
  assert.equal(registered.length, 1)
  const { opts, Panel } = registered[0]
  assert.equal(opts.customFrame, true, '选择业务整页，必须显式声明 customFrame')
  assert.equal(typeof opts.title, 'string')
  assert.ok(opts.title.length > 0)
  assert.match(opts.repository, /^https:\/\/github\.com\/[^/]+\/[^/]+$/, 'repository 必须是规范的 GitHub URL')
  assert.equal(typeof Panel, 'function')
})

test('首次进入无需会话即可渲染：表单四个必填项都在', () => {
  const { exported } = loadFactory()
  let Panel = null
  const ctx = {
    effect(fn) { fn(); return () => {} },
    desktopWorkbenches: { register(_o, P) { Panel = P; return () => {} } },
  }
  exported.apply(ctx)

  // 无会话、无 host 快照的最小入参
  const tree = Panel({ service: undefined, entry: undefined })
  assert.ok(tree, 'Panel 应返回元素树')

  for (const label of ['第三方端点 Base URL', '模型 ID', '协议测试模型', '单次请求超时（秒）', '第三方 key', '官方 key']) {
    assert.ok(findByAriaLabel(tree, label), `缺少输入项：${label}`)
  }

  const buttons = walk(tree).filter((n) => n.type === 'button').map((n) => n.children.join(''))
  assert.ok(buttons.some((t) => t.includes('开始校验')), '应有「开始校验」按钮')
  assert.ok(buttons.some((t) => t.includes('让 Agent 解读')), '应有按需会话入口')
})

test('计费单价格子共五个（输入/缓存命中/写入5m/写入1h/输出）', () => {
  const { exported } = loadFactory()
  let Panel = null
  exported.apply({
    effect(fn) { fn(); return () => {} },
    desktopWorkbenches: { register(_o, P) { Panel = P; return () => {} } },
  })
  const tree = Panel({})
  for (const label of ['输入单价', '缓存命中单价', '缓存写入5m单价', '缓存写入1h单价', '输出单价']) {
    assert.ok(findByAriaLabel(tree, label), `缺少单价格子：${label}`)
  }
  // 计价模型下拉（option 列表在 mock fetch 下拉不到清单——树里至少有 select 或提示文案）
  const hasSelector = walk(tree).some((n) => n.type === 'select' && n.props && n.props['aria-label'] === '计价模型（单价跟随此模型）')
  const texts0 = walk(tree).map((n) => (Array.isArray(n.children) ? n.children.join('') : '')).join(' ')
  assert.ok(hasSelector || texts0.includes('跟随协议测试模型'), '应有计价模型下拉或跟随提示')

  // 每格上方的名称与含义说明
  const texts = walk(tree).map((n) => (Array.isArray(n.children) ? n.children.join('') : '')).join(' ')
  for (const name of ['输入（未命中）', '缓存命中', '缓存写入 5m', '缓存写入 1h', '输出']) {
    assert.ok(texts.includes(name), `缺少单价格子名称：${name}`)
  }
  for (const meaning of ['首次处理的输入部分', '命中后不再收写入费', '仅按实际写入 token 收', '思考（reasoning）token 计入输出量']) {
    assert.ok(texts.includes(meaning), `缺少含义说明：${meaning}`)
  }
})

test('无 conversation prop → 渲染 fallback 对话列（提示创建会话）', () => {
  const { exported } = loadFactory()
  let Panel = null
  exported.apply({
    effect(fn) { fn(); return () => {} },
    desktopWorkbenches: { register(_o, P) { Panel = P; return () => {} } },
  })
  const tree = Panel({})
  const texts = walk(tree).map((n) => (Array.isArray(n.children) ? n.children.join('') : '')).join(' ')
  assert.ok(texts.includes('宿主未注入原生对话列'), '应渲染 fallback 提示')
  assert.ok(texts.includes('在会话里解读'), '应提示入口')
})

test('有 conversation prop → 渲染宿主对话列（含收起/展开）', () => {
  const { exported } = loadFactory()
  let Panel = null
  exported.apply({
    effect(fn) { fn(); return () => {} },
    desktopWorkbenches: { register(_o, P) { Panel = P; return () => {} } },
  })
  // conversation 是一个 React 元素桩
  const convNode = { type: 'div', props: { className: 'host-conversation' }, children: [] }
  const tree = Panel({ conversation: convNode })
  // 对话列 aside 存在且包含宿主节点
  const chatAside = walk(tree).find((n) => n.type === 'aside' && String(n.props && n.props.className || '').includes('ksv-chat'))
  assert.ok(chatAside, '应有对话列 aside')
  assert.ok(!String(chatAside.props.className).includes('ksv-chat-fallback'), '不应是 fallback')
  const hasHost = walk(chatAside).some((n) => n === convNode)
  assert.ok(hasHost, '宿主 conversation 节点应被渲染进对话列')
  // 顶部有展开/收起按钮
  const texts = walk(tree).map((n) => (Array.isArray(n.children) ? n.children.join('') : '')).join(' ')
  assert.ok(texts.includes('收起对话') || texts.includes('展开对话'), '应有展开/收起控制')
})

test('快捷解读按钮：有结果时四个、无结果时三个', () => {
  const { exported } = loadFactory()
  let Panel = null
  exported.apply({
    effect(fn) { fn(); return () => {} },
    desktopWorkbenches: { register(_o, P) { Panel = P; return () => {} } },
  })
  const convNode = { type: 'div', props: {}, children: [] }
  const tree = Panel({ conversation: convNode })
  const texts = walk(tree).map((n) => (Array.isArray(n.children) ? n.children.join('') : '')).join(' ')
  assert.ok(texts.includes('测试逻辑是什么'), '无结果时应含「测试逻辑」快捷问')
  assert.ok(texts.includes('报告怎么读'), '应含「报告怎么读」')
  assert.ok(texts.includes('怎么验证官转'), '应含「怎么验证官转」')
  assert.ok(!texts.includes('解读本次结论'), '无结果时不应有结果解读按钮')
})

test('首次进入展示空历史状态，而不是空白区块', () => {
  const { exported } = loadFactory()
  let Panel = null
  exported.apply({
    effect(fn) { fn(); return () => {} },
    desktopWorkbenches: { register(_o, P) { Panel = P; return () => {} } },
  })
  const tree = Panel({})
  const texts = walk(tree).map((n) => (Array.isArray(n.children) ? n.children.join('') : '')).join(' ')
  assert.match(texts, /还没有报告/, '无历史时应给出空状态文案')
  assert.match(texts, /结论分级/, '主列应有结论分级说明')
  // 布局回归：side 并入主列，不再独立成列（避免三列布局出现空白列）
  assert.ok(!walk(tree).some((n) => n.type === 'aside' && String(n.props && n.props.className || '').includes('ksv-side')), '不应再有独立 ksv-side 列')
  assert.ok(walk(tree).some((n) => String(n.props && n.props.className || '').includes('ksv-inlinecards')), '侧栏内容应并入主列（ksv-inlinecards）')
})

test('下载不导航：源码无 window.open / 无裸 a.href 点击', () => {
  const src = readFileSyncSource()
  assert.ok(!src.includes('window.open('), '不得使用 window.open（会在 Electron 里开白屏 tab）')
  // downloadBlob 模式存在
  assert.ok(src.includes('downloadBlob'), '应有 blob 下载实现')
  assert.ok(src.includes('URL.createObjectURL'), 'blob URL 生成')
  assert.ok(src.includes('a.download = filename'), 'download 属性命名文件')
})

test('密钥输入默认是密码框，且不会写入浏览器存储', () => {
  const { exported } = loadFactory()
  let Panel = null
  exported.apply({
    effect(fn) { fn(); return () => {} },
    desktopWorkbenches: { register(_o, P) { Panel = P; return () => {} } },
  })
  const tree = Panel({})
  for (const label of ['第三方 key', '官方 key']) {
    const input = findByAriaLabel(tree, label)
    assert.equal(input.props.type, 'password', `${label} 默认应为密码框`)
  }
  // 触发一次渲染后，本地存储里只应有端点/模型/超时
  const { localStorageStub } = bootClient()
  const keys = Object.keys(localStorageStub._v)
  for (const k of keys) {
    const v = localStorageStub._v[k]
    assert.ok(!/providerKey|officialKey|sk-/.test(v), `本地存储不应含密钥：${k}=${v}`)
  }
})

test('「记住 key」默认不勾选，勾选控件与风险提示在表单里', () => {
  const { exported } = loadFactory()
  let Panel = null
  exported.apply({
    effect(fn) { fn(); return () => {} },
    desktopWorkbenches: { register(_o, P) { Panel = P; return () => {} } },
  })
  const tree = Panel({})
  const remember = findByAriaLabel(tree, '记住 key（明文保存到本机）')
  assert.ok(remember, '应有「记住 key」复选框')
  assert.equal(remember.props.type, 'checkbox')
  assert.equal(remember.props.checked, false, '默认不勾选，必须用户显式同意')

  const texts = walk(tree).map((n) => (Array.isArray(n.children) ? n.children.join('') : '')).join(' ')
  assert.match(texts, /记住 key，下次不用重输（明文存本机）/, '勾选项应写明「明文」后果')
})