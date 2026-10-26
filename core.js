/**
 * ImageFree · 核心逻辑（无 SillyTavern 依赖）
 *
 * 这里只放「跟酒馆无关」的纯函数与纯 DOM 工具：
 *   - 正文切段、提示词清洗、段落相似度、锚点选择
 *   - 楼层内联图片节点（<figure>）的创建与定位
 *
 * 之所以单独拆一个文件：index.js 里全是 `import ... from '../../../../script.js'`，
 * 在 Node 里跑不起来；把判定逻辑放在这里，就可以用 jsdom 直接单测，
 * 定位「图为什么插错位置」这类问题不用每次都开酒馆点半天。
 */

/** 楼层内联图片节点用到的 class / 属性名（index.js 与测试共用，避免写法漂移） */
export const IF_CLASS = 'if-figure';
export const IF_ID_ATTR = 'data-if-id';
export const IF_STATUS_ATTR = 'data-if-status';
export const IF_SRC_ATTR = 'data-if-src';
export const IF_ANCHOR_ATTR = 'data-if-anchor';
export const IF_ACTION_ATTR = 'data-if-action';

/** 允许作为「段」的标签：酒馆 markdown 渲染后正文基本是 <p>，其它主题偶尔用 <div>/<li> */
const BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'BLOCKQUOTE', 'PRE', 'TABLE',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
]);

// ───────────────────────────── 文本处理 ─────────────────────────────

/**
 * 压成「可见文本」：去 HTML、去 markdown 记号、去图片/链接、空白归一。
 * 用于切段、算相似度、生成快照（snippet）。
 */
