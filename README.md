# ST-ImageFree · v3.3 — 酒馆正文内联配图

给 SillyTavern 用的自动配图扩展：AI 每回一段，**插件自己**把这段剧情改写成绘图提示词、
出图，并把图片**直接插在那段文字的后面**（不是塞到楼层底部的图廊里）。
锚点随聊天存档走，刷新、切聊天、换设备都能回到原位。

两个关键设计：

1. **提示词重写跑在独立 API 上**（v3）。不用改预设、不占对话额度、不往正文里塞 `<local_img>` 标签 ——
   换任何角色卡/预设效果都一样；
2. **图片是正文的一部分**（v2）。不走酒馆的 `extra.media` 图廊，而是插进 `.mes_text` 的锚点段落后面。

> v1 的问题不是「生图没成功」，而是**图片根本没进正文**；v2 修好了落位，
> v3 又把「重写提示词」从预设里拆了出来。下面把根因、参考实现和改法都写清楚。

---

## 一、v1 为什么完全看不到图

| # | 根因 | 证据 |
|---|---|---|
| 1 | **走了错误的通道**：v1 把图塞进 `message.extra.media[]` 再调 `appendMediaToMessage()`。这条通道渲染出来的是 `.mes_text` **外面**的 `.mes_media_wrapper`，位置固定在楼层底部，永远贴不到正文中间。 | `appendMediaToMessage` 末尾是 `mediaWrapper.empty().append(mediaBlocks)`，`mediaWrapper` 是 `.mes_media_wrapper`，与 `.mes_text` 平级 |
| 2 | **触发时楼层还不存在**：`MESSAGE_RECEIVED` 在 `addOneMessage()` **之前** 触发（`script.js` 非流式 6722→6723 行、流式 `finalizeIntermediaryMessage` 里也是先 emit 再渲染）。v1 在这个时机去 `$('#chat .mes[mesid]')` 取元素，取到空集，`appendMediaToMessage` 静默空转；它又没在渲染后再补一次，于是图只存在于内存里。 | `script.js:6722` `emit(MESSAGE_RECEIVED)` → `6723` `addOneMessage(...)` |
| 3 | **默认值把出图频率砍半**：`interval` 默认 2，且计数器只在「通过基础校验」时才递增。用户以为坏了，其实是隔一条才出一张。 | 旧 `defaultSettings.interval = 2` |
| 4 | **没有任何自愈**：酒馆的 `updateMessageBlock`、右键编辑、swipe 都直接用 `.html()` / `.empty()` 重写 `.mes_text`，且**一个事件都不发**。凡是把节点插在 `.mes_text` 里的方案，被洗掉之后必须有补挂机制，v1 完全没有。 | 见 `src/floor/hydrate.ts` 里「两层触发，缺一不可」的注释 |

---

## 二、三个参考项目是怎么做到的

| 项目 | 触发时机 | 位置锚点 | 落位方式 | 状态持久化 |
|---|---|---|---|---|
| **ST-BaiBai-Image** | 生成 tag 后握手（`autoGenerate` 标记 + 渲染事件） | 正文里的 `bbi_image` 槽位；副 API 规划 `⟦P编号⟧` 段落 ID，注入时按 ID 映射回原始物理行 | 每槽位一个 host + shadow root，挂在槽位**行内** | 模块级 `genState` + 独立 store（含 `generationMeta`） |
| **st-chatu8** | `MESSAGE_RECEIVED` / `MESSAGE_SWIPED` + 流式预生成 | LLM 在正文里写 `image###prompt###`，插件按文本位置匹配 DOM | 直接改 `.mes_text` 内部节点，改完用 `messageFormatting()` 重渲 | `message.extra.images[swipeKey]` |
| **本地 LocalDream 脚本**（`D:\.生图`） | `MutationObserver` + 酒馆事件轮询 | AI 输出 `<local_img>…</local_img>`，正则渲染成占位框 | 脚本往占位框里填 `<img>` | 图存 IndexedDB，正文只留占位标记 |

三条实现的共同点，也是这件事真正的关键：

1. **位置必须靠「正文里的锚点」表达**，不能靠 `extra.media`（BaiBai 在
   `architecture.md` 里明确写过：因为「卡片必须落在 tag 的行内位置」，所以否掉了官方 `extra.media` 方案）；
