'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractFields, pickChips, _bsToAd } = require('../src/scrapers/lib/insta-fields');
const SP = require('../src/posting/socialPost');

const DAYMS = 86400000;
const NOW = Date.UTC(2026, 10, 22);
const T = Date.UTC(2026, 6, 20);
const ex = (c, o) => extractFields(c, Object.assign({ nowMs: NOW, takenAt: T }, o || {}));
const cp = (...n) => String.fromCodePoint(...n);
const NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const KEYS = ['date', 'endDate', 'time', 'deadline', 'location', 'price', 'registrationUrl', 'mode', 'organizer', 'audience', 'prize'];
const boldMath = (s) => Array.from(s).map((c) => (/[A-Z]/.test(c) ? cp(0x1D400 + c.charCodeAt(0) - 65) : /[a-z]/.test(c) ? cp(0x1D41A + c.charCodeAt(0) - 97) : /[0-9]/.test(c) ? cp(0x1D7CE + Number(c)) : c)).join('');
const tmpStore = () => SP.createPostsStore({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fld-')), 'posts.json') });
const mkBot = () => ({ cache: { pendingEvents: [], postedEvents: [], skippedEvents: [] }, saves: 0, saveCache() { this.saves++; }, sanitizeEventFields() {} });
const mkRec = (caption, extra) => Object.assign({ club: 'c', label: 'C', caption, hints: null, url: 'https://www.instagram.com/p/x/', image: null, postedAt: Date.UTC(2026, 7, 1), savedAt: Date.now(), bridged: false }, extra || {});

test('null / empty / non-string input never throws and returns all-null fields', () => {
    for (const v of [null, undefined, '', '   ', 42, {}, [], true]) {
        const r = extractFields(v);
        for (const k of KEYS) assert.equal(r[k], null, String(v) + ' -> ' + k);
        assert.ok(r.meta && Array.isArray(r.meta.tags));
    }
});

test('source files are ASCII-only', () => {
    for (const f of [path.join(__dirname, '..', 'src', 'scrapers', 'lib', 'insta-fields.js'), __filename]) {
        assert.equal(/[^\x00-\x7F]/.test(fs.readFileSync(f, 'utf8')), false, f);
    }
});

test('weekday fixes the year of a yearless date', () => {
    const r = ex('Workshop\nTuesday, 4th August\n4:00 PM onwards');
    assert.equal(r.date, '2026-08-04');
    assert.equal(r.time, '16:00');
    assert.equal(ex('Workshop\nTuesday, 4th August', { takenAt: Date.UTC(2025, 6, 20) }).date, '2026-08-04');
    const x = ex('Talk\nThursday, August 13, 2026');
    assert.equal(x.date, '2026-08-13');
    assert.equal(x.meta.weekdayMismatch, false);
});

test('ranges: same month, crossing years (explicit and yearless)', () => {
    const a = ex('Fellowship\nJuly 15-23, 2026');
    assert.equal(a.date, '2026-07-15'); assert.equal(a.endDate, '2026-07-23');
    const b = ex('ANAIS\n28 December 2026 - 7 January 2027');
    assert.equal(b.date, '2026-12-28'); assert.equal(b.endDate, '2027-01-07');
    const c = ex('ANAIS\n28 December - 7 January', { takenAt: Date.UTC(2026, 11, 1) });
    assert.equal(c.date, '2026-12-28'); assert.equal(c.endDate, '2027-01-07');
});

test('"Monday to Saturday" is a weekday range, not a date', () => {
    const r = ex('Camp\nMonday to Saturday');
    assert.equal(r.date, null);
});

test('non-contiguous BS days give first and last with a warning', () => {
    const r = ex('Event\nPoush 24,25,27,28', { takenAt: Date.UTC(2026, 10, 1) });
    assert.ok(r.date && r.date.startsWith('2027-01'), String(r.date));
    assert.ok(r.endDate > r.date);
    assert.equal(r.meta.nonContiguous, true);
    assert.ok(r.meta.warnings.some((w) => /non-contiguous/.test(w)));
});

test('BS weekday agreement: converted date agrees with the weekday in the caption', () => {
    for (const y of [2082, 2083, 2084]) {
        const ad = _bsToAd(y, 4, 25);
        assert.ok(ad, 'library must convert ' + y + ' Shrawan 25');
        const wd = NAMES[new Date(ad + 'T00:00:00Z').getUTCDay()];
        const taken = Date.parse(ad + 'T00:00:00Z') - 20 * DAYMS;
        const r = ex('Workshop\n25 - 30 Shrawan, ' + wd + ' to Saturday', { takenAt: taken });
        assert.equal(r.date, ad, 'BS->AD mismatch for ' + y + ' Shrawan 25 (' + wd + ')');
        assert.equal(r.meta.weekdayMismatch, false);
        assert.ok(r.endDate >= r.date);
    }
    const ad = _bsToAd(2083, 4, 25);
    const wrong = NAMES[(new Date(ad + 'T00:00:00Z').getUTCDay() + 2) % 7];
    const m = ex('Workshop\n25 Shrawan 2083, ' + wrong);
    assert.equal(m.date, ad);
    assert.equal(m.meta.weekdayMismatch, true);
});

test('BS invalid day or out-of-range year -> null date, named warning', () => {
    const a = ex('Workshop\n40 Shrawan 2083');
    assert.equal(a.date, null); assert.equal(a.meta.bsFailed, true);
    assert.ok(a.meta.warnings.some((w) => /BS date not converted/.test(w)));
    assert.equal(ex('Workshop\n5 Shrawan 2095').date, null);
    assert.equal(_bsToAd(2083, 5, 40), null);
});

test('deadline: new deadline wins, rolling is null, closes today resolves against the post day', () => {
    assert.equal(ex('Codejam\nDeadline: January 10, 2027\nNew Deadline: January 15, 2027 6:00 PM').deadline, '2027-01-15 18:00');
    const r = ex('Fellowship\nDeadline Rolling');
    assert.equal(r.deadline, null); assert.equal(r.meta.rolling, true);
    const t = ex('Fellowship\nCLOSES TODAY\nRegister: bit.ly/abc');
    assert.equal(t.deadline, '2026-07-20'); assert.equal(t.meta.lastCall, true);
    assert.equal(ex('Apply by: August 01, 2026 11:59PM NPT').deadline, '2026-08-01 23:59');
});

test('price: free vs paid vs per-unit vs prize-only', () => {
    assert.equal(ex('Workshop\nFREE REGISTRATION').price, 0);
    assert.equal(ex('Workshop\nDid we mention it\'s free ?').price, 0);
    assert.equal(ex('Workshop\nRegistration Fee: Rs.500').price, 500);
    assert.equal(ex('Workshop\nRs 200 commitment fee').price, 200);
    assert.equal(ex('Workshop\nRs. 150 only').price, 150);
    assert.equal(ex('Cup\nEntry Fee: 500 per squad').price, '500 per squad');
    const p = ex('Hackathon\nRs 15,000 PRIZE POOL');
    assert.equal(p.price, null);
    assert.equal(p.prize, 'Rs 15,000 prize pool');
    assert.equal(ex('Cup\n25K Prize Pool').prize, '25K prize pool');
    assert.equal(ex('Cup\nPrizes worth NPR 40,000+').prize, 'NPR 40,000+');
    assert.equal(ex('Cup\nSwag giveaways for all').prize, 'Gift giveaways');
});

test('TBA venue stays null; venue implies onsite; platform implies online', () => {
    const t = ex('Talk\nVenue: To be announced via email');
    assert.equal(t.location, null); assert.equal(t.mode, null);
    const v = ex('Talk\nVenue: D-Hall, Pulchowk Campus');
    assert.equal(v.location, 'D-Hall, Pulchowk Campus'); assert.equal(v.mode, 'onsite');
    const o = ex('Online Webinar\nvia Zoom');
    assert.equal(o.mode, 'online'); assert.equal(o.location, null);
});

test('emoji-only labels are read (date, clock, pin, money bag)', () => {
    const r = ex([cp(0x1F4C5) + ' 13 August 2026', cp(0x1F552) + ' 4:00 PM', cp(0x1F4CD) + ' D-Hall, Pulchowk Campus', cp(0x1F4B0) + ' Registration Fee: Rs.500'].join('\n'));
    assert.equal(r.date, '2026-08-13'); assert.equal(r.time, '16:00');
    assert.equal(r.location, 'D-Hall, Pulchowk Campus'); assert.equal(r.price, 500);
});

test('bold-math text is normalised (NFKC)', () => {
    const r = ex(boldMath('Venue') + ': D-Hall\n' + boldMath('August 13, 2026'));
    assert.equal(r.location, 'D-Hall'); assert.equal(r.date, '2026-08-13');
});

test('phone numbers are never a time or a price', () => {
    const r = ex('Workshop\nFor queries call 9867525552 or 9841000000');
    assert.equal(r.time, null); assert.equal(r.price, null); assert.equal(r.date, null);
});

test('time: start only, duration ignored, Nepal variant preferred when stated', () => {
    assert.equal(ex('Talk\n7:00 AM - 9:00 AM').time, '07:00');
    assert.equal(ex('Course\n[ 2 Hours/Day ]').time, null);
    assert.equal(ex('Talk\n00:00 UTC (5:45 AM Nepal Time)').time, '05:45 Nepal Time');
});

test('registration link: label on the previous line, denied syllabus link, no unlabeled unknown link', () => {
    const r = ex('Fellowship\nSyllabus: https://drive.google.com/x\nRegister NOW:\nhttps://bit.ly/SoftwareFellowship2027');
    assert.equal(r.registrationUrl, 'https://bit.ly/SoftwareFellowship2027');
    assert.equal(ex('Talk\nVisit https://example.com/about').registrationUrl, null);
});

test('organizer: organizers yes, sponsors no', () => {
    assert.equal(ex('Talk\norganized by IT Club').organizer, 'IT Club');
    assert.equal(ex('Talk\nIT Club x PDSC').organizer, 'IT Club x PDSC');
    assert.equal(ex('Talk\nsponsored by UXCam\nPowered by Logpoint').organizer, null);
});

test('pickChips: never filler, deadline first when close, prize only for competitions, Free only if explicit', () => {
    assert.deepEqual(pickChips({ date: '2026-08-13', meta: {} }, 'workshop', T).map((c) => c.key), ['date']);
    assert.deepEqual(pickChips({ meta: {} }, null, T), []);
    const close = pickChips({ date: '2026-08-20', deadline: '2026-07-22', location: 'Lab', price: 0, meta: {} }, 'workshop', T);
    assert.equal(close[0].key, 'deadline'); assert.equal(close.length, 3);
    assert.deepEqual(pickChips({ date: '2026-08-20', prize: 'Rs 5,000', meta: {} }, 'workshop', T).map((c) => c.key), ['date']);
    assert.deepEqual(pickChips({ date: '2026-08-20', prize: 'Rs 5,000', meta: {} }, 'hackathon', T).map((c) => c.key), ['date', 'prize']);
    assert.equal(pickChips({ date: '2026-08-20', price: null, meta: {} }, null, T).some((c) => c.key === 'price'), false);
    assert.equal(pickChips({ price: 0, meta: {} }, null, T)[0].value, 'Free');
    assert.equal(pickChips({ mode: 'online', meta: {} }, null, T)[0].value, 'Online');
    const last = pickChips({ date: '2026-09-30', deadline: '2026-07-20', meta: { lastCall: true } }, null, T);
    assert.equal(last[0].key, 'deadline');
});

test('buildEventFromPost: expo caption gets register link, Free, prize, online, fewer warnings, non-filler chips', () => {
    const cap = 'Online Project Exhibition | LOCUS is LIVE\nShowcase your tech project and win prizes\nRs 15,000 PRIZE POOL\nDid we mention it\'s free ?\nRegister Now : bit.ly/Online_Project_Expo';
    const ev = SP.buildEventFromPost(mkRec(cap, { club: 'locus_ioe' }), 'e1');
    assert.equal(ev.registrationUrl, 'https://bit.ly/Online_Project_Expo');
    assert.equal(ev.price, 'Free');
    assert.equal(ev.attendanceMode, 'Online');
    assert.equal(ev.fields.prize, 'Rs 15,000 prize pool');
    const w = (ev.dataQualityWarnings || []).join(' | ');
    assert.equal(/no location/.test(w), false);
    assert.ok(ev.fields.chips.length <= 3);
    ev.fields.chips.forEach((c) => assert.ok(c.value && c.label));
});

test('hints win over extractFields', () => {
    const ev = SP.buildEventFromPost(mkRec('Workshop\nAugust 13, 2026\nVenue: Lab 2', { hints: { title: 'W', date: '2026-09-01', location: 'Hall A', link: 'https://forms.gle/x' } }), 'h1');
    assert.equal(ev.date, '2026-09-01'); assert.equal(ev.location, 'Hall A'); assert.equal(ev.registrationUrl, 'https://forms.gle/x');
});

test('filters tag, never drop: recruitment and stale are tagged and still built', () => {
    const r = SP.buildEventFromPost(mkRec('Call for Marketing Team\nDeadline: 25 August, 2026'), 'r1');
    assert.ok(r.title); assert.ok(r.fields.tags.includes('recruitment'));
    assert.ok(r.dataQualityWarnings.some((w) => /recruitment/.test(w)));
    const s = SP.buildEventFromPost(mkRec('Workshop on July 3, 2026'), 's1');
    assert.ok(s.fields.tags.includes('stale')); assert.equal(s.date, '2026-07-03');
    const none = SP.buildEventFromPost(mkRec('Join us for a great session soon'), 'n1');
    assert.ok(none.dataQualityWarnings.some((w) => /no date, deadline or registration link/.test(w)));
});

test('link dedup: same registration link updates ONLY the deadline of the pending instagram item', () => {
    const store = tmpStore();
    store.put('s2', mkRec('Hackathon 2026\nLAST CALL - registrations close tonight\nRegister: bit.ly/abc'));
    const bot = mkBot();
    const existing = { id: 'ig_s1', source: 'instagram-c', title: 'Hackathon 2026', registrationUrl: 'https://bit.ly/abc/', deadline: '2026-07-20', date: '2026-08-10', location: 'Lab 2' };
    bot.cache.pendingEvents.push(Object.assign({}, existing));
    assert.equal(SP.queueItem(bot, { shortcode: 's2' }, store), 'dup');
    assert.equal(bot.cache.pendingEvents.length, 1);
    const hit = bot.cache.pendingEvents[0];
    assert.equal(hit.deadline, '2026-08-01');
    for (const k of ['id', 'source', 'title', 'registrationUrl', 'date', 'location']) assert.equal(hit[k], existing[k], k);
    // an item from another source with the same link is not a duplicate
    const store2 = tmpStore();
    store2.put('s3', mkRec('Hackathon 2026\nRegister: bit.ly/abc'));
    const bot2 = mkBot();
    bot2.cache.pendingEvents.push({ id: 'x1', source: 'nepvents', registrationUrl: 'https://bit.ly/abc' });
    assert.equal(SP.queueItem(bot2, { shortcode: 's3' }, store2), 'queued');
    assert.equal(bot2.cache.pendingEvents.length, 2);
});

// ---- ground truth (tests/fixtures/insta-fields.truth.json, installed by script 2 of 2)
const TRUTH = path.join(__dirname, 'fixtures', 'insta-fields.truth.json');
if (fs.existsSync(TRUTH)) {
    const rows = JSON.parse(fs.readFileSync(TRUTH, 'utf8'));
    rows.forEach((row) => test('truth: ' + row.id, () => {
        const r = extractFields(row.caption, { nowMs: row.nowMs, takenAt: row.takenAt || null });
        const keys = row.ambiguous ? (row.certain || []) : Object.keys(row.expect || {});
        for (const k of keys) assert.deepEqual(r[k], row.expect[k], row.id + ': ' + k);
        if (row.libraryDerived) {
            const post = new Date(row.takenAt || row.nowMs).toISOString().slice(0, 10);
            assert.match(r.date || '', /^\d{4}-\d{2}-\d{2}$/, row.id + ': date');
            const span = Math.abs(Date.parse(r.date) - Date.parse(post)) / DAYMS;
            assert.ok(span <= 366, row.id + ': date more than a year from the post date: ' + r.date);
            if (r.endDate) assert.ok(r.endDate >= r.date, row.id + ': endDate before date');
        }
        if (!row.expectMismatch) assert.equal(r.meta.weekdayMismatch, false, row.id + ': converted date disagrees with the weekday in the caption');
    }));
} else {
    test('truth fixture not installed yet (script 2 of 2)', { skip: true }, () => {});
}

// ---- truth rows with substring assertions (installed by script 2 of 2)
if (fs.existsSync(TRUTH)) {
    JSON.parse(fs.readFileSync(TRUTH, 'utf8')).filter((row) => row.contains).forEach((row) => test('truth-contains: ' + row.id, () => {
        const r = extractFields(row.caption, { nowMs: row.nowMs, takenAt: row.takenAt || null });
        Object.keys(row.contains).forEach((k) => assert.ok(String(r[k] == null ? '' : r[k]).toLowerCase().includes(String(row.contains[k]).toLowerCase()), row.id + ': ' + k + ' expected to contain ' + row.contains[k] + ', got ' + JSON.stringify(r[k])));
    }));
}

// ---- chips v2 (Instagram /pending): pick-3 order, register once, no-repeat strip, non-Instagram unchanged
const _dd = require('../src/scrapers/lib/insta-chip-dedupe');
const _bep = (typeof SP !== 'undefined' && SP && SP.buildEventFromPost) ? SP.buildEventFromPost : require('../src/posting/socialBridge').buildEventFromPost;
const _keys = (a) => a.map((c) => c.key);

test('pickChips v2: ranked pick of 3, date not mandatory, nulls skipped, fewer than 3 is fine', () => {
    const all = { date: '2026-08-20', deadline: '2030-01-01', registrationUrl: 'https://bit.ly/x', location: 'Lab', prize: 'Rs 5,000', teamSize: 'Team of 3', audience: 'School, +2, Bachelor-level students', price: 0, college: 'Pulchowk Campus', organizer: 'IT Club', phone: '9800000000', meta: { lastCall: true } };
    assert.deepEqual(_keys(pickChips(all, 'hackathon', T)), ['deadline', 'register', 'date']);
    assert.deepEqual(_keys(pickChips(Object.assign({}, all, { deadline: null }), 'hackathon', T)), ['register', 'date', 'location']);
    assert.deepEqual(_keys(pickChips(Object.assign({}, all, { deadline: null, date: null }), 'hackathon', T)), ['register', 'location', 'prize']);
    assert.deepEqual(_keys(pickChips(Object.assign({}, all, { deadline: null, date: null, registrationUrl: null, location: null }), 'hackathon', T)), ['prize', 'teamSize', 'level']);
    assert.deepEqual(_keys(pickChips({ price: 0, college: 'Pulchowk Campus', organizer: 'IT Club', phone: '9800000000', meta: {} }, null, T)), ['price', 'college', 'organizer']);
    assert.deepEqual(_keys(pickChips({ phone: '9800000000', meta: {} }, null, T)), ['phone']);
    assert.deepEqual(_keys(pickChips({ time: '16:00', meta: {} }, null, T)), ['time']);
    assert.deepEqual(pickChips({ meta: {} }, null, T), []);
});

test('pickChips v2: register chip appears once; a college already in the location is not repeated', () => {
    const ch = pickChips({ registrationUrl: 'https://bit.ly/x', date: '2026-08-20', location: 'ICTC Building, IOE Pulchowk Campus', college: 'IOE Pulchowk Campus', meta: {} }, null, T);
    assert.equal(ch.filter((c) => c.key === 'register').length, 1);
    assert.equal(ch.some((c) => c.key === 'college'), false);
    assert.equal(ch.find((c) => c.key === 'register').value, 'https://bit.ly/x');
});

test('chip dedupe: lines whose payload is a chip value are stripped, other lines are kept', () => {
    const chips = [{ key: 'register', label: 'Register', value: 'https://bit.ly/X' }, { key: 'location', label: 'Location', value: 'Online' }, { key: 'phone', label: 'Phone', value: '9800000000' }, { key: 'teamSize', label: 'Team', value: 'Team of 3' }];
    const d = 'Join us\nRegister Now: bit.ly/X\nVenue: Online\nCall us: 98000-00000\nTeam of 3\nRegister at bit.ly/X before the seats run out for good\nBring a laptop';
    assert.equal(_dd.stripChipLines(d, chips), 'Join us\nRegister at bit.ly/X before the seats run out for good\nBring a laptop');
    assert.equal(_dd.stripChipLines('Venue: Online\nRegister: bit.ly/X', [{ key: 'register', label: 'Register', value: 'https://bit.ly/X' }]), 'Venue: Online');
    assert.equal(_dd.normUrl('https://www.bit.ly/X/?a=1'), 'bit.ly/x');
    assert.equal(_dd.normPhone('+977-9801234567'), '9801234567');
});

test('chip dedupe: non-instagram items render exactly as before; register link is shown once', () => {
    const ch = [{ key: 'register', label: 'Register', value: 'https://bit.ly/X' }];
    const other = { source: 'nepvents', description: 'Register: bit.ly/X', fields: { chips: ch } };
    assert.equal(_dd.igChipsOf(other), null);
    assert.equal(_dd.igDescription(other), 'Register: bit.ly/X');
    assert.equal(_dd.igDescription({ source: 'khalti' }), 'No description');
    const ig = { source: 'instagram-x', description: 'Hello\nRegister: bit.ly/X', fields: { chips: ch } };
    assert.equal(_dd.igDescription(ig), 'Hello');
    const fields = [{ name: 'Register', value: 'https://bit.ly/X' }, { name: 'Link', value: '[form](https://bit.ly/X)' }, { name: 'Date', value: 'TBD' }];
    _dd.dropUrlDupes(fields, ch);
    assert.deepEqual(fields.map((f) => f.name), ['Register', 'Date']);
});

test('chips v2 screenshot case: only location Online + register link gives 2 chips, link not repeated', () => {
    const rec = { club: 'locus_ioe', label: 'LOCUS', caption: 'Online Project Exhibition\n\nVenue: Online\n\nRegister Now: bit.ly/Online_Project_Expo\n\nJoin us and showcase your project.', postedAt: 1782345600000, hints: {}, image: null, url: null };
    const ev = _bep(rec, 'scChips1');
    assert.deepEqual(_keys(ev.fields.chips), ['register', 'location']);
    assert.equal(ev.fields.chips[0].value, 'https://bit.ly/Online_Project_Expo');
    assert.equal(ev.fields.chips[1].value, 'Online');
    const desc = _dd.igDescription(ev);
    assert.equal(/Online_Project_Expo/i.test(desc), false);
    assert.equal(/Venue/i.test(desc), false);
    assert.ok(/Join us/.test(desc));
    const fields = ev.fields.chips.map((c) => ({ name: c.label, value: c.value }));
    fields.push({ name: 'Link', value: 'https://bit.ly/Online_Project_Expo' });
    _dd.dropUrlDupes(fields, ev.fields.chips);
    assert.equal(fields.filter((f) => /Online_Project_Expo/i.test(f.value)).length, 1);
});
