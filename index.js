/**
 * ImageFree 自动配图 — SillyTavern 扩展 v2
 *
 * 把 imagefree.net 生图（经 imagefree-2api 中转）接到酒馆：AI 每回一段，
 * 自动挑一段剧情出图，并把图片**内联插到正文对应段落的后面**。
 *
 * v2 与 v1 的关键差异（也是 v1 完全不工作的根因）：
 *
 *   v1 走的是酒馆的「楼层媒体」通道：message.extra.media + appendMediaToMessage()。
 *   那条通道的图只能落在 .mes_text **外面**的 .mes_media_wrapper 里，
 *   位置固定在图廊区，永远贴不到正文中间；而且 MESSAGE_RECEIVED 早于 addOneMessage，
 *   触发时楼层 DOM 还不存在，appendMediaToMessage 找不到容器直接空转。
 *
 *   v2 走「正文内联」通道：把图片节点插进 .mes_text 内部、锚点段落的后面，
 *   锚点信息（段序号 + 段首文字快照）存在 message.extra.imagefree 里随聊天存档走；
 *   再用「渲染事件 + #chat MutationObserver」双保险重水合 —— 因为酒馆的
 *   updateMessageBlock / 右键编辑 / swipe 会直接用 .html() 重写 .mes_text，
 *   把所有插件插进去的节点一起洗掉，而且不发任何事件。
 *
 * 参考实现（机制验证）：
 *   - ST-BaiBai-Image：锚点水合 + 自愈层，明确记录「官方 extra.media 方案无法定位到行内」；
 *   - st-chatu8：图片状态存 message.extra，渲染时按文本位置重建节点；
 *   - 本地 LocalDream 脚本：MutationObserver 驱动 + 占位符内联。
 */

import {
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';
import {
    eventSource,
    event_types,
    generateQuietPrompt,
    getRequestHeaders,
    saveChatDebounced,
    saveSettingsDebounced,
    syncMesToSwipe,
} from '../../../../script.js';
import {
    IF_ACTION_ATTR,
    IF_CLASS,
    IF_ID_ATTR,
    chooseAnchor,
    cleanPrompt,
    normalizeText,
    pickSceneBlock,
    splitBlocks,
    syncFigures,
} from './core.js';

const MODULE_NAME = 'imagefree';
const LOG = '[ImageFree]';
const VERSION = '2.0.0';

const defaultSettings = {
    enabled: true,
    apiBase: 'http://127.0.0.1:8080/v1',
    apiKey: '',
    model: 'imagefree-1',
    aspect: '3:4',
    mode: 'direct',            // direct=直接取正文 | llm=让对话模型写提示词
    interval: 1,               // 每 N 条 AI 回复出一张（1=每条都出）
    maxChars: 400,
    position: 'auto',          // auto=按剧情匹配 | end=楼层末尾 | first=开头 | random=随机
    perMessage: 1,             // 每条正文最多几张图
    storeInTavern: true,
    autoOnSwipe: true,
    showButton: true,
    showCaption: false,
    displaySize: 'medium',
    timeoutSec: 180,
    retries: 2,
    debug: false,
    llmInstruction:
        '你是一个 AI 绘图提示词生成器。读下面的剧情片段，提炼出一个具体的画面：' +
        '写清楚主体、外貌、动作、服装、场景、光线、镜头与画风。' +
        '只输出一条提示词（用英文逗号分隔的中文短语，60~120 字），不要解释、不要引号、不要换行。',
};

// ─────────────────────────── 运行状态 ───────────────────────────

/** `${chatId}|${messageId}|${swipe}` -> AbortController */
const inflight = new Map();
let intervalCounter = 0;
let quietDepth = 0;
let hydrating = false;
let observer = null;
let scheduled = false;
let fullRepaint = false;
const dirtyFloors = new Set();
const lastErrors = [];

// ─────────────────────────── 设置 ───────────────────────────

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const s = extension_settings[MODULE_NAME];
    // 补齐新增字段（老用户升级）
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (s[k] === undefined) s[k] = v;
    }
    // v1 的默认 interval=2 是「隔一条出一张」，很多用户以为坏了。v2 只在
    // 用户没手动改过（仍等于旧默认 2）且没迁移过时，改回 1。
    if (!s.v2Migrated) {
        if (Number(s.interval) === 2) s.interval = 1;
        s.v2Migrated = true;
        saveSettingsDebounced();
    }
    return s;
}

