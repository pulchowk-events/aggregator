// scripts/test/verify.implausibility.test.js
// Item-plausibility gate: batch-generated failures, controls, threshold
// behaviour, decidePass integration. Fixtures use `salary` (real field).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { checkImplausibility, scanItems, decidePass } = require('../batch/verify');
const { getJunkTitleReason } = require('../../src/posting/gates');

const codes = (r) => (r ? Array.from(new Set(r.problems.map((p) => p.code))).sort() : []);
const warnCodes = (items) => scanItems(items).warnings.map((w) => w.code);

const TITLES = ['Backend Developer', 'Data Engineer', 'QA Engineer', 'Product Designer',
    'DevOps Engineer', 'Content Writer', 'ML Engineer', 'Support Engineer'];
const LOCS = ['Kathmandu', 'Lalitpur', 'Pokhara', 'Remote', 'Bhaktapur', 'Biratnagar', 'Butwal', 'Hetauda'];

function clean(i, over) {
    return Object.assign({
        title: TITLES[i % TITLES.length],
        company: 'Acme Pvt. Ltd.',
        location: LOCS[i % LOCS.length],
        salary: null,
        description: 'Role body number ' + i + ' covering duties, requirements and benefits for this position.',
        image: 'https://acme.test/img/' + i + '.png',
        url: 'https://acme.test/jobs/' + i
    }, over || {});
}

function okParsed(n, over) {
    const c = n + '/' + n;
    return Object.assign({
        verdict: 'ok', items: n, rawItems: n,
        coverage: { title: c, company: c, description: c, location: c, image: c, deadline: '0/' + n },
        siteAbsent: null, semantic: null, itemsFile: 'written'
    }, over || {});
}

// 1
test('junk gate is reachable and enabled with no settings', () => {
    assert.equal(
        getJunkTitleReason({ title: 'Sorry, there are no positions available at this time.', itemType: 'job' }),
        'empty_state'
    );
});

// 2
test('blacktech: footer description on 3/4 items', () => {
    const footer = 'Dream Big Build Bigger Succeed Together.\n\n\u00a9 2026 Black Tech (P) Ltd. All rights reserved.';
    const real = 'We are looking for a motivated and detail-oriented Frontend Developer Intern. '.repeat(9);
    const mk = (title, desc, n) => ({
        title, company: 'Black Tech Pvt. Ltd.', location: null, salary: null, salary_status: 'site_absent', description: desc,
        image: 'https://www.blacktech.com.np/favicon.ico',
        url: 'https://www.blacktech.com.np/career/' + n
    });
    const items = [
        mk('Backend Developer', footer, 'a'),
        mk('UI/UX Designer - Figma', footer, 'b'),
        mk('Frontend Developer [Intern]', real, 'c'),
        mk('Mid Level Flutter Developer', footer, 'd')
    ];
    const r = checkImplausibility(items);
    assert.ok(r, 'must fail');
    assert.ok(codes(r).includes('desc_is_footer'));
    assert.ok(codes(r).includes('desc_identical_majority'));
    assert.ok(warnCodes(items).includes('image_favicon'), 'favicon stays soft');
});

// 3
test('dev: prose salary and mid-sentence location', () => {
    const items = [{
        title: 'Programiz is hiring Programming Content Writer Interns!',
        company: 'Programiz',
        location: '. Friendly Environment. If you feel you have what it takes t',
        salary: 'Tutorials Search Try Programiz PRO Programiz is hiring Progr',
        description: 'Python online compiler JavaScript online compiler SQL online compiler Java online compiler HTML online compiler C online compiler C++ online compiler Programiz is hiring interns.',
        image: 'https://dev.programiz.com/sites/default/files/favicon.png',
        url: 'https://dev.programiz.com/careers/content-writer-intern'
    }];
    const r = checkImplausibility(items);
    assert.ok(r);
    assert.ok(codes(r).includes('price_prose'));
    assert.ok(codes(r).includes('location_starts_punct'));
});

