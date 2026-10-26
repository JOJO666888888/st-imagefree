/**
 * core.js 单元测试：切段 / 提示词清洗 / 锚点选择 / DOM 定位 / 差分水合
 * 运行（在 tests/ 目录）：npm i && node --test core.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { fileURLToPath } from 'node:url';
const core = await import(new URL('../core.js', import.meta.url).href);

const dom = new JSDOM('<!doctype html><body><div id="chat"></div></body>');
const doc = dom.window.document;

function mesTextFrom(mes) {
    const host = doc.createElement('div');
    host.className = 'mes_text';
    const paras = String(mes).split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    host.innerHTML = paras.map((p) => `<p>${p}</p>`).join('');
    return host;
}

// ── 切段 ────────────────────────────────────────────────
test('splitBlocks：空行分段、代码块整块跳过', () => {
    const mes = [
        '第一段。',
        '',
        '第二段，稍微长一点的剧情描写。',
        '',
        '```js',
        'const a = 1;',
        '```',
        '',
        '最后一段。',
    ].join('\n');
    const blocks = core.splitBlocks(mes);
    assert.equal(blocks.length, 4);
    assert.equal(blocks[0].skip, false);
    assert.equal(blocks[1].skip, false);
    assert.equal(blocks[2].skip, true, '代码块必须 skip');
    assert.equal(blocks[3].skip, false);
});

test('splitBlocks：长段落用单换行也能切开', () => {
    const line = '这是一句剧情描写，长度足够。'.repeat(40); // >420 字
    const mes = `${line}\n他还是没回头。\n她走了。`;
    const blocks = core.splitBlocks(mes);
    assert.ok(blocks.length >= 3, `期望被切成多段，实际 ${blocks.length}`);
});

test('splitBlocks：纯符号行不成段', () => {
    const blocks = core.splitBlocks('***\n\n---\n\n正文一句。');
    assert.equal(blocks.filter((b) => !b.skip).length, 1);
});

// ── 提示词 ──────────────────────────────────────────────
test('cleanPrompt：去引号、去换行、去 HTML', () => {
    const out = core.cleanPrompt('“<b>少女</b>站在\n雨里，\n举着伞。”');
    assert.equal(out.includes('\n'), false);
    assert.equal(out.includes('<'), false);
    assert.equal(out.startsWith('"'), false);
    assert.ok(out.startsWith('少女'));
});

test('cleanPrompt：超长截断', () => {
    const out = core.cleanPrompt('啊'.repeat(500), 60);
    assert.equal(out.length, 60);
});

// ── 提示词段落选择 ──────────────────────────────────────
test('pickSceneBlock：跳过纯对话、挑信息量最大的一段', () => {
    const blocks = core.splitBlocks([
        '“你来了。”她说。',
        '',
        '林晚站在街角，抬手把伞往他那边偏了偏，雨水顺着伞骨落在柏油路上，霓虹把她半个侧脸照得发亮。',
        '',
        '他没有回答。',
    ].join('\n'));
    const pick = core.pickSceneBlock(blocks, 400);
    assert.ok(pick.plain.includes('林晚站在街角'));
});

// ── 锚点选择 ────────────────────────────────────────────
const SCENE = [
    '雨下了整夜。',
    '林晚站在街角，抬手把伞往他那边偏了偏，雨水顺着伞骨落下来，霓虹把她侧脸照得发亮。',
    '他低头看她，没说话。',
].join('\n\n');

test('chooseAnchor(auto)：插到与提示词最像的那段', () => {
    const anchor = core.chooseAnchor(SCENE, '林晚 街角 撑伞 雨夜 霓虹 侧脸', 'auto');
    assert.equal(anchor.para, 1);
    assert.ok(anchor.snippet.startsWith('林晚站在街角'));
});

test('chooseAnchor(first/end)：按设置走', () => {
    assert.equal(core.chooseAnchor(SCENE, '', 'first').para, 0);
    assert.equal(core.chooseAnchor(SCENE, '', 'end').para, 2);
});

test('chooseAnchor：提示词跟正文毫无重合时退回最有画面的一段', () => {
    const anchor = core.chooseAnchor(SCENE, '1girl, silver hair, city night, cinematic', 'auto');
    assert.equal(anchor.para, 1);
});

// ── DOM 定位 ────────────────────────────────────────────
test('resolveAnchorElement：段号漂了也能靠快照找回', () => {
    const host = mesTextFrom(SCENE);
    // 前面被别的东西插了一段，段号整体后移 1
    host.insertAdjacentHTML('afterbegin', '<p>【系统】时间推进。</p>');
    const el = core.resolveAnchorElement(host, { para: 1, snippet: '林晚站在街角' });
    assert.equal(el.textContent, '林晚站在街角，抬手把伞往他那边偏了偏，雨水顺着伞骨落下来，霓虹把她侧脸照得发亮。');
});

test('resolveAnchorElement：快照对不上时按段号，越界兜底末段', () => {
    const host = mesTextFrom(SCENE);
    const byIndex = core.resolveAnchorElement(host, { para: 0, snippet: '完全不相干的一段文字' });
    assert.equal(byIndex.textContent, '雨下了整夜。');

    const overflow = core.resolveAnchorElement(host, { para: 99, snippet: '' });
    assert.equal(overflow.textContent, '他低头看她，没说话。');
});

test('resolveAnchorElement：空正文返回 null', () => {
    const host = doc.createElement('div');
    host.className = 'mes_text';
    assert.equal(core.resolveAnchorElement(host, { para: 0 }), null);
});

// ── 插入 & 差分 ─────────────────────────────────────────
test('placeFigure：插在锚点段之后；同段多图按顺序排队', () => {
    const host = mesTextFrom(SCENE);
    const p1 = host.children[1];

    const a = core.createFigureElement(doc, { id: 'a', status: 'ready', url: '/a.png' });
    core.placeFigure(host, a, p1);

    const b = core.createFigureElement(doc, { id: 'b', status: 'ready', url: '/b.png' });
    core.placeFigure(host, b, p1);

    const order = Array.from(host.children).map((c) => c.tagName === 'FIGURE'
        ? c.getAttribute('data-if-id') : c.tagName);
    assert.deepEqual(order, ['P', 'P', 'a', 'b', 'P']);
});

test('placeFigure：没有锚点时落到正文末尾', () => {
    const host = mesTextFrom('只有一段。');
    const fig = core.createFigureElement(doc, { id: 'z', status: 'ready', url: '/z.png' });
    core.placeFigure(host, fig, null);
    assert.equal(host.lastElementChild.getAttribute('data-if-id'), 'z');
});

test('syncFigures：差分幂等，重复调用不重复插', () => {
    const host = mesTextFrom(SCENE);
    const items = [{ id: 'x', status: 'ready', url: '/x.png', anchor: { para: 1, snippet: '林晚站在街角' } }];

    const s1 = core.syncFigures(host, items, { doc });
    assert.deepEqual(s1, { added: 1, updated: 0, removed: 0 });

    const s2 = core.syncFigures(host, items, { doc });
    assert.deepEqual(s2, { added: 0, updated: 0, removed: 0 });
    assert.equal(host.querySelectorAll('.if-figure').length, 1);
});

test('syncFigures：状态/地址变化只替换，不挪位置', () => {
    const host = mesTextFrom(SCENE);
    const items = [{ id: 'x', status: 'pending', url: '', anchor: { para: 1, snippet: '林晚站在街角' } }];
    core.syncFigures(host, items, { doc });

    items[0].status = 'ready';
    items[0].url = '/x.png';
    const s = core.syncFigures(host, items, { doc });
    assert.equal(s.updated, 1);
    assert.equal(host.children[2].getAttribute('data-if-id'), 'x');
    assert.equal(host.children[2].getAttribute('data-if-status'), 'ready');
});

test('syncFigures：不属于当前楼层/swipe 的图会被清掉', () => {
    const host = mesTextFrom(SCENE);
    core.syncFigures(host, [{ id: 'old', status: 'ready', url: '/o.png', anchor: { para: 0 } }], { doc });
    assert.equal(host.querySelectorAll('.if-figure').length, 1);

    const s = core.syncFigures(host, [], { doc });
    assert.equal(s.removed, 1);
    assert.equal(host.querySelectorAll('.if-figure').length, 0);
});

// ── 节点内容 ────────────────────────────────────────────
test('createFigureElement：三种状态渲染正确', () => {
    const pending = core.createFigureElement(doc, { id: 'p', status: 'pending' });
    assert.ok(pending.textContent.includes('正在配图'));
    assert.equal(pending.querySelector('img'), null);

    const ready = core.createFigureElement(doc, { id: 'r', status: 'ready', url: '/r.png', prompt: 'abc' });
    assert.equal(ready.querySelector('img').getAttribute('src'), '/r.png');
    assert.equal(ready.querySelectorAll('[data-if-action]').length, 3);

    const error = core.createFigureElement(doc, { id: 'e', status: 'error', error: '上游 429' });
    assert.ok(error.textContent.includes('上游 429'));
    assert.equal(error.querySelector('[data-if-action="retry"]') !== null, true);
});

test('createFigureElement：默认不显示提示词，开了才显示', () => {
    const a = core.createFigureElement(doc, { id: 'a', status: 'ready', url: '/a.png', prompt: '少女' });
    assert.equal(a.querySelector('figcaption'), null);
    const b = core.createFigureElement(doc, { id: 'b', status: 'ready', url: '/b.png', prompt: '少女' }, { showCaption: true });
    assert.equal(b.querySelector('figcaption').textContent, '少女');
});

// ── 提示词重写（独立 API） ───────────────────────────────

test('parseRewriteOutput：一行纯文本', () => {
    const out = core.parseRewriteOutput('  a girl standing in the rain, neon lights, cinematic  ');
    assert.equal(out.prompt, 'a girl standing in the rain, neon lights, cinematic');
    assert.equal(out.anchor, '');
});

test('parseRewriteOutput：剥掉思维链与代码块', () => {
    const raw = [
        '<think>用户给了一段中文，我先分析……</think>',
        '```text',
        'silver hair girl, holding umbrella, rainy neon street, cinematic',
        '```',
    ].join('\n');
    assert.equal(core.parseRewriteOutput(raw).prompt,
        'silver hair girl, holding umbrella, rainy neon street, cinematic');
});

test('parseRewriteOutput：JSON 带 prompt / anchor', () => {
    const raw = '结果如下：\n{"prompt":"two people under one umbrella, close-up, rain","anchor":"他低头看她"}';
    const out = core.parseRewriteOutput(raw);
    assert.equal(out.prompt, 'two people under one umbrella, close-up, rain');
    assert.equal(out.anchor, '他低头看她');
});

test('parseRewriteOutput：中文前缀、说明行、残留标签都要清掉', () => {
    const raw = [
        '说明：我先挑了最有画面的一段。',
        '提示词：林晚撑着伞站在霓虹雨夜，半身特写',
        '（备注：已避开文字）',
    ].join('\n');
    const out = core.parseRewriteOutput(raw);
    // 全角逗号会被规范成 ASCII 逗号：出图模型对逗号分隔更敏感
    assert.equal(out.prompt, '林晚撑着伞站在霓虹雨夜, 半身特写');

    const tagged = core.parseRewriteOutput('<local_img>girl in rain, umbrella</local_img>');
    assert.equal(tagged.prompt, 'girl in rain, umbrella');
});

test('parseRewriteOutput：空输入', () => {
    assert.deepEqual(core.parseRewriteOutput(''), { prompt: '', anchor: '' });
    assert.deepEqual(core.parseRewriteOutput(null), { prompt: '', anchor: '' });
});

test('renderTemplate：占位符替换，缺变量原样留', () => {
    const out = core.renderTemplate('{{char}}|{{story}}|{{index}}/{{count}}|{{nope}}', {
        char: '林晚', story: '正文', index: 1, count: 2,
    });
    assert.equal(out, '林晚|正文|1/2|{{nope}}');
});

test('buildRewriteMessages：system + user 两条', () => {
    const msgs = core.buildRewriteMessages({
        system: '规则 {{char}}',
        userTemplate: '{{story}}',
        vars: { char: 'A', story: 'B' },
    });
    assert.equal(msgs.length, 2);
    assert.deepEqual(msgs[0], { role: 'system', content: '规则 A' });
    assert.deepEqual(msgs[1], { role: 'user', content: 'B' });
});

test('stripImageTags：摘掉各种残留标签', () => {
    const src = '前文<local_img>girl, rain</local_img>中段<image>x</image>后段 image###y### 结尾';
    const out = core.stripImageTags(src);
    assert.equal(/local_img|<image>|image###/.test(out), false);
    assert.ok(out.includes('前文'));
    assert.ok(out.includes('结尾'));
});

test('composePrompt：追加风格后缀并去重', () => {
    assert.equal(core.composePrompt('a, b', 'c, d'), 'a, b, c, d');
    assert.equal(core.composePrompt('a, cinematic', 'cinematic, d'), 'a, cinematic, d');
    assert.equal(core.composePrompt('a', ''), 'a');
    assert.equal(core.composePrompt('', 'x'), 'x');
});

test('cleanBlocksForPrompt：标签连内容一起摘掉，段号不变', () => {
    const mes = [
        '雨下了整夜。',
        '林晚站在街角，抬手把伞往他那边偏了偏。',
        '<local_img>1girl, silver hair, holding umbrella, masterpiece</local_img>',
        '他低头看她，没说话。',
    ].join('\n\n');
    const blocks = core.cleanBlocksForPrompt(core.splitBlocks(mes));
    assert.equal(blocks.length, 4);
    assert.equal(blocks[2].skip, true, '整块都是标签，清完应该被跳过');
    assert.equal(blocks[2].plain, '');
    assert.ok(blocks[1].plain.includes('林晚站在街角'));
    assert.equal(blocks[1].index, 1, 'index 不能被改，DOM 段号要对得上');
});

test('chooseAnchor(hint)：按模型指认的段落落位', () => {
    const hint = '他低头看她，没说话。';
    const anchor = core.chooseAnchor(SCENE, 'a close-up of a man looking down', 'auto', hint);
    assert.equal(anchor.para, 2);

    // 明确选了 end 时，hint 不该抢戏
    const endAnchor = core.chooseAnchor(SCENE, 'a close-up', 'end', hint);
    assert.equal(endAnchor.para, 2);
    const firstAnchor = core.chooseAnchor(SCENE, 'a close-up', 'first', hint);
    assert.equal(firstAnchor.para, 0);
});

test('capPrompt：超长按标点截断，不硬切半句', () => {
    const long = 'a'.repeat(60) + ', ' + 'b'.repeat(60) + ', ' + 'c'.repeat(400);
    const r = core.capPrompt(long, 140);
    assert.equal(r.truncated, true);
    assert.ok(r.text.length <= 140);
    assert.equal(r.text.endsWith(','), true, '应停在逗号后');

    const short = core.capPrompt('a short prompt', 400);
    assert.equal(short.truncated, false);
    assert.equal(short.text, 'a short prompt');
});

test('parseRewriteOutput：剥掉模型开场白', () => {
    assert.equal(
        core.parseRewriteOutput('好的，我先梳理一下这段剧情，然后给出提示词。silver hair girl, rainy street').prompt,
        'silver hair girl, rainy street',
    );
    assert.equal(
        core.parseRewriteOutput('Sure, here is the prompt: a girl under an umbrella').prompt,
        'a girl under an umbrella',
    );
    // 正常提示词不能被误伤
    assert.equal(
        core.parseRewriteOutput('a woman standing in the rain, cinematic').prompt,
        'a woman standing in the rain, cinematic',
    );
});
