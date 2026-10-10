// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CashAutoQuest — index.js
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import 'dotenv/config';
import { Client, Collection, GatewayIntentBits, Partials, REST, Routes, ActivityType } from 'discord.js';

import { TokenStore, StatsStore, AQStore, startAutoQuestWatcher } from './engine.js';
import { ALL_COMMANDS, handleInteraction } from './commands.js';

// ─── Env validation ───────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
if (!BOT_TOKEN) { console.error('[FATAL] DISCORD_TOKEN is not set.'); process.exit(1); }
if (!CLIENT_ID) { console.error('[FATAL] DISCORD_CLIENT_ID is not set.'); process.exit(1); }

const PREFIX = process.env.BOT_PREFIX ?? ',,';

// ─── Banner ───────────────────────────────────────────────────────────────────
const R = '\x1b[0m', B = '\x1b[1m', G = '\x1b[92m', C = '\x1b[96m', D = '\x1b[90m', W = '\x1b[97m', Y = '\x1b[93m';
console.log(`
${C}${B}   ██████╗ █████╗ ███████╗██╗  ██╗${R}
${C}${B}  ██╔════╝██╔══██╗██╔════╝██║  ██║${R}
${C}${B}  ██║     ███████║███████╗███████║${R}
${C}${B}  ██║     ██╔══██║╚════██║██╔══██║${R}
${W}${B}  ╚██████╗██║  ██║███████║██║  ██║${R}
${W}${B}   ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝${R}
${D}  ── CashAutoQuest ── Full-auto quest engine with tracking ──${R}
`);

// ─── Deploy slash commands ────────────────────────────────────────────────────
console.log(`${D}[Deploy]${R} Registering ${ALL_COMMANDS.length} slash commands...`);
try {
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    await rest.put(Routes.applicationCommands(CLIENT_ID), {
        body: ALL_COMMANDS.map(c => c.data.toJSON()),
    });
    console.log(`${G}[Deploy]${R} ${ALL_COMMANDS.length} commands registered: ${D}${ALL_COMMANDS.map(c => c.data.name).join(', ')}${R}`);
} catch (err) {
    console.error(`[Deploy] Failed:`, err.message);
}

// ─── Client ───────────────────────────────────────────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Message, Partials.Channel],
});

client.commands     = new Collection();
client.tokenStore   = new TokenStore(BOT_TOKEN);
client.statsStore   = new StatsStore();

for (const cmd of ALL_COMMANDS) {
    if (cmd.data)   client.commands.set(cmd.data.name, cmd);
}

// ─── Events ───────────────────────────────────────────────────────────────────
client.once('ready', () => {
    console.log(`${G}[Ready]${R} Logged in as ${W}${client.user.tag}${R} — ${G}${client.guilds.cache.size}${R} guild(s)`);

    client.user.setPresence({
        activities: [{ name: `quests | ${PREFIX}help`, type: ActivityType.Watching }],
        status: 'online',
    });

    startAutoQuestWatcher(client.tokenStore, client.statsStore, client);
    console.log(`${G}[AutoQuest]${R} Watcher started — scanning every 5 minutes`);
});

client.on('interactionCreate', interaction => handleInteraction(interaction, client));

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args        = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const commandName = args.shift().toLowerCase();
    const cmd         = ALL_COMMANDS.find(c => c.prefix === commandName);

    if (!cmd?.prefixExecute) return;
    try { await cmd.prefixExecute(message, args, client); }
    catch (err) { console.error('[PREFIX CMD ERROR]', err); await message.reply('❌ Something went wrong.').catch(() => {}); }
});

client.on('error', err => console.error('[WS ERROR]', err.message));
process.on('unhandledRejection', err => console.error('[UNHANDLED]', err));

client.login(BOT_TOKEN);
