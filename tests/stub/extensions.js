// 测试用：SillyTavern extensions.js 的最小替身
import fs from 'node:fs';

export const extension_settings = {};

export const ctx = {
    chat: [],
    chatId: 'test-chat',
    name2: '测试角色',
    groupId: null,
    saveChat() {},
};

export function getContext() {
    return ctx;
}

export async function renderExtensionTemplateAsync() {
    return fs.readFileSync(new URL('../../settings.html', import.meta.url), 'utf8');
}
