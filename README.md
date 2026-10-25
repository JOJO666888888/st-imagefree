# ST-ImageFree · v2 — 酒馆正文内联配图

给 SillyTavern 用的自动配图扩展：AI 每回一段，自动挑一段剧情出图，
**图片直接插在那段文字的后面**（不是塞到楼层底部的图廊里），
锚点随聊天存档走，刷新、切聊天、换设备都能回到原位。

> v1 的问题不是「生图没成功」，而是**图片根本没进正文**。v2 重写了整条渲染链路，
> 下面第二节把根因、参考实现和改法都写清楚了。

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

## 四、装 & 配

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
| **图片插入位置** | `按剧情自动匹配`（默认）/ 开头 / 末尾 / 随机；自动匹配 = 提示词与各段正文的二元组相似度取最大 |
| **每 N 楼出图** | v2 默认 1（每条都出）；老配置里仍是 2 的会自动迁到 1 |
| **每楼最多几张** | 1~4，多张按生成顺序排在同一段后面 |
| **换 swipe 时也自动配图** | 每条 swipe 独立出图 |
| **显示大小** | 小/中/大/铺满，只影响聊天里的显示宽度 |
| **调试日志** | 打开后控制台会打印触发、锚点段号、水合增量 |

---

## 五、怎么验证（从便宜到贵）

### 1. 单测 + 流程测试（不联网、不开酒馆）

```bash
cd tests && npm install && npm test      # 期望 35 passed
```

`flow.test.mjs` 用 jsdom 复刻楼层 DOM，把 `index.js` 的 import 改指到 `stub/`
真跑一遍，覆盖：自动触发、内联位置、`.mes_text` 被重写后自愈、不重复出图、
interval、user/system/quiet 过滤、swipe 隔离、删除/重试、`position=end`、`perMessage` 上限。

### 2. 页面内自检（真网络，会消耗一张额度）

酒馆页面 F12 控制台：

```js
STImageFree.diagnose()     // 看 dom/observer/inflight/最近错误
await STImageFree.selfTest()   // 真出一张图 + 真存进 user/images，返回 path
```

### 3. 实聊验证清单

1. 打开设置 → 勾「调试日志」，F12 看 `[ImageFree]` 有没有 `自动触发：楼层 N type=normal`；
2. 正常聊一句 → 该楼层目标段落后面出现「正在配图…」骨架；
3. 15~30 秒后骨架变成图片，且**夹在两段正文之间**（不是楼层底部）；
4. 右键编辑该楼层随便改个字再保存 → 图应自动回到原段落后面（这就是自愈）；
5. 刷一下页面 → 图还在（说明 `extra.imagefree` 已随存档落盘）；
6. 右滑换一条 swipe → 出新图；切回旧 swipe → 变回旧图。

### 4. 这次交付时实跑的结果（酒馆 1.18.0 + 真中转）

- 真浏览器端到端：造一条 3 段楼层 → 出图 17.1s → `<figure>` 落在第 2 段之后 →
  `<img>` 实际加载 768px → `extra.media` 为空（没走图廊通道）→ `updateMessageBlock`
  重写后 400ms 内自动补回原位 → 页面无 JS 异常；
- 存档恢复：只给 `extra.imagefree` 数据 + `hydrateAll()`，图正确复位，300px 显示上限、
  10px 圆角、悬停操作条（重绘/复制/删除）都生效。

---

## 六、已知限制

- 上游只有一个模型、固定长边 1024，画幅只能选比例；单张 15~40 秒，同 IP 最多 3 张并行；
- 没有 seed / 负面提示词（上游忽略这些字段）；
- 删除配图只删聊天里的记录，`user/images` 里的文件会留着（避免误删复用图）；
- 手动改了正文内容后，锚点会按新正文重算（`MESSAGE_EDITED` 里处理），
  但如果改动大到「这一段文字全变了」，图会退到段序号位置。

---

## 七、排障

| 现象 | 先看这里 |
|---|---|
| 完全不出图 | 控制台 `STImageFree.diagnose()`；`lastErrors` 里 401 = Key 没填；`自动触发` 没打印 = 消息不是最新一楼 / `is_user` / interval 没到 |
| 出图了但看不见 | 「运行诊断」按钮：`messagesWithItems > 0 && dom.figures === 0` 说明水合没挂上，多半是 `#chat` 里没有 `.mes_text`（主题改过结构） |
| 图跑到楼层底部 | 你装的是 v1 的旧文件，确认 `manifest.json` 里 `version` 是 `2.0.0` |
| 位置老是不对 | 把「插入位置」从「自动匹配」改成「末尾」先看链路通不通，再回来调 |
| 混合内容报错 | 酒馆是 https 时浏览器会拦 http 接口，给中转套一层 https 或反代 |

---

## 八、免责

仅供个人学习与研究。别拿它刷图，站方的带宽和 GPU 都是自费的。
