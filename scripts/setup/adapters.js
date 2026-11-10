// scripts/setup/adapters.js
// Real + demo connectors for the setup wizard. Both modes expose the same
// interface; the orchestrator calls `adapters.discord.connect()` etc. and
// never needs to know which one is active.
//
// Demo mode exists so the full UX can be walked end-to-end without a real
// Discord token, a real guild, or a real Supabase project. Mock data is
// structured like the real thing — list entries have the same fields,
// results have the same shape — so the wizard's logic runs identically.
//
// Demo mode never writes to .env either. It writes to data/demo-setup.env
// (gitignored) so the diff view still works.

const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..', '..');

// ---------- Demo fixture data ----------

const DEMO_GUILDS = [
    { id: '1124910714855886860', name: 'Pulchowk Events (Demo)', memberCount: 1905, ownerId: '1000000000000000000' },
    { id: '961199022847188993',  name: 'Ye Server ab Nhi raha (Demo)', memberCount: 26, ownerId: '1000000000000000000' }
];

const DEMO_CATEGORIES = [
    { id: '2000000000000000001', name: 'Events',     position: 1 },
    { id: '2000000000000000002', name: 'Bot Ops',    position: 2 },
    { id: '2000000000000000003', name: 'Ambassador', position: 3 }
];

const DEMO_CHANNELS = [
    { id: '3000000000000000001', name: '⚽┃sports',              type: 'announcement', parentId: '2000000000000000001', parentName: 'Events', position: 1 },
    { id: '3000000000000000002', name: '💻┃software',            type: 'announcement', parentId: '2000000000000000001', parentName: 'Events', position: 2 },
    { id: '3000000000000000003', name: '💡┃hardware',            type: 'announcement', parentId: '2000000000000000001', parentName: 'Events', position: 3 },
    { id: '3000000000000000004', name: '🎮┃gaming',              type: 'announcement', parentId: '2000000000000000001', parentName: 'Events', position: 4 },
    { id: '3000000000000000005', name: '🎙️┃music',               type: 'announcement', parentId: '2000000000000000001', parentName: 'Events', position: 5 },
    { id: '3000000000000000006', name: '💵┃business',            type: 'announcement', parentId: '2000000000000000001', parentName: 'Events', position: 6 },
    { id: '3000000000000000007', name: '🎈┃miscellaneous',       type: 'announcement', parentId: '2000000000000000001', parentName: 'Events', position: 7 },
    { id: '3000000000000000008', name: '🎓┃scholarships',        type: 'announcement', parentId: '2000000000000000001', parentName: 'Events', position: 8 },
    { id: '3000000000000000009', name: '💼┃jobs-internships',    type: 'announcement', parentId: '2000000000000000001', parentName: 'Events', position: 9 },
    { id: '3000000000000000010', name: '⚽┃sports-test',          type: 'text',        parentId: '2000000000000000002', parentName: 'Bot Ops', position: 10 },
    { id: '3000000000000000011', name: '💻┃software-test',       type: 'text',        parentId: '2000000000000000002', parentName: 'Bot Ops', position: 11 },
    { id: '3000000000000000012', name: 'pe-bot-logs',            type: 'text',        parentId: '2000000000000000002', parentName: 'Bot Ops', position: 12 },
    { id: '3000000000000000013', name: 'pe-bot-audit',           type: 'text',        parentId: '2000000000000000002', parentName: 'Bot Ops', position: 13 },
    { id: '3000000000000000014', name: 'pe-bot-alerts',          type: 'text',        parentId: '2000000000000000002', parentName: 'Bot Ops', position: 14 },
    { id: '3000000000000000015', name: 'general',                type: 'text',        parentId: null,                   parentName: null,       position: 15 }
];