// 4
test('technorio: empty-state titles plus majority "Learn more"', () => {
    const longLoc = '2nd Floor, Shankhamool Tower, Shankhamul, New Baneshwor, Kathmandu, Nepal';
    const items = [
        { title: 'Sorry, there are no positions available at this time.', company: 'Technorio Inc.', location: 'Kathmandu, Nepal', salary: null, description: '', image: null, url: 'https://technorio.com/career/apprenticeship' },
        { title: 'Sorry, there are no positions available at this time.', company: 'Technorio Inc.', location: 'Kathmandu, Nepal', salary: null, description: '', image: null, url: 'https://technorio.com/career/traineeship' }
    ];
    for (let i = 0; i < 6; i++) {
        items.push({
            title: 'Learn more', company: 'Technorio Inc.', location: longLoc, salary: null,
            description: 'Internship body ' + i + ' with enough distinct text to be a real description.',
            image: 'https://technorio.com/wp-content/uploads/2021/12/og-homepage-1024x538.jpg',
            url: 'https://technorio.com/career/internship/role-' + i + '/'
        });
    }
    const r = checkImplausibility(items);
    assert.ok(r);
    assert.ok(codes(r).includes('junk_title'));
    assert.ok(codes(r).includes('titles_duplicate_majority'));
});

// 5
test('yarsalabs: ALLCAPS category titles and "No Jobs" descriptions', () => {
    const mk = (title, desc) => ({
        title, company: 'Yarsa Labs', location: null, salary: null, description: desc,
        image: 'https://www.yarsalabs.com/assets/social/yarsa-labs-cover.jpg',
        url: 'https://www.yarsalabs.com/jobs/' + title.toLowerCase() + '/'
    });
    const r = checkImplausibility([
        mk('CONTENT', 'Content writing, technical documentation, translation and more... No Jobs'),
        mk('MANAGEMENT', 'People and products management, business development, HR management, etc. No Jobs'),
        mk('FINANCE', 'Financial planning, resource management, accounting, reporting, etc. No Jobs')
    ]);
    assert.ok(r);
    assert.ok(codes(r).includes('junk_title'));
    assert.ok(codes(r).includes('desc_is_footer'));
});

// 6
test('cloudtechservice: same role twice (distinct urls, so only duplicate_item)', () => {
    const base = {
        title: 'AI Enablement Lead', company: 'CloudTech Services',
        location: 'Chakupat-10, Lalitpur (Kathmandu Branch)', salary: null,
        image: 'https://cloudtechservice.com/udeeglup/2023/08/social-logo.png'
    };
    const r = checkImplausibility([
        Object.assign({}, base, { description: 'AI Enablement Lead Onsite- Full Time Chakupat, Lalitpur -10 Apply Now', url: 'https://cloudtechservice.com/career/ai-enablement-lead/' }),
        Object.assign({}, base, { description: 'AI Enablement Lead Onsite- Full Time Chakupat, Lalitpur -10', url: 'https://cloudtechservice.com/careers/' })
    ]);
    assert.ok(r);
    assert.deepEqual(codes(r), ['duplicate_item']);
});

// 7
test('control eminenceways: no hard rule (favicon is soft)', () => {
    const items = [{
        title: 'Business Development Associate', company: 'Eminence Ways Pvt. Ltd.',
        location: 'Kathmandu', salary: null,
        description: "We are seeking a motivated and result-oriented Business Associate to support the company's business development and client relationship activities.",
        image: 'https://eminenceways.com/images/favicon.ico', url: 'https://eminenceways.com/career'
    }];
    assert.equal(checkImplausibility(items), null);
    assert.ok(warnCodes(items).includes('image_favicon'));
});

// 8
test('control uxcam: no hard rule', () => {
    const items = [{
        title: 'Sales Development Representative - Outbound (LATAM Focus)', company: 'UXCam GmbH',
        location: 'Hybrid', salary: null,
        description: 'Why Choose UXCam: Category leader trusted by global brands, now doubling down on AI. Big impact, low bureaucracy, international team. '.repeat(10),
        image: 'https://assets.cdn.personio.de/rebrand/favicon.svg', url: 'https://uxcam.jobs.personio.de/job/2651822'
    }];
    assert.equal(checkImplausibility(items), null);
});

