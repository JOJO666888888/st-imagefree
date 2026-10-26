// 测试用：SillyTavern extensions.js 的最小替身
import fs from 'node:fs';

export const extension_settings = {
    connectionManager: {
        profiles: [
            { id: 'p1', name: '档案一', api: 'custom', model: 'profile-model' },
            { id: 'p2', name: '档案二', api: 'openai', model: 'gpt-x' },
        ],
        selectedProfile: '',
    },
};

/** 「复用主 API」的两条通道替身：只记录调用、返回固定文本 */
export const mainApiMock = {
    reply: 'main api rewritten prompt, rainy street',
    profileReply: 'profile rewritten prompt, close-up portrait',
    chatCalls: [],
    profileCalls: [],
    reset() {
        this.chatCalls.length = 0;
        this.profileCalls.length = 0;
        this.reply = 'main api rewritten prompt, rainy street';
        this.profileReply = 'profile rewritten prompt, close-up portrait';
    },
};

export const ctx = {
    chat: [],
    chatId: 'test-chat',
    name2: '测试角色',
    groupId: null,
    mainApi: 'openai',
    chatCompletionSettings: {
        chat_completion_source: 'custom',
        openai_model: 'main-model',
        custom_url: 'http://main.test/v1',
        reverse_proxy: '',
        proxy_password: '',
    },
    ChatCompletionService: {
        async sendRequest(payload) {
            mainApiMock.chatCalls.push(payload);
            return { content: mainApiMock.reply, reasoning: '' };
        },
    },
    ConnectionManagerRequestService: {
        constructPrompt(prompt) {
            return prompt;
        },
        async sendRequest(profileId, prompt, maxTokens, opts, override) {
            mainApiMock.profileCalls.push({ profileId, prompt, maxTokens, opts, override });
            return { content: mainApiMock.profileReply, reasoning: '' };
        },
    },
    saveChat() {},
};

export function getContext() {
    return ctx;
}

export async function renderExtensionTemplateAsync() {
    return fs.readFileSync(new URL('../../settings.html', import.meta.url), 'utf8');
}