const settings = () => getSettings();

function dbg(...args) {
    if (settings().debug) console.debug(LOG, ...args);
}

function bindSettingsUI() {
    const s = settings();
    const setVal = (id, val) => { const el = $(id); if (el.length) el.val(val); };

    $('#if_enabled').prop('checked', s.enabled);
    setVal('#if_api_base', s.apiBase);
    setVal('#if_api_key', s.apiKey);
    setVal('#if_model', s.model);
    setVal('#if_aspect', s.aspect);
    setVal('#if_mode', s.mode);
    setVal('#if_interval', s.interval);
    setVal('#if_maxchars', s.maxChars);
    setVal('#if_position', s.position);
    setVal('#if_per_message', s.perMessage);
    setVal('#if_timeout', s.timeoutSec);
    setVal('#if_retries', s.retries);
    setVal('#if_display_size', s.displaySize);
    $('#if_store').prop('checked', s.storeInTavern);
    $('#if_auto_swipe').prop('checked', s.autoOnSwipe);
    $('#if_show_button').prop('checked', s.showButton);
    $('#if_show_caption').prop('checked', s.showCaption);
    $('#if_debug').prop('checked', s.debug);

    const bindCheck = (sel, key, after) => $(sel).on('change', function () {
        s[key] = $(this).prop('checked');
        saveSettingsDebounced();
        after?.();
    });
    const bindText = (sel, key, after) => $(sel).on('input', function () {
        s[key] = String($(this).val()).trim();
        saveSettingsDebounced();
        after?.();
    });
    const bindNum = (sel, key, min, max, after) => $(sel).on('input', function () {
        const n = parseInt($(this).val(), 10);
        s[key] = Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
        saveSettingsDebounced();
        after?.();
    });

    bindCheck('#if_enabled', 'enabled');
    bindText('#if_api_base', 'apiBase', () => { s.apiBase = s.apiBase.replace(/\/+$/, ''); });
    bindText('#if_api_key', 'apiKey');
    bindText('#if_model', 'model');
    bindText('#if_aspect', 'aspect');
    bindText('#if_mode', 'mode');
    bindNum('#if_interval', 'interval', 1, 20);
    bindNum('#if_maxchars', 'maxChars', 80, 2000);
    bindText('#if_position', 'position', () => hydrateAll('position-change'));
    bindNum('#if_per_message', 'perMessage', 1, 4);
    bindNum('#if_timeout', 'timeoutSec', 30, 600);
    bindNum('#if_retries', 'retries', 0, 3);
    bindText('#if_display_size', 'displaySize', applyCssVars);
    bindCheck('#if_store', 'storeInTavern');
    bindCheck('#if_auto_swipe', 'autoOnSwipe');
    bindCheck('#if_show_button', 'showButton', () => hydrateAll('button-toggle'));
    bindCheck('#if_show_caption', 'showCaption', () => hydrateAll('caption-toggle'));
    bindCheck('#if_debug', 'debug');

    $('#if_test').on('click', async function () {
        const btn = $(this);
        btn.prop('disabled', true).text('测试中…');
        try {
            const res = await requestImage('a simple red apple on a wooden table, studio light');
            const url = res.b64 ? await uploadToTavern(res.b64, -1) : res.url;
            toastr.success(`接口正常：${String(url).slice(0, 70)}`);
        } catch (e) {
            toastr.error(`测试失败：${e.message}`, 'ImageFree');
        } finally {
            btn.prop('disabled', false).text('测试连接');
        }
    });

    $('#if_diagnose').on('click', () => runDiagnostics());

    $('#if_generate_last').on('click', async function () {
        const ctx = getContext();
        for (let i = ctx.chat.length - 1; i >= 0; i--) {
            if (!ctx.chat[i].is_user && !ctx.chat[i].is_system) {
                await generateForMessage(i, { manual: true });
                return;
            }
        }
        toastr.warning('当前聊天里还没有 AI 回复');
    });

    applyCssVars();
}

function applyCssVars() {
    const map = { small: '180px', medium: '300px', large: '440px', full: '100%' };
    const w = map[settings().displaySize] || map.medium;
    document.documentElement.style.setProperty('--if-img-max', w);
}

