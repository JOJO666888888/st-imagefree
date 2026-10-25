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
 * 决定图片插在哪一段之后。
 *
 * @param {string} mes 正文
 * @param {string} prompt 出图提示词
 * @param {'auto'|'end'|'first'|'random'} position
 * @returns {{para:number, snippet:string}} 锚点：段序号 + 段首快照（快照用于刷新后重新定位）
 */
export function chooseAnchor(mes, prompt, position = 'auto') {
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
        const existing = Array.from(mesText.children)
            .find((c) => c.classList?.contains(IF_CLASS) && c.getAttribute(IF_ID_ATTR) === id);

        if (existing) {
            if (existing.getAttribute(IF_STATUS_ATTR) !== item.status
                || existing.getAttribute(IF_SRC_ATTR) !== src) {
                existing.replaceWith(createFigureElement(doc, item, { showCaption, size }));
                stats.updated++;
            }
            continue;
        }

        const anchorEl = resolveAnchorElement(mesText, item.anchor);
        const fig = createFigureElement(doc, item, { showCaption, size });
        placeFigure(mesText, fig, anchorEl);
        stats.added++;
    }

    return stats;
}

/** 单测 / 调试用：把 figure 还原成「可断言的纯数据」 */
export function describeFigure(fig) {
    if (!fig) return null;
    return {
        id: fig.getAttribute(IF_ID_ATTR),
        status: fig.getAttribute(IF_STATUS_ATTR),
        src: fig.getAttribute(IF_SRC_ATTR),
        text: (fig.textContent || '').trim(),
    };
}
