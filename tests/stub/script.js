// 测试用：SillyTavern script.js 的最小替身
export const calls = { saveChat: 0, saveSettings: 0, syncMesToSwipe: 0, quiet: 0 };

const listeners = new Map();

export const eventSource = {
    on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(fn);
    },
    off(event, fn) {
        const arr = listeners.get(event) || [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
    },
    async emit(event, ...args) {
        for (const fn of [...(listeners.get(event) || [])]) await fn(...args);
    },
};

export const event_types = {
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_EDITED: 'message_edited',
    MESSAGE_UPDATED: 'message_updated',
    MESSAGE_DELETED: 'message_deleted',
    MORE_MESSAGES_LOADED: 'more_messages_loaded',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    USER_MESSAGE_RENDERED: 'user_message_rendered',
    CHAT_CHANGED: 'chat_id_changed',
};

let quietPromptText = 'silver hair girl in rain, holding umbrella, cinematic light';

export function setQuietPrompt(text) {
    quietPromptText = text;
}

export async function generateQuietPrompt() {
    calls.quiet++;
    return quietPromptText;
}

export function getRequestHeaders() {
    return { 'Content-Type': 'application/json' };
}

export function saveChatDebounced() {
    calls.saveChat++;
}

export function saveSettingsDebounced() {
    calls.saveSettings++;
}

export function syncMesToSwipe() {
    calls.syncMesToSwipe++;
    return true;
}
