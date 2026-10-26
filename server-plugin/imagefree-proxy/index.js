/**
 * ImageFree 出图中转（SillyTavern 服务端插件）
 *
 * 为什么需要它：
 *   st-imagefree 插件默认从**浏览器**直接请求出图中转，这要求中转返回
 *   Access-Control-Allow-Origin。没开 CORS 的中转在浏览器里一律 Failed to fetch，
 *   而酒馆自己的请求走服务端，所以「写文能用、出图不能用」。
 *
 * 这个插件把出图请求改成由酒馆服务端发出，彻底绕开 CORS。
 *
 * 安全：只转发到 config.json 里 allowHosts 列出的主机，避免变成任意 SSRF 跳板。
 */

const fs = require('fs');
const path = require('path');

const info = {
    id: 'imagefree-proxy',
    name: 'ImageFree Proxy',
    description: 'Forward image generation requests to the relay from the server side (bypasses browser CORS).',
};

const CONFIG_FILE = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
    // 只允许转发到这些主机（hostname 或 IP，不含端口）。写 "*" 表示不限制（不安全，不推荐）
    allowHosts: ['77.113.242.115'],
    // 单次请求超时（毫秒）
    timeoutMs: 180000,
};

function readConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return { ...DEFAULT_CONFIG, ...raw };
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

function ensureConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        try {
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 4) + '\n', 'utf8');
        } catch { /* 只读目录就算了 */ }
    }
}

function hostAllowed(url, allowHosts) {
    if (!Array.isArray(allowHosts) || !allowHosts.length) return false;
    if (allowHosts.includes('*')) return true;
    try {
        const { protocol, hostname } = new URL(url);
        if (protocol !== 'http:' && protocol !== 'https:') return false;
        return allowHosts.some((h) => String(h).toLowerCase() === hostname.toLowerCase());
    } catch {
        return false;
    }
}

async function init(router) {
    ensureConfig();

    router.get('/info', (_req, res) => {
        const cfg = readConfig();
        res.json({ ok: true, plugin: info.id, allowHosts: cfg.allowHosts, timeoutMs: cfg.timeoutMs });
    });

    router.post('/generate', async (req, res) => {
        const cfg = readConfig();
        const { url, apiKey, model, prompt, size, responseFormat, timeoutMs } = req.body || {};

        if (!url) return res.status(400).json({ error: 'missing url' });
        if (!hostAllowed(url, cfg.allowHosts)) {
            return res.status(403).json({
                error: `不允许转发到该主机：${url}。把它的主机名加进 plugins/imagefree-proxy/config.json 的 allowHosts`,
            });
        }

        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), Number(timeoutMs) || cfg.timeoutMs);
        const started = Date.now();

        try {
            const upstream = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                },
                body: JSON.stringify({
                    model: model || 'imagefree-1',
                    prompt,
                    size: size || '3:4',
                    n: 1,
                    response_format: responseFormat || 'b64_json',
                }),
                signal: ctl.signal,
            });

            const text = await upstream.text();
            let json = null;
            try { json = JSON.parse(text); } catch { /* 上游返回非 JSON */ }

            if (!upstream.ok || !json) {
                return res.status(502).json({
                    error: `上游 ${upstream.status}：${String(text).slice(0, 300)}`,
                    status: upstream.status,
                    ms: Date.now() - started,
                });
            }

            const first = json.data?.[0];
            if (!first) return res.status(502).json({ error: '上游没有返回图片数据', raw: String(text).slice(0, 200) });

            return res.json({
                ok: true,
                ms: Date.now() - started,
                b64: first.b64_json || null,
                url: first.url || null,
                revisedPrompt: first.revised_prompt || null,
            });
        } catch (e) {
            const aborted = ctl.signal.aborted;
            return res.status(aborted ? 504 : 502).json({
                error: aborted
                    ? `出图超时（>${Math.round((Number(timeoutMs) || cfg.timeoutMs) / 1000)}s）`
                    : `连不上上游：${e.message}`,
                ms: Date.now() - started,
            });
        } finally {
            clearTimeout(timer);
        }
    });
}

module.exports = { info, init };
