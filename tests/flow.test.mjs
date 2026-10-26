/**
 * 端到端流程测试：真跑 index.js（只把酒馆本体换成 stub）。
 * 运行（在 tests/ 目录）：npm i && node --test flow.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, makeMessage, mountMessage, remountText, settle, net, resetNet } from './harness.mjs';
import { ctx, mainApiMock } from './stub/extensions.js';
import { eventSource, event_types, calls } from './stub/script.js';

const env = await boot();
const doc = env.doc;
const win = env.window;
const S = () => globalThis.STImageFree.settings();

const SCENE = [
    '雨下了整夜。',
    '林晚站在街角，抬手把伞往他那边偏了偏，雨水顺着伞骨落在柏油路上，霓虹把她半个侧脸照得发亮。',
    '他低头看她，没说话。',
].join('\n\n');

const OTHER = [
    '天亮了。',
    '厨房里飘着粥的味道，他把碗推到她面前，指尖在桌沿停了一下。',
].join('\n\n');

let chatSeq = 0;

/** 开一个干净的聊天：清 DOM、清 chat、复位队列与网络计数 */
async function newChat() {
    await eventSource.emit(event_types.CHAT_CHANGED);
    doc.getElementById('chat').innerHTML = '';
    ctx.chatId = `chat-${++chatSeq}`;
    ctx.chat = [];
    resetNet();
    Object.assign(S().promptApi, {
        source: 'dedicated', profileId: '',
        baseUrl: '', apiKey: '', model: '', style: '', system: '', user: '',
        lang: 'en', jsonMode: false, retries: 0, temperature: 0.7, maxTokens: 300,
        timeoutSec: 60, storyChars: 2400,
    });
    mainApiMock.reset();
    ctx.mainApi = 'openai';
    Object.assign(S(), {
        enabled: true,
        mode: 'direct',
        trigger: 'auto',
        marker: '[[配图]]',
        interval: 1,
        perMessage: 1,
        position: 'auto',
        storeInTavern: true,
        autoOnSwipe: true,
        showButton: true,
        showCaption: false,
        debug: false,
        retries: 0,
    });
    await settle(10);
}

function pushAi(mes, { isUser = false, isSystem = false, swipeId = 0 } = {}) {
    const msg = makeMessage({ mes, isUser, isSystem, swipeId });
    ctx.chat.push(msg);
    const id = ctx.chat.length - 1;
    mountMessage(doc, id, mes);
    return { msg, id };
}

const figEls = (id) => [...doc.querySelectorAll(`.mes[mesid="${id}"] .mes_text > .if-figure`)];
const items = (msg) => msg.extra?.imagefree?.items ?? [];
const genCalls = () => net.calls.filter((c) => c.url.includes('/images/generations')).length;

async function receive(id, type = 'normal') {
    await eventSource.emit(event_types.MESSAGE_RECEIVED, id, type);
    await settle(60);
}

// ─────────────────────────────────────────────────────────

test('自动触发：MESSAGE_RECEIVED 后图片内联插到匹配段落之后', async () => {
    await newChat();
    const { msg, id } = pushAi(SCENE);
    await receive(id);

    const list = items(msg);
    assert.equal(list.length, 1, '应该有 1 条配图记录');
    assert.equal(list[0].status, 'ready');
    assert.match(list[0].url, /^\/user\/images\/selftest_\d+\.png$/);
    assert.equal(list[0].anchor.para, 1, '锚点应落在第二段');
    assert.ok(list[0].prompt.includes('林晚站在街角'), '提示词应取到有画面的那段');

    const fig = figEls(id);
    assert.equal(fig.length, 1, '.mes_text 里应有 1 个内联 figure');
    assert.equal(fig[0].querySelector('img').getAttribute('src'), list[0].url);

    const children = [...doc.querySelector(`.mes[mesid="${id}"] .mes_text`).children];
    const figIndex = children.findIndex((c) => c.classList.contains('if-figure'));
    const pIndex = children.findIndex((c) => c.tagName === 'P' && c.textContent.includes('林晚站在街角'));
    assert.equal(figIndex, pIndex + 1, '图必须紧跟目标段落，而不是堆在楼层底部');
});

test('不再依赖 extra.media（v1 的图廊通道已废弃）', async () => {
    await newChat();
    const { msg, id } = pushAi(SCENE);
    await receive(id);
    assert.equal(msg.extra.media, undefined);
    assert.equal(msg.extra.media_display, undefined);
    assert.equal(doc.querySelector(`.mes[mesid="${id}"] .mes_media_wrapper`), null);
});

