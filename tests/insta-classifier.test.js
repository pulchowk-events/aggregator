'use strict';
// tests/insta-classifier.test.js
// Ground truth: 12 captions from locus_ioe. Scrubbed: phones -> #PHONE, handles -> @USER, participant names -> NAME.
// Emoji are built with String.fromCodePoint so this file stays ASCII-only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { classifyPost, THRESHOLD } = require('../src/scrapers/lib/insta-classifier');

const U = (...cps) => String.fromCodePoint(...cps);
const BULB = U(0x1F4A1, 0x2728);
const LINK = U(0x1F517);
const LAPTOP = U(0x1F4BB);
const GEAR = U(0x2699, 0xFE0F);
const TROPHY = U(0x1F3C6);
const PLUG = U(0x1F50C);
const GLOBE = U(0x1F310);
const PEOPLE = U(0x1F465);
const PERSON = U(0x1F464);
const PIN = U(0x1F4CD);
const TICKET = U(0x1F39F, 0xFE0F);
const GRAD = U(0x1F393);
const PHONE_E = U(0x1F4F2);
const FIRE = U(0x1F525);
const TARGET = U(0x1F3AF);
const CAKE = U(0x1F382);
const HEART = U(0x1F49C);
const SPARK = U(0x2728);

// og:description wrapper exactly as captured
const cap = (stats, date, body) => stats + ' - locus_ioe on ' + date + ': "' + body + '". ';

const F1 = cap('37 likes, 2 comments', 'October 18, 2026', [
    'Online Project Exhibition | LOCUS',
    'Build it. Film it. Showcase it.',
    '',
    'Got a project ready to showcase? ' + BULB,
    'Turn your ideas into something that gets recognised!',
    '',
    'The LOCUS 2027 Online Project Exhibition invites students to showcase their innovative projects across Software & Hardware/ Electronics/ IoT.',
    '',
    LINK + ' Register Now : bit.ly/Online_Project_Expo',
    '',
    LAPTOP + ' SOFTWARE',
    'Web & Mobile Apps | AI/ML | Games',
    'Tools & Utilities | Creative Tech | and more',
    '',
    GEAR + ' HARDWARE / ELECTRONICS / IoT',
    'Embedded System | Robotics | IoT Solution',
    'Prototypes | Smart Devices | and more',
    '',
    TICKET + ' FREE REGISTRATION',
    TROPHY + ' Rs 15,000 PRIZE POOL',
    GRAD + ' School, +2, Bachelor-level students, Anyone Interested ',
    PEOPLE + ' Teams of 1\u20134 members',
    '',
    'Whether it\u2019s an app, an AI solution, a robotic system, an IoT prototype, or your next big idea - this is your chance to put your project in the spotlight! ' + FIRE,
    '',
    PHONE_E + ' For More Information:',
    '@USER : #PHONE',
    '@USER : #PHONE',
    '',
    '[#LOCUS2027 #OnlineProjectExhibition #LOCUS #23rdNationalTechnologicalFestival #ProjectExhibition StudentProjects Technology Innovation Engineering Software Hardware IoT Robotics AI MachineLearning CreativeTech Nepal ]'
].join('\n'));

const F2 = cap('23 likes, 0 comments', 'October 24, 2026', [
    'Online Project Exhibition | LOCUS is LIVE!',
    'Showcase your tech project, get recognized & win prize ! ' + TROPHY,
    LAPTOP + ' Software',
    ' ' + GEAR + ' Hardware | ' + PLUG + ' Electronics | ' + GLOBE + ' IOT',
    '',
    LINK + ' Register Now: bit.ly/Online_Project_Expo',
    '',
    '[Online Project Exhibition, LOCUS, Student Project Exhibition, Tech Project Competition, Engineering Projects, Software Projects, Hardware Projects, IoT Project',
    '#LOCUS2027 #OnlineProjectExhibition #TechProject #StudentInnovation #EngineeringProjects ]'
].join('\n'));