2. **渲染完还要能重挂**：ST 有多条路径会静默重写 `.mes_text`，必须有
   `MutationObserver` 这一层自愈（BaiBai 的 `chatObserver.ts`、LocalDream 的
   `MutationObserver + 酒馆事件` 都是同一招）；
3. **状态要跟着聊天存档走**，而不是只活在 DOM 里（chatu8 存 `extra.images`）。

v2 就是按这三条重写的，但**不要求 AI 输出任何标记** —— 锚点由插件自己算。

---

## 三、v2 的机制

```
MESSAGE_RECEIVED ──► 挑一段正文当提示词 ──► 算出锚点(段号+段首快照)
                          │                        │
                          │                        ├─► 立刻插「正在配图…」骨架
                          ▼                        │
                 POST /images/generations          │
                          ▼                        │
            POST /api/images/upload ──► /user/images/xxx.png
                          ▼                        ▼
             写入 message.extra.imagefree ──► 水合：<figure> 插到锚点段之后
                          │
                          ▼
        syncMesToSwipe() + saveChatDebounced()   ← 锚点随存档走
```

**锚点** = `{ para: 段序号, snippet: 段首 60 字 }`。
渲染时先拿 `snippet` 跟每个 `<p>` 做二元组「包含度」匹配（阈值 0.55），
对不上再退回段序号，越界兜底末段 —— 所以正文被翻译、被排版、被追加新段都不会丢图。

**两层触发，缺一不可**：

- 事件层：`CHARACTER_MESSAGE_RENDERED` / `MESSAGE_UPDATED` / `MESSAGE_EDITED` / `MESSAGE_SWIPED` / `CHAT_CHANGED`；
- 自愈层：`#chat` 上的 `MutationObserver`（`childList + subtree`，rAF 合并），
  兜住所有不发事件的重写路径。水合是**差分**的：状态和地址都没变就不动 DOM，
  避免流式渲染时 `<img>` 反复重载。

**每条 swipe 一套图**：`item.swipe` 记录生成时的 `swipe_id`，渲染只取当前 swipe 的；
切回旧 swipe 会显示当时那张。

---

## 三·五、触发方式：标记驱动（v3.2，默认）

问题：靠「AI 每回一楼就出图」，会在开场白、纯对话、甚至正文还没成型的时刻就触发，
重写模型拿不到足够的剧情，图自然乱。改成**让写文模型自己指定位置**：

1. 世界书已放在 `data/default-user/worlds/ImageFree配图标记.json`（酒馆世界书面板里直接可见；仓库里也留了一份 `worldbook/ImageFree配图标记.json` 供分发），
   它会让写文模型在合适的位置单独写一行 `[[配图]]`；
2. 插件只认这个标记：
   - **没有标记 → 一张都不出**（问候语、纯对话、没画面的段落都会被跳过）；
   - 有标记 → 只把**标记之前**的正文喂给重写模型（后面的剧情还没发生，不该影响这张图）；
   - 图插在标记所在位置，标记那一段自动隐藏，读者看不到 `[[配图]]`；
   - 一条正文里最多 2 个标记 → 最多 2 张图，按顺序生成。

| 设置项 | 说明 |
|---|---|
| **什么时候出图** | `正文里出现配图标记时`（默认，推荐）/ `每条 AI 回复都自动配一张`（老行为） |
| **配图标记** | 默认 `[[配图]]`，可改。也认 `[配图]`、`<配图>`、`[插图]`、`<image>` 等写法 |

> 想手动补图：点楼层右侧的魔杖按钮，tag 模式下它仍然会按「整楼」出图。

---

## 四、提示词重写 API（v3，重点）

### 为什么要单开一条 API

以前想让 AI「按剧情写提示词」，只能把规则塞进**预设**（那种让主模型在正文里输出
`<local_img>xxx</local_img>` 的格式条）。代价是：

- 换个预设就失效，只能用特定卡的特定预设；
- 规则条本身占 context、参与正文写作，容易把文风带跑；
- 正文里混进一堆标签，导出、复制、TTS 全被污染；
- 想调规则就得改预设，改坏了原来的效果也没了。