// ─────────────────────────── 存储（随聊天存档） ───────────────────────────

function storeOf(message, create = false) {
    if (!message) return null;
    if (!message.extra || typeof message.extra !== 'object') {
        if (!create) return null;
        message.extra = {};
    }
    let store = message.extra.imagefree;
    if (!store || typeof store !== 'object') {
        if (!create) return null;
        store = { v: 2, items: [] };
        message.extra.imagefree = store;
    }
    if (!Array.isArray(store.items)) store.items = [];
    return store;
}

const itemsOf = (message) => storeOf(message)?.items ?? [];
const swipeOf = (message) => message?.swipe_id ?? 0;

function itemsForSwipe(message, swipe = swipeOf(message)) {
    return itemsOf(message).filter((i) => (i.swipe ?? 0) === (swipe ?? 0));
}

function hasReadyItem(message, swipe = swipeOf(message)) {
    return itemsForSwipe(message, swipe).some((i) => i.status === 'ready' && i.url);
}

function findItem(message, itemId) {
    return itemsOf(message).find((i) => String(i.id) === String(itemId)) || null;
}

function persist(messageId, chatId, itemId = null) {
    try {
        const ctx = getContext();
        if (ctx.chatId !== chatId) return;
        // 生成要 20~30 秒，这期间楼层可能被删、被换位；确认记录还挂在这层上再写
        if (itemId && !findItem(ctx.chat?.[messageId], itemId)) return;
        syncMesToSwipe(messageId);
    } catch (e) {
        dbg('syncMesToSwipe 失手', e);
    }
    try {
        saveChatDebounced();
    } catch (e) {
        dbg('saveChatDebounced 失手', e);
    }
}

// ─────────────────────────── 出图接口 ───────────────────────────

function apiUrl(path) {
    const base = String(settings().apiBase || '').replace(/\/+$/, '');
    return `${base}${path}`;
}

/**
 * 调 imagefree-2api 出一张图。
 * @returns {Promise<{url?:string, b64?:string}>}
 */
async function requestImage(prompt, signal) {
    const s = settings();
    if (!s.apiBase) throw new Error('未配置 API 地址（设置里填到 /v1 为止）');
    const wantB64 = !!s.storeInTavern;
    const timeoutMs = Math.max(30, Number(s.timeoutSec) || 180) * 1000;

    const ctl = new AbortController();
    const abortAll = () => ctl.abort();
    signal?.addEventListener('abort', abortAll, { once: true });
    const timer = setTimeout(() => ctl.abort(), timeoutMs);

    let resp;
    try {
        resp = await fetch(apiUrl('/images/generations'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}),
            },
            body: JSON.stringify({
                model: s.model || 'imagefree-1',
                prompt,
                size: s.aspect,
                n: 1,
                response_format: wantB64 ? 'b64_json' : 'url',
            }),
            signal: ctl.signal,
        });
    } catch (e) {
        if (signal?.aborted) throw new Error('已取消');
        if (ctl.signal.aborted) throw new Error(`出图超时（>${Math.round(timeoutMs / 1000)}s 无响应）`);
        throw new Error(
            `连不上出图服务（${e.message}）。排查：① 地址是否以 /v1 结尾、服务是否在跑；` +
            '② 酒馆是 https 时浏览器会拦 http 接口（混合内容）；③ 跨域是否被挡。',
        );
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortAll);
    }

    if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try {
            const err = await resp.json();
            detail = err?.error?.message || detail;
        } catch { /* 忽略非 JSON 错误体 */ }
        if (resp.status === 401 || resp.status === 403) {
            detail += ' —— 中转服务要求 API Key，请在设置里填入 RELAY_API_KEY（默认 1234567A）';
        }
        throw new Error(detail);
    }

    const data = await resp.json();
    const first = data?.data?.[0];
    if (!first) throw new Error('接口没有返回图片');

    if (wantB64) {
        if (!first.b64_json) throw new Error('接口未返回 b64_json（中转服务版本过旧？）');
        return { b64: String(first.b64_json).replace(/^data:[^,]+,/, '') };
    }
    if (!first.url) throw new Error('接口未返回 url');
    return { url: first.url };
}

