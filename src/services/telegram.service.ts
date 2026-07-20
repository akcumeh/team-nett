import { Telegraf } from 'telegraf';
import { getConfig } from '../config/index.js';

let bot: Telegraf | null = null;

export function getBot(): Telegraf {
    if (!bot) {
        bot = new Telegraf(getConfig().botToken);
    }
    return bot;
}

export async function push(chatId: string, text: string): Promise<void> {
    try {
        await getBot().telegram.sendMessage(chatId, text);
    } catch (error) {
        console.error(`push to ${chatId} failed:`, error);
    }
}