test('自愈：.mes_text 被整体重写后图片自动补回原位', async () => {
    await newChat();
    const { msg, id } = pushAi(SCENE);
    await receive(id);

    const before = figEls(id)[0];
    const src = before.querySelector('img').getAttribute('src');
    const indexBefore = [...before.parentElement.children].indexOf(before);

    // 酒馆 updateMessageBlock / 右键编辑 就是这么干的：直接重写 innerHTML，且不发事件
    remountText(doc, id, msg.mes);
    assert.equal(figEls(id).length, 0, '重写后图应该先被抹掉');

    await settle(80);
    const after = figEls(id);
    assert.equal(after.length, 1, 'MutationObserver 应该把图补回来');
    assert.equal(after[0].querySelector('img').getAttribute('src'), src);
    const indexAfter = [...after[0].parentElement.children].indexOf(after[0]);
    assert.equal(indexAfter, indexBefore, '补回的位置必须跟原来一致');
});

test('同一楼不重复出图', async () => {
    await newChat();
    const { msg, id } = pushAi(SCENE);
    await receive(id);
    const genBefore = genCalls();

    await receive(id);
    await receive(id);

    assert.equal(items(msg).length, 1);
    assert.equal(genCalls(), genBefore, '已有成品图时不应再打接口');
    assert.equal(figEls(id).length, 1);
});

test('每 N 楼出图：interval=2 时只对第 2 楼出图', async () => {
    await newChat();
    S().interval = 2;

    const a = pushAi(SCENE);
    await receive(a.id);
    assert.equal(items(a.msg).length, 0, '第 1 楼应该被间隔跳过');

    const b = pushAi(SCENE);
    await receive(b.id);
    assert.equal(items(b.msg).length, 1, '第 2 楼应该出图');
});

test('user / system / quiet 楼层都不触发出图', async () => {
    await newChat();

    const u = pushAi('我是玩家发言。', { isUser: true });
    await receive(u.id);
    assert.equal(items(u.msg).length, 0);

    const sys = pushAi('系统提示。', { isSystem: true });
    await receive(sys.id);
    assert.equal(items(sys.msg).length, 0);

    const q = pushAi(SCENE);
    await receive(q.id, 'quiet');
    assert.equal(items(q.msg).length, 0);

    assert.equal(genCalls(), 0);
});

test('swipe 独立成图，切回旧 swipe 显示旧图', async () => {
    await newChat();
    const { msg, id } = pushAi(SCENE);
    await receive(id);
    const first = items(msg)[0].url;

    // 用户右滑：正文变了，swipe_id 变 1
    msg.swipe_id = 1;
    msg.mes = OTHER;
    msg.swipes.push(OTHER);
    remountText(doc, id, OTHER);
    await eventSource.emit(event_types.MESSAGE_SWIPED, id);
    await settle(80);

    assert.equal(items(msg).length, 2, '两条 swipe 各一张');
    let view = figEls(id);
    assert.equal(view.length, 1);
    assert.equal(view[0].getAttribute('data-if-swipe'), '1');
    assert.notEqual(view[0].querySelector('img').getAttribute('src'), first);

    const second = items(msg)[1].url;

    // 切回 swipe 0
    msg.swipe_id = 0;
    msg.mes = SCENE;
    remountText(doc, id, SCENE);
    await eventSource.emit(event_types.MESSAGE_SWIPED, id);
    await settle(80);

    view = figEls(id);
    assert.equal(view.length, 1, '不同 swipe 的图不能同时显示');
    assert.equal(view[0].getAttribute('data-if-swipe'), '0');
    assert.equal(view[0].querySelector('img').getAttribute('src'), first);
    assert.notEqual(first, second);
});

test('删除按钮：移除节点 + 清掉存档记录', async () => {
    await newChat();
    const { msg, id } = pushAi(SCENE);
    await receive(id);
    assert.equal(items(msg).length, 1);

    const icon = figEls(id)[0].querySelector('[data-if-action="delete"] i');
    icon.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle(40);

    assert.equal(items(msg).length, 0);
    assert.equal(figEls(id).length, 0);
});