/**
 * 带重试的出图：上游偶发 5xx / 断连，重跑一次通常就好。
 * 4xx、401、主动取消都不重试（配置错了重试也没用，白烧额度）。
 */
async function requestImageWithRetry(prompt, signal) {
    const attempts = Math.max(1, Math.min(4, (Number(settings().retries) || 0) + 1));
    let lastErr = null;
    for (let i = 1; i <= attempts; i++) {
        try {
            return await requestImage(prompt, signal);
        } catch (e) {
            lastErr = e;
            const msg = e?.message || '';
            const fatal = signal?.aborted || /已取消/.test(msg) || /\b(4\d\d)\b/.test(msg);
            if (fatal || i === attempts) break;
            console.warn(LOG, `第 ${i}/${attempts} 次失败，2 秒后重试：${msg}`);
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
    throw lastErr || new Error('生成失败');
}

function sniffImageExt(b64) {
    const head = String(b64).slice(0, 24);
    if (head.startsWith('/9j/')) return 'jpg';
    if (head.startsWith('UklGR')) return 'webp';
    if (head.startsWith('R0lGOD')) return 'gif';
    return 'png';
}

/** 把 base64 存进酒馆，返回可直接用于 <img src> 的相对路径 */
async function uploadToTavern(b64, messageId) {
    const ctx = getContext();
    const raw = ctx.groupId ? 'group' : (ctx.name2 || '');
    const chName = raw && raw !== 'SillyTavern System' ? raw : '';
    const format = sniffImageExt(b64);
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    const resp = await fetch('/api/images/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            image: b64,
            format,
            filename: `imagefree_${messageId}_${stamp}`,
            ...(chName ? { ch_name: chName } : {}),
        }),
    });
    if (!resp.ok) throw new Error(`存进酒馆失败 HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data?.path) throw new Error('存图接口没有返回路径');
    return data.path;
}

// ─────────────────────────── 提示词 ───────────────────────────

async function buildPrompt(message) {
    const s = settings();
    const blocks = splitBlocks(message.mes);
    const fallbackBlock = pickSceneBlock(blocks, s.maxChars);
    const fallback = cleanPrompt(fallbackBlock?.plain || normalizeText(message.mes), s.maxChars);
    if (!fallback) throw new Error('本楼没有可用正文');

    if (s.mode === 'llm') {
        quietDepth++;
        try {
            const raw = await generateQuietPrompt({
                quietPrompt: `${s.llmInstruction}\n\n【剧情片段】\n${normalizeText(message.mes).slice(0, 1500)}`,
                quietName: 'ImageFree',
                responseLength: 160,
            });
            const cleaned = cleanPrompt(raw, 400);
            if (cleaned.length >= 6) return cleaned;
            console.warn(LOG, 'LLM 写的提示词太短，回退到正文模式');
        } catch (e) {
            console.warn(LOG, 'LLM 写提示词失败，回退到正文模式：', e);
        } finally {
            quietDepth--;
        }
    }
    return fallback;
}

// ─────────────────────────── 内联渲染（水合） ───────────────────────────

const chatEl = () => document.getElementById('chat');
const mesEl = (id) => chatEl()?.querySelector(`.mes[mesid="${id}"]`) || null;

function uiOpts() {
    const s = settings();
    return { showCaption: !!s.showCaption, size: s.displaySize };
}

function ensureFloorButton(node, messageId) {
    const holder = node.querySelector('.extraMesButtons');
    if (!holder) return;
    const existing = holder.querySelector('.if_gen_button');
    if (!settings().showButton) {
        existing?.remove();
        return;
    }
    if (existing) return;

    const btn = document.createElement('div');
    btn.className = 'mes_button if_gen_button fa-solid fa-wand-magic-sparkles';
    btn.title = '用 ImageFree 为这一楼配图';
    btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void generateForMessage(messageId, { manual: true });
    });
    holder.appendChild(btn);
}

/**
 * 把某一楼的配图渲染到 .mes_text 里。
 *
 * 幂等：已存在且状态没变的节点原样保留（避免流式渲染期间每帧重建）；
 * 状态/地址变了才替换；不属于当前 swipe 的一律清掉。
 */
function hydrateFloor(messageId, node = null) {
    const el = node || mesEl(messageId);
    if (!el) return;
    const ctx = getContext();
    const message = ctx.chat?.[messageId];
    const mesText = el.querySelector('.mes_text');
    if (!mesText) return;

    const items = message ? itemsForSwipe(message) : [];

    hydrating = true;
    try {
        const stats = syncFigures(mesText, items, { doc: document, ...uiOpts() });
        if (stats.added || stats.updated || stats.removed) {
            dbg(`楼层 ${messageId} 水合：+${stats.added} ~${stats.updated} -${stats.removed}`);
        }
        ensureFloorButton(el, messageId);
    } finally {
        hydrating = false;
    }
}

function hydrateAll(reason = '') {
    const root = chatEl();
    if (!root) return;
    let n = 0;
    for (const el of root.querySelectorAll('.mes[mesid]')) {
        const id = Number(el.getAttribute('mesid'));
        if (Number.isNaN(id)) continue;
        hydrateFloor(id, el);
        n++;
    }
    dbg(`水合全部楼层（${reason}）：${n} 层`);
}

function renderNow(messageId) {
    const el = mesEl(messageId);
    if (el) {
        hydrateFloor(messageId, el);
        return;
    }
    // MESSAGE_RECEIVED 早于 addOneMessage：此刻楼层还没建出来，等它出现
    dirtyFloors.add(messageId);
    schedule();
}

function markDirty(el) {
    const id = Number(el?.getAttribute?.('mesid'));
    if (!Number.isNaN(id)) dirtyFloors.add(id);
}

function schedule() {
    if (scheduled) return;
    scheduled = true;
    const run = () => {
        scheduled = false;
        if (fullRepaint) {
            fullRepaint = false;
            dirtyFloors.clear();
            hydrateAll('mutation');
            return;
        }
        const ids = [...dirtyFloors];
        dirtyFloors.clear();
        for (const id of ids) hydrateFloor(id);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
}

/**
 * 自愈层：#chat 子树变更就重水合。
 *
 * 必须有的原因：酒馆的 updateMessageBlock / 右键编辑 / swipe 直接对 .mes_text
 * 做 .html() / .empty()，把我们插在里面的 <figure> 一起清掉，而且**一个事件都不发**。
 * 只靠渲染事件会出现「图生成好了、楼层里看不见」。
 */
function ensureObserver() {
    if (observer) return true;
    const root = chatEl();
    if (!root) return false;

    observer = new MutationObserver((records) => {
        // 自己在插节点时触发的记录不用管，但不能直接丢掉这一批 —— 同一批里
        // 可能还混着酒馆重写 .mes_text 的记录，丢了下一次就补不回来。
        if (hydrating) {
            fullRepaint = true;
            schedule();
            return;
        }
        for (const rec of records) {
            const target = rec.target instanceof Element ? rec.target : null;
            const host = target?.closest?.('.mes[mesid]');
            if (host) {
                markDirty(host);
                continue;
            }
            if (!target || target === root || target.id === 'chat') {
                fullRepaint = true;
                continue;
            }
            for (const node of [...rec.addedNodes, ...rec.removedNodes]) {
                if (node.nodeType !== 1) continue;
                const hit = node.matches?.('.mes[mesid]') ? node : node.querySelector?.('.mes[mesid]');
                if (hit) markDirty(hit);
            }
        }
        schedule();
    });
    observer.observe(root, { childList: true, subtree: true });
    dbg('MutationObserver 已挂载');
    return true;
}

// ─────────────────────────── 生成主流程 ───────────────────────────

async function generateForMessage(messageId, { manual = false } = {}) {
    const ctx = getContext();
    const message = ctx.chat?.[messageId];
    if (!message) return;

    const s = settings();
    if (!s.enabled && !manual) return;
    if (message.is_user || message.is_system) {
        if (manual) toastr.info('这一楼不是 AI 回复');
        return;
    }

    const swipe = swipeOf(message);
    const chatId = ctx.chatId;
    const key = `${chatId}|${messageId}|${swipe}`;
    if (inflight.has(key)) {
        if (manual) toastr.info('这一楼正在生成中');
        return;
    }

    const existing = itemsForSwipe(message, swipe);
    if (!manual && existing.some((i) => i.status === 'ready')) return;

    const cap = Math.max(1, Math.min(4, Number(s.perMessage) || 1));
    if (existing.length >= cap) {
        if (manual) toastr.info('这一楼已经配满图了，先删一张再试');
        return;
    }

    // 先落占位，用户马上能看到「图会插在这里」，也便于确认锚点对不对
    const item = {
        id: `if_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        swipe,
        status: 'pending',
        prompt: '',
        url: '',
        anchor: chooseAnchor(message.mes, '', s.position),
        created: Date.now(),
        model: s.model,
        aspect: s.aspect,
    };
    storeOf(message, true).items.push(item);
    renderNow(messageId);

    await runGeneration(messageId, item, key);
}

