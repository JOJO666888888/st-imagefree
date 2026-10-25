/**
 * 测试脚手架：用 jsdom 复刻酒馆的楼层 DOM，然后把 index.js 的两条 import
 * 改指向 tests/stub，在 gen/ 里真跑一遍。
 *
 * 这样测的是**真代码**（事件注册、自动触发、水合、存档写入都跑），
 * 只有酒馆本体被替身掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);

export const PLUGIN_DIR = path.resolve(import.meta.dirname, '..');
const GEN_DIR = path.join(import.meta.dirname, '.gen');

export const TINY_PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ── 假 fetch ──────────────────────────────────────────────
export const net = {
    calls: [],
    delayMs: 0,
    fail: null,          // 设成字符串则生成接口返回 500 + 该错误
    uploadSeq: 0,
    rewriteReply: 'silver-haired girl holding an umbrella under neon rain, cinematic',
    rewriteFail: null,   // 设成字符串则重写接口返回 500
    rewriteDelayMs: 0,
};

function jsonResponse(obj, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() { return obj; },
        async text() { return JSON.stringify(obj); },
    };
}

function installFetch() {
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        net.calls.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
        if (net.delayMs) await new Promise((r) => setTimeout(r, net.delayMs));

        if (u.includes('/images/generations')) {
            if (net.fail) return jsonResponse({ error: { message: net.fail } }, 500);
            const body = init.body ? JSON.parse(init.body) : {};
            if (body.response_format === 'b64_json') {
                return jsonResponse({ data: [{ b64_json: TINY_PNG }] });
            }
            return jsonResponse({ data: [{ url: 'https://example.test/remote.png' }] });
        }
        if (u.includes('/chat/completions')) {
            if (net.rewriteDelayMs) await new Promise((r) => setTimeout(r, net.rewriteDelayMs));
            if (net.rewriteFail) return jsonResponse({ error: { message: net.rewriteFail } }, 500);
            return jsonResponse({
                choices: [{ index: 0, message: { role: 'assistant', content: net.rewriteReply } }],
            });
        }
        if (u.includes('/api/images/upload')) {
            const n = net.uploadSeq++;
            return jsonResponse({ path: `/user/images/selftest_${n}.png` });
        }
        return jsonResponse({ error: 'unexpected url ' + u }, 404);
    };
}

// ── 编译 index.js（改 import 指向 stub） ───────────────────
export function build() {
    fs.mkdirSync(GEN_DIR, { recursive: true });
    let src = fs.readFileSync(path.join(PLUGIN_DIR, 'index.js'), 'utf8');
    src = src
        .replace("'../../../extensions.js'", "'../stub/extensions.js'")
        .replace("'../../../../script.js'", "'../stub/script.js'");
    if (src.includes("'../../../extensions.js'") || src.includes("'../../../../script.js'")) {
        throw new Error('import 重写失败：index.js 的 import 路径变了？');
    }
    fs.writeFileSync(path.join(GEN_DIR, 'index.gen.mjs'), src);
    fs.copyFileSync(path.join(PLUGIN_DIR, 'core.js'), path.join(GEN_DIR, 'core.js'));
    return path.join(GEN_DIR, 'index.gen.mjs');
}

// ── 楼层 DOM（对齐酒馆 .mes 结构） ─────────────────────────
export function paragraphsOf(mes) {
    return String(mes)
        .split(/\n{2,}/)
        .map((s) => s.trim())
        .filter(Boolean);
}

export function mountMessage(doc, id, mes) {
    const chat = doc.getElementById('chat');
    chat.querySelector(`.mes[mesid="${id}"]`)?.remove();

    const el = doc.createElement('div');
    el.className = 'mes';
    el.setAttribute('mesid', String(id));
    el.innerHTML =
        '<div class="mes_block">' +
        '<div class="mes_text"></div>' +
        '<div class="mes_buttons"><div class="extraMesButtons"></div></div>' +
        '</div>';
    el.querySelector('.mes_text').innerHTML = paragraphsOf(mes).map((p) => `<p>${p}</p>`).join('');
    chat.appendChild(el);
    return el;
}

/** 复刻酒馆 updateMessageBlock：直接重写 .mes_text.innerHTML，不发任何事件 */
export function remountText(doc, id, mes) {
    const mesText = doc.querySelector(`.mes[mesid="${id}"] .mes_text`);
    mesText.innerHTML = paragraphsOf(mes).map((p) => `<p>${p}</p>`).join('');
    return mesText;
}

export async function boot() {
    const html = '<!doctype html><html><body>' +
        '<div id="extensions_settings2"></div>' +
        '<div id="chat"></div>' +
        '</body></html>';
    const dom = new JSDOM(html, { url: 'http://127.0.0.1:8000/', pretendToBeVisual: true });

    const { window } = dom;
    globalThis.window = window;
    globalThis.document = window.document;
    try { globalThis.navigator = window.navigator; } catch { /* Node 自带 navigator，只读 */ }
    globalThis.Element = window.Element;
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.Node = window.Node;
    globalThis.MutationObserver = window.MutationObserver;

    const jq = require('jquery');
    // jquery 的 CJS 入口：有 global.document 时直接返回绑定好的实例，否则返回工厂
    const $ = typeof jq === 'function' && jq.fn ? jq : jq(window);
    globalThis.$ = $;
    globalThis.jQuery = $;

    // 让 schedule() 立刻跑，不用等 16ms 的帧
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);

    const toasts = [];
    globalThis.toastr = {
        success: (m) => toasts.push(['success', m]),
        info: (m) => toasts.push(['info', m]),
        warning: (m) => toasts.push(['warning', m]),
        error: (m) => toasts.push(['error', m]),
    };
    globalThis.__toasts = toasts;

    installFetch();

    const entry = build();
    await import(`file://${entry.replace(/\\/g, '/')}?t=${Date.now()}`);
    await settle(120);
    return { window, doc: window.document, toasts };
}

export const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

export function resetNet() {
    net.calls.length = 0;
    net.delayMs = 0;
    net.fail = null;
    net.rewriteFail = null;
    net.rewriteDelayMs = 0;
    net.rewriteReply = 'silver-haired girl holding an umbrella under neon rain, cinematic';
}

/** 造一条酒馆消息对象 */
export function makeMessage({ mes, isUser = false, isSystem = false, swipeId = 0 } = {}) {
    return {
        name: isUser ? 'User' : 'AI',
        is_user: isUser,
        is_system: isSystem,
        mes,
        extra: {},
        swipe_id: swipeId,
        swipes: [mes],
        swipe_info: [{}],
    };
}
