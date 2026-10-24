import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const css = readFileSync(new URL('./src/panel.css', import.meta.url), 'utf8')
const source = readFileSync(new URL('./src/panel.js', import.meta.url), 'utf8')

if (!source.includes('__CSS__')) {
  throw new Error('src/panel.js 缺少 __CSS__ 占位符')
}
if (source.split('__CSS__').length !== 2) {
  throw new Error('src/panel.js 中 __CSS__ 应只出现一次')
}

const out = source.replace('__CSS__', JSON.stringify(css))

// 客户端是浏览器脚本（引用 window 与 require），不能执行，但可以做纯语法解析校验，
// 避免出现「构建成功但产物语法错误」的假通过。
try {
  new Function(out) // eslint-disable-line no-new-func
} catch (e) {
  throw new Error(`lib/client.js 语法错误：${e.message}`)
}
mkdirSync(new URL('./lib', import.meta.url), { recursive: true })
writeFileSync(new URL('./lib/client.js', import.meta.url), out)

const kb = (Buffer.byteLength(out) / 1024).toFixed(1)
console.log(`Built lib/client.js (${kb} KB, css ${(Buffer.byteLength(css) / 1024).toFixed(1)} KB)`)