test('出图失败：显示错误块，点重试后恢复', async () => {
    await newChat();
    net.fail = '上游打烊了';
    const { msg, id } = pushAi(SCENE);
    await receive(id);

    const list = items(msg);
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'error');
    assert.equal(list[0].error, '上游打烊了');

    const fig = figEls(id)[0];
    assert.equal(fig.getAttribute('data-if-status'), 'error');
    assert.ok(fig.textContent.includes('上游打烊了'));

    net.fail = null;
    fig.querySelector('[data-if-action="retry"] i')
        .dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle(80);

    assert.equal(items(msg)[0].status, 'ready');
    assert.equal(figEls(id)[0].getAttribute('data-if-status'), 'ready');
});

test('失败重试：retries=1 时会把 5xx 再试一次', async () => {
    await newChat();
    S().retries = 1;
    net.fail = '上游打烊了';
    const { msg, id } = pushAi(SCENE);
    await eventSource.emit(event_types.MESSAGE_RECEIVED, id, 'normal');
    await settle(2600);   // 等一次 2 秒退避

    assert.equal(genCalls(), 2, '应该尝试两次');
    assert.equal(items(msg)[0].status, 'error');
    assert.equal(items(msg)[0].error, '上游打烊了');
});

test('position=end：插在最后一段之后', async () => {
    await newChat();
    S().position = 'end';
    const { id } = pushAi(SCENE);
    await receive(id);

    const children = [...doc.querySelector(`.mes[mesid="${id}"] .mes_text`).children];
    const figIndex = children.findIndex((c) => c.classList.contains('if-figure'));
    assert.equal(figIndex, children.length - 1, 'end 模式应落在正文最末');
});

test('perMessage：可配多张，但不超上限', async () => {
    await newChat();
    S().perMessage = 2;
    const { msg, id } = pushAi(SCENE);
    await receive(id);

    await globalThis.STImageFree.generate(id);
    await settle(80);
    assert.equal(items(msg).length, 2);
    assert.equal(figEls(id).length, 2);

    await globalThis.STImageFree.generate(id);
    await settle(40);
    assert.equal(items(msg).length, 2, '达到上限后不再新增');
});

test('llm 模式：用对话模型写的提示词，并据此定位段落', async () => {
    await newChat();
    S().mode = 'llm';
    S().position = 'auto';
    const { msg, id } = pushAi(SCENE);
    await receive(id);

    assert.equal(calls.quiet, 1, '应调用一次 quiet prompt');
    assert.equal(items(msg)[0].status, 'ready');
    // stub 返回英文 tag，跟正文没有二元组重合 → 应退回「最有画面」的第二段
    assert.equal(items(msg)[0].anchor.para, 1);
});

test('storeInTavern=false：直接用远端 url，不走存图接口', async () => {
    await newChat();
    S().storeInTavern = false;
    const { msg, id } = pushAi(SCENE);
    await receive(id);

    assert.equal(items(msg)[0].url, 'https://example.test/remote.png');
    assert.equal(net.calls.filter((c) => c.url.includes('/api/images/upload')).length, 0);
    assert.equal(figEls(id)[0].querySelector('img').getAttribute('src'), 'https://example.test/remote.png');
});

test('诊断接口能给出可排障的快照', async () => {
    await newChat();
    const { id } = pushAi(SCENE);
    await receive(id);

    const info = globalThis.STImageFree.diagnose();
    assert.match(info.version, /^\d+\.\d+\.\d+$/);
    assert.equal(info.chatLength, 1);
    assert.equal(info.dom.figures, 1);
    assert.equal(info.dom.mesText, 1);
    assert.equal(info.observer, true);
    assert.equal(info.messagesWithItems.length, 1);
    assert.equal(info.settings.apiKey, '');
});

// ── 独立重写 API ─────────────────────────────────────────

test('rewrite 模式：提示词来自独立重写 API，主模型完全不参与', async () => {
    await newChat();
    S().mode = 'rewrite';
    S().promptApi.baseUrl = 'http://127.0.0.1:9999/v1';
    S().promptApi.model = 'rewrite-model';
    S().promptApi.style = 'film grain, 35mm';
    const quietBefore = calls.quiet;
    const { msg, id } = pushAi(SCENE);
    await receive(id);

    const rw = net.calls.filter((c) => c.url.includes('/chat/completions'));
    assert.equal(rw.length, 1, '应该调一次重写接口');
    assert.equal(rw[0].url, 'http://127.0.0.1:9999/v1/chat/completions');
    assert.equal(rw[0].body.model, 'rewrite-model');
    assert.equal(rw[0].body.messages[0].role, 'system');
    assert.ok(rw[0].body.messages[0].content.includes('文生图提示词'), 'system 应是内置重写规则');
    assert.ok(rw[0].body.messages[1].content.includes('林晚站在街角'), 'user 消息要带上正文');

    const item = items(msg)[0];
    assert.equal(item.status, 'ready');
    assert.equal(item.source, 'rewrite');
    assert.equal(
        item.prompt,
        'silver-haired girl holding an umbrella under neon rain, cinematic, film grain, 35mm',
        '最终提示词 = 模型输出 + 风格后缀',
    );
    assert.equal(calls.quiet, quietBefore, '绝不能再去动酒馆的 quiet prompt（那是预设耦合的根源）');
});

