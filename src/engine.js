// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CashAutoQuest — engine.js
//  All core logic: token store · API client · quest engine · stats · autoquest
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import crypto from 'node:crypto';
import fs     from 'node:fs';
import path   from 'node:path';

// ─── Constants ────────────────────────────────────────────────────────────────
const BASE   = 'https://discord.com/api/v10';
const UA     = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9215 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36';
const PROPS  = () => Buffer.from(JSON.stringify({
    os: 'Windows', browser: 'Discord Client', release_channel: 'stable',
    client_version: '1.0.9215', os_version: '10.0.19045', os_arch: 'x64',
    app_arch: 'x64', system_locale: 'en-US', has_client_mods: false,
    browser_user_agent: UA, browser_version: '37.6.0', os_sdk_version: '19045',
    client_build_number: 471091, native_build_number: 72186,
    client_event_source: null,
    client_heartbeat_session_id: crypto.randomUUID(),
    client_app_state: 'focused',
})).toString('base64');

const BLACKLISTED = new Set(['1412491570820812933']);
const ALGO        = 'aes-256-gcm';
const sleep       = ms => new Promise(r => setTimeout(r, ms));

// ─── File helpers ─────────────────────────────────────────────────────────────
const DATA_DIR    = path.join(process.cwd(), 'data');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
const STATS_FILE  = path.join(DATA_DIR, 'stats.json');
const AQ_FILE     = path.join(DATA_DIR, 'autoquest.json');

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    for (const f of [TOKENS_FILE, STATS_FILE, AQ_FILE]) {
        if (!fs.existsSync(f)) {
            const empty = f === AQ_FILE ? '[]' : '{}';
            fs.writeFileSync(f, empty);
        }
    }
}

function readJSON(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return fallback; }
}

function writeJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ─── TokenStore ──────────────────────────────────────────────────────────────
export class TokenStore {
    #key;

    constructor(botToken) {
        this.#key = crypto.createHash('sha256').update(botToken).digest();
        ensureDataDir();
    }

    #encrypt(text) {
        const iv     = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv(ALGO, this.#key, iv);
        const enc    = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
        const tag    = cipher.getAuthTag();
        return JSON.stringify({ iv: iv.toString('hex'), tag: tag.toString('hex'), data: enc.toString('hex') });
    }

    #decrypt(stored) {
        try {
            const { iv, tag, data } = JSON.parse(stored);
            const d = crypto.createDecipheriv(ALGO, this.#key, Buffer.from(iv, 'hex'));
            d.setAuthTag(Buffer.from(tag, 'hex'));
            return d.update(Buffer.from(data, 'hex')) + d.final('utf8');
        } catch { return null; }
    }

    save(userId, token) {
        const store = readJSON(TOKENS_FILE, {});
        store[userId] = this.#encrypt(token);
        writeJSON(TOKENS_FILE, store);
    }

    get(userId) {
        const store = readJSON(TOKENS_FILE, {});
        const raw   = store[userId];
        return raw ? this.#decrypt(raw) : null;
    }

    remove(userId) {
        const store = readJSON(TOKENS_FILE, {});
        if (!store[userId]) return false;
        delete store[userId];
        writeJSON(TOKENS_FILE, store);
        return true;
    }

    has(userId) { return !!readJSON(TOKENS_FILE, {})[userId]; }
    get size()  { return Object.keys(readJSON(TOKENS_FILE, {})).length; }
    listUserIds() { return Object.keys(readJSON(TOKENS_FILE, {})); }
}

// ─── Stats ───────────────────────────────────────────────────────────────────
// Per-user stat schema:
// {
//   completed: number,
//   failed: number,
//   claimed: number,
//   totalSecondsSpent: number,
//   rewardHistory: [{ questName, reward, completedAt, taskType, secondsTaken }],
//   sessionStreak: number,
//   lastCompletedAt: ISO string | null,
//   byTaskType: { WATCH_VIDEO: number, PLAY_ON_DESKTOP: number, ... }
// }

