import { bot, configureBotCommands } from './controllers/telegram.controller.js';
import { createApp } from './app.js';
import { getConfig } from './config/index.js';

// local dev/testing entrypoint: long polling the bot + the same express app
// the Vercel functions serve. deployed app uses webhooks instead.
async function main(): Promise<void> {
    const config = getConfig();

    const app = createApp();
    app.listen(config.port, () => {
        console.log(`NETT HTTP server listening on ${config.port}`);
    });

    await configureBotCommands();
    console.log('NETT Finance Room bot starting in long-polling mode...');
    await bot.launch();
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

main().catch((error) => {
    console.error('Bot failed to start:', error);
    process.exit(1);
});
