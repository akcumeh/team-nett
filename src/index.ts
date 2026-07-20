import { bot, configureBotCommands } from './controllers/telegram.controller.js';

// local dev/testing entrypoint: long polling the bot.
// deployed app uses webhooks the Vercel functions instead.
async function main(): Promise<void> {
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
