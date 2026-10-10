// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CashAutoQuest — commands.js
//  Every slash command and prefix command in one file
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import {
    SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} from 'discord.js';

import {
    DiscordClient, runQuest, claimAllRewards, filterValidQuests,
    AQStore, startAutoQuestWatcher,
} from './engine.js';

const PREFIX = process.env.BOT_PREFIX ?? ',,';

// ─── UI helpers ───────────────────────────────────────────────────────────────
const C = {
    green:  0x57F287,
    red:    0xED4245,
    yellow: 0xFEE75C,
    blue:   0x5865F2,
    gray:   0x4F545C,
    cash:   0x2ECC71,
};

function embed(color, title, desc, fields = []) {
    const e = { color, title, description: desc, fields, timestamp: new Date().toISOString() };
    return { embeds: [e] };
}

function ephemeral(color, title, desc, fields = []) {
    return { ...embed(color, title, desc, fields), flags: MessageFlags.Ephemeral };
}

function taskBadge(taskType) {
    const map = {
        WATCH_VIDEO:           '🎬 Watch Video',
        WATCH_VIDEO_ON_MOBILE: '📱 Watch Video (Mobile)',
        PLAY_ON_DESKTOP:       '🎮 Play on Desktop',
        STREAM_ON_DESKTOP:     '📡 Stream (Manual)',
        PLAY_ACTIVITY:         '🎲 Activity (Manual)',
    };
    return map[taskType] ?? taskType;
}

function fmtTime(seconds) {
    if (seconds < 60)  return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
}

function sanitizeToken(raw) { return raw.replace(/\s+/g, '').replace(/^Bot\s+/i, ''); }

function isValidToken(t) {
    return /^[A-Za-z0-9_-]{24,30}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}$/.test(t);
}

// ─── /link ────────────────────────────────────────────────────────────────────
export const linkCmd = {
    data: new SlashCommandBuilder()
        .setName('link')
        .setDescription('Link your Discord account token to CashAutoQuest'),
    prefix: 'link',

    async execute(interaction, client) {
        const modal = new ModalBuilder()
            .setCustomId('caq_link_modal')
            .setTitle('Link Your Token');

        const input = new TextInputBuilder()
            .setCustomId('caq_token_input')
            .setLabel('Discord Token (Authorization header value)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Paste your token here...')
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
    },

    async prefixExecute(message, args, client) {
        const inlineToken = args.join('').trim();
        if (!inlineToken) {
            await message.reply(ephemeral(C.blue, '🔗 Link Your Token',
                `Send your token inline:\n\`\`\`${PREFIX}link YOUR_TOKEN\`\`\`\n> ⚠️ **Delete your message immediately after.** Your token grants full account access.`
            ));
            return;
        }

        try { await message.delete(); } catch {}

        const token = sanitizeToken(inlineToken);
        if (!isValidToken(token)) {
            await safeDM(client, message.author.id, ephemeral(C.red, '❌ Invalid Token', 'That doesn\'t look like a valid Discord token.'));
            return;
        }

        const api  = new DiscordClient(token);
        const user = await api.verifyToken();
        if (!user) {
            await safeDM(client, message.author.id, ephemeral(C.red, '❌ Token Rejected', 'Discord rejected this token. Re-copy the `Authorization` header exactly.'));
            return;
        }

        client.tokenStore.save(message.author.id, token);
        await safeDM(client, message.author.id, embed(C.green, '✅ Token Linked',
            `Linked as **${user.global_name ?? user.username}**.\n\nYou're ready. Use \`${PREFIX}quest\` or \`/quest\` to start.`
        ));
    },
};