v3 把这件事搬到插件里：**另配一条 OpenAI 兼容的 `chat/completions`**，
它的唯一职责是「一段正文 → 一条提示词」。它不读对话预设、不进聊天上下文、
不产生任何聊天楼层，所以：

- 与预设**完全解耦**：你现在用哪张卡、哪个预设都不影响出图；
- 也不影响预设本身的任何行为（不注入、不改写、不追加）。

### 出图请求走哪边（CORS）

出图中转如果没返回 `Access-Control-Allow-Origin`，浏览器直接请求会 `Failed to fetch`，
而酒馆自己走服务端，所以会出现「写文正常、出图不行」。三个选项：

| 选项 | 说明 |
|---|---|
| **自动**（默认） | 先浏览器直连，被 CORS 挡了就自动改走服务端代理 |
| **只走浏览器** | 要求中转开 CORS |
| **只走服务端代理** | 需要装仓库里的 `server-plugin/imagefree-proxy`（见下） |

服务端代理是酒馆的服务端插件，把出图 POST 改由酒馆进程发出，彻底绕开 CORS：

```bash
cp -r server-plugin/imagefree-proxy <SillyTavern>/plugins/
# 改 plugins/imagefree-proxy/config.json 里的 allowHosts，填你中转的主机名
# 重启酒馆
```

它只转发到 `allowHosts` 里的主机（默认只放一个），避免变成任意 SSRF 跳板。

### 两种来源：专用 API / 复用主 API

面板里第一项就是「重写走哪条 API」：

| 来源 | 说明 | 什么时候用 |
|---|---|---|
| **专用 API** | 自己填地址 / Key / 模型，直连 `{base}/chat/completions` | 想用便宜的小模型单独跑重写；或主 API 是按量计费、不想被重写蹭额度 |
| **复用主 API** | 走酒馆自己的 `/api/backends/chat-completions/generate`，用的就是「生成正文那条连接」 | 懒人首选：不用再填 Key，也不会多一份账单地址 |

「复用主 API」下面还能选具体用哪条连接：

- **当前对话连接**（默认）：`chat_completion_source` / `model` / `custom_url` 原样透传，
  和你此刻聊天用的完全是同一套；
- **指定连接档案**：从酒馆「连接管理器」里挑一条，用它的地址和模型；
  插件会强制 `includePreset: false`，**不吃档案自带的预设**，规则只走插件这份。

两种方式 Key 都留在酒馆服务端（`secrets.json`），插件读不到、也不需要读。
选「复用主 API」时，下面那套地址 / Key / 模型会自动隐藏并被忽略。

### 配置项

| 项 | 说明 |
|---|---|
| **重写走哪条 API** | `专用 API` / `复用主 API`，见上 |
| **使用哪条连接** | 仅「复用主 API」：当前对话连接，或某个连接档案 |
| **重写 API 地址** | 填到 `/v1` 为止，如 `https://api.deepseek.com/v1`；只填域名会自动补 `/chat/completions` |
| **Key / 模型** | 常规 OpenAI 兼容参数；本地 Ollama、LM Studio、vLLM 都行 |
| **温度 / 最大 tokens** | 默认 **1.0** / **320000**（上限 100 万）。推理模型会先烧 reasoning token，别给太少 |
| **超时 / 重试** | 默认 60s（上限 600s）/ 1 次；4xx 不重试（配置错了重试没意义） |
| **正文上限** | 默认 **20000** 字（可到 100 万）。给重写模型看的剧情长度，按你的上下文上限给 |
| **提示词语言** | 英文（多数模型更准）/ 中文 |
| **风格后缀** | 拼在模型输出后面，模型本身不用写画质词，改这里就能统一画风 |
| **提示词上限（字）** | 默认 **800**（上限 4000）。注意：这只管最终那句提示词，不是模型的输出上限 |
| **重写规则 / 用户模板** | 可完全自定义；**清空 = 用内置规则**，可一键「恢复默认提示词」 |
| **测试重写** | 拿当前聊天最后一楼（没有就用示例文本）真跑一次，结果显示在面板下方 |

内置规则（`core.js` 的 `DEFAULT_REWRITE_SYSTEM`）是从主流中文卡那套画面公式里收敛出来的：
主体 → 动作表情 → 环境 → 光影 → 镜头 → 画风，一次只画**一个**瞬间，
禁止标签堆砌、禁止画质词（交给风格后缀）、禁止文字水印。

