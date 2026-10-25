# 测试（仅开发用，酒馆不会加载这里）

这套测试不依赖酒馆进程，用 jsdom 复刻楼层 DOM，然后把 `index.js` 的两条
`import` 改指向 `stub/`（假酒馆），在 `.gen/` 里真跑一遍 —— 测的是真代码：
事件注册、自动触发、锚点计算、内联水合、存档写入全都跑，只有酒馆本体被替身掉。

## 跑法

```bash
cd tests
npm install          # 只装 jsdom + jquery，约 30MB，装在本目录的 node_modules
npm test             # = node --test core.test.mjs flow.test.mjs
```

预期：`# pass 35  # fail 0`。

## 两个文件测什么

| 文件 | 覆盖 |
|---|---|
| `core.test.mjs` | 切段（空行/单换行/代码块）、提示词清洗、段落相似度选锚点、段号漂移后靠快照复位、同段多图排序、差分水合幂等 |
| `flow.test.mjs` | MESSAGE_RECEIVED 自动触发、图片内联位置、`.mes_text` 被重写后自愈、不重复出图、interval、user/system/quiet 过滤、swipe 独立成图、删除/重试按钮、失败自动重试、position=end、perMessage 上限、llm 模式、不走 extra.media |

## 注意

- `flow.test.mjs` 第 3 条（自愈）是这套改动的核心断言：酒馆的 `updateMessageBlock`
  会用 `.html()` 重写 `.mes_text` 且**不发事件**，图必须能自己回来。
- 测试只跑逻辑，不联外网：`fetch` 被 `harness.mjs` 里的假实现接管。
- 想连真接口做冒烟，用酒馆页面控制台里的 `STImageFree.selfTest()`（会在 `user/images` 留一张测试图）。