// ─── /unlink ──────────────────────────────────────────────────────────────────
export const unlinkCmd = {
    data: new SlashCommandBuilder()
        .setName('unlink')
        .setDescription('Remove your linked token and disable autoquest'),
    prefix: 'unlink',

    async execute(interaction, client) {
        const removed = client.tokenStore.remove(interaction.user.id);
        AQStore.disable(interaction.user.id);
        await interaction.reply(ephemeral(
            removed ? C.yellow : C.gray,
            removed ? '🔓 Token Removed' : 'No Token Found',
            removed ? 'Your token and autoquest settings have been cleared.' : 'You have no linked token.',
        ));
    },

    async prefixExecute(message, _args, client) {
        const removed = client.tokenStore.remove(message.author.id);
        AQStore.disable(message.author.id);
        await message.reply(embed(
            removed ? C.yellow : C.gray,
            removed ? '🔓 Token Removed' : 'No Token Found',
            removed ? 'Your token and autoquest settings have been cleared.' : 'You have no linked token.',
        ));
    },
};

// ─── /quest ───────────────────────────────────────────────────────────────────
export const questCmd = {
    data: new SlashCommandBuilder()
        .setName('quest')
        .setDescription('View and complete your active Discord quests'),
    prefix: 'quest',

    async execute(interaction, client) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const result = await fetchQuestList(interaction.user.id, client);
        if (result.error) {
            await interaction.editReply(ephemeral(C.red, '❌ Error', result.error));
            return;
        }

        if (result.quests.length === 0) {
            await interaction.editReply(ephemeral(C.gray, '📭 No Quests', 'You have no active quests right now.'));
            return;
        }

        const menu = new StringSelectMenuBuilder()
            .setCustomId('caq_quest_select')
            .setPlaceholder('Pick a quest to complete...')
            .addOptions(result.quests.map(q => ({
                label:       (q.config?.messages?.quest_name ?? q.id).slice(0, 100),
                description: taskBadge(Object.keys(q.config?.task_config?.tasks ?? q.config?.task_config_v2?.tasks ?? {})[0] ?? ''),
                value:       q.id,
            })));

        const row  = new ActionRowBuilder().addComponents(menu);
        const list = result.quests.map((q, i) => {
            const tc     = q.config?.task_config ?? q.config?.task_config_v2;
            const tasks  = tc?.tasks ?? {};
            const tType  = Object.keys(tasks)[0] ?? 'Unknown';
            const target = tasks[tType]?.target ?? 0;
            const exp    = q.config?.expires_at ? `<t:${Math.floor(new Date(q.config.expires_at).getTime() / 1000)}:R>` : 'Unknown';
            return `**${i + 1}. ${q.config?.messages?.quest_name ?? q.id}**\n${taskBadge(tType)} · ${fmtTime(target)} needed · Expires ${exp}`;
        }).join('\n\n');

        await interaction.editReply({
            ...embed(C.cash, `🎮 Your Active Quests (${result.quests.length})`, list),
            components: [row],
            flags: MessageFlags.Ephemeral,
        });
    },

    async prefixExecute(message, _args, client) {
        const result = await fetchQuestList(message.author.id, client);
        if (result.error) { await message.reply(embed(C.red, '❌ Error', result.error)); return; }
        if (result.quests.length === 0) { await message.reply(embed(C.gray, '📭 No Quests', 'No active quests right now.')); return; }

        const list = result.quests.map((q, i) => {
            const tc    = q.config?.task_config ?? q.config?.task_config_v2;
            const tasks = tc?.tasks ?? {};
            const tType = Object.keys(tasks)[0] ?? 'Unknown';
            return `**${i + 1}.** ${q.config?.messages?.quest_name ?? q.id} — ${taskBadge(tType)}`;
        }).join('\n');

        await message.reply({
            ...embed(C.cash, `🎮 Active Quests (${result.quests.length})`, `${list}\n\nUse \`/quest\` (slash) to pick and run one interactively.`),
        });
    },
};

// ─── /questall ────────────────────────────────────────────────────────────────
export const questAllCmd = {
    data: new SlashCommandBuilder()
        .setName('questall')
        .setDescription('Auto-complete ALL active quests back to back'),
    prefix: 'questall',

    async execute(interaction, client) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await runAllQuests(interaction.user.id, client, async (update) => {
            await interaction.editReply(ephemeral(C.cash, '⚙️ Running Quests…', update)).catch(() => {});
        });
        await interaction.editReply(r);
    },

    async prefixExecute(message, _args, client) {
        const msg = await message.reply(embed(C.cash, '⚙️ Running All Quests…', 'Starting...'));
        const r   = await runAllQuests(message.author.id, client, async (update) => {
            await msg.edit(embed(C.cash, '⚙️ Running Quests…', update)).catch(() => {});
        });
        await msg.edit(r);
    },
};