### 数据流

```
AI 正文 ──► 重写通道（system=内置规则，user=正文）
              ├─ 专用 API：直连 {base}/chat/completions
              └─ 复用主 API：酒馆 /api/backends/chat-completions/generate
                │
                ▼
        { prompt, anchor? }   ← 模型可以顺便指出「画的是哪一段」
                │
                ├─ prompt + 风格后缀 ──► 出图 API
                └─ anchor（可选）──► 锚点选择（比自己猜段落更准）
```

重写失败（没配、超时、报错）**不会中断出图**：自动回退到「直接取正文」，
但**一定会让你看见**：

- 图下面挂一个橙色 **「未重写」** 徽标，悬停能看到具体原因；
- 每个聊天第一次降级时弹一次 toast；
- 设置面板顶部常驻一条警告条（选了「独立 API 重写」但没配好时）。

> 这条是 v3.1.1 补的。之前是纯静默降级：正文原样被当提示词发出去，
> 看起来就像「插件还在把整段正文/预设内容丢给生图模型」，非常难排查。

### 提示词用 tag 还是自然语言？

拿同一段剧情、同一画幅（3:4）在 imagefree 上做了两组对照，只改写法：

| | 写法 | 结果 |
|---|---|---|
| A | `1girl, solo, silver hair, long hair, black dress, holding umbrella, clear umbrella, rain, night, neon lights, city street, wet ground, reflection, upper body, looking at viewer, masterpiece, best quality…` | 景别（upper body）、视线（looking at viewer）、服装细节、霓虹反光**全部照做**，画面很「稳」 |
| B | `A young woman with long silver hair stands on a rain-soaked city street at night, holding a clear umbrella tilted slightly to one side, neon signs reflected in the puddles around her feet, her black dress damp at the hem. Medium shot, shallow depth of field…` | 动作与场景关系更自然（走姿、伞的角度、裙摆湿了），但**景别被打回全身**、眼神没写就自己闭眼了 |

结论（也是插件的默认策略）：

- **要控制画面 → tag 更听话**：景别、视角、人数、服装件数、角色一致性，用标签短语写最不容易跑；
- **要还原剧情 → 自然语言更贴**：「把伞往他那边偏了偏」「指尖在桌沿停了一下」这类关系与动作，标签根本表达不了；
- **最好混写**：自然语言写「谁在做什么、什么关系」，尾部少量 tag 锁「景别 + 视线 + 画质」。
  插件的内置规则就是这么干的（英文短句 + 风格后缀），你只要在「风格后缀」里补
  `upper body, looking at viewer, masterpiece, best quality` 这类控制词即可。

两个容易踩的点：
1. **视线/表情一定要写**，不写模型自己发挥（上面对照里 B 就闭眼了）；
2. 这个上游对长度不敏感（60 词的自然语言照样能过），别为了「不超 token」把画面压成标签堆。

### 和旧方案的关系

`提示词来源` 里保留了三档，默认是新的 `独立 API 重写`：

| 档位 | 说明 |
|---|---|
| `独立 API 重写` | v3 默认。推荐 |
| `直接取正文` | 不调任何模型，长文容易出乱图 |
| `主模型 quiet prompt` | 旧方案，会跑当前预设 —— 只是为兼容保留，不建议 |

> 升级到 v3 会自动把模式切到「独立 API 重写」一次；没填地址前会自动回退，不会把出图中断。

---

## 五、装 & 配

把目录放进 `SillyTavern/public/scripts/extensions/third-party/st-imagefree/`，刷新页面。

后端只要实现 OpenAI Images 协议（`imagefree-2api` 就是）：

```http
POST {base_url}/images/generations        Authorization: Bearer <key>
{"model":"...","prompt":"...","size":"3:4","n":1,"response_format":"b64_json"}
→ 200 {"data":[{"b64_json":"iVBORw0KGgo..."}]}
```