export class StatsStore {
    constructor() { ensureDataDir(); }

    #load()          { return readJSON(STATS_FILE, {}); }
    #save(data)      { writeJSON(STATS_FILE, data); }

    get(userId) {
        const all = this.#load();
        if (!all[userId]) all[userId] = this.#default();
        return all[userId];
    }

    #default() {
        return {
            completed: 0, failed: 0, claimed: 0,
            totalSecondsSpent: 0,
            rewardHistory: [],
            sessionStreak: 0,
            lastCompletedAt: null,
            byTaskType: {},
        };
    }

    recordCompletion(userId, { questName, reward, taskType, secondsTaken }) {
        const all  = this.#load();
        const stat = all[userId] ?? this.#default();

        stat.completed++;
        stat.totalSecondsSpent += secondsTaken ?? 0;
        stat.byTaskType[taskType] = (stat.byTaskType[taskType] ?? 0) + 1;

        // Streak — increment if last completion was within 48h
        const last = stat.lastCompletedAt ? new Date(stat.lastCompletedAt) : null;
        const now  = new Date();
        if (last && now - last < 48 * 60 * 60 * 1000) stat.sessionStreak++;
        else stat.sessionStreak = 1;

        stat.lastCompletedAt = now.toISOString();

        stat.rewardHistory.push({
            questName, reward: reward ?? 'Unknown',
            completedAt: now.toISOString(),
            taskType, secondsTaken: secondsTaken ?? 0,
        });

        // Cap history at 100 entries
        if (stat.rewardHistory.length > 100) {
            stat.rewardHistory = stat.rewardHistory.slice(-100);
        }

        all[userId] = stat;
        this.#save(all);
    }

    recordFailure(userId, { questName, reason }) {
        const all  = this.#load();
        const stat = all[userId] ?? this.#default();
        stat.failed++;
        all[userId] = stat;
        this.#save(all);
    }

    recordClaim(userId, count) {
        const all  = this.#load();
        const stat = all[userId] ?? this.#default();
        stat.claimed += count;
        all[userId] = stat;
        this.#save(all);
    }

    // Global leaderboard — top N by completions
    leaderboard(n = 10) {
        const all = this.#load();
        return Object.entries(all)
            .map(([userId, s]) => ({ userId, completed: s.completed, streak: s.sessionStreak }))
            .sort((a, b) => b.completed - a.completed)
            .slice(0, n);
    }

    // Global totals
    globalStats() {
        const all      = this.#load();
        const users    = Object.values(all);
        const total    = users.reduce((a, s) => a + s.completed, 0);
        const claimed  = users.reduce((a, s) => a + s.claimed, 0);
        const failed   = users.reduce((a, s) => a + s.failed, 0);
        const seconds  = users.reduce((a, s) => a + s.totalSecondsSpent, 0);
        return { totalQuests: total, totalClaimed: claimed, totalFailed: failed, totalSeconds: seconds, userCount: users.length };
    }

    reset(userId) {
        const all = this.#load();
        all[userId] = this.#default();
        this.#save(all);
    }
}

// ─── AutoQuest Store ──────────────────────────────────────────────────────────
export const AQStore = {
    load() { return readJSON(AQ_FILE, []); },
    enable(userId) {
        const d = this.load();
        if (d.includes(userId)) return false;
        d.push(userId); writeJSON(AQ_FILE, d); return true;
    },
    disable(userId) {
        const d = this.load();
        const i = d.indexOf(userId);
        if (i === -1) return false;
        d.splice(i, 1); writeJSON(AQ_FILE, d); return true;
    },
    isEnabled(userId)  { return this.load().includes(userId); },
    allUsers()         { return this.load(); },
    count()            { return this.load().length; },
};

// ─── Discord API Client ───────────────────────────────────────────────────────
export class DiscordClient {
    #token;

    constructor(userToken) { this.#token = userToken; }

    #headers() {
        return {
            'Authorization':      this.#token,
            'User-Agent':         UA,
            'Content-Type':       'application/json',
            'accept-language':    'en-US,en;q=0.9',
            'origin':             'https://discord.com',
            'referer':            'https://discord.com/channels/@me',
            'sec-ch-ua':          '"Not)A;Brand";v="8", "Chromium";v="138"',
            'sec-ch-ua-mobile':   '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest':     'empty',
            'sec-fetch-mode':     'cors',
            'sec-fetch-site':     'same-origin',
            'x-debug-options':    'bugReporterEnabled',
            'x-discord-locale':   'en-US',
            'x-discord-timezone': 'America/New_York',
            'x-super-properties': PROPS(),
        };
    }

    async #req(method, endpoint, body) {
        const url = `${BASE}${endpoint}`;
        for (let attempt = 0; attempt <= 4; attempt++) {
            let res;
            try {
                res = await fetch(url, {
                    method,
                    headers: this.#headers(),
                    body: body !== undefined ? JSON.stringify(body) : undefined,
                });
            } catch (err) {
                if (attempt < 4) { await sleep(2 ** attempt * 1000); continue; }
                throw new Error(`Network error on ${method} ${endpoint}: ${err.message}`);
            }

            if (res.status === 429) {
                const wait = Number(res.headers.get('retry-after') ?? 2) * 1000;
                await sleep(wait);
                continue;
            }
            if ([500, 502, 503, 504].includes(res.status) && attempt < 4) {
                await sleep(2 ** attempt * 1500); continue;
            }
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`${res.status} ${res.statusText} — ${text}`);
            }
            return res.json();
        }
        throw new Error(`Max retries exceeded: ${method} ${endpoint}`);
    }

    get(ep)        { return this.#req('GET', ep); }
    post(ep, body) { return this.#req('POST', ep, body); }

    fetchQuests()  { return this.get('/quests/@me'); }
    fetchUser()    { return this.get('/users/@me'); }

    async verifyToken() {
        try {
            const res = await fetch(`${BASE}/users/@me`, { headers: this.#headers() });
            if (!res.ok) return null;
            return res.json();
        } catch { return null; }
    }
}

// ─── Quest Engine ─────────────────────────────────────────────────────────────
// Returns: { success, taskType?, reason?, secondsTaken, timedOut? }

export async function runQuest(api, questRaw, progressCb = () => {}) {
    const startTime = Date.now();

    // ── Enroll ──────────────────────────────────────────────────────────────
    if (!questRaw.user_status?.enrolled_at) {
        try {
            const r = await api.post(`/quests/${questRaw.id}/enroll`, {
                location: 11, is_targeted: false, metadata_raw: null,
            });
            questRaw.user_status = r?.user_status ?? r;
        } catch (err) {
            return { success: false, reason: 'enroll_failed', secondsTaken: 0 };
        }
    }

    const tc = questRaw.config?.task_config ?? questRaw.config?.task_config_v2;
    if (!tc) return { success: false, reason: 'no_task_config', secondsTaken: 0 };

    const tasks    = tc.tasks ?? {};
    const TYPES    = ['WATCH_VIDEO','WATCH_VIDEO_ON_MOBILE','PLAY_ON_DESKTOP','STREAM_ON_DESKTOP','PLAY_ACTIVITY'];
    const taskName = TYPES.find(t => tasks[t] != null);
    if (!taskName) return { success: false, reason: 'unsupported_task', secondsTaken: 0 };

    const task       = tasks[taskName];
    const needed     = task.target;
    const eventName  = task.event_name ?? task.type ?? taskName;
    const appName    = questRaw.config?.application?.name ?? 'Unknown Game';

    function readDone(qs) {
        const prog = qs?.user_status?.progress;
        if (!prog) return 0;
        return Number(prog[eventName]?.value ?? prog[taskName]?.value ?? 0) || 0;
    }

    async function refreshStatus(questObj) {
        try {
            const fresh = await api.fetchQuests();
            const updated = fresh.quests?.find(q => q.id === questObj.id);
            if (updated?.user_status) questObj.user_status = updated.user_status;
        } catch {}
        return questObj;
    }

    // ── WATCH_VIDEO ──────────────────────────────────────────────────────────
    if (taskName === 'WATCH_VIDEO' || taskName === 'WATCH_VIDEO_ON_MOBILE') {
        const enrolledAt = questRaw.user_status?.enrolled_at
            ? new Date(questRaw.user_status.enrolled_at).getTime()
            : Date.now();

        let done = readDone(questRaw);
        let errors = 0;
        const SPEED = 7;

        while (done < needed) {
            const elapsed    = Math.floor((Date.now() - enrolledAt) / 1000);
            const maxAllowed = elapsed + 10;
            if (maxAllowed - done < SPEED) { await sleep(1000); continue; }

            try {
                const sendTs = Math.min(needed, done + SPEED + Math.random() * 0.4);
                const res    = await api.post(`/quests/${questRaw.id}/video-progress`, { timestamp: sendTs });
                done = Math.min(needed, done + SPEED);
                errors = 0;
                const pct = Math.min(100, Math.round((done / needed) * 100));
                progressCb({ pct, done, needed, taskType: taskName, appName });
                if (res?.completed_at || res?.user_status?.completed_at) break;
            } catch (err) {
                errors++;
                if (errors >= 8) return { success: false, reason: 'video_beat_failures', secondsTaken: Math.round((Date.now() - startTime) / 1000) };
                await sleep(3000);
            }
            await sleep(1000);
        }

        // Final seal
        try { await api.post(`/quests/${questRaw.id}/video-progress`, { timestamp: needed }); } catch {}
        progressCb({ pct: 100, done: needed, needed, taskType: taskName, appName });
        return { success: true, taskType: taskName, secondsTaken: Math.round((Date.now() - startTime) / 1000) };
    }

    // ── PLAY_ON_DESKTOP ──────────────────────────────────────────────────────
    if (taskName === 'PLAY_ON_DESKTOP') {
        const maxMs = (needed + 600) * 1000;
        let beats = 0, errors = 0;

        while (true) {
            if (Date.now() - startTime > maxMs) {
                try { await api.post(`/quests/${questRaw.id}/heartbeat`, { stream_key: null, terminal: true }); } catch {}
                return { success: true, taskType: taskName, timedOut: true, secondsTaken: Math.round((Date.now() - startTime) / 1000) };
            }

            try {
                const res = await api.post(`/quests/${questRaw.id}/heartbeat`, { stream_key: null, terminal: false });
                if (res?.user_status) questRaw.user_status = res.user_status;
                errors = 0;
            } catch {
                errors++;
                if (errors >= 5) return { success: false, reason: 'heartbeat_failures', secondsTaken: Math.round((Date.now() - startTime) / 1000) };
                await sleep(5000); continue;
            }

            beats++;
            if (beats % 5 === 0) await refreshStatus(questRaw);

            const done      = readDone(questRaw);
            const remaining = Math.max(0, needed - done);
            const pct       = Math.min(100, Math.round((done / needed) * 100));
            progressCb({ pct, done, needed, remaining, taskType: taskName, appName });

            if (done >= needed || questRaw.user_status?.completed_at) break;
            await sleep(30_000);
        }

        try { await api.post(`/quests/${questRaw.id}/heartbeat`, { stream_key: null, terminal: true }); } catch {}
        progressCb({ pct: 100, done: needed, needed, taskType: taskName, appName });
        return { success: true, taskType: taskName, secondsTaken: Math.round((Date.now() - startTime) / 1000) };
    }

    if (taskName === 'STREAM_ON_DESKTOP') return { success: false, reason: 'stream_manual', secondsTaken: 0 };
    if (taskName === 'PLAY_ACTIVITY')     return { success: false, reason: 'activity_manual', secondsTaken: 0 };

    return { success: false, reason: 'unknown', secondsTaken: 0 };
}

// ─── Claim rewards ────────────────────────────────────────────────────────────
export async function claimAllRewards(api) {
    const fresh = await api.fetchQuests();
    const quests = fresh.quests ?? [];
    let claimed = 0;
    const names = [];

    for (const q of quests) {
        const done      = !!q.user_status?.completed_at;
        const notClaimed = !q.user_status?.claimed_at;
        if (!done || !notClaimed) continue;
        try {
            await api.post(`/quests/${q.id}/claim-reward`);
            claimed++;
            names.push(q.config?.messages?.quest_name ?? q.id);
        } catch {}
    }
    return { claimed, names };
}

// ─── Filter helper ────────────────────────────────────────────────────────────
export function filterValidQuests(quests) {
    const now = new Date();
    return quests.filter(q => {
        if (BLACKLISTED.has(q.id)) return false;
        if (q.user_status?.completed_at) return false;
        if (new Date(q.config?.expires_at) < now) return false;
        return true;
    });
}

// ─── AutoQuest Watcher ────────────────────────────────────────────────────────
const _processed = new Set();
let   _watcher   = null;

export function startAutoQuestWatcher(tokenStore, statsStore, discordClient, intervalMs = 5 * 60_000) {
    if (_watcher) clearInterval(_watcher);

    const tick = async () => {
        const users = AQStore.allUsers();
        for (const userId of users) {
            const token = tokenStore.get(userId);
            if (!token) { AQStore.disable(userId); continue; }

            const api = new DiscordClient(token);

            let raw;
            try { raw = await api.fetchQuests(); } catch { continue; }

            const valid = filterValidQuests(raw.quests ?? []);
            for (const quest of valid) {
                const key = `${userId}:${quest.id}`;
                if (_processed.has(key)) continue;
                _processed.add(key);

                (async () => {
                    const result = await runQuest(api, quest);
                    if (result.success) {
                        statsStore.recordCompletion(userId, {
                            questName:    quest.config?.messages?.quest_name ?? quest.id,
                            reward:       quest.config?.messages?.reward ?? 'Unknown',
                            taskType:     result.taskType,
                            secondsTaken: result.secondsTaken,
                        });

                        // Auto-claim
                        const { claimed, names } = await claimAllRewards(api).catch(() => ({ claimed: 0, names: [] }));
                        if (claimed > 0) statsStore.recordClaim(userId, claimed);

                        // DM the user
                        try {
                            const user = await discordClient.users.fetch(userId);
                            const dm   = await user.createDM();
                            const stat = statsStore.get(userId);
                            const mins = Math.round(result.secondsTaken / 60);
                            await dm.send({
                                content: [
                                    `## ✅ CashAutoQuest — Quest Completed`,
                                    `**Quest:** ${quest.config?.messages?.quest_name ?? quest.id}`,
                                    `**Type:** \`${result.taskType}\``,
                                    `**Time:** ${mins}m`,
                                    claimed > 0 ? `**Claimed:** ${names.join(', ')}` : '',
                                    ``,
                                    `📊 **Your Stats** — ${stat.completed} completed · ${stat.sessionStreak}🔥 streak`,
                                ].filter(Boolean).join('\n'),
                            });
                        } catch {}

                    } else {
                        statsStore.recordFailure(userId, {
                            questName: quest.config?.messages?.quest_name ?? quest.id,
                            reason:    result.reason,
                        });

                        if (result.reason === 'enroll_failed') {
                            // Token may be dead — check
                            const verify = await api.verifyToken().catch(() => null);
                            if (!verify) {
                                tokenStore.remove(userId);
                                AQStore.disable(userId);
                                try {
                                    const user = await discordClient.users.fetch(userId);
                                    const dm   = await user.createDM();
                                    await dm.send({ content: `⚠️ **CashAutoQuest** — Your token expired and was removed. Use \`/link\` to re-link.` });
                                } catch {}
                            }
                        }
                    }
                })().catch(() => {});
            }
        }
    };

    _watcher = setInterval(tick, intervalMs);
    tick(); // run immediately on start
    return _watcher;
}