/**
 * 真正跑一次出图，把结果写回 item。
 * 新建与「重新生成」共用（重新生成时 item 已被重置为 pending）。
 */
async function runGeneration(messageId, item, key) {
    const ctx = getContext();
    const chatId = ctx.chatId;
    const message = ctx.chat?.[messageId];
    if (!message) return;

    const controller = new AbortController();
    inflight.set(key, controller);
    const t0 = Date.now();

    try {
        const prompt = await buildPrompt(message);
        if (controller.signal.aborted) throw new Error('已取消');

        item.prompt = prompt;
        item.anchor = chooseAnchor(message.mes, prompt, settings().position);
        renderNow(messageId);

        const res = await requestImageWithRetry(prompt, controller.signal);
        const url = res.b64 ? await uploadToTavern(res.b64, messageId) : res.url;
        if (controller.signal.aborted) throw new Error('已取消');

        item.status = 'ready';
        item.url = url;
        item.error = '';
        item.ms = Date.now() - t0;
        lastErrors.length = 0;

        // 正文在生成期间可能被编辑/swipe 换掉，落盘前按最新正文再校一次锚点
        const fresh = getContext().chat?.[messageId];
        if (fresh?.mes) item.anchor = chooseAnchor(fresh.mes, prompt, settings().position);

        persist(messageId, chatId, item.id);
        renderNow(messageId);
        console.info(LOG, `楼层 ${messageId} 出图完成 ${(item.ms / 1000).toFixed(1)}s`, prompt);
    } catch (e) {
        const aborted = controller.signal.aborted || /已取消/.test(e?.message || '');
        if (aborted) {
            const store = storeOf(getContext().chat?.[messageId]);
            if (store) {
                const i = store.items.findIndex((x) => x.id === item.id);
                if (i >= 0) store.items.splice(i, 1);
            }
            renderNow(messageId);
            return;
        }
        item.status = 'error';
        item.error = e?.message || String(e);
        lastErrors.unshift({ at: new Date().toLocaleTimeString(), message: item.error });
        lastErrors.splice(8);
        console.error(LOG, '生成失败', e);
        persist(messageId, chatId, item.id);
        renderNow(messageId);
        toastr.error(`配图失败：${item.error}`, 'ImageFree');
    } finally {
        inflight.delete(key);
        if (getContext().chatId === chatId) persist(messageId, chatId, item.id);
    }
}