| 项 | 说明 |
|---|---|
| **API 地址** | 填到 `/v1`，例如 `http://127.0.0.1:8080/v1` 或你的远端中转 |
| **API Key** | 中转的 `RELAY_API_KEY`（默认 `1234567A`，**留空会被回 401**） |
| **提示词来源** | `独立 API 重写`（v3 默认）/ 直接取正文 / 主模型 quiet prompt（旧）|
| **图片插入位置** | `按剧情自动匹配`（默认）/ 开头 / 末尾 / 随机；自动匹配 = 提示词与各段正文的二元组相似度取最大 |
| **每 N 楼出图** | v2 默认 1（每条都出）；老配置里仍是 2 的会自动迁到 1 |
| **每楼最多几张** | 1~4，多张按生成顺序排在同一段后面 |
| **换 swipe 时也自动配图** | 每条 swipe 独立出图 |
| **显示大小** | 小/中/大/铺满，只影响聊天里的显示宽度 |
| **调试日志** | 打开后控制台会打印触发、锚点段号、水合增量 |

---

## 六、怎么验证（从便宜到贵）

### 1. 单测 + 流程测试（不联网、不开酒馆）

```bash
cd tests && npm install && npm test      # 期望 66 passed
```

`flow.test.mjs` 用 jsdom 复刻楼层 DOM，把 `index.js` 的 import 改指到 `stub/`
真跑一遍，覆盖：自动触发、内联位置、`.mes_text` 被重写后自愈、不重复出图、
interval、user/system/quiet 过滤、swipe 隔离、删除/重试、`position=end`、`perMessage` 上限，
以及 v3 的重写链路：**调用独立 API 且不碰主模型**、失败回退、未配置回退、按模型指认的段落落位。

### 2. 页面内自检（真网络，会消耗一张额度）

酒馆页面 F12 控制台：

```js
STImageFree.diagnose()     // 看 dom/observer/inflight/mode/rewriteReady/最近错误
await STImageFree.selfTest()   // 真出一张图 + 真存进 user/images，返回 path
```

设置面板里还有「**测试重写**」：拿最后一楼正文真跑一次重写，把「提示词 / 段落线索 /
模型原始返回」直接打在面板上，不用出图就能确认重写 API 通不通。

### 3. 实聊验证清单

1. 打开设置 → 勾「调试日志」，F12 看 `[ImageFree]` 有没有 `自动触发：楼层 N type=normal`；
2. 正常聊一句 → 该楼层目标段落后面出现「正在配图…」骨架；
3. 15~30 秒后骨架变成图片，且**夹在两段正文之间**（不是楼层底部）；
4. 右键编辑该楼层随便改个字再保存 → 图应自动回到原段落后面（这就是自愈）；
5. 刷一下页面 → 图还在（说明 `extra.imagefree` 已随存档落盘）；
6. 右滑换一条 swipe → 出新图；切回旧 swipe → 变回旧图。

### 4. 这次交付时实跑的结果（酒馆 1.18.0 + 真中转）

- 真浏览器端到端（v2）：造一条 3 段楼层 → 出图 17.1s → `<figure>` 落在第 2 段之后 →
  `<img>` 实际加载 768px → `extra.media` 为空（没走图廊通道）→ `updateMessageBlock`
  重写后 400ms 内自动补回原位 → 页面无 JS 异常；
- 真浏览器端到端（v3 重写）：接一条本地假 `chat/completions` → 出图 14.0s →
  `item.source === 'rewrite'` → 提示词 = 模型输出 + 风格后缀 →
  按模型给的 `anchor` 落在第 2 段之后 → 图真实加载 768px → 无 JS 异常；
- 真浏览器端到端（v3.1 复用主 API）：把「当前对话连接」临时指向本地假服务 →
  插件 → 酒馆 `/api/backends/chat-completions/generate` → 假上游收到
  `model=main-model`、system 621 字、user 带正文 → 出图 27.3s → 图 768px 正常 → 无 JS 异常；
- 存档恢复：只给 `extra.imagefree` 数据 + `hydrateAll()`，图正确复位，300px 显示上限、
  10px 圆角、悬停操作条（重绘/复制/删除）都生效；
- **长对话压测（v3.1.2）**：连发 7 楼，正文 700→3031 字（含 `<local_img>` 标签楼、
  `{{setvar}}` 变量楼），每楼都走 `MESSAGE_RECEIVED` 真触发。结果：7/7 `source=rewrite`、
  0 降级、生图接口实收提示词 200~219 字（无正文/标签泄漏）、图 7/7 落在对应段落；
  额外加一楼「模型把剧情复述一遍」，输出被压到 52 字（`maxPromptChars` 生效），
  且开场白「好的，我先梳理一下…」被剥掉。