const DEMO_ROLES = [
    { id: '4000000000000000001', name: 'Senior Admin',         color: '#e74c3c', position: 10, managed: false },
    { id: '4000000000000000002', name: 'Admin',                color: '#3498db', position: 9,  managed: false },
    { id: '4000000000000000003', name: 'Management',           color: '#9b59b6', position: 8,  managed: false },
    { id: '4000000000000000004', name: 'Sports Ping',          color: '#00AE86', position: 7,  managed: false },
    { id: '4000000000000000005', name: 'Software Ping',        color: '#00AE86', position: 6,  managed: false },
    { id: '4000000000000000006', name: 'Hardware Ping',        color: '#00AE86', position: 5,  managed: false },
    { id: '4000000000000000007', name: 'Jobs Ping',            color: '#00AE86', position: 4,  managed: false },
    { id: '4000000000000000008', name: 'Scholarships Ping',    color: '#00AE86', position: 3,  managed: false },
    { id: '4000000000000000009', name: 'YAGPDB.xyz',           color: '#95a5a6', position: 2,  managed: true }
];

// ---------- Mock Discord connector ----------

function mockDiscord() {
    let nextIdCounter = 5000000000000000001;
    const nextId = () => String(nextIdCounter++);
    let connected = false;

    return {
        async connect(token) {
            // Validate the shape but accept any well-formed token.
            if (!token || token.split('.').length !== 3) {
                throw new Error('Mock Discord: token must be 3 dot-separated segments.');
            }
            connected = true;
            // Small delay so the spinner shows
            await new Promise((r) => setTimeout(r, 400));
            return { user: { tag: 'Pulchowk Events#DEMO', id: '5555555555555555555' } };
        },

        async disconnect() { connected = false; },

        listGuilds() { return DEMO_GUILDS.slice(); },

        async getGuild(id) {
            const g = DEMO_GUILDS.find((x) => x.id === id);
            if (!g) throw new Error(`Mock Discord: guild ${id} not found`);
            return g;
        },

        async listTextChannels(guildId) { return DEMO_CHANNELS.slice(); },

        async listCategories(guildId) { return DEMO_CATEGORIES.slice(); },

        async listRoles(guildId) { return DEMO_ROLES.slice(); },

        async checkPermissions(guildId) {
            return {
                canManageChannels: true,
                canManageRoles: true,
                canManageGuild: true,
                isAdmin: true,
                readyToCreate: true,
                memberTag: 'Pulchowk Events#DEMO',
                memberId: '5555555555555555555'
            };
        },

        async ensureCategory(guildId, name, { dryRun = false } = {}) {
            const found = DEMO_CATEGORIES.find((c) => c.name.toLowerCase() === name.toLowerCase());
            if (found) return { ok: true, category: { id: found.id, name: found.name }, created: false };
            if (dryRun) return { ok: true, category: { id: '(new)', name }, created: false, wouldCreate: true };
            const id = nextId();
            DEMO_CATEGORIES.push({ id, name, position: DEMO_CATEGORIES.length + 1 });
            return { ok: true, category: { id, name }, created: true };
        },

        async ensureTextChannel(guildId, name, { parentId = null, dryRun = false } = {}) {
            const found = DEMO_CHANNELS.find((c) => c.name.toLowerCase() === name.toLowerCase() && c.parentId === parentId);
            if (found) return { ok: true, channel: { id: found.id, name: found.name, parentId: found.parentId }, created: false };
            if (dryRun) return { ok: true, channel: { id: '(new)', name, parentId }, created: false, wouldCreate: true };
            const id = nextId();
            const parent = DEMO_CATEGORIES.find((c) => c.id === parentId);
            DEMO_CHANNELS.push({ id, name, type: 'text', parentId, parentName: parent ? parent.name : null, position: DEMO_CHANNELS.length + 1 });
            return { ok: true, channel: { id, name, parentId }, created: true };
        },

        async ensureRole(guildId, name, { color = null, dryRun = false } = {}) {
            const found = DEMO_ROLES.find((r) => r.name.toLowerCase() === name.toLowerCase());
            if (found) return { ok: true, role: { id: found.id, name: found.name }, created: false };
            if (dryRun) return { ok: true, role: { id: '(new)', name }, created: false, wouldCreate: true };
            const id = nextId();
            DEMO_ROLES.push({ id, name, color: color ? '#' + color.toString(16).padStart(6, '0') : '#99aab5', position: 1, managed: false });
            return { ok: true, role: { id, name }, created: true };
        }
    };
}

// ---------- Mock Supabase connector ----------