export function normalizeText(raw) {
    return String(raw ?? '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/~~~[\s\S]*?~~~/g, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/[*_~`>#|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * 生成送给出图接口的提示词：在 normalizeText 基础上再去掉引号与句末标点。
 * 上游对换行和引号很敏感（会被当成参数分隔符），必须压成一行。
 */
export function cleanPrompt(raw, maxLen = 400) {
    const text = normalizeText(raw)
        .replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '')
        .replace(/[。！？；]+$/g, '')
        .trim();
    return maxLen > 0 ? text.slice(0, maxLen) : text;
}

/**
 * 把一条正文切成「段」。
 *
 * 规则（按优先级）：
 *   1. 围栏代码块（``` / ~~~）整块保留，标记 skip —— 代码块里不该插图；
 *   2. 空行分段的段落；
 *   3. 单段超过 420 字时，再按单换行切开 —— 很多模型用 \n 而不是空行分段，
 *      不切的话整楼只有一段，"插到对应位置"就退化成"永远插在末尾"。
 *
 * @returns {{index:number, text:string, plain:string, skip:boolean}[]}
 */
export function splitBlocks(mes) {
    const src = String(mes ?? '');
    const blocks = [];
    let buf = [];
    let fence = null;

    const makeBlock = (text) => {
        const plain = normalizeText(text);
        const isFence = /^\s*(```|~~~)/.test(text);
        // 纯符号行（***、---）normalize 后为空；代码块整块跳过。
        // 阈值取 4 而不是更大：中文 5~6 个字的一段已经能当锚点了。
        const skip = isFence || plain.length < 4;
        blocks.push({ index: blocks.length, text, plain, skip });
    };

    const flush = () => {
        const text = buf.join('\n').trim();
        buf = [];
        if (!text) return;
        if (text.length > 420 && /\n/.test(text) && !/^\s*(```|~~~)/.test(text)) {
            for (const part of text.split(/\n/)) {
                const line = part.trim();
                if (line) makeBlock(line);
            }
            return;
        }
        makeBlock(text);
    };

    for (const line of src.split(/\r?\n/)) {
        const fenceMatch = /^\s*(```|~~~)/.exec(line);
        if (fenceMatch) {
            if (!fence) {
                flush();
                fence = fenceMatch[1];
                buf.push(line);
                continue;
            }
            if (line.trim().startsWith(fence)) {
                buf.push(line);
                flush();
                fence = null;
                continue;
            }
        }
        if (fence) {
            buf.push(line);
            continue;
        }
        if (!line.trim()) {
            flush();
            continue;
        }
        buf.push(line);
    }
    flush();

    return blocks;
}

// ─────────────────── 提示词重写（独立 API，不碰对话预设） ───────────────────

/**
 * 内置的重写规则。
 *
 * 这套规则原本只能写在预设里（让主模型边写正文边吐 `<local_img>` 标签），
 * 结果是「换预设就失效」「正文被标签污染」。搬到插件侧之后，主模型只写正文，
 * 重写由另一条 API 单独做，两边彻底解耦。
 *
 * 内容参考了主流中文卡预设里那套 SDXL 画面公式（主体/临时特征/环境/光影/景别），
 * 但收敛成「一段正文 → 一条提示词」，不要求模型输出标签或列表。
 */
export const DEFAULT_REWRITE_SYSTEM = [
    '你是一名文生图提示词工程师。用户会给你一段中文小说正文，你要把它转写成**一条**可直接喂给文生图模型的提示词。',
    '',
    '## 工作方式',
    '1. 读完整段正文，只挑**一个**最值得定格的瞬间：画面清楚、主体明确、有动作或情绪的那一刻。',
    '   不要把整段剧情塞进一张图，也不要把几个不相干的场景拼在一起。',
    '2. 把这一刻写成画面，依次交代：主体（性别、年龄段、发型发色、瞳色、体型、服装）→ 动作与表情 →',
    '   环境与道具 → 光线与氛围 → 镜头（景别、角度、景深）→ 画风。',
    '3. 画面里超过一个人时，写清楚谁在前景、谁在背景、各自在做什么，避免肢体糊成一团。',
    '4. 角色外貌只写一遍、写具体；同一角色前后要一致。',
    '',
    '## 输出规则（严格遵守）',
    '- 只输出一行提示词。不要解释、不要编号、不要引号、不要 Markdown、不要「提示词：」这类前缀、',
    '  不要任何 XML 或尖括号标签。',
    '- 用英文写，逗号分隔的短语或短句，可以有 1~2 个完整句子。',
    '- 长度 25~60 个英文单词。宁可少写，也不要堆互相矛盾的形容词。',
    '- 不要写画质词（masterpiece、best quality、8k 之类）—— 画质与画风由用户配置的「风格后缀」统一追加。',
    '- 不要出现文字、水印、签名、logo、边框，也不要写多余的手指、重复肢体。',
    '- 如果正文是纯对话或纯心理活动，就画「说话的人此刻的样子」：姿势、表情、所在环境。',
    '',
    '只输出那一行提示词。',
].join('\n');

/** 默认的用户消息模板；可用 {{char}} {{user}} {{story}} {{index}} {{count}} {{style}} */
export const DEFAULT_REWRITE_USER = [
    '【角色】{{char}}',
    '【正文】',
    '{{story}}',
    '',
    '按规则输出这一张的提示词（第 {{index}}/{{count}} 张）。',
].join('\n');

/**
 * 去掉正文里残留的生图标签。
 *
 * 用户可能还在别的预设下沿用 `<local_img>…</local_img>` / `<image>…</image>` /
 * `image###…###` 那套写法；这些标签对重写模型是噪声，先摘掉再送过去。
 */
export function stripImageTags(text) {
    return String(text ?? '')
        .replace(/<local_img>[\s\S]*?<\/local_img>/gi, ' ')
        .replace(/<image>[\s\S]*?<\/image>/gi, ' ')
        .replace(/<images>[\s\S]*?<\/images>/gi, ' ')
        .replace(/image###[\s\S]*?###/g, ' ')
        .replace(/[ \t]{2,}/g, ' ');
}

/** 极简模板替换：{{name}} → vars.name，缺变量原样保留 */
export function renderTemplate(tpl, vars = {}) {
    return String(tpl ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) => {
        const v = vars[key];
        return v === undefined || v === null ? m : String(v);
    });
}

/**
 * 组装重写请求的 messages。
 * @returns {{role:string, content:string}[]}
 */
export function buildRewriteMessages({ system, userTemplate, vars = {} }) {
    const sys = renderTemplate(system || DEFAULT_REWRITE_SYSTEM, vars).trim();
    const user = renderTemplate(userTemplate || DEFAULT_REWRITE_USER, vars).trim();
    const messages = [];
    if (sys) messages.push({ role: 'system', content: sys });
    messages.push({ role: 'user', content: user });
    return messages;
}

/**
 * 从重写模型的回复里抠出提示词。
 *
 * 现实里各家模型/网关的输出非常脏：思维链、代码块、JSON、`提示词：` 前缀、
 * 甚至把 `<local_img>` 标签也照抄一遍。这里按「越像成品越优先」的顺序逐层剥。
 *
 * @returns {{prompt:string, anchor:string}} anchor 是模型指认的段落开头（可选，用于提高插图位置准确度）
 */
export function parseRewriteOutput(raw) {
    let text = String(raw ?? '').trim();
    if (!text) return { prompt: '', anchor: '' };

    // 1. 思维链 / reasoning
    text = text
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, ' ')
        .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, ' ')
        // 模型可能照着老习惯把提示词包进标签：这里要的是「脱壳」而不是「连内容一起删」
        .replace(/<local_img>([\s\S]*?)<\/local_img>/gi, '$1')
        .replace(/<image>([\s\S]*?)<\/image>/gi, '$1')
        .replace(/image###([\s\S]*?)###/g, '$1')
        .trim();

    // 2. 整体被包在代码块里 → 先脱一层
    const fence = /^```[\w-]*\s*\n([\s\S]*?)\n?```$/.exec(text);
    if (fence) text = fence[1].trim();
    text = text.replace(/```[\s\S]*?```/g, ' ').trim();

    // 3. JSON（允许前后有废话）
    const jsonMatch = /\{[\s\S]*\}/.exec(text);
    if (jsonMatch) {
        try {
            const obj = JSON.parse(jsonMatch[0]);
            const p = obj.prompt ?? obj.prompt_en ?? obj.text ?? obj.tag ?? obj.tags;
            if (typeof p === 'string' && p.trim()) {
                return {
                    prompt: finalizePrompt(p),
                    anchor: typeof obj.anchor === 'string' ? obj.anchor.trim() : '',
                };
            }
        } catch { /* 不是 JSON，继续走文本解析 */ }
    }

    // 4. 纯文本：去掉标签、前缀、引号，取第一条像样的行
    text = stripImageTags(text).trim();

    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const raw of lines) {
        const line = raw
            .replace(/^[-*·•]\s*/, '')
            .replace(/^(?:正向提示词|提示词|prompt|tags?)\s*[:：]\s*/i, '')
            .trim();
        if (line.length < 6) continue;
        if (/^[#<>{}\[\]|]/.test(line)) continue;          // 标题、标签行
        if (/^(?:说明|解释|注|注意|理由|解析|备注)[:：]/.test(line)) continue;
        return { prompt: finalizePrompt(stripLeadIn(line)), anchor: '' };
    }

    return { prompt: finalizePrompt(stripLeadIn(text)), anchor: '' };
}

/**
 * 去掉模型的开场白。
 * 有些模型会先来一句「好的，我先梳理一下这段剧情」「以下是提示词：」再给正文，
 * 不剥掉的话，这句话会被当成提示词的一部分发给生图模型。
 */
function stripLeadIn(text) {

    const CN = /^(?:(?:好的|好|当然|没问题|可以|明白|收到|以下是|下面是|这是|根据|我先|我来|让我|这里|简单来说)[^。！？\n]{0,40}[。！？:：]\s*)+/u;
    const EN = /^(?:(?:sure|okay|ok|certainly|of course|here(?:'s| is)|below is)[^.!?\n]{0,60}[.!?:]\s*)+/i;
    return String(text ?? '').replace(CN, '').replace(EN, '').trim();
}

/** 收尾：去引号/多余空白/句末句号，压成一行 */
function finalizePrompt(text) {
    return String(text ?? '')
        .replace(/\s*\r?\n\s*/g, ' ')
        .replace(/^["'“”‘’「」『』\s]+|["'“”‘’「」『』\s]+$/g, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/[，、；]+/g, (m) => (m === '，' ? ', ' : m))
        .trim()
        .slice(0, 600);
}

/**
 * 给提示词硬性封顶。
 *
 * 现实里总会有模型无视「只输出一行」，把整段剧情复述一遍；不封顶的话，
 * 生图接口收到的就还是「一大段正文」—— 用户看到的症状正是这个。
 * 截断点优先落在句号/逗号/分号后面，避免把一句话劈成两半。
 */
export function capPrompt(text, maxChars = 400) {
    const raw = String(text ?? '').trim();
    const limit = Math.max(80, Number(maxChars) || 400);
    if (raw.length <= limit) return { text: raw, truncated: false };

    const slice = raw.slice(0, limit);
    const cut = Math.max(
        slice.lastIndexOf('. '), slice.lastIndexOf(', '),
        slice.lastIndexOf('; '), slice.lastIndexOf('。'), slice.lastIndexOf('，'),
    );
    const text2 = (cut > limit * 0.5 ? slice.slice(0, cut + 1) : slice).trim();
    return { text: text2, truncated: true };
}

/**
 * 把模型写的提示词和用户配置的风格后缀拼起来。
 * 后缀放最后，避免模型自己写画质词时把主体挤出权重。
 */
export function composePrompt(base, style) {
    const b = String(base ?? '').trim().replace(/[,\s]+$/, '');
    const s = String(style ?? '').trim().replace(/^[,\s]+|[,\s]+$/g, '');
    if (!b) return s;
    if (!s) return b;
    // 后缀里已经出现过的词就不重复追加
    const lowerB = b.toLowerCase();
    const extra = s.split(',').map((x) => x.trim()).filter(Boolean)
        .filter((x) => !lowerB.includes(x.toLowerCase()));
    return extra.length ? `${b}, ${extra.join(', ')}` : b;
}


/** 中文/英文都能用的二元组集合（不依赖分词器，纯字符级） */
export function bigrams(text) {
    const set = new Set();
    const s = String(text ?? '').replace(/[\s\p{P}\p{S}]+/gu, '');
    if (s.length < 2) {
        if (s) set.add(s);
        return set;
    }
    for (let i = 0; i < s.length - 1; i++) {
        set.add(s.slice(i, i + 2));
    }
    return set;
}

/** Dice 相似度：0~1，对长短不一的两段文本比 Jaccard 更宽容 */
export function diceCoefficient(a, b) {
    const A = a instanceof Set ? a : bigrams(a);
    const B = b instanceof Set ? b : bigrams(b);
    if (!A.size || !B.size) return 0;
    let hit = 0;
    for (const g of A) {
        if (B.has(g)) hit++;
    }
    return (2 * hit) / (A.size + B.size);
}

/**
 * 从正文里挑一段「最适合当画面描述」的段落（direct 模式用）。
 * 优先长度在 60~maxChars 之间、信息量最大的一段。
 */
export function pickSceneBlock(blocks, maxChars = 400) {
    const cands = (blocks || []).filter((b) => !b.skip && b.plain);
    if (!cands.length) return null;

    let best = cands[0];
    let bestScore = -Infinity;
    for (const b of cands) {
        const len = b.plain.length;
        // 太短没信息，太长会被接口截断；60~maxChars 区间给满分
        let lenScore;
        if (len < 20) lenScore = len / 20 * 0.4;
        else if (len <= maxChars) lenScore = 1;
        else lenScore = Math.max(0.35, maxChars / len);
        // 对话多的段落画面感差，稍微降权
        const quotePenalty = (b.plain.match(/[“"「『]/g) || []).length * 0.08;
        const score = lenScore - quotePenalty;
        if (score > bestScore) {
            bestScore = score;
            best = b;
        }
    }
    return best;
}

/**
 * 「直接取正文」兜底用：把正文里的生图标签**连内容**一起摘掉，再重算 plain。
 *
 * 为什么必须在块级别做：normalizeText 只去标签、留内容，正文里若有
 * `<local_img>1girl, silver hair…</local_img>`，剥完标签会把里面那段
 * （往往是预设让模型写的提示词或变量串）当正文喂给生图模型，
 * 于是就出现「提示词里混进预设内容」。
 *
 * 注意：不改 index，保持和 DOM 里的段序号一一对应。
 */
export function cleanBlocksForPrompt(blocks) {
    return (blocks || []).map((b) => {
        const text = stripImageTags(b.text);
        if (text === b.text) return b;
        const plain = normalizeText(text);
        return { ...b, text, plain, skip: plain.length < 4 };
    });
}

/**
 * 决定图片插在哪一段之后。
 *
 * @param {string} mes 正文
 * @param {string} prompt 出图提示词
 * @param {'auto'|'end'|'first'|'random'} position
 * @param {string} [hint] 重写模型指认的段落原文（可选）。有它时优先按它落位 ——
 *        模型知道「这一张画的是哪一段」，比拿提示词去反推段落更准。
 * @returns {{para:number, snippet:string}} 锚点：段序号 + 段首快照（快照用于刷新后重新定位）
 */
export function chooseAnchor(mes, prompt, position = 'auto', hint = '') {
    const blocks = splitBlocks(mes);
    if (!blocks.length) return { para: 0, snippet: '' };

    const anchorOf = (b) => ({ para: b.index, snippet: b.plain.slice(0, 60) });
    const usable = blocks.filter((b) => !b.skip);

    if (position === 'end') {
        return anchorOf(usable.length ? usable[usable.length - 1] : blocks[blocks.length - 1]);
    }
    if (position === 'first') {
        return anchorOf(usable.length ? usable[0] : blocks[0]);
    }
    if (!usable.length) return anchorOf(blocks[0]);

    if (position === 'random') {
        const pick = usable[Math.floor(Math.random() * usable.length)];
        return anchorOf(pick);
    }

    // auto 模式：重写模型指认了段落就按它落位 —— 它知道「这一张画的是哪一段」
    const hintText = normalizeText(hint || '');
    if (hintText.length >= 6) {
        const hintGrams = bigrams(hintText);
        let hinted = null;
        let hintedScore = 0;
        for (const b of usable) {
            const grams = bigrams(b.plain);
            if (!grams.size) continue;
            let hit = 0;
            for (const g of hintGrams) {
                if (grams.has(g)) hit++;
            }
            const score = hit / hintGrams.size;
            if (score > hintedScore) {
                hintedScore = score;
                hinted = b;
            }
        }
        if (hinted && hintedScore >= 0.55) return anchorOf(hinted);
    }

    // auto：跟提示词最像的那一段
    const promptGrams = bigrams(prompt);
    let best = null;
    let bestScore = -Infinity;
    for (const b of usable) {
        const sim = promptGrams.size ? diceCoefficient(promptGrams, bigrams(b.plain)) : 0;
        const lenFit = Math.min(b.plain.length, 260) / 260;
        const score = sim + lenFit * 0.08;
        if (score > bestScore) {
            bestScore = score;
            best = b;
        }
    }

    // 提示词跟正文几乎没重合（比如 LLM 输出英文 tag）→ 退回「最有画面」的一段
    if (!best || bestScore < 0.1) {
        const scene = pickSceneBlock(usable, 400);
        if (scene) return anchorOf(scene);
    }
    return anchorOf(best || usable[0]);
}


// ───────────────────── 配图标记（标签驱动） ─────────────────────

/**
 * 默认标记。用纯文本方括号而不是尖括号，原因：
 * 尖括号会被酒馆的 HTML 清洗和 Markdown 渲染吃掉，正文里可能根本留不下痕迹；
 * `[[配图]]` 一定作为文本存在，插件能稳定找到，找到后再从 DOM 里隐藏。
 */
export const DEFAULT_MARKER = '[[配图]]';

/** 兼容几种常见写法，用户改标记时不用记死 */
const MARKER_ALIASES = ['[[配图]]', '[配图]', '<配图>', '[插图]', '[[插图]]', '<image>', '[[image]]'];

/** 在正文里找出所有标记位置（字符偏移 + 所在段序号） */
export function findMarkers(mes, marker = DEFAULT_MARKER) {
    const src = String(mes ?? '');
    const needles = [...new Set([marker, ...MARKER_ALIASES])].filter(Boolean);
    const hits = [];

    for (const needle of needles) {
        let from = 0;
        for (;;) {
            const at = src.indexOf(needle, from);
            if (at < 0) break;
            hits.push({ at, end: at + needle.length, text: needle });
            from = at + needle.length;
        }
    }
    if (!hits.length) return [];

    hits.sort((a, b) => a.at - b.at);

    // 归并重叠（不同别名可能互相包含）
    const merged = [];
    for (const h of hits) {
        const last = merged[merged.length - 1];
        if (last && h.at < last.end) { last.end = Math.max(last.end, h.end); continue; }
        merged.push({ ...h });
    }

    // 算段序号：按空行分段，数一下标记前面有几个换行段
    const blocks = splitBlocks(src);
    for (const h of merged) {
        const before = src.slice(0, h.at);
        const paraCount = before.split(/\n{2,}/).length - 1;
        const block = blocks[Math.min(paraCount, Math.max(0, blocks.length - 1))];
        h.para = block ? block.index : 0;
        h.onlyMarker = (block ? block.text : '').replace(h.text, '').trim().length === 0;
    }
    return merged;
}

/** 去掉标记文本（给重写模型看的故事片段用） */
export function stripMarkers(text, marker = DEFAULT_MARKER) {
    let out = String(text ?? '');
    for (const needle of [...new Set([marker, ...MARKER_ALIASES])].filter(Boolean)) {
        out = out.split(needle).join(' ');
    }
    return out.replace(/[ \t]{2,}/g, ' ');
}

/**
 * 标记之前的正文（重写素材）。
 * 只取标记**前面**的内容 —— 标签本身就代表「图插在这里」，
 * 后面的剧情不该影响这张画。
 */
export function storyBeforeMarker(mes, markerAt, maxChars = 2400) {
    const before = String(mes ?? '').slice(0, Math.max(0, markerAt));
    const text = stripMarkers(before, DEFAULT_MARKER).trim();
    if (!text) return '';
    const limit = Math.max(200, Number(maxChars) || 2400);
    return text.length > limit ? text.slice(text.length - limit) : text;
}

/**
 * 标记对应的锚点：插在标记**前面那一段**之后。
 * 这样图片正好落在标记的位置，标记那一段随后被隐藏，视觉上看不出破绽。
 */
export function anchorForMarker(mes, markerAt) {
    const before = String(mes ?? '').slice(0, Math.max(0, Number(markerAt) || 0));
    const usable = splitBlocks(before).filter((b) => !b.skip);
    const last = usable[usable.length - 1];
    if (last) return { para: last.index, snippet: last.plain.slice(0, 60), byMarker: true };
    return { para: 0, snippet: '', byMarker: true };
}

/**
 * 在 DOM 里隐藏标记文字。
 *
 * 标记写成独立一段时整段隐藏（图片会插在这个位置）；
 * 如果标记混在正文句子里，就只把标记文字抠掉，保留那段。
 * @returns {number} 处理了几处
 */
export function hideMarkersInDom(mesText, marker = DEFAULT_MARKER) {
    if (!mesText) return 0;
    const needles = [...new Set([marker, ...MARKER_ALIASES])].filter(Boolean);
    let touched = 0;

    for (const el of listBlockElements(mesText)) {
        const text = el.textContent || '';
        if (!needles.some((n) => text.includes(n))) continue;

        let rest = text;
        for (const n of needles) rest = rest.split(n).join('');
        if (rest.trim().length === 0) {
            if (el.style.display !== 'none') { el.style.display = 'none'; }
        } else {
            // 句子里夹着标记：只把标记抠掉
            const walker = mesText.ownerDocument.createTreeWalker(el, 4 /* TEXT_NODE */);
            const nodes = [];
            while (walker.nextNode()) nodes.push(walker.currentNode);
            for (const node of nodes) {
                if (needles.some((n) => node.nodeValue.includes(n))) {
                    let v = node.nodeValue;
                    for (const n of needles) v = v.split(n).join('');
                    node.nodeValue = v;
                }
            }
        }
        touched++;
    }
    return touched;
}

// ───────────────────────────── DOM 定位 ─────────────────────────────

function isBlockElement(node) {
    if (!node || node.nodeType !== 1) return false;
    if (!BLOCK_TAGS.has(node.tagName)) return false;
    if (node.classList && node.classList.contains(IF_CLASS)) return false;
    if (node.tagName === 'DIV' && node.classList && node.classList.contains('if-figure__body')) return false;
    return true;
}

/** 取出 .mes_text 里可当锚点的顶层块元素（跳过我们自己插的 figure） */
export function listBlockElements(mesText) {
    if (!mesText || !mesText.children) return [];
    return Array.from(mesText.children).filter(isBlockElement);
}

/**
 * 把存储的锚点解析成真实 DOM 元素。
 *
 * 优先按「段首快照」匹配（正文被翻译/自动排版后段序号会漂，但文字不会），
 * 快照对不上再退回段序号，最后兜底到末段 —— 保证永远有位置可插，绝不丢图。
 *
 * 这里用「包含度」（快照二元组有多少被该段命中）而不是 Dice：
 * 快照来自短段，命中它的 <p> 可能长得多，Dice 会被长度差稀释到 0.4 以下误判成不匹配。
 */
export function resolveAnchorElement(mesText, anchor) {
    const blocks = listBlockElements(mesText);
    if (!blocks.length) return null;

    const snippet = normalizeText(anchor?.snippet || '');
    if (snippet.length >= 6) {
        const snippetGrams = bigrams(snippet);
        let best = null;
        let bestScore = 0;
        for (const el of blocks) {
            const grams = bigrams(el.textContent || '');
            if (!grams.size) continue;
            let hit = 0;
            for (const g of snippetGrams) {
                if (grams.has(g)) hit++;
            }
            const score = snippetGrams.size ? hit / snippetGrams.size : 0;
            if (score > bestScore) {
                bestScore = score;
                best = el;
            }
        }
        if (best && bestScore >= 0.55) return best;
    }

    const para = Number(anchor?.para);
    if (Number.isInteger(para) && para >= 0 && para < blocks.length) {
        return blocks[para];
    }
    return blocks[blocks.length - 1];
}

/**
 * 把 figure 插到锚点段之后（幂等：调用前应先确认这层还没有同 id 的节点）。
 * 同一段后面已经站了别的 figure 时，排在它们后面，保持生成顺序。
 */
export function placeFigure(mesText, figure, anchorEl) {
    if (!mesText) return;
    if (!anchorEl) {
        mesText.appendChild(figure);
        return;
    }
    let ref = anchorEl;
    while (ref.nextElementSibling && ref.nextElementSibling.classList
        && ref.nextElementSibling.classList.contains(IF_CLASS)) {
        ref = ref.nextElementSibling;
    }
    ref.insertAdjacentElement('afterend', figure);
}

// ───────────────────────────── 节点构建 ─────────────────────────────

const ICON = {
    regen: 'fa-rotate-right',
    copy: 'fa-copy',
    delete: 'fa-trash-can',
    retry: 'fa-rotate-right',
};

function makeButton(doc, action, title) {
    const btn = doc.createElement('a');
    btn.className = 'if-figure__btn';
    btn.setAttribute(IF_ACTION_ATTR, action);
    btn.setAttribute('title', title);
    btn.setAttribute('role', 'button');
    const icon = doc.createElement('i');
    icon.className = `fa-solid ${ICON[action] || 'fa-circle'}`;
    btn.appendChild(icon);
    return btn;
}

/**
 * 生成一张内联图的 DOM 节点。三种状态：
 *   pending → 骨架 + 「正在配图…」
 *   ready   → <img>
 *   error   → 错误信息 + 重试按钮
 *
 * 按钮不绑事件，只带 data-if-action；点击统一由 index.js 在 document 上代理 ——
 * 楼层重渲染会把节点整个换掉，直接在节点上绑监听必然失效。
 */
export function createFigureElement(doc, item, { showCaption = false, size = 'medium' } = {}) {
    const fig = doc.createElement('figure');
    fig.className = IF_CLASS;
    fig.setAttribute(IF_ID_ATTR, String(item.id));
    fig.setAttribute(IF_STATUS_ATTR, item.status || 'pending');
    fig.setAttribute(IF_SRC_ATTR, item.url || '');
    fig.setAttribute(IF_ANCHOR_ATTR, anchorKey(item.anchor));
    fig.setAttribute('data-if-source', item.source || '');
    if (item.swipe !== undefined) fig.setAttribute('data-if-swipe', String(item.swipe));
    if (size) fig.setAttribute('data-if-size', size);

    const body = doc.createElement('div');
    body.className = 'if-figure__body';

    if (item.status === 'ready' && item.url) {
        const img = doc.createElement('img');
        img.className = 'if-figure__img';
        img.setAttribute('src', item.url);
        img.setAttribute('alt', item.prompt || 'AI 配图');
        img.setAttribute('loading', 'lazy');
        img.setAttribute('decoding', 'async');
        img.setAttribute('referrerpolicy', 'no-referrer');
        body.appendChild(img);

        const bar = doc.createElement('div');
        bar.className = 'if-figure__bar';
        bar.appendChild(makeButton(doc, 'regen', '重新生成这张图'));
        bar.appendChild(makeButton(doc, 'copy', '复制提示词'));
        bar.appendChild(makeButton(doc, 'delete', '删除这张图'));
        body.appendChild(bar);
    } else if (item.status === 'error') {
        const err = doc.createElement('div');
        err.className = 'if-figure__error';
        const text = doc.createElement('span');
        text.className = 'if-figure__error-text';
        text.textContent = `配图失败：${item.error || '未知错误'}`;
        err.appendChild(text);
        err.appendChild(makeButton(doc, 'retry', '重试'));
        body.appendChild(err);
    } else {
        const sk = doc.createElement('div');
        sk.className = 'if-figure__skeleton';
        const bar = doc.createElement('div');
        bar.className = 'if-figure__skeleton-bar';
        const label = doc.createElement('div');
        label.className = 'if-figure__skeleton-label';
        label.textContent = '正在配图…';
        sk.appendChild(bar);
        sk.appendChild(label);
        body.appendChild(sk);
    }

    fig.appendChild(body);

    // 标记「这张没重写，只是截了正文」—— 静默降级是最坑人的，必须让人一眼看见
    if (item.fallback) {
        const badge = doc.createElement('span');
        badge.className = 'if-figure__badge';
        badge.textContent = '未重写';
        badge.setAttribute(
            'title',
            `提示词重写没成功，这张图用的是直接截取的正文。
原因：${item.fallbackReason || '未知'}`,
        );
        fig.appendChild(badge);
    }

    if (showCaption && item.prompt) {
        const cap = doc.createElement('figcaption');
        cap.className = 'if-figure__cap';
        cap.textContent = item.prompt;
        cap.setAttribute('title', item.prompt);
        fig.appendChild(cap);
    }

    return fig;
}

/**
 * 把「这一楼该有的图」同步到 .mes_text 里 —— 水合的核心，幂等。
 *
 * 之所以要做成「差分」而不是「先清空再重建」：流式渲染期间酒馆每帧都可能重排
 * .mes_text 的兄弟节点，无脑重建会让 <img> 反复重载（闪、费流量），
 * 也会把用户正在悬停的操作条闪没。
 *
 * @returns {{added:number, updated:number, removed:number}}
 */
export function syncFigures(mesText, items, { doc = globalThis.document, showCaption = false, size = 'medium' } = {}) {
    const stats = { added: 0, updated: 0, removed: 0 };
    if (!mesText || !doc) return stats;

    const list = Array.isArray(items) ? items : [];
    const wanted = new Set(list.map((i) => String(i.id)));

    for (const child of Array.from(mesText.children)) {
        if (!child.classList?.contains(IF_CLASS)) continue;
        if (!wanted.has(child.getAttribute(IF_ID_ATTR))) {
            child.remove();
            stats.removed++;
        }
    }

    for (const item of list) {
        const id = String(item.id);
        const src = item.url || '';
        const wantAnchor = anchorKey(item.anchor);
        let existing = Array.from(mesText.children)
            .find((c) => c.classList?.contains(IF_CLASS) && c.getAttribute(IF_ID_ATTR) === id);

        if (existing) {
            // 锚点变了（比如重写模型后来指认了另一段）→ 拆掉重插，不能留在原地
            if ((existing.getAttribute(IF_ANCHOR_ATTR) || '') !== wantAnchor) {
                existing.remove();
                stats.removed++;
                existing = null;
            } else if (existing.getAttribute(IF_STATUS_ATTR) !== item.status
                || existing.getAttribute(IF_SRC_ATTR) !== src) {
                existing.replaceWith(createFigureElement(doc, item, { showCaption, size }));
                stats.updated++;
                continue;
            } else {
                continue;
            }
        }

        const anchorEl = resolveAnchorElement(mesText, item.anchor);
        const fig = createFigureElement(doc, item, { showCaption, size });
        placeFigure(mesText, fig, anchorEl);
        stats.added++;
    }

    return stats;
}

/** 锚点指纹：用来判断「同一张图是不是被挪了段落」 */
export function anchorKey(anchor) {
    if (!anchor) return '';
    return `${anchor.para ?? ''}|${String(anchor.snippet || '').slice(0, 40)}`;
}

/** 单测 / 调试用：把 figure 还原成「可断言的纯数据」 */
export function describeFigure(fig) {
    if (!fig) return null;
    return {
        id: fig.getAttribute(IF_ID_ATTR),
        status: fig.getAttribute(IF_STATUS_ATTR),
        src: fig.getAttribute(IF_SRC_ATTR),
        source: fig.getAttribute('data-if-source'),
        text: (fig.textContent || '').trim(),
    };
}