test('rewrite 失败：静默回退到直接取正文，图照样出', async () => {
    await newChat();
    S().mode = 'rewrite';
    S().promptApi.baseUrl = 'http://127.0.0.1:9999/v1';
    S().promptApi.model = 'rewrite-model';
    net.rewriteFail = '上游 500';
    const { msg, id } = pushAi(SCENE);
    await receive(id);

    const item = items(msg)[0];
    assert.equal(item.status, 'ready', '重写挂了也要把图出来');
    assert.equal(item.source, 'direct');
    assert.ok(item.prompt.includes('林晚站在街角'));
});

test('未配置重写 API：不请求、不报错，直接回退', async () => {
    await newChat();
    S().mode = 'rewrite';           // 地址留空
    const { msg, id } = pushAi(SCENE);
    await receive(id);

    assert.equal(net.calls.filter((c) => c.url.includes('/chat/completions')).length, 0);
    assert.equal(items(msg)[0].status, 'ready');
    assert.equal(items(msg)[0].source, 'direct');
});

test('重写给的段落线索会决定插图位置', async () => {
    await newChat();
    S().mode = 'rewrite';
    S().promptApi.baseUrl = 'http://127.0.0.1:9999/v1';
    S().promptApi.model = 'rewrite-model';
    // 模型返回英文提示词（跟中文正文毫无字符重合），但指认了第三段
    net.rewriteReply = JSON.stringify({
        prompt: 'a man looking down at a woman in the rain, close-up',
        anchor: '他低头看她，没说话。',
    });
    const { msg, id } = pushAi(SCENE);
    await receive(id);

    assert.equal(items(msg)[0].anchor.para, 2, '应该听模型的段落线索，而不是靠提示词猜');
    const children = [...doc.querySelector(`.mes[mesid="${id}"] .mes_text`).children];
    assert.equal(children.findIndex((c) => c.classList.contains('if-figure')), 3);
});

// ── 复用主 API ───────────────────────────────────────────

test('复用主 API（当前对话连接）：走 ChatCompletionService，不填 Key 也能重写', async () => {
    await newChat();
    S().mode = 'rewrite';
    S().promptApi.source = 'main';
    S().promptApi.profileId = '';
    S().promptApi.style = 'film grain';
    const { msg, id } = pushAi(SCENE);
    await receive(id);

    assert.equal(mainApiMock.chatCalls.length, 1, '应调用一次当前对话连接');
    const call = mainApiMock.chatCalls[0];
    assert.equal(call.chat_completion_source, 'custom');
    assert.equal(call.model, 'main-model');
    assert.equal(call.custom_url, 'http://main.test/v1');
    assert.equal(call.messages[0].role, 'system');
    assert.ok(call.messages[1].content.includes('林晚站在街角'));

    const item = items(msg)[0];
    assert.equal(item.source, 'rewrite');
    assert.equal(item.prompt, 'main api rewritten prompt, rainy street, film grain');
    assert.equal(net.calls.filter((c) => c.url.includes('/chat/completions')).length, 0, '不该再打专用地址');
});

test('复用主 API（指定连接档案）：走 ConnectionManagerRequestService 且不吃预设', async () => {
    await newChat();
    S().mode = 'rewrite';
    S().promptApi.source = 'main';
    S().promptApi.profileId = 'p1';
    const { msg, id } = pushAi(SCENE);
    await receive(id);

    assert.equal(mainApiMock.profileCalls.length, 1);
    assert.equal(mainApiMock.profileCalls[0].profileId, 'p1');
    assert.equal(mainApiMock.profileCalls[0].opts.includePreset, false, '必须忽略档案自带预设');
    assert.equal(mainApiMock.chatCalls.length, 0, '指定档案后就不该再走当前连接');

    const item = items(msg)[0];
    assert.equal(item.source, 'rewrite');
    assert.ok(item.prompt.startsWith('profile rewritten prompt'));
});