// 9
test('control ycotek: no hard rule', () => {
    const items = [{
        title: 'Senior Data & Analytics Engineer', company: 'Ycotek', location: null, salary: null,
        description: 'FULL TIME Posted: 1mo ago Apply before: December 3, 2026 APPLY NOW',
        image: 'https://raw.githubusercontent.com/pulchowk-events/aggregator/main/assets/placeholders/ycotek.png',
        url: 'https://ycotek.com/careers-at-yco/'
    }];
    assert.equal(checkImplausibility(items), null);
});

// 10
test('clean synthetic batch of 5 passes with no warnings', () => {
    const items = [0, 1, 2, 3, 4].map((i) => clean(i));
    assert.equal(checkImplausibility(items), null);
    assert.deepEqual(scanItems(items).warnings, []);
});

// 11
test('one junk title among 8 is below the systemic threshold (warning only)', () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => clean(i));
    items[3].title = 'Sorry, there are no positions available at this time.';
    assert.equal(checkImplausibility(items), null);
    const w = scanItems(items).warnings.find((x) => x.code === 'junk_title');
    assert.ok(w);
    assert.equal(w.count, 1);
    assert.equal(w.of, 8);
});

// 12
test('soft rules alone never fail (favicon + same location on every item)', () => {
    const items = [0, 1, 2].map((i) => clean(i, {
        location: 'Kathmandu', image: 'https://acme.test/favicon.ico'
    }));
    assert.equal(checkImplausibility(items), null);
    const w = warnCodes(items);
    assert.ok(w.includes('image_favicon'));
    assert.ok(w.includes('same_location_all'));
});

// 13
test('salary: truncated "rs," fails; "Negotiable" and a real range do not', () => {
    const bad = [0, 1, 2].map((i) => clean(i, { salary: 'rs,' }));
    assert.ok(codes(checkImplausibility(bad)).includes('price_truncated'));
    const good = [clean(0, { salary: 'Negotiable' }), clean(1, { salary: 'Rs. 30,000 - 50,000' }), clean(2)];
    assert.equal(checkImplausibility(good), null);
    const absent = [0, 1, 2].map((i) => clean(i, { salary: 'rs,', salary_status: 'site_absent' }));
    assert.equal(checkImplausibility(absent), null, 'knowingly-missing salary is not checked');
});

// 14
test('decidePass: bad items -> reason implausible_values with problems[]', () => {
    const footer = 'Dream Big Build Bigger Succeed Together.\n\n\u00a9 2026 Black Tech (P) Ltd. All rights reserved.';
    const mk = (title, desc, n) => ({
        title, company: 'Black Tech Pvt. Ltd.', location: null, salary: null, description: desc,
        image: 'https://www.blacktech.com.np/favicon.ico', url: 'https://www.blacktech.com.np/career/' + n
    });
    const items = [
        mk('Backend Developer', footer, 'a'),
        mk('UI/UX Designer - Figma', footer, 'b'),
        mk('Frontend Developer [Intern]', 'A genuine role body that is long enough to be a description. '.repeat(10), 'c'),
        mk('Mid Level Flutter Developer', footer, 'd')
    ];
    const parsed = okParsed(4, {
        coverage: { title: '4/4', company: '4/4', description: '4/4', location: '0/4', image: '4/4', deadline: '3/4' },
        siteAbsent: { title: 0, company: 0, description: 0, location: 4 }
    });
    const d = decidePass(parsed, { items });
    assert.equal(d.pass, false);
    assert.equal(d.reason, 'implausible_values');
    assert.ok(Array.isArray(d.problems) && d.problems.length > 0);
    assert.ok(d.problems.every((p) => p.code && typeof p.evidence === 'string'));
});

// 15
test('decidePass: clean items still pass as ok', () => {
    const items = [0, 1, 2, 3, 4].map((i) => clean(i));
    const d = decidePass(okParsed(5), { items });
    assert.equal(d.pass, true);
    assert.equal(d.reason, 'ok');
});

// 16
test('decidePass: no trusted items file -> passes with a visible skip note', () => {
    const d = decidePass(okParsed(2, { itemsFile: 'skipped' }), {});
    assert.equal(d.pass, true);
    assert.equal(d.reason, 'ok');
    assert.match(d.warn, /plausibility skipped/);
});