---

## 七、已知限制

- 上游只有一个模型、固定长边 1024，画幅只能选比例；单张 15~40 秒，同 IP 最多 3 张并行；
- 没有 seed / 负面提示词（上游忽略这些字段）；
- 删除配图只删聊天里的记录，`user/images` 里的文件会留着（避免误删复用图）；
- 手动改了正文内容后，锚点会按新正文重算（`MESSAGE_EDITED` 里处理），
  但如果改动大到「这一段文字全变了」，图会退到段序号位置。

---

## 八、排障

| 现象 | 先看这里 |
|---|---|
| 完全不出图 | 控制台 `STImageFree.diagnose()`；`lastErrors` 里 401 = Key 没填；`自动触发` 没打印 = 消息不是最新一楼 / `is_user` / interval 没到 |
| 出图了但看不见 | 「运行诊断」按钮：`messagesWithItems > 0 && dom.figures === 0` 说明水合没挂上，多半是 `#chat` 里没有 `.mes_text`（主题改过结构） |
| 图跑到楼层底部 | 你装的是 v1 的旧文件，确认 `manifest.json` 里 `version` 是 `2.0.0` |
| 位置老是不对 | 把「插入位置」从「自动匹配」改成「末尾」先看链路通不通，再回来调 |
| 混合内容报错 | 酒馆是 https 时浏览器会拦 http 接口，给中转套一层 https 或反代 |
| 图里有奇怪的东西 / 一张图塞了整段剧情 | 提示词没重写好。开「调试日志」看 `出图完成（rewrite/direct）`：`direct` 说明重写 API 没通，去设置里点「测试重写」看报错 |
| 重写报 404 | 地址通常该填到 `/v1` 为止；有的网关是 `/v1/chat/completions` 直填，两种都支持 |
| 重写报 400 且提示 response_format | 关掉「JSON 模式」再试（部分网关不支持该字段） |
| 中文提示词效果差 | 「提示词语言」切英文；风格后缀里补画风词（如 `anime style, cel shading`） |
| 复用主 API 报 `Connection Manager is not available` | 酒馆里把「连接管理器」扩展启用了；或改用「专用 API」 |
| 复用主 API 报 400/401 | 说明你当前对话那条连接本身就有问题（先去正常聊一句确认）；也可改用「指定连接档案」换一条 |
| 复用主 API 走的是文本补全接口 | 插件只支持 Chat Completion；面板会提示，并自动回退到「直接取正文」 |
| 图上挂「未重写」徽标 | 这张是降级产物：重写没成功。悬停看原因，或点设置里「测试重写」 |
| 复用主 API 报 `URL scheme "xx" is not supported` | 你的 `custom_url` 用了自定义协议（如 `ds://xxx`）。那是给浏览器/本地代理看的，酒馆服务端 `fetch` 不了；换成真实的 `https://…/v1` |
| 连接档案报 `Authorization Required` | 所有 custom 档案共用同一个 secret（`api_key_custom`），key 和该站不匹配；换一条档案或改用专用 API |
| 提示词里混进 `1girl, masterpiece` 之类 | v3.1.1 已修：降级取正文时会把这些标签连内容一起摘掉 |
| 报错 `连不上出图服务 http://…` | 出图服务本身没起/挂了。先在浏览器直接打开那个地址确认，跟插件无关 |
| 报错 `Failed to fetch` | 同上；若地址是 http 而酒馆是 https，会被浏览器拦掉 |
| 报错 `重写 API 400` | 现在会带 URL、模型名和响应体原文。多数是模型名不对，或该站不认 `temperature`/`max_tokens`/`stream` |
| 报错「只返回了思考过程」 | 推理模型把 token 花在 reasoning 上了，「最大 tokens」调到 800 以上 |
| 一条图都不出（tag 模式） | 正文里没有 `[[配图]]`。检查世界书有没有生效 |

---

## 九、免责

仅供个人学习与研究。别拿它刷图，站方的带宽和 GPU 都是自费的。