async function regenerate(messageId, item) {
    const ctx = getContext();
    const message = ctx.chat?.[messageId];
    if (!message) return;
    const key = `${ctx.chatId}|${messageId}|${item.swipe ?? swipeOf(message)}`;
    if (inflight.has(key)) {
        toastr.info('这一楼正在生成中');
        return;
    }
    item.status = 'pending';
    item.url = '';
    item.error = '';
    renderNow(messageId);
    await runGeneration(messageId, item, key);
}

function removeItem(messageId, itemId, { silent = false } = {}) {
    const ctx = getContext();
    const message = ctx.chat?.[messageId];
    const store = storeOf(message);
    if (!store) return;
    const idx = store.items.findIndex((i) => String(i.id) === String(itemId));
    if (idx < 0) return;
    store.items.splice(idx, 1);
    persist(messageId, ctx.chatId);
    renderNow(messageId);
    if (!silent) toastr.info('已从正文里移除这张图（磁盘文件仍留在 user/images）');
}

/** 正文被编辑后，按新正文重算所有锚点（文字变了，旧快照就对不上了） */
function relocateAnchors(messageId) {
    const ctx = getContext();
    const message = ctx.chat?.[messageId];
    if (!message) return;
    const items = itemsOf(message);
    if (!items.length) return;
    for (const item of items) {
        item.anchor = chooseAnchor(message.mes, item.prompt || '', settings().position);
    }
    persist(messageId, ctx.chatId);
}