const F3 = cap('34 likes, 3 comments', 'October 27, 2026', [
    'ONLINE PROJECT EXHIBITION | LOCUS 2027 IS LIVE!',
    'Got a tech project? Put your innovation in the spotlight! ' + BULB,
    'Showcase your project, get recognized, connect with opportunities, and compete for exciting prizes! ' + TROPHY,
    LAPTOP + ' Software',
    GEAR + ' Hardware | ' + PLUG + ' Electronics | ' + GLOBE + ' IoT',
    TARGET + ' Build it. Film it. Showcase it.',
    LINK + ' Register Now: bit.ly/Online_Project_Expo',
    '',
    '[Online Project Exhibition, LOCUS 2027, Student Project Exhibition, Tech Project Competition, Engineering Projects, Software Projects, Hardware Projects, IoT Projects, Student Innovation',
    '#LOCUS2027 #OnlineProjectExhibition #TechProject #StudentInnovation #EngineeringProjects ]'
].join('\n'));

function spotlight(stats, date, name, team, who, people, college, catEmoji, category, tag, kind) {
    return cap(stats, date, [
        'Project Name: ' + name + ' | Team ID: ' + team,
        who + ' ' + people,
        PIN + ' ' + college,
        catEmoji + ' Category: ' + category,
        '',
        'Online Project Exhibition | LOCUS 2027',
        'Showcase your tech project, get recognized & compete for exciting prizes! ' + TROPHY,
        '',
        LAPTOP + ' Software | ' + GEAR + ' Hardware | ' + PLUG + ' Electronics | ' + GLOBE + ' IoT',
        '',
        LINK + ' Register Now: Link in Bio',
        '',
        '#LOCUS2027 #OnlineProjectExhibition #' + tag + ' #StudentInnovation #' + kind + 'Projects'
    ].join('\n'));
}

const F4 = spotlight('23 likes, 0 comments', 'November 21, 2026', 'CollegeBuddy', 19, PEOPLE, 'NAME, NAME', 'Purbanchal University, ACME Engineering College', LAPTOP, 'Software', 'SW19CollegeBuddy', 'Software');
const F5 = spotlight('124 likes, 30 comments', 'November 21, 2026', 'Manimater', 24, PERSON, 'NAME', 'IOE, Pulchowk Campus', LAPTOP, 'Software', 'SW24manimater', 'Software');
const F6 = spotlight('45 likes, 13 comments', 'November 20, 2026', 'Ashlya Academy - AI Powered eLearning Platform', 15, PERSON, 'NAME', 'Nepal College of Information Technology', LAPTOP, 'Software', 'SW15AshlyaAcademy', 'Software');
const F7 = spotlight('23 likes, 0 comments', 'November 19, 2026', 'Dhara: An AI-Powered PCOS Lifestyle Companion for Nepali Women', 9, PERSON, 'NAME', 'IOE, Pulchowk Campus', LAPTOP, 'Software', 'SW09Dhara', 'Software');
const F8 = cap('54 likes, 9 comments', 'November 18, 2026', [
    'Wishing our Project Manager, @USER , a very Happy Birthday! ' + CAKE + HEART,
    '',
    'May your leadership continue to inspire great teamwork and turn ideas into successful projects. Wishing you a year ahead filled with happiness, growth, and success! ' + SPARK,
    '',
    '#HappyBirthday #LOCUS2027 #TeamLOCUS'
].join('\n'));
const F9 = spotlight('10 likes, 0 comments', 'November 18, 2026', 'EtonNote', 18, PERSON, 'NAME', 'IOE, Purwanchal Campus', LAPTOP, 'Software', 'SW18EtonNote', 'Software');
const F10 = spotlight('118 likes, 4 comments', 'November 18, 2026', 'Hydration Dispenser', 3, PEOPLE, 'NAME, NAME', 'IOE, Advanced College of Engineering and Management', GEAR, 'Hardware/Electronics/IoT', 'HW03HydrationDispenser', 'Hardware');
const F11 = spotlight('155 likes, 18 comments', 'November 17, 2026', 'Suraksha360', 17, PERSON, 'NAME', 'Pokhara Engineering College', GEAR, 'Hardware/IoT/Electronics', 'HW17Suraksha360', 'Hardware');
const F12 = cap('210 likes, 20 comments', 'November 17, 2026', [
    'Project Name: LipiAI | Team ID: 8 ',
    PEOPLE + ' NAME, NAME, NAME ',
    PIN + ' Pulchowk Campus, Advanced College & Softwarica College ',
    LAPTOP + ' Category: Software',
    '',
    'Online Project Exhibition | LOCUS 2027 Showcase your tech project, get recognized & compete for exciting prizes! ' + TROPHY,
    '',
    LAPTOP + ' Software | ' + GEAR + ' Hardware | ' + PLUG + ' Electronics | ' + GLOBE + ' IoT ' + LINK + ' Register Now: Link in Bio',
    '',
    '#LOCUS2027 #OnlineProjectExhibition #SW08LipiAI #StudentInnovation #SoftwareProjects'
].join('\n'));