test('主 API 不是 Chat Completion 时给出明确报错并回退', async () => {
    await newChat();
    S().mode = 'rewrite';
    S().promptApi.source = 'main';
    ctx.mainApi = 'textgenerationwebui';
    const { msg, id } = pushAi(SCENE);
    await receive(id);

    const item = items(msg)[0];
    assert.equal(item.status, 'ready', '回退后图还是要出');
    assert.equal(item.source, 'direct');
    assert.equal(mainApiMock.chatCalls.length, 0);
});

test('重写失败降级：图上必须标「未重写」，并记下原因', async () => {
    await newChat();
    S().mode = 'rewrite';            // 地址留空 → 必失败
    const { msg, id } = pushAi(SCENE);
    await receive(id);

    const item = items(msg)[0];
    assert.equal(item.status, 'ready');
    assert.equal(item.source, 'direct');
    assert.equal(item.fallback, true, '要能标记出这是降级产物');
    assert.ok(/未配置/.test(item.fallbackReason || ''), '要记下原因');

    const fig = figEls(id)[0];
    assert.equal(fig.getAttribute('data-if-source'), 'direct');
    assert.ok(fig.querySelector('.if-figure__badge'), '没有重写就挂个「未重写」的标');
});

test('直接取正文时不能把 <local_img> 里的预设内容带进提示词', async () => {
    await newChat();
    S().mode = 'rewrite';
    const withTag = [
        '雨下了整夜。',
        '林晚站在街角，抬手把伞往他那边偏了偏，霓虹落在她侧脸上。',
        '<local_img>1girl, silver hair, masterpiece, best quality</local_img>',
    ].join('\n\n');
    const { msg, id } = pushAi(withTag);
    await receive(id);

    const prompt = items(msg)[0].prompt;
    assert.ok(prompt.includes('林晚'), '正文该留下');
    assert.equal(/1girl|silver hair|masterpiece/i.test(prompt), false,
        '标签里的内容（往往是预设让模型写的提示词）必须被摘掉');
});

test('正常重写 / 直接模式都不挂「未重写」标', async () => {
    await newChat();
    S().mode = 'direct';
    const a = pushAi(SCENE);
    await receive(a.id);
    assert.equal(figEls(a.id)[0].querySelector('.if-figure__badge'), null);
    assert.equal(items(a.msg)[0].fallback, false);

    await newChat();
    S().mode = 'rewrite';
    S().promptApi.baseUrl = 'http://127.0.0.1:9999/v1';
    S().promptApi.model = 'rewrite-model';
    const b = pushAi(SCENE);
    await receive(b.id);
    assert.equal(figEls(b.id)[0].querySelector('.if-figure__badge'), null);
    assert.equal(items(b.msg)[0].source, 'rewrite');
});

// ── 标记驱动（v3.2） ─────────────────────────────────────

const TAGGED = [
    '雨下了整夜，屋檐的水线一直没断。',
    '林晚站在旧书店门口，把伞往他那边偏了偏，霓虹落在她侧脸上。',
    '[[配图]]',
    '他低头看她，最终什么也没说。',
].join('\n\n');

test('标记驱动：没有标记的楼层一张图都不出', async () => {
    await newChat();
    S().trigger = 'tag';
    const { msg, id } = pushAi(SCENE);          // SCENE 里没有标记
    await receive(id);

    assert.equal(items(msg).length, 0, '没有标记就不该有配图记录');
    assert.equal(genCalls(), 0, '更不该去打生图接口');
});

test('标记驱动：问候语/空正文不触发出图', async () => {
    await newChat();
    S().trigger = 'tag';
    const hello = pushAi('你好呀，今天想聊点什么？');
    await receive(hello.id);
    assert.equal(items(hello.msg).length, 0);
    assert.equal(genCalls(), 0);
});