// ─────────────────────────── 自动触发 ───────────────────────────

function onMessageReceived(messageId, type) {
    try {
        if (quietDepth > 0) return;               // 自己发的 quiet 请求，别递归
        const s = settings();
        if (!s.enabled) return;
        if (type === 'quiet' || type === 'impersonate') return;

        const ctx = getContext();
        const id = Number(messageId);
        const message = ctx.chat?.[id];
        if (!message || message.is_user || message.is_system) return;
        if (id !== ctx.chat.length - 1) return;    // 只处理最新一楼（群聊每人都发事件）
        if (!normalizeText(message.mes)) return;   // 空楼层（比如工具调用中间态）
        if (hasReadyItem(message)) return;
        if (!hitInterval()) return;

        dbg(`自动触发：楼层 ${id} type=${type}`);
        void generateForMessage(id, { manual: false });
    } catch (e) {
        console.error(LOG, 'MESSAGE_RECEIVED 处理异常', e);
    }
}

function onSwiped(messageId) {
    try {
        const s = settings();
        if (!s.enabled || !s.autoOnSwipe) return;
        if (quietDepth > 0) return;
        const ctx = getContext();
        const id = Number(messageId);
        const message = ctx.chat?.[id];
        if (!message || message.is_user || message.is_system) return;
        if (!normalizeText(message.mes)) return;
        if (hasReadyItem(message)) return;
        dbg(`swipe 触发：楼层 ${id} swipe=${swipeOf(message)}`);
        void generateForMessage(id, { manual: false });
    } catch (e) {
        console.error(LOG, 'MESSAGE_SWIPED 处理异常', e);
    }
}

function hitInterval() {
    const n = Math.max(1, Number(settings().interval) || 1);
    intervalCounter++;
    if (intervalCounter < n) {
        dbg(`计数 ${intervalCounter}/${n}，本条不出图`);
        return false;
    }
    intervalCounter = 0;
    return true;
}

function onChatChanged() {
    intervalCounter = 0;
    for (const ctl of inflight.values()) {
        try { ctl.abort(); } catch { /* 忽略 */ }
    }
    inflight.clear();
    dirtyFloors.clear();
    fullRepaint = false;
    setTimeout(() => hydrateAll('chat-changed'), 120);
}

// ─────────────────────────── 点击 / 灯箱 ───────────────────────────

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
    }
}

function openLightbox(src) {
    const box = document.createElement('div');
    box.className = 'if-lightbox';
    const img = document.createElement('img');
    img.src = src;
    box.appendChild(img);
    box.addEventListener('click', () => box.remove());
    document.addEventListener('keydown', function onKey(ev) {
        if (ev.key === 'Escape') {
            box.remove();
            document.removeEventListener('keydown', onKey);
        }
    });
    document.body.appendChild(box);
}

function onDocumentClick(ev) {
    const target = ev.target;

    if (target?.classList?.contains('if-figure__img')) {
        ev.preventDefault();
        openLightbox(target.getAttribute('src'));
        return;
    }

    const btn = target?.closest?.(`[${IF_ACTION_ATTR}]`);
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();

    const action = btn.getAttribute(IF_ACTION_ATTR);
    const fig = btn.closest(`.${IF_CLASS}`);
    const mes = btn.closest('.mes[mesid]');
    const messageId = Number(mes?.getAttribute('mesid'));
    const itemId = fig?.getAttribute(IF_ID_ATTR);
    if (!Number.isInteger(messageId) || !itemId) return;

    const message = getContext().chat?.[messageId];
    const item = findItem(message, itemId);
    if (!item) return;

    if (action === 'copy') {
        void copyToClipboard(item.prompt || '').then(() => toastr.success('提示词已复制'));
        return;
    }
    if (action === 'delete') {
        removeItem(messageId, itemId);
        return;
    }
    if (action === 'regen' || action === 'retry') {
        void regenerate(messageId, item);
    }
}

// ─────────────────────────── 诊断 ───────────────────────────

