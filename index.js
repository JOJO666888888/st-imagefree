/**
 * ImageFree 自动配图 — SillyTavern 扩展
 *
 * 把 imagefree.net 生图（经 imagefree-2api 中转）接到酒馆：AI 每回一段，自动/手动出一张图，
 * 直接嵌在对应楼层里。
 *
 * 关键实现点（对齐酒馆 1.18.0）：
 *   - 楼层图片 = message.extra.media[] + appendMediaToMessage()
 *   - 图片落盘 = POST /api/images/upload （base64），返回 user/images/xxx.png 相对路径
 *   - 事件    = MESSAGE_RECEIVED / MESSAGE_SWIPED
 */

import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import {
    appendMediaToMessage,
    eventSource,
    event_types,
    generateQuietPrompt,
    getRequestHeaders,
    saveSettingsDebounced,
} from '../../../../script.js';
import { SCROLL_BEHAVIOR } from '../../../constants.js';

const MODULE_NAME = 'imagefree';
const LOG = '[ImageFree]';

const defaultSettings = {
    enabled: true,
    apiBase: 'http://127.0.0.1:8080/v1',
    apiKey: '',
    model: 'imagefree-1',
    aspect: '3:4',
    mode: 'direct',        // direct=直接取正文 | llm=让对话模型写提示词
    interval: 2,           // 每 N 条 AI 回复出一张（4=每4条）
    maxChars: 400,
    storeInTavern: true,
    showButton: true,
    displaySize: 'medium',
    llmInstruction:
        '你是一个 AI 绘图提示词生成器。读下面的剧情片段，提炼出一个具体的画面：' +
        '写清楚主体、外貌、动作、服装、场景、光线、镜头与画风。' +
        '只输出一条提示词（用英文逗号分隔的中文短语，60~120 字），不要解释、不要引号、不要换行。',
};

const inFlight = new Set();   // 正在生成的 messageId，防止重复触发
let aiMessageCounter = 0;     // 自上次出图以来收到的 AI 回复数

// ─────────────────────────── 设置 ───────────────────────────

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    // 补齐新增字段（老用户升级）
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][k] === undefined) {
            extension_settings[MODULE_NAME][k] = v;
        }
    }
    return extension_settings[MODULE_NAME];
}

const settings = () => getSettings();

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
    setVal('#if_display_size', s.displaySize);
    $('#if_store').prop('checked', s.storeInTavern);
    $('#if_show_button').prop('checked', s.showButton);

    $('#if_enabled').on('change', function () {
        s.enabled = $(this).prop('checked'); saveSettingsDebounced();
    });
    $('#if_api_base').on('input', function () {
        s.apiBase = String($(this).val()).trim().replace(/\/+$/, ''); saveSettingsDebounced();
    });
    $('#if_api_key').on('input', function () {
        s.apiKey = String($(this).val()).trim(); saveSettingsDebounced();
    });
    $('#if_model').on('input', function () {
        s.model = String($(this).val()).trim() || defaultSettings.model; saveSettingsDebounced();
    });
    $('#if_aspect').on('change', function () {
        s.aspect = String($(this).val()); saveSettingsDebounced();
    });
    $('#if_mode').on('change', function () {
        s.mode = String($(this).val()); saveSettingsDebounced();
    });
    $('#if_interval').on('input', function () {
        s.interval = Math.max(1, parseInt($(this).val(), 10) || 1); saveSettingsDebounced();
    });
    $('#if_maxchars').on('input', function () {
        s.maxChars = Math.max(80, parseInt($(this).val(), 10) || 400); saveSettingsDebounced();
    });
    $('#if_display_size').on('change', function () {
        s.displaySize = String($(this).val()); applyDisplaySize(); saveSettingsDebounced();
    });
    $('#if_store').on('change', function () {
        s.storeInTavern = $(this).prop('checked'); saveSettingsDebounced();
    });
    $('#if_show_button').on('change', function () {
        s.showButton = $(this).prop('checked'); saveSettingsDebounced();
        $('.if_gen_button').toggleClass('if-hidden', !s.showButton);
    });

    $('#if_test').on('click', async function () {
        const btn = $(this);
        btn.prop('disabled', true).text('测试中…');
        try {
            const url = await requestImage('a simple red apple on a wooden table, studio light');
            toastr.success(`接口正常，示例图：${String(url).slice(0, 60)}…`);
        } catch (e) {
            toastr.error(`测试失败：${e.message}`);
        } finally {
            btn.prop('disabled', false).text('测试连接');
        }
    });

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

    applyDisplaySize();
}

function applyDisplaySize() {
    const map = { small: '180px', medium: '300px', large: '440px', full: '100%' };
    const w = map[settings().displaySize] || map.medium;
    document.documentElement.style.setProperty('--if-img-max', w);
}

// ─────────────────────── 提示词构建 ───────────────────────