test('标记驱动：出了标记才出图，且图插在标记所在位置', async () => {
    await newChat();
    S().trigger = 'tag';
    const { msg, id } = pushAi(TAGGED);
    await receive(id);

    const list = items(msg);
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'ready');
    assert.equal(list[0].markerAt > 0, true, '要记下标记的位置');

    // 标记在第 3 段（index 2），图应插在第 2 段之后
    const kids = [...doc.querySelector(`.mes[mesid="${id}"] .mes_text`).children];
    const figIndex = kids.findIndex((c) => c.classList.contains('if-figure'));
    assert.equal(figIndex, 2, `图应紧跟第 2 段，实际 ${figIndex}`);
    assert.equal(kids[figIndex - 1].textContent.includes('林晚站在旧书店门口'), true);

    // 标记那一段要被藏起来，读者看不见 [[配图]]
    const markerPara = kids.find((c) => c.textContent.includes('[[配图]]'));
    assert.ok(markerPara, '标记段应还在 DOM 里（只是隐藏）');
    assert.equal(markerPara.style.display, 'none', '标记段必须被隐藏');
});

test('标记驱动：重写给的是标记之前的正文，不含后面剧情', async () => {
    await newChat();
    S().trigger = 'tag';
    S().mode = 'rewrite';
    S().promptApi.baseUrl = 'http://127.0.0.1:9999/v1';
    S().promptApi.model = 'rewrite-model';
    const { msg, id } = pushAi(TAGGED);
    await receive(id);

    const rw = net.calls.filter((c) => c.url.includes('/chat/completions'))[0];
    const userMsg = rw.body.messages[1].content;
    assert.equal(userMsg.includes('林晚站在旧书店门口'), true, '标记前的正文要在');
    assert.equal(userMsg.includes('他低头看她'), false, '标记后的剧情不该给重写模型');
    assert.equal(userMsg.includes('[[配图]]'), false, '标记本身要去掉');
    assert.equal(items(msg)[0].status, 'ready');
});

test('标记驱动：两个标记出两张，各自锚在自己的位置', async () => {
    await newChat();
    S().trigger = 'tag';
    S().perMessage = 2;
    const mes = [
        '第一段：雨声很密。',
        '[[配图]]',
        '第二段：她把伞收了。',
        '[[配图]]',
        '第三段：他终于开口。',
    ].join('\n\n');
    const { msg, id } = pushAi(mes);
    await receive(id);

    const list = items(msg);
    assert.equal(list.length, 2, '两个标记应该出两张');
    const paras = list.map((i) => i.anchor.para).sort((a, b) => a - b);
    assert.deepEqual(paras, [0, 2], '分别锚在第 1、第 3 段');
    assert.equal(figEls(id).length, 2);
});

test('auto 模式不受标记限制（兼容老用法）', async () => {
    await newChat();
    S().trigger = 'auto';
    const { msg, id } = pushAi(SCENE);
    await receive(id);
    assert.equal(items(msg).length, 1);
    assert.equal(items(msg)[0].markerAt, null);
});

// ── 通道选择 / CORS 兜底 ─────────────────────────────────

test('复用主 API 时，重写模型字段会覆盖酒馆里的对话模型', async () => {
    await newChat();
    S().mode = 'rewrite';
    S().promptApi.source = 'main';
    S().promptApi.profileId = '';
    S().promptApi.model = 'spark-x2.6';       // 酒馆里是 main-model
    const { msg, id } = pushAi(SCENE);
    await receive(id);

    assert.equal(mainApiMock.chatCalls.length, 1);
    assert.equal(mainApiMock.chatCalls[0].model, 'spark-x2.6', '必须用插件里填的模型，否则会被上游 400');
    assert.equal(items(msg)[0].source, 'rewrite');
});

test('专用 API 被 CORS 拦掉时，自动改走酒馆服务端通道', async () => {
    await newChat();
    S().mode = 'rewrite';
    S().promptApi.source = 'dedicated';
    S().promptApi.baseUrl = 'http://127.0.0.1:9999/v1';
    S().promptApi.model = 'rewrite-model';
    S().promptApi.style = '';

    // 让浏览器直连表现成 CORS 失败
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        if (String(url).includes('/chat/completions')) throw new TypeError('Failed to fetch');
        return realFetch(url, init);
    };
    try {
        const { msg, id } = pushAi(SCENE);
        await receive(id);
        assert.equal(mainApiMock.chatCalls.length, 1, '应自动退到服务端通道');
        assert.equal(items(msg)[0].source, 'rewrite', '结果仍算重写成功');
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('楼层「配图」按钮：存在且可点', async () => {
    await newChat();
    const { msg, id } = pushAi(SCENE);
    await receive(id);

    const btn = doc.querySelector(`.mes[mesid="${id}"] .extraMesButtons .if_gen_button`);
    assert.ok(btn, '应注入配图按钮');

    S().perMessage = 2;
    btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle(80);
    assert.equal(items(msg).length, 2);
});