// ─── /claim ───────────────────────────────────────────────────────────────────
export const claimCmd = {
    data: new SlashCommandBuilder()
        .setName('claim')
        .setDescription('Claim rewards for all completed quests'),
    prefix: 'claim',

    async execute(interaction, client) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await doClaim(interaction.user.id, client);
        await interaction.editReply(r);
    },

    async prefixExecute(message, _args, client) {
        await message.reply(await doClaim(message.author.id, client));
    },
};

// ─── /autoquest ───────────────────────────────────────────────────────────────
export const autoQuestCmd = {
    data: new SlashCommandBuilder()
        .setName('autoquest')
        .setDescription('Toggle automatic quest completion every 5 minutes'),
    prefix: 'autoquest',

    async execute(interaction, client) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await toggleAutoQuest(interaction.user.id, client);
        await interaction.editReply(r);
    },

    async prefixExecute(message, _args, client) {
        await message.reply(await toggleAutoQuest(message.author.id, client));
    },
};

// ─── /stats ───────────────────────────────────────────────────────────────────
export const statsCmd = {
    data: new SlashCommandBuilder()
        .setName('stats')
        .setDescription('View your personal quest stats and reward history'),
    prefix: 'stats',

    async execute(interaction, client) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await interaction.editReply(buildStats(interaction.user.id, interaction.user.username, client));
    },

    async prefixExecute(message, _args, client) {
        await message.reply(buildStats(message.author.id, message.author.username, client));
    },
};

// ─── /history ─────────────────────────────────────────────────────────────────
export const historyCmd = {
    data: new SlashCommandBuilder()
        .setName('history')
        .setDescription('View your last 10 completed quests'),
    prefix: 'history',

    async execute(interaction, client) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await interaction.editReply(buildHistory(interaction.user.id, client));
    },

    async prefixExecute(message, _args, client) {
        await message.reply(buildHistory(message.author.id, client));
    },
};

// ─── /leaderboard ─────────────────────────────────────────────────────────────
export const lbCmd = {
    data: new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Top 10 users by total quests completed'),
    prefix: 'lb',

    async execute(interaction, client) {
        await interaction.deferReply();
        await interaction.editReply(await buildLeaderboard(client));
    },

    async prefixExecute(message, _args, client) {
        await message.reply(await buildLeaderboard(client));
    },
};

// ─── /globalstats ─────────────────────────────────────────────────────────────
export const globalStatsCmd = {
    data: new SlashCommandBuilder()
        .setName('globalstats')
        .setDescription('Bot-wide stats: total quests, claims, and users'),
    prefix: 'globalstats',

    async execute(interaction, client) {
        await interaction.deferReply();
        await interaction.editReply(buildGlobalStats(client));
    },

    async prefixExecute(message, _args, client) {
        await message.reply(buildGlobalStats(client));
    },
};

// ─── /resetstats ──────────────────────────────────────────────────────────────
export const resetStatsCmd = {
    data: new SlashCommandBuilder()
        .setName('resetstats')
        .setDescription('Reset your personal stats back to zero'),
    prefix: 'resetstats',

    async execute(interaction, client) {
        client.statsStore.reset(interaction.user.id);
        await interaction.reply(ephemeral(C.yellow, '🔄 Stats Reset', 'Your personal stats have been cleared.'));
    },

    async prefixExecute(message, _args, client) {
        client.statsStore.reset(message.author.id);
        await message.reply(embed(C.yellow, '🔄 Stats Reset', 'Your personal stats have been cleared.'));
    },
};