// [row, kind, code, is_event, caption]
const TRUTH = [
    [1, 'post', 'Deo1UA6hr7T', true, F1],
    [2, 'post', 'De4L-t8D9YI', true, F2],
    [3, 'reel', 'De_uDW1Bcni', true, F3],
    [4, 'reel', 'DgAX4jQoxQW', false, F4],
    [5, 'reel', 'DgASqwWonnT', false, F5],
    [6, 'reel', 'Df9lL_EvL-u', false, F6],
    [7, 'reel', 'Df7Ldb0Nj5t', false, F7],
    [8, 'post', 'Df6KP88uCQF', false, F8],
    [9, 'reel', 'Df4oxqQBakA', false, F9],
    [10, 'reel', 'Df4gENCtAW1', false, F10],
    [11, 'reel', 'Df2AwKcN5M1', false, F11],
    [12, 'reel', 'Df1v_zatGGF', false, F12]
];
const NOW = Date.UTC(2026, 10, 22);

// ---------------------------------------------------------------- ground truth

for (const row of TRUTH) {
    const n = row[0], kind = row[1], code = row[2], expected = row[3], caption = row[4];
    test('row ' + n + ' ' + kind + ' ' + code + ' -> is_event=' + expected, () => {
        const r = classifyPost({ code, kind, caption, isPinned: false });
        assert.strictEqual(r.is_event, expected, 'score=' + r.score + ' reasons=' + JSON.stringify(r.reasons));
        assert.strictEqual(r.score >= THRESHOLD, expected, 'score=' + r.score);
    });
}

test('scores are well separated around the threshold', () => {
    const scores = TRUTH.map((row) => ({ expected: row[3], score: classifyPost({ caption: row[4] }).score }));
    const minTrue = Math.min(...scores.filter((s) => s.expected).map((s) => s.score));
    const maxFalse = Math.max(...scores.filter((s) => !s.expected).map((s) => s.score));
    assert.ok(minTrue - maxFalse >= 0.4, 'minTrue=' + minTrue + ' maxFalse=' + maxFalse);
});

// ---------------------------------------------------------------- hints on real fixtures

test('hints: event posts (rows 1-3)', () => {
    for (const row of TRUTH.slice(0, 3)) {
        const h = classifyPost({ caption: row[4] }).hints;
        const tag = 'row ' + row[0] + ' hints=' + JSON.stringify(h);
        assert.match(h.title, /^Online Project Exhibition/i, tag);
        assert.strictEqual(h.type, 'exhibition', tag);
        assert.strictEqual(h.link, 'https://bit.ly/Online_Project_Expo', tag);
        assert.strictEqual(h.date, null, tag); // no event date in these captions; wrapper date and "2027" must not leak
        assert.strictEqual(h.deadline, null, tag);
        assert.strictEqual(h.location, null, tag);
    }
});

test('hints: non-event posts (all 9) have a first-line title and no date/link/location/type', () => {
    for (const row of TRUTH.filter((r) => !r[3])) {
        const h = classifyPost({ caption: row[4] }).hints;
        const tag = 'row ' + row[0] + ' hints=' + JSON.stringify(h);
        if (row[0] === 8) assert.match(h.title, /Happy Birthday/, tag);
        else assert.ok(h.title.startsWith('Project Name: '), tag);
        assert.strictEqual(h.link, null, tag); // "Link in Bio" is not a URL
        assert.strictEqual(h.date, null, tag);
        assert.strictEqual(h.deadline, null, tag);
        assert.strictEqual(h.location, null, tag); // the pin line is the participant's college, not a venue
        assert.strictEqual(h.type, null, tag);
    }
    assert.strictEqual(classifyPost({ caption: F5 }).hints.title, 'Project Name: Manimater | Team ID: 24');
});

// ---------------------------------------------------------------- synthetic

test('synthetic: no-signal caption is not an event', () => {
    const r = classifyPost({ caption: 'Just a quiet evening by the lake.' }, { nowMs: NOW });
    assert.strictEqual(r.is_event, false);
    assert.ok(r.score < THRESHOLD, 'score=' + r.score);
});

