/**
 * 端到端流程测试：真跑 index.js（只把酒馆本体换成 stub）。
 * 运行（在 tests/ 目录）：npm i && node --test flow.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, makeMessage, mountMessage, remountText, settle, net, resetNet } from './harness.mjs';
import { ctx } from './stub/extensions.js';
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
    Object.assign(S(), {
        enabled: true,
        mode: 'direct',
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
    assert.equal(info.version, '2.0.0');
    assert.equal(info.chatLength, 1);
    assert.equal(info.dom.figures, 1);
    assert.equal(info.dom.mesText, 1);
    assert.equal(info.observer, true);
    assert.equal(info.messagesWithItems.length, 1);
    assert.equal(info.settings.apiKey, '');
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