// ─── /ping ────────────────────────────────────────────────────────────────────
export const pingCmd = {
    data: new SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),
    prefix: 'ping',

    async execute(interaction, client) {
        const sent = await interaction.reply({ ...ephemeral(C.blue, '🏓 Pinging...', ''), fetchReply: true });
        const latency = sent.createdTimestamp - interaction.createdTimestamp;
        await interaction.editReply(ephemeral(C.green, '🏓 Pong!', `**Roundtrip:** ${latency}ms\n**WS Heartbeat:** ${client.ws.ping}ms`));
    },

    async prefixExecute(message, _args, client) {
        const sent    = await message.reply(embed(C.blue, '🏓 Pinging...', ''));
        const latency = sent.createdTimestamp - message.createdTimestamp;
        await sent.edit(embed(C.green, '🏓 Pong!', `**Roundtrip:** ${latency}ms\n**WS Heartbeat:** ${client.ws.ping}ms`));
    },
};

// ─── /help ────────────────────────────────────────────────────────────────────
export const helpCmd = {
    data: new SlashCommandBuilder().setName('help').setDescription('All CashAutoQuest commands'),
    prefix: 'help',

    async execute(interaction, client) {
        await interaction.reply({ ...buildHelp(), flags: MessageFlags.Ephemeral });
    },

    async prefixExecute(message, _args, client) {
        await message.reply(buildHelp());
    },
};

// ─── Interaction handlers (modal + select) ────────────────────────────────────
export async function handleInteraction(interaction, client) {
    // Modal — token link
    if (interaction.isModalSubmit() && interaction.customId === 'caq_link_modal') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const raw   = interaction.fields.getTextInputValue('caq_token_input');
        const token = sanitizeToken(raw);

        if (!isValidToken(token)) {
            await interaction.editReply(ephemeral(C.red, '❌ Invalid Format', 'Paste the exact `Authorization` header value.'));
            return;
        }

        const api  = new DiscordClient(token);
        const user = await api.verifyToken();

        if (!user) {
            await interaction.editReply(ephemeral(C.red, '❌ Token Rejected', 'Discord rejected this token. Try again.'));
            return;
        }

        client.tokenStore.save(interaction.user.id, token);
        await interaction.editReply(ephemeral(C.green, '✅ Token Linked!',
            `Linked as **${user.global_name ?? user.username}**.\n\nUse \`/quest\` to view quests, \`/autoquest\` to enable auto-completion.`
        ));
        return;
    }

    // Select — pick a quest to run
    if (interaction.isStringSelectMenu() && interaction.customId === 'caq_quest_select') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const questId = interaction.values[0];

        const token = client.tokenStore.get(interaction.user.id);
        if (!token) {
            await interaction.editReply(ephemeral(C.red, '❌ No Token', 'Link your token first with `/link`.'));
            return;
        }

        const api = new DiscordClient(token);
        let raw;
        try {
            const data = await api.fetchQuests();
            raw = (data.quests ?? []).find(q => q.id === questId);
        } catch {
            await interaction.editReply(ephemeral(C.red, '❌ Fetch Failed', 'Could not fetch quests from Discord.'));
            return;
        }

        if (!raw) {
            await interaction.editReply(ephemeral(C.red, '❌ Quest Not Found', 'That quest wasn\'t found on your account.'));
            return;
        }

        const questName = raw.config?.messages?.quest_name ?? questId;
        await interaction.editReply(ephemeral(C.cash, `⚙️ Starting: ${questName}`, 'Quest engine firing up...'));

        const startedAt = Date.now();
        const result    = await runQuest(api, raw, async ({ pct, appName, taskType }) => {
            const bar = progressBar(pct);
            await interaction.editReply(ephemeral(C.cash, `⚙️ ${questName}`, `${bar} \`${pct}%\`\n**App:** ${appName}\n**Type:** ${taskBadge(taskType)}`)).catch(() => {});
        });

        if (result.success) {
            client.statsStore.recordCompletion(interaction.user.id, {
                questName,
                reward:       raw.config?.messages?.reward ?? 'Unknown',
                taskType:     result.taskType,
                secondsTaken: result.secondsTaken,
            });

            const { claimed, names } = await claimAllRewards(api).catch(() => ({ claimed: 0, names: [] }));
            if (claimed > 0) client.statsStore.recordClaim(interaction.user.id, claimed);

            const stat = client.statsStore.get(interaction.user.id);
            await interaction.editReply(ephemeral(C.green, `✅ Quest Complete!`, [
                `**${questName}** finished in ${fmtTime(result.secondsTaken)}.`,
                claimed > 0 ? `🎁 Claimed: ${names.join(', ')}` : '',
                ``,
                `📊 ${stat.completed} quests total · ${stat.sessionStreak}🔥 streak`,
            ].filter(Boolean).join('\n')));
        } else {
            client.statsStore.recordFailure(interaction.user.id, { questName, reason: result.reason });
            const reasons = {
                stream_manual:      'Stream quests require the Discord desktop app. Do it manually.',
                activity_manual:    'Activity quests can\'t be automated.',
                enroll_failed:      'Failed to enroll in quest. Your token may be expired.',
                heartbeat_failures: 'Too many heartbeat failures. Try again.',
                video_beat_failures:'Too many video progress failures. Try again.',
            };
            await interaction.editReply(ephemeral(C.red, '❌ Quest Failed', reasons[result.reason] ?? `Reason: ${result.reason}`));
        }
        return;
    }

    // Slash commands
    if (!interaction.isChatInputCommand()) return;
    const cmd = client.commands.get(interaction.commandName);
    if (!cmd) return;
    try { await cmd.execute(interaction, client); }
    catch (err) {
        console.error('[CMD ERROR]', err);
        const msg = { content: '❌ Something went wrong.', flags: MessageFlags.Ephemeral };
        if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
        else await interaction.reply(msg).catch(() => {});
    }
}