test('synthetic: thank-you / recap is not an event', () => {
    const caption = ['Thank you everyone who joined our Robotics Workshop yesterday!', 'It was a success. Glimpses from the day are in the next posts.'].join('\n');
    const r = classifyPost({ caption }, { nowMs: NOW });
    assert.strictEqual(r.is_event, false, 'score=' + r.score + ' reasons=' + JSON.stringify(r.reasons));
});

test('synthetic: hiring post is not an event', () => {
    const caption = ["We're hiring! Apply now for our Frontend Internship.", 'Send your CV to jobs@example.com'].join('\n');
    const r = classifyPost({ caption }, { nowMs: NOW });
    assert.strictEqual(r.is_event, false, 'score=' + r.score + ' reasons=' + JSON.stringify(r.reasons));
    assert.strictEqual(r.hints.link, null);
});

test('synthetic: throwback with a past date is not an event and gives no date', () => {
    const r = classifyPost({ caption: 'Throwback to our Hackathon on March 3, 2024! What a day.' }, { nowMs: NOW });
    assert.strictEqual(r.is_event, false, 'score=' + r.score + ' reasons=' + JSON.stringify(r.reasons));
    assert.strictEqual(r.hints.date, null);
});

test('synthetic: upcoming workshop gives date, deadline, venue, link and type', () => {
    const caption = [
        'Robotics Workshop 2026',
        'Join us for a hands-on Robotics Workshop on December 12 at Pulchowk Campus.',
        'Venue: Pulchowk Campus, Hall B',
        'Register: forms.gle/abc123XYZ',
        'Deadline: December 8',
        'For more information contact the club.'
    ].join('\n');
    const r = classifyPost({ caption }, { nowMs: NOW });
    const tag = JSON.stringify(r);
    assert.strictEqual(r.is_event, true, tag);
    assert.strictEqual(r.hints.date, '2026-12-12', tag);
    assert.strictEqual(r.hints.deadline, '2026-12-08', tag);
    assert.strictEqual(r.hints.location, 'Pulchowk Campus, Hall B', tag);
    assert.strictEqual(r.hints.link, 'https://forms.gle/abc123XYZ', tag);
    assert.strictEqual(r.hints.type, 'workshop', tag);
});

test('synthetic: a year-less date more than 14 days in the past rolls to next year', () => {
    const caption = 'Dashain Cultural Night on January 10 at the main hall.\nRegister at forms.gle/xyz';
    const r = classifyPost({ caption }, { nowMs: Date.UTC(2026, 11, 20) });
    assert.strictEqual(r.hints.date, '2027-01-10', JSON.stringify(r));
});

test('synthetic: bare year and month-year are not dates', () => {
    const r = classifyPost({ caption: 'LOCUS 2027 Expo in March 2027. Register now: forms.gle/abc' }, { nowMs: NOW });
    assert.strictEqual(r.hints.date, null, JSON.stringify(r));
});

test('synthetic: wrapper date is the reference time, never the event date', () => {
    const caption = '1 like, 0 comments - some.club on November 3, 2026: "Open Workshop on Friday. Register: forms.gle/a1b2".';
    const r = classifyPost({ caption });
    assert.strictEqual(r.hints.date, '2026-11-06', JSON.stringify(r)); // Friday after Tue Nov 3
});

test('post.text is accepted as a fallback for post.caption', () => {
    const a = classifyPost({ caption: F3 });
    const b = classifyPost({ text: F3 });
    assert.strictEqual(b.is_event, true);
    assert.deepStrictEqual(b.hints, a.hints);
});

test('empty / non-object input never throws and is not an event', () => {
    for (const input of [null, undefined, {}, { caption: '' }, { caption: 12345 }, '']) {
        const r = classifyPost(input);
        assert.strictEqual(r.is_event, false);
        assert.strictEqual(r.hints.title, null);
    }
});

test('sources are ASCII-only and the classifier has no dependencies', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'scrapers', 'lib', 'insta-classifier.js'), 'utf8');
    assert.ok(/^[\x00-\x7F]*$/.test(src), 'classifier source has non-ASCII characters');
    assert.ok(!/\brequire\s*\(/.test(src), 'classifier must not import anything');
    assert.ok(/^[\x00-\x7F]*$/.test(fs.readFileSync(__filename, 'utf8')), 'test source has non-ASCII characters');
});