function mockSupabase() {
    return {
        async testConnection(url, key, tableNames = ['events']) {
            // Accept anything that looks structurally correct.
            if (!url || !key) return { ok: false, error: 'Missing URL or key', tables: {} };
            await new Promise((r) => setTimeout(r, 300));
            const tables = {};
            for (const name of tableNames) {
                // Demo mode: some tables "exist", some "missing", to exercise
                // the SQL-paste branch.
                if (name === 'scholarships') {
                    tables[name] = { exists: false, error: 'missing', message: 'relation "scholarships" does not exist (DEMO)' };
                } else {
                    tables[name] = { exists: true };
                }
            }
            const allExist = Object.values(tables).every((t) => t.exists);
            return { ok: allExist, tables };
        },

        getSqlEditorUrl(url) {
            try {
                const u = new URL(url);
                const ref = u.hostname.split('.')[0];
                return `https://supabase.com/dashboard/project/${ref}/sql/new`;
            } catch (e) { return null; }
        },

        getCreateTableSql(name) {
            // Re-export from real module — no side effects.
            return require('./supabase').getCreateTableSql(name);
        }
    };
}

// ---------- Adapter factories ----------

function realAdapters() {
    const discordReal = require('./discord');
    const discordCreate = require('./discord-create');
    const supabaseReal = require('./supabase');
    const { EnvFile } = require('./env-writer');

    return {
        mode: 'real',
        discord: {
            connect: discordReal.connect,
            disconnect: discordReal.disconnect,
            listGuilds: discordReal.listGuilds,
            getGuild: discordReal.getGuild,
            listTextChannels: async (guildId) => discordReal.listTextChannels(await discordReal.getGuild(global.__setupClient, guildId)),
            listCategories: async (guildId) => discordReal.listCategories(await discordReal.getGuild(global.__setupClient, guildId)),
            listRoles: async (guildId) => discordReal.listRoles(await discordReal.getGuild(global.__setupClient, guildId)),
            checkPermissions: async (guildId) => discordReal.checkPermissions(await discordReal.getGuild(global.__setupClient, guildId)),
            ensureCategory: async (guildId, name, opts) => discordCreate.ensureCategory(await discordReal.getGuild(global.__setupClient, guildId), name, opts),
            ensureTextChannel: async (guildId, name, opts) => discordCreate.ensureTextChannel(await discordReal.getGuild(global.__setupClient, guildId), name, opts),
            ensureRole: async (guildId, name, opts) => discordCreate.ensureRole(await discordReal.getGuild(global.__setupClient, guildId), name, opts),
            channelLabel: discordReal.channelLabel,
            roleLabel: discordReal.roleLabel,
            _setClient: (c) => { global.__setupClient = c; }
        },
        supabase: supabaseReal,
        envPath: path.join(REPO, '.env'),
        envWriter: EnvFile,
        canBootTest: true
    };
}

function demoAdapters() {
    const discordMock = mockDiscord();
    const supabaseMock = mockSupabase();
    const { EnvFile } = require('./env-writer');

    return {
        mode: 'demo',
        discord: {
            connect: discordMock.connect,
            disconnect: discordMock.disconnect,
            listGuilds: discordMock.listGuilds,
            getGuild: discordMock.getGuild,
            listTextChannels: discordMock.listTextChannels,
            listCategories: discordMock.listCategories,
            listRoles: discordMock.listRoles,
            checkPermissions: discordMock.checkPermissions,
            ensureCategory: discordMock.ensureCategory,
            ensureTextChannel: discordMock.ensureTextChannel,
            ensureRole: discordMock.ensureRole,
            channelLabel: (c) => `${c.parentName ? c.parentName + ' / ' : ''}#${c.name}  (${c.id})`,
            roleLabel: (r) => `@${r.name}  (${c_id(r)})`,
            _setClient: () => {}   // no-op
        },
        supabase: supabaseMock,
        envPath: path.join(REPO, 'data', 'demo-setup.env'),
        envWriter: EnvFile,
        canBootTest: false
    };
}

function c_id(r) { return r.id; }

function getAdapters({ demo = false } = {}) {
    return demo ? demoAdapters() : realAdapters();
}

module.exports = { getAdapters, realAdapters, demoAdapters };
