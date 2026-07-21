import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getConfig } from '../src/config/index.js';
import { verifyTelegramSecret } from '../src/utils/security.js';
import { bot } from '../src/controllers/telegram.controller.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== 'POST') {
        res.status(405).send('method not allowed');
        return;
    }

    const header = req.headers['x-telegram-bot-api-secret-token'];
    let supplied: string | undefined;
    if (Array.isArray(header)) {
        supplied = header[0];
    } else {
        supplied = header;
    }

    // Any POST without the secret token we registered via setWebhook is a forgery.
    if (!verifyTelegramSecret(supplied, getConfig().tgWebhookSecret)) {
        console.warn('tg webhook rejected: missing or invalid secret token');
        res.status(401).send('unauthorized');
        return;
    }

    try {
        await bot.handleUpdate(req.body);
    } catch (error) {
        console.error('Telegram update failed:', error);
    }
    res.status(200).send('ok');
}