// ─── Shared logic ──────────────────────────────────────────────────────────────
async function fetchQuestList(userId, client) {
    const token = client.tokenStore.get(userId);
    if (!token) return { error: 'No linked token. Use `/link` first.' };

    const api = new DiscordClient(token);
    let raw;
    try { raw = await api.fetchQuests(); }
    catch { return { error: 'Failed to fetch quests from Discord. Your token may be expired.' }; }

    return { quests: filterValidQuests(raw.quests ?? []), api };
}

async function runAllQuests(userId, client, progressUpdate) {
    const result = await fetchQuestList(userId, client);
    if (result.error) return ephemeral(C.red, '❌ Error', result.error);
    if (result.quests.length === 0) return ephemeral(C.gray, '📭 No Quests', 'Nothing to complete right now.');

    const api     = result.api;
    const results = [];
    let totalSeconds = 0;

    for (let i = 0; i < result.quests.length; i++) {
        const q    = result.quests[i];
        const name = q.config?.messages?.quest_name ?? q.id;
        await progressUpdate(`Running **${name}** (${i + 1}/${result.quests.length})...`);

        const r = await runQuest(api, q, async ({ pct }) => {
            await progressUpdate(`**${name}** — ${progressBar(pct)} \`${pct}%\` (${i + 1}/${result.quests.length})`).catch(() => {});
        });

        results.push({ name, ...r });
        totalSeconds += r.secondsTaken ?? 0;

        if (r.success) {
            client.statsStore.recordCompletion(userId, {
                questName: name, reward: q.config?.messages?.reward ?? 'Unknown',
                taskType: r.taskType, secondsTaken: r.secondsTaken,
            });
        } else {
            client.statsStore.recordFailure(userId, { questName: name, reason: r.reason });
        }
    }

    const { claimed, names } = await claimAllRewards(api).catch(() => ({ claimed: 0, names: [] }));
    if (claimed > 0) client.statsStore.recordClaim(userId, claimed);

    const stat      = client.statsStore.get(userId);
    const succeeded = results.filter(r => r.success).length;
    const failed    = results.filter(r => !r.success && !['stream_manual','activity_manual'].includes(r.reason)).length;
    const skipped   = results.filter(r => ['stream_manual','activity_manual'].includes(r.reason)).length;

    const lines = results.map(r => {
        const icon = r.success ? '✅' : ['stream_manual','activity_manual'].includes(r.reason) ? '⏭️' : '❌';
        return `${icon} ${r.name}${r.success ? ` · ${fmtTime(r.secondsTaken)}` : ` · ${r.reason}`}`;
    }).join('\n');

    return {
        ...embed(succeeded > 0 ? C.green : C.red, `Quest Run Complete`, [
            lines,
            '',
            `**Results:** ${succeeded} done · ${failed} failed · ${skipped} skipped`,
            claimed > 0 ? `**Claimed:** ${names.join(', ')}` : '',
            `**Total time:** ${fmtTime(totalSeconds)}`,
            ``,
            `📊 ${stat.completed} lifetime · ${stat.sessionStreak}🔥 streak`,
        ].filter(Boolean).join('\n')),
        flags: MessageFlags.Ephemeral,
    };
}