/** 去掉 HTML / 代码块 / 常见占位符，压成一行纯文本 */
function plainText(raw) {
    return String(raw || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/[*_~`#>]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

async function buildPrompt(message) {
    const s = settings();
    const text = plainText(message.mes);
    if (!text) throw new Error('本楼没有可用正文');

    if (s.mode === 'llm') {
        try {
            const raw = await generateQuietPrompt({
                quietPrompt: `${s.llmInstruction}\n\n【剧情片段】\n${text.slice(0, 1200)}`,
                quietName: 'ImageFree',
                responseLength: 160,
            });
            const cleaned = plainText(raw).replace(/^["'“”]|["'“”]$/g, '').trim();
            if (cleaned.length >= 6) return cleaned.slice(0, 400);
            console.warn(LOG, 'LLM 提示词过短，回退到正文模式');
        } catch (e) {
            console.warn(LOG, 'LLM 写提示词失败，回退到正文模式:', e);
        }
    }

    // direct 模式：直接取正文前 N 字（场景描写通常在前面）
    return text.slice(0, s.maxChars);
}

// ─────────────────────── 接口调用 ───────────────────────

function apiUrl(path) {
    const base = String(settings().apiBase || '').replace(/\/+$/, '');
    return `${base}${path}`;
}

/** 调用 imagefree-2api 出一张图，返回 url 或 base64 */
async function requestImage(prompt) {
    const s = settings();
    if (!s.apiBase) throw new Error('未配置 API 地址');

    const body = {
        model: s.model || 'imagefree-1',
        prompt,
        size: s.aspect,                       // 直接把宽高比当 size 传，服务端会识别
        n: 1,
        response_format: s.storeInTavern ? 'b64_json' : 'url',
    };

    let resp;
    try {
        resp = await fetch(apiUrl('/images/generations'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}),
            },
            body: JSON.stringify(body),
        });
    } catch (e) {
        throw new Error(
            `连不上 API（${e.message}）。请检查：① 地址是否以 /v1 结尾；` +
            '② 酒馆是 HTTPS 时不能调 HTTP 接口（混合内容会被浏览器拦）；③ 网络是否可达该服务器',
        );
    }

    if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try {
            const err = await resp.json();
            detail = err?.error?.message || detail;
        } catch { /* ignore */ }
        throw new Error(detail);
    }

    const data = await resp.json();
    const item = data?.data?.[0];
    if (!item) throw new Error('接口没有返回图片');

    if (s.storeInTavern) {
        if (!item.b64_json) throw new Error('接口未返回 b64_json');
        return await uploadToTavern(item.b64_json);
    }
    if (!item.url) throw new Error('接口未返回 url');
    return item.url;
}

/** 把 base64 图片存进酒馆，返回可直接用于 <img src> 的相对路径 */
async function uploadToTavern(b64) {
    const ctx = getContext();
    // 没选角色时 name2 会是 "SillyTavern System"，这种别拿去当文件夹名
    const raw = ctx.groupId ? 'group' : (ctx.name2 || '');
    const chName = raw && raw !== 'SillyTavern System' ? raw : '';
    const resp = await fetch('/api/images/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            image: b64,
            format: 'png',
            filename: `imagefree_${Date.now()}`,
            ...(chName ? { ch_name: chName } : {}),
        }),
    });
    if (!resp.ok) throw new Error(`存图失败 HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data?.path) throw new Error('存图未返回路径');
    return data.path;
}

// ─────────────────────── 挂到楼层 ───────────────────────

function messageElement(messageId) {
    return $(`#chat .mes[mesid="${messageId}"]`);
}

function attachImage(messageId, url, title) {
    const ctx = getContext();
    const message = ctx.chat[messageId];
    console.debug(LOG, `attach id=${messageId} found=${!!message} prevMedia=${message?.extra?.media?.length}`);
    if (!message) return false;

    if (!message.extra || typeof message.extra !== 'object') message.extra = {};
    if (!Array.isArray(message.extra.media)) message.extra.media = [];

    message.extra.media.push({
        url,
        type: 'image',
        title: title || 'AI 配图',
        source: 'generated',
    });
    message.extra.media_index = message.extra.media.length - 1;
    message.extra.media_display = 'gallery';
    // 第一张图时保持正文可见（true = 图片与正文并存）
    if (message.extra.inline_image === undefined) message.extra.inline_image = true;

    const el = messageElement(messageId);
    if (el.length) {
        el.addClass('if-generated');
        appendMediaToMessage(message, el, SCROLL_BEHAVIOR.KEEP);
    }
    return true;
}

function showLoading(messageId, text = 'AI 正在配图…') {
    const el = messageElement(messageId);
    if (!el.length) return;
    el.find('.if-loading').remove();
    el.find('.mes_text').append(`<div class="if-loading"><span class="if-dot"></span>${text}</div>`);
}

function hideLoading(messageId) {
    messageElement(messageId).find('.if-loading').remove();
}

// ─────────────────────── 主流程 ───────────────────────

async function generateForMessage(messageId, { manual = false } = {}) {
    const ctx = getContext();
    const message = ctx.chat?.[messageId];
    console.debug(LOG, `generate id=${messageId} chatLen=${ctx.chat?.length} found=${!!message}`);
    if (!message) return;

    if (inFlight.has(messageId)) {
        if (manual) toastr.info('这一楼正在生成中');
        return;
    }

    // 自动模式：本楼已有图就跳过，避免重复烧额度
    if (!manual && Array.isArray(message.extra?.media) && message.extra.media.length > 0) {
        console.debug(LOG, `楼层 ${messageId} 已有图片，跳过`);
        return;
    }

    inFlight.add(messageId);
    showLoading(messageId, manual ? 'AI 正在配图…' : '自动配图中…');
    const t0 = Date.now();

    try {
        const prompt = await buildPrompt(message);

        // 上游图床偶发抖动，失败自动再来一次（不重新写提示词，省一次 LLM 调用）
        let url = null;
        let lastErr = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                url = await requestImage(prompt);
                break;
            } catch (e) {
                lastErr = e;
                if (/HTTP 4\d\d|Invalid API key|401|403/.test(e.message)) break;
                if (attempt < 2) {
                    console.warn(LOG, `第 ${attempt} 次失败，2 秒后重试：`, e.message);
                    await new Promise((r) => setTimeout(r, 2000));
                }
            }
        }
        if (!url) throw lastErr || new Error('生成失败');

        const ok = attachImage(messageId, url, prompt);
        if (ok) {
            const sec = ((Date.now() - t0) / 1000).toFixed(1);
            console.info(LOG, `楼层 ${messageId} 出图完成 (${sec}s)`, prompt);
            try { await ctx.saveChat(); } catch (e) { console.warn(LOG, '保存聊天失败', e); }
            if (manual) toastr.success(`配图完成（${sec}s）`);
        }
    } catch (e) {
        console.error(LOG, '生成失败', e);
        toastr.error(`配图失败：${e.message}`, 'ImageFree');
    } finally {
        inFlight.delete(messageId);
        hideLoading(messageId);
    }
}

