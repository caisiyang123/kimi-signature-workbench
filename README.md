# 模型端点签名核验工作台

DSH Desktop 本地工作台。核验**第三方大模型端点（中转 / 网关 / 代理）是否真的把请求交给了
Kimi 官方 API、且没有偷换模型**，并产出一份可读、可留档的验证报告。

判定依据是 Kimi 官方文档的「请求签名」机制：签名由官方私钥签发，只能回源
`POST /v1/signatures/verify` 校验。**判别权不在被怀疑的一方手里**，所以这套机制能自证。

---

## 为什么需要两把 key

| key | 作用 | 能不能省 |
|---|---|---|
| 第三方 key | 打第三方端点、取回签名响应头 | 不能省 |
| 官方 key | **只**用于回源校验签名 | 省了无法判定，结论停在「无法判定」 |

官方 key 在 https://platform.kimi.com/console/api-keys 生成，仅调用
`/v1/signatures/verify`，不参与任何业务请求。

## 使用

1. 左侧切到本工作台，直接就是业务页，**不需要先建会话**。
2. 填：第三方 Base URL（填到 `/v1`）、模型 ID、第三方 key、官方 key、超时。
3. 点「开始校验」，6–15 秒出结论与证据。
4. 可下载 Markdown / HTML / JSON；报告同时在本机留档，出现在右侧「最近报告」。

想让人解读时点「让 Agent 解读」：会按需创建/恢复本工作台的会话，并把问题**填入草稿**，
由你自己确认后发送（不会自动发送）。

## 两种对比模式

| 模式 | 用途 | 签名验证 | 适用对象 |
|---|---|---|---|
| **官转验证（relay）** | 验证「声称官转的第三方」是否真的路由到官方 | ✅ 签名回源校验 | Kimi（Moonshot 独有 `Msh-Request-Signature` 机制） |
| **推理对比（infer）** | 第三方**自部署推理** vs 官方 API 的质量对比 | ❌ 不适用（自部署本就不是官方路由，合法形态） | DeepSeek / GLM / MiniMax / Qwen 等开源权重模型 |

推理模式下签名链四项（签名头/行为契约/回源校验/key 归属）自动跳过，其余 18 个协议脚本、
tokenizer 指纹、输出指纹、逐脚本延迟全部双侧执行。官方 Base URL 可填任意厂商并带快捷预设：
Kimi 官方 / DeepSeek（`https://api.deepseek.com`）/ 智谱 GLM（`https://open.bigmodel.cn/api/paas/v4`）/
MiniMax（`https://api.minimaxi.com/v1`）/ 阿里百炼（`https://dashscope.aliyuncs.com/compatible-mode/v1`）。

**国内四家官转验证机制调研（2026-10）**：智谱 GLM 的 `{id}.{secret}` 是客户端 JWT 鉴权；
DeepSeek / MiniMax 纯 Bearer；阿里百炼的 `ACS3-HMAC-SHA256` 是 API 网关鉴权——
**均无「官方私钥签名响应 + 回源校验」机制**，Kimi 为国内独一份。对这四家只能用推理对比模式做间接对比。

## 结论分级

| 代码 | 含义 | 能对外说什么 |
|---|---|---|
| `VERIFIED_OFFICIAL` | 官方确认以该模型名接受过本次 nonce | 已路由到 Kimi 官方，模型未被替换 |
| `VERIFIED_ALIAS` | 改用官方模型名后才通过 | 别名映射，非偷换；**计价/限速/上下文长度需按真实模型重核** |
| `NOT_VERIFIED` | 有签名但官方不认 | **不能**说「已验证是 Kimi 官方」 |
| `INSUFFICIENT` | 缺官方 key 或缺签名头 | 结论是「未知」，不是「失败」也不是「造假」 |
| `ENDPOINT_ERROR` | 端点不可达 | 未取得任何证据 |
| `COMPARE_ALIGNED` | 推理模式：双侧全对齐 | 第三方推理与官方口径对齐（不证明权重相同） |
| `COMPARE_DIVERGENT` | 推理模式：双侧有分歧 | 按分歧项评估对业务的影响 |

## 证据清单（12 项）

1 官方 key 有效性 · 2 端点连通性 · 3 模型是否在端点清单中 · 4 第三方 key 归属 ·
5 签名响应头（带 nonce）· 6 时间戳与本地时钟偏差 · 7 行为契约（不带 nonce 不应给签名）·
8 流式 SSE 支持 · 9 token 计量来源（服务端 usage / reasoning 占比）· 10 官方签名校验 ·
外加别名映射探测，以及两个**协议透传用例**：

**16 个协议脚本**（每个在第三方与官方两侧各执行一遍，行为一致性 + 逐脚本延迟三合一；
业界对照来源：GateScope IMC'26、cdnping 五项一致性检查、LLMCompat/LLM API Check 探针组）：

