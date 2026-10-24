# ST-ImageFree — 酒馆自动配图

给 SillyTavern 用的生图扩展：AI 每回复若干楼，自动（或手动）调出一张图，
存进酒馆并嵌在对应楼层里。

### 需要一个 OpenAI Images 兼容的后端

本扩展本身不含生图能力，只负责「什么时候画、写什么提示词、画完怎么塞进楼层」。
后端只要满足一条协议即可：

```http
POST {base_url}/images/generations
Authorization: Bearer <key>
Content-Type: application/json

{"model":"...","prompt":"...","size":"3:4","n":1,"response_format":"b64_json"}

→ 200 {"data":[{"b64_json":"iVBORw0KGgo..."}]}
```

`response_format` 填 `url` 时应返回 `{"data":[{"url":"https://..."}]}`。
任何实现了 OpenAI Images API 的服务（自建中转、SD WebUI 的 openai 兼容层等）都能接。

---

## 一、安装

把本目录整个放进酒馆的第三方扩展目录：

```
SillyTavern/public/scripts/extensions/third-party/st-imagefree/
```

或在酒馆「扩展 → 安装扩展」里填本仓库地址。放好后**刷新酒馆页面**即可。

打开「扩展设置」就能看到 **ImageFree 自动配图** 面板。

---

## 二、配置

| 项 | 说明 |
|---|---|
| **API 地址** | 填到 `/v1` 为止，例如 `http://127.0.0.1:8080/v1` |
| **API Key** | 后端的中转 Key（默认 `1234567A`） |
| **画幅** | 竖版 3:4 最适合人物半身；9:16 适合竖构图长图 |
| **提示词来源** | 见下 |
| **每 N 楼出图** | 默认 2，即每两条 AI 回复配一张，避免刷屏和浪费额度 |
| **正文截取字数** | 「直接取正文」模式下截取多少字 |
| **把图片存进酒馆** | 推荐开启，图片落到 `user/images`，换设备不失效 |
| **楼层按钮** | 关掉后只能用自动模式 |

### 两种提示词模式

- **直接取正文（默认）**：把本楼文字截一段直接当提示词。零额外开销，20 秒内出图。
  Z-Image 对中文自然语言理解很好，正文本身带场景/光线描述时效果已经不错。
- **让对话模型写提示词**：额外调一次当前对话模型，把剧情浓缩成一条画面描述。
  画面更准（会自动提炼主体、服装、光线、镜头），代价是多一次 LLM 调用。

---

## 三、用法

- **自动**：开着「启用自动配图」，正常聊天即可。每 N 条 AI 回复出一张。
- **手动**：楼层右侧的魔杖按钮（🪄），点一下给这一楼配图。
- **补图**：设置面板里的「为最后一楼配图」。
- **测试**：设置面板里的「测试连接」，会真的出一张苹果图验证链路。

生成时楼层里会显示「正在配图…」，完成后图片嵌在该楼层正文下方，鼠标悬停可看提示词。

---

## 四、实现要点（给改代码的人）

对齐酒馆 1.18.0 的接口：

```js
// 1. 楼层图片 = message.extra.media[]
message.extra.media.push({ url, type: 'image', title: prompt, source: 'generated' });
message.extra.media_display = 'gallery';
message.extra.inline_image = true;        // true = 图片与正文并存
appendMediaToMessage(message, messageElement, SCROLL_BEHAVIOR.KEEP);

// 2. 图片落盘 = POST /api/images/upload（base64），返回 user/images/xxx.png
//    比直接塞外链稳：换设备、导出聊天都不会丢图

// 3. 事件
eventSource.on(event_types.MESSAGE_RECEIVED, ...)       // 新回复
eventSource.on(event_types.MESSAGE_SWIPED, ...)         // 换 swipe
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, ...)  // 补楼层按钮
```

### 几个坑

1. **别把 base64 写进聊天存档**。旧式做法会让存档膨胀到上百 MB。本扩展走
   `/api/images/upload` 落成文件，存档里只留路径。
2. **CORS**：`r2.dev` 不返回 `Access-Control-Allow-Origin`，浏览器**读不了**图片字节
   （但 `<img src>` 能正常显示）。所以想要本地副本，必须由后端把图转 base64 返回。
3. **混合内容**：酒馆跑在 HTTPS 时不能调 HTTP 接口。本地面板一般是 http，没问题。
4. **上游图床偶发断连**：扩展内置一次自动重试（2 秒后），后端另有独立下载重试。

---

## 五、已知限制

- 上游只有一个模型、固定长边 1024，画幅只能选比例
- 单张 15~40 秒（上游波动大），同一 IP 最多 3 张并行
- 没有 seed / 负面提示词（上游直接忽略这些字段）

---

## 六、免责

仅供个人学习与研究。别拿它刷图，站方的带宽和 GPU 都是自费的。