function diagnose() {
    const ctx = getContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const withItems = chat
        .map((m, i) => ({ i, items: itemsOf(m).length }))
        .filter((x) => x.items > 0);

    const domFloors = chatEl()?.querySelectorAll('.mes[mesid]').length ?? 0;
    const domFigures = chatEl()?.querySelectorAll(`.${IF_CLASS}`).length ?? 0;
    const mesTextFloors = chatEl()?.querySelectorAll('.mes[mesid] .mes_text').length ?? 0;
    const buttons = chatEl()?.querySelectorAll('.if_gen_button').length ?? 0;

    return {
        version: VERSION,
        settings: { ...settings(), apiKey: settings().apiKey ? '***' : '' },
        chatId: ctx.chatId ?? null,
        chatLength: chat.length,
        dom: { floors: domFloors, mesText: mesTextFloors, figures: domFigures, buttons },
        observer: !!observer,
        inflight: inflight.size,
        counter: intervalCounter,
        messagesWithItems: withItems,
        lastErrors,
    };
}

async function selfTest() {
    const res = await requestImage('a small red apple on a wooden table, studio light, 3:4');
    if (!res.b64) return { ok: true, url: res.url };
    const path = await uploadToTavern(res.b64, -1);
    return { ok: true, path };
}

function runDiagnostics() {
    const info = diagnose();
    console.group(LOG, '诊断');
    console.log(JSON.stringify(info, null, 2));
    console.groupEnd();
    const d = info.dom;
    const msg = `楼层 ${d.floors} / 正文区 ${d.mesText} / 已渲染图 ${d.figures} / 有无图配图的消息 ${info.messagesWithItems.length}`;
    if (!info.observer) {
        toastr.error('自愈观察器没挂上（#chat 不存在？），刷新页面重试', 'ImageFree');
    } else if (info.messagesWithItems.length > 0 && d.figures === 0) {
        toastr.warning(`${msg} —— 有图但没渲染，右键编辑任意楼层或切一下聊天触发重绘`, 'ImageFree');
    } else {
        toastr.success(`${msg}（详情见控制台）`, 'ImageFree');
    }
    return info;
}

// ─────────────────────────── 初始化 ───────────────────────────

function bindEvents() {
    eventSource.on(event_types.MESSAGE_RECEIVED, (id, type) => onMessageReceived(id, type));
    eventSource.on(event_types.MESSAGE_SWIPED, (id) => onSwiped(id));

    // 渲染事件层：不 await，纯渲染不阻塞酒馆的生成流程
    const repaint = (id) => { try { renderNow(Number(id)); } catch (e) { dbg('repaint 失败', e); } };
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, repaint);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, repaint);
    eventSource.on(event_types.MESSAGE_UPDATED, repaint);
    eventSource.on(event_types.MESSAGE_EDITED, (id) => {
        try { relocateAnchors(Number(id)); repaint(id); } catch (e) { dbg('edited 失败', e); }
    });
    eventSource.on(event_types.MESSAGE_DELETED, () => hydrateAll('message-deleted'));
    eventSource.on(event_types.MORE_MESSAGES_LOADED, () => hydrateAll('more-loaded'));
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    document.addEventListener('click', onDocumentClick, true);
}

async function init() {
    getSettings();

    const html = await renderExtensionTemplateAsync('third-party/st-imagefree', 'settings');
    $('#extensions_settings2').append(html);
    bindSettingsUI();

    bindEvents();
    ensureObserver();

    // 进聊天/刷新页面时补一次（有些渲染路径不发事件）
    setTimeout(() => hydrateAll('init'), 600);
    setTimeout(() => ensureObserver(), 1500);

    console.info(LOG, `v${VERSION} 已加载（内联锚点 + 自愈水合）`);
}

jQuery(async () => {
    try {
        await init();
    } catch (e) {
        console.error(LOG, '初始化失败', e);
    }
});

// 给高级用户 / 其它插件 / 自检工具留的入口
globalThis.STImageFree = {
    version: VERSION,
    settings: () => getSettings(),
    generate: (messageId, opts) => generateForMessage(messageId, { manual: true, ...opts }),
    regenerate: (messageId, itemId) => {
        const item = findItem(getContext().chat?.[messageId], itemId);
        return item ? regenerate(messageId, item) : Promise.resolve();
    },
    remove: (messageId, itemId) => removeItem(messageId, itemId),
    hydrateAll,
    diagnose,
    selfTest,
    chooseAnchor,
    splitBlocks,
};