| # | 脚本 | 判什么 |
|---|---|---|
| 1 | tools.dynamic | 无 content 的 system.tools + tool_choice required |
| 2 | partial.nonempty | 非空前缀续写（流式+非流式，期望续写 42"}） |
| 3 | temperature.zero | temperature=0 同请求双发一致性 |
| 4 | json.mode | response_format json_object |
| 5 | stop.sequence | stop=["5"] 截断 |
| 6 | max_tokens.cap | max_completion_tokens=5 上限 |
| 7 | tools.roundtrip | 工具结果回传闭环（agent 回环，第二步动态构造） |
| 8 | tokenizer.parity | 双侧 prompt_tokens 对比：一致=同源指纹；恒差=注入；比例差=疑换模型 |
| 9 | multi_turn.memory | 多轮暗号召回（暗号随 nonce 随机，防缓存蒙混） |
| 10 | system.fidelity | system 指定随机代号并要求复述 |
| 11 | json.schema | json_schema + strict + 嵌套数组 |
| 12 | context.inject | "hi" 静态开销双侧对比（隐藏前缀注入检测） |
| 13 | cache.billing | 长前缀两连发读 cached_tokens（429 会如实记 info） |
| 14 | reasoning.effort | reasoning_effort 放行性与 reasoning_tokens 计量 |
| 15 | vision.probe | 1×1 红色 PNG 多模态探测 |
| 16 | identity.probe | 去品牌身份提问（**仅观察信号**，业界混淆率 12.9%，不作证据） |

协议脚本默认用主模型；**协议测试模型**字段可单独指定（如 `kimi-k3.1-pro`），
**官方协议模型**可单独指定官方侧模型。单次全量约 40–70 请求、40–120 秒。

## 延迟对比（官方 vs 第三方）

填入有效官方 key 后自动运行：两侧同打 `/models`，串行 3 轮取中位数与最优值，
报告给出差值与百分比。差异包含网关转发、地域路由与 TLS 建连，
**不是官方服务端内部时延**；方向性可信，但不代表重负载吞吐。

## 完整分析报告

报告（Markdown / HTML / JSON 可下载）在证据清单之外还包含：

- **延迟对比**小节（两侧中位/最优/3 轮明细/差值）
- **综合分析与建议**：路由可信度、协议兼容性、延迟三个维度各给一段结论，
  附按证据生成的「建议动作」清单（可直接发给供应商）

## 可选记住 key

勾选「记住 key」并完成一次校验后，两把 key 保存到
`dshHomePath('kimi-signature-workbench')/keys.json`（权限 0600，原子写入），
下次打开自动回填。取消勾选或点「清除已保存的 key」即删除。

**明文存储，无加密**：能接触本机或其备份的人即可读取。报告、日志、浏览器
localStorage 永不包含 key；此开关默认关闭，仅在你显式同意后生效。

## 隐私与数据

- **两把 key 只在内存与单次请求体内**：不进报告、不进访问日志、
  **不写入浏览器存储**（localStorage 只保存端点、模型、协议测试模型、超时）。
- 唯一例外：你显式勾选「记住 key」后，key 以**明文**保存到本机
  `keys.json`（0600）。清除开关随时可用，见上文。
- 报告只保留 key 的 `sha256` 前 10 位指纹，用于多次校验之间比对同一把 key。
- 报告落盘在 `dshHomePath('kimi-signature-workbench')/reports/`，保留最近 60 份，
  内容仅含校验项与指纹。卸载工作台不删除该目录。

## 这套机制证明什么、不证明什么

**证明**：Kimi 官方在该时间点、以该 model 名接受了这个 nonce。

**不证明**：请求最终成功；响应内容完整未被二次改写；权重/量化版本一致；
`temperature`、`max_tokens` 等参数未被篡改（不在签名覆盖范围）；
也不能防重放（官方不记录 nonce、无有效期窗口）。

报告里固定列出「未覆盖维度」：队列与预填充拆分、reasoning token 独立时延、
多轮与缓存命中；并声明本机出口网络耗时不能当作服务端内部时延。

## 开发

```bash
node build.mjs                  # src/panel.js + src/panel.css -> lib/client.js
node --test test/*.test.mjs     # 12 项纯逻辑单测（注入假 fetch，不联网）
pnpm pack                       # 产出可安装 tarball
```

改了 `src/` 之后**必须重新 build**，Desktop 不会替你构建客户端文件。

## 结构

```
package.json          npm 与 DSH 插件声明（dsh.bundle.patch / dsh.client）
cordis.patch.yml      把服务端入口插入 Harness 插件树
dsh/index.js          服务端入口：注册 /api/kimi-signature-workbench/* 接口
dsh/verify-core.mjs   校验逻辑（纯函数，可注入 fetch，便于测试）
dsh/render.mjs        Markdown / 自包含 HTML 报告渲染
lib/client.js         已构建的客户端单文件（提交构建产物）
src/panel.js          客户端源码
src/panel.css         样式（ksv- 前缀，深浅色自适应）
test/core.test.mjs    单测
```

## 说明

- 不声明 `peerDependencies`：本机 `~/.dsh/profiles/node_modules/@deepseek-ai/*` 的符号链接
  指向已不存在的 `DSH Desktop Beta.app`，声明 peer 范围会在安装期触发 ERESOLVE。
  `@deepseek-ai/schemastery` 由宿主自身解析。
- 面向本机自用，不上架市场，因此 `repository` 仅用于 Desktop 解析工作台身份。