function shouldAutoGenerate(message) {
    const s = settings();
    if (!s.enabled) return false;
    if (!message || message.is_user || message.is_system) return false;
    if (!plainText(message.mes)) return false;

    aiMessageCounter++;
    const n = Math.max(1, Number(s.interval) || 1);
    if (aiMessageCounter < n) {
        console.debug(LOG, `计数 ${aiMessageCounter}/${n}，暂不出图`);
        return false;
    }
    aiMessageCounter = 0;
    return true;
}

// ─────────────────────── 楼层按钮 ───────────────────────

function addFloorButton(messageId) {
    const s = settings();
    if (!s.showButton) return;
    const el = messageElement(messageId);
    if (!el.length) return;
    const holder = el.find('.extraMesButtons');
    if (!holder.length || holder.find('.if_gen_button').length) return;

    const btn = $(
        '<div class="mes_button if_gen_button fa-solid fa-wand-magic-sparkles" ' +
        'title="用 ImageFree 为这一楼配图"></div>',
    );
    btn.on('click', (ev) => {
        ev.stopPropagation();
        void generateForMessage(messageId, { manual: true });
    });
    holder.append(btn);
}

// ─────────────────────── 初始化 ───────────────────────

async function init() {
    getSettings();

    const html = await renderExtensionTemplateAsync('third-party/st-imagefree', 'settings');
    $('#extensions_settings2').append(html);
    bindSettingsUI();

    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
        const ctx = getContext();
        const message = ctx.chat?.[messageId];
        if (!message) return;
        if (shouldAutoGenerate(message)) void generateForMessage(messageId);
    });

    eventSource.on(event_types.MESSAGE_SWIPED, (messageId) => {
        const ctx = getContext();
        const message = ctx.chat?.[messageId];
        if (!message) return;
        // 换 swipe 视为一次新的 AI 回复，但同楼已有图不重复出
        if (shouldAutoGenerate(message)) void generateForMessage(messageId);
    });

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
        addFloorButton(messageId);
    });

    // 重新渲染历史楼层时补按钮
    eventSource.on(event_types.CHAT_CHANGED, () => {
        aiMessageCounter = 0;
        setTimeout(() => {
            $('#chat .mes').each(function () {
                const id = Number($(this).attr('mesid'));
                if (!Number.isNaN(id)) addFloorButton(id);
            });
        }, 500);
    });

    console.info(LOG, '扩展已加载');
}

jQuery(async () => {
    try {
        await init();
    } catch (e) {
        console.error(LOG, '初始化失败', e);
    }
});

// 给高级用户 / 其它插件留个入口
globalThis.STImageFree = {
    generate: (messageId, opts) => generateForMessage(messageId, opts),
    settings: () => getSettings(),
    version: '1.0.0',
    debug: () => {
        const c = getContext();
        return {
            chatIsArray: Array.isArray(c.chat),
            chatLength: c.chat?.length ?? null,
            chatId: c.chatId ?? null,
            name2: c.name2 ?? null,
            mediaStats: Array.isArray(c.chat)
                ? c.chat.map((m, i) => ({ i, hasMedia: Array.isArray(m?.extra?.media) && m.extra.media.length > 0 }))
                : null,
        };
    },
};