async function doClaim(userId, client) {
    const token = client.tokenStore.get(userId);
    if (!token) return ephemeral(C.red, '❌ No Token', 'Link your token first with `/link`.');

    const api = new DiscordClient(token);
    let claimed, names;
    try { ({ claimed, names } = await claimAllRewards(api)); }
    catch { return ephemeral(C.red, '❌ Claim Failed', 'Could not reach Discord. Try again.'); }

    if (claimed === 0) return ephemeral(C.gray, '📭 Nothing to Claim', 'No completed quests with unclaimed rewards.');

    client.statsStore.recordClaim(userId, claimed);
    return ephemeral(C.green, `🎁 Claimed ${claimed} Reward${claimed > 1 ? 's' : ''}`, names.map(n => `✅ ${n}`).join('\n'));
}

async function toggleAutoQuest(userId, client) {
    const token = client.tokenStore.get(userId);
    if (!token) return ephemeral(C.red, '❌ No Token', 'Link your token first with `/link`.');

    const wasOn = AQStore.isEnabled(userId);
    if (wasOn) {
        AQStore.disable(userId);
        return ephemeral(C.yellow, '⏸️ AutoQuest Disabled', 'Automatic quest completion has been turned off.');
    } else {
        AQStore.enable(userId);
        return ephemeral(C.green, '▶️ AutoQuest Enabled', [
            'CashAutoQuest will now check for and complete new quests automatically every **5 minutes**.',
            '',
            'You\'ll get a DM when each quest finishes.',
            'Use `/autoquest` again to disable.',
        ].join('\n'));
    }
}

function buildStats(userId, username, client) {
    const s    = client.statsStore.get(userId);
    const last = s.lastCompletedAt ? `<t:${Math.floor(new Date(s.lastCompletedAt).getTime() / 1000)}:R>` : 'Never';
    const hrs  = (s.totalSecondsSpent / 3600).toFixed(1);

    const byType = Object.entries(s.byTaskType)
        .map(([t, n]) => `${taskBadge(t)}: **${n}**`)
        .join('\n') || 'None yet';

    const aq = AQStore.isEnabled(userId) ? '▶️ Enabled' : '⏸️ Disabled';

    return ephemeral(C.cash, `📊 ${username}'s Stats`, null, [
        { name: '✅ Completed',     value: `**${s.completed}**`,              inline: true },
        { name: '❌ Failed',        value: `**${s.failed}**`,                 inline: true },
        { name: '🎁 Claimed',       value: `**${s.claimed}**`,                inline: true },
        { name: '🔥 Streak',        value: `**${s.sessionStreak}** quests`,   inline: true },
        { name: '⏱️ Time Spent',    value: `**${hrs}h** total`,               inline: true },
        { name: '🤖 AutoQuest',     value: aq,                                inline: true },
        { name: '🕒 Last Completed',value: last,                              inline: false },
        { name: '📂 By Task Type',  value: byType,                            inline: false },
    ]);
}

