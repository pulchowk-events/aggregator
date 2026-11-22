'use strict';
// Simulated block check. STOP THE BOT FIRST. Backs up schedule.json, drives the real scheduler
// with a fake blocked runner + fake clock + fake club "sim_club", prints ladder and alert, restores.
const fs = require('fs');
const path = require('path');
const SS = require('../src/posting/socialSchedule');

const file = SS.FILE;
const bak = file + '.sim-bak';
if (fs.existsSync(bak)) { console.error('Backup already exists, refusing to run: ' + bak); process.exit(1); }
const had = fs.existsSync(file);
if (had) fs.copyFileSync(file, bak);

async function main() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const store = SS.createScheduleStore({ file });
    let t = Date.now();
    let blocked = true;
    const bot = { sendLogMessage: async (m) => { console.log('ALERT -> ' + m); } };
    const sched = SS.createScheduler({
        store,
        runner: async (b, o) => ({ items: [], meta: { instagram: { perClub: { [o.only]: blocked ? { state: 'challenge' } : { state: 'ok' } } } } }),
        clock: () => t,
        env: {},
        listClubs: () => [{ username: 'sim_club', enabled: true }],
        log: () => {}
    });
    for (let i = 1; i <= 6; i++) {
        const before = t;
        await sched.tick(bot);
        const rec = store.read().data.sim_club;
        const mins = Math.round((Date.parse(rec.nextAttemptAt) - before) / 60000);
        console.log('block ' + i + ': consecutiveBlocks=' + rec.consecutiveBlocks + ' backoff=' + mins + ' min alerted=' + rec.alerted);
        t = Date.parse(rec.nextAttemptAt) + 1000;
    }
    blocked = false;
    await sched.tick(bot);
    const rec = store.read().data.sim_club;
    console.log('success: consecutiveBlocks=' + rec.consecutiveBlocks + ' alerted=' + rec.alerted + ' nextAttemptAt=' + rec.nextAttemptAt);
}

main().catch((e) => { console.error('sim failed: ' + e.message); process.exitCode = 1; })
    .finally(() => {
        if (had) { fs.copyFileSync(bak, file); fs.unlinkSync(bak); } else { try { fs.unlinkSync(file); } catch (e) { /* none */ } }
        console.log('restored schedule.json from backup' + (had ? '' : ' (there was none, file removed)'));
    });