function buildHistory(userId, client) {
    const s       = client.statsStore.get(userId);
    const history = s.rewardHistory.slice(-10).reverse();

    if (history.length === 0) {
        return ephemeral(C.gray, '📜 No History', 'You haven\'t completed any quests yet.');
    }

    const lines = history.map((h, i) => {
        const ts = Math.floor(new Date(h.completedAt).getTime() / 1000);
        return `**${i + 1}.** ${h.questName}\n${taskBadge(h.taskType)} · ${fmtTime(h.secondsTaken)} · <t:${ts}:R>`;
    }).join('\n\n');

    return ephemeral(C.cash, '📜 Last 10 Quests', lines);
}

async function buildLeaderboard(client) {
    const lb    = client.statsStore.leaderboard(10);
    if (lb.length === 0) return embed(C.gray, '🏆 Leaderboard', 'No data yet.');

    const medals = ['🥇','🥈','🥉'];
    const lines  = await Promise.all(lb.map(async (entry, i) => {
        let name = entry.userId;
        try {
            const u = await client.users.fetch(entry.userId);
            name = u.username ?? entry.userId;
        } catch {}
        const medal = medals[i] ?? `**${i + 1}.**`;
        return `${medal} **${name}** — ${entry.completed} quests · ${entry.streak}🔥`;
    }));

    return embed(C.cash, '🏆 Top Quest Completers', lines.join('\n'));
}

function buildGlobalStats(client) {
    const g   = client.statsStore.globalStats();
    const hrs = (g.totalSeconds / 3600).toFixed(1);
    return embed(C.cash, '🌐 CashAutoQuest — Global Stats', null, [
        { name: '👥 Users',         value: `**${g.userCount}**`,        inline: true },
        { name: '✅ Total Quests',  value: `**${g.totalQuests}**`,       inline: true },
        { name: '🎁 Total Claimed', value: `**${g.totalClaimed}**`,      inline: true },
        { name: '❌ Total Failed',  value: `**${g.totalFailed}**`,       inline: true },
        { name: '⏱️ Hours Spent',   value: `**${hrs}h** combined`,       inline: true },
        { name: '🤖 AutoQuest On',  value: `**${AQStore.count()}** users`, inline: true },
    ]);
}

function buildHelp() {
    return embed(C.cash, '💰 CashAutoQuest — Commands', null, [
        {
            name: '🔐 Account',
            value: '`/link` — Link your Discord token\n`/unlink` — Remove your token',
            inline: false,
        },
        {
            name: '🎮 Quests',
            value: '`/quest` — View & complete a quest\n`/questall` — Complete ALL quests\n`/claim` — Claim all rewards\n`/autoquest` — Toggle auto-completion',
            inline: false,
        },
        {
            name: '📊 Stats & Tracking',
            value: '`/stats` — Your personal stats\n`/history` — Last 10 completed quests\n`/leaderboard` — Top completers\n`/globalstats` — Bot-wide totals\n`/resetstats` — Reset your stats',
            inline: false,
        },
        {
            name: '🛠️ Utility',
            value: '`/ping` — Check latency\n`/help` — This menu',
            inline: false,
        },
        {
            name: 'Prefix',
            value: `All commands also work with \`${PREFIX}\` (e.g. \`${PREFIX}quest\`)`,
            inline: false,
        },
    ]);
}

// ─── Misc ──────────────────────────────────────────────────────────────────────
function progressBar(pct) {
    const filled = Math.round(pct / 10);
    return '▓'.repeat(filled) + '░'.repeat(10 - filled);
}

async function safeDM(client, userId, payload) {
    try {
        const user = await client.users.fetch(userId);
        const dm   = await user.createDM();
        await dm.send(payload);
    } catch {}
}

// ─── Export all commands for auto-loading ─────────────────────────────────────
export const ALL_COMMANDS = [
    linkCmd, unlinkCmd, questCmd, questAllCmd, claimCmd,
    autoQuestCmd, statsCmd, historyCmd, lbCmd, globalStatsCmd,
    resetStatsCmd, pingCmd, helpCmd,
];
