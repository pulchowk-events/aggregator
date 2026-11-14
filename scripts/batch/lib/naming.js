// scripts/batch/lib/naming.js
// Derive a slug-friendly source name from a URL. Pure function except for
// the collision check, which reads the on-disk source/extractor directories.
//
// Examples:
//   https://career.f1soft.com/                        -> f1soft
//   https://www.cloudfactory.com/careers              -> cloudfactory
//   https://careers.smartrecruiters.com/Verisk        -> verisk
//   https://apply.workable.com/cloudfactory           -> cloudfactory (collision -> cloudfactory-2)
//   https://uxcam.jobs.personio.de/                   -> uxcam
//   https://career.lftechnology.com/                  -> lftechnology
//
// Name rules (must satisfy wizard's existing validation):
//   /^[a-z0-9_-]+$/  (lowercase letters, digits, dash, underscore)
//
// Collision policy: if the derived name already exists as a source or
// extractor file for the given type, append -2, -3, ... until clean. Never
// silently overwrite. Callers should log the collision so the human sees it.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SOURCES_DIR = path.join(REPO, 'src', 'scrapers', 'sources');
const EXTRACTORS_DIR = path.join(REPO, 'src', 'scrapers', 'extractors');

// Hosts that are ATS vendors, not the hiring company. When the URL's first
// segment is one of these, the tenant slug is in the next segment.
const ATS_HOSTS = new Set([
    'apply.workable.com',
    'workable.com',
    'jobs.smartrecruiters.com',
    'careers.smartrecruiters.com',
    'smartrecruiters.com',
    'boards.greenhouse.io',
    'boards-api.greenhouse.io',
    'greenhouse.io',
    'jobs.lever.co',
    'lever.co',
    'jobs.ashbyhq.com',
    'ashbyhq.com',
    'recruitee.com',
    'breezy.hr',
    'bamboohr.com',
    'jobvite.com',
    'teamtailor.com'
]);

// Prefixes commonly used as a subdomain on a company's own domain. Strip
// them so career.f1soft.com -> f1soft, not career.
const STRIP_PREFIXES = ['www', 'careers', 'career', 'jobs', 'job', 'apply', 'boards', 'hire', 'work-with-us', 'recruiting'];

function slugify(s) {
    return String(s)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-+/g, '-');
}

// Extract the raw host + first meaningful path segment. Returns
// { host, segments } or null on unparseable input.
function parseUrlParts(url) {
    try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        const segments = u.pathname.split('/').filter(Boolean);
        return { host, segments };
    } catch (e) {
        return null;
    }
}

// Base name derivation, before collision handling.
function deriveBaseName(url) {
    const parts = parseUrlParts(url);
    if (!parts) return null;
    const { host, segments } = parts;

    // ATS-vendor host: tenant is in the first path segment.
    if (ATS_HOSTS.has(host)) {
        const tenant = segments[0];
        return tenant ? slugify(tenant) : null;
    }

    // Personio pattern: {tenant}.jobs.personio.{tld}
    const personioMatch = host.match(/^([a-z0-9-]+)\.jobs\.personio\.[a-z]+$/);
    if (personioMatch) return slugify(personioMatch[1]);

    // Recruitee pattern: {tenant}.recruitee.com
    const recruiteeMatch = host.match(/^([a-z0-9-]+)\.recruitee\.com$/);
    if (recruiteeMatch) return slugify(recruiteeMatch[1]);

    // Company's own domain: strip prefixes, take the first meaningful label.
    const labels = host.split('.').filter(Boolean);
    while (labels.length > 1 && STRIP_PREFIXES.includes(labels[0])) {
        labels.shift();
    }
    if (labels.length === 0) return null;

    // If the first label is a common TLD-shaped token (co, com), skip it.
    // e.g. foo.co.uk -> we want foo, not co.
    const first = labels[0];
    if (first === 'co' || first === 'com') {
        return labels[1] ? slugify(labels[1]) : null;
    }
    return slugify(first);
}

// True if a source or extractor file already exists for (type, name).
function sourceExists(type, name) {
    const srcFile = path.join(SOURCES_DIR, type, `${name}.js`);
    const extFile = path.join(EXTRACTORS_DIR, type, `${name}.js`);
    return fs.existsSync(srcFile) || fs.existsSync(extFile);
}

// Derive a collision-free name. Returns { name, baseName, collided }.
//
// `takenSet` (optional, Set of names): when provided, used INSTEAD of the
// live filesystem. This is how batch runs get stable naming: init freezes
// the committed src/scrapers state into a snapshot, discover passes that
// snapshot as a Set, and every subsequent discover on the same run gets
// identical names for identical URLs. Without this, an interrupted verify
// leaving orphans in src/ would shift naming between discover runs and
// orphan every generated/*.js, prompts/*.md, results/*.json keyed by
// the old names.
//
// Also fixes within-run collisions: if two URLs in the same batch derive
// the same base name, they collide against each other. Caller should add
// the returned name to takenSet after each call so the next URL gets a
// suffix instead of silently overwriting.
function deriveName(url, type = 'jobs', takenSet = null) {
    const base = deriveBaseName(url);
    if (!base) {
        return { name: null, baseName: null, collided: false, error: 'could not derive name from URL' };
    }
    const isTaken = (n) => takenSet ? takenSet.has(n) : sourceExists(type, n);
    if (!isTaken(base)) {
        return { name: base, baseName: base, collided: false };
    }
    for (let i = 2; i <= 99; i++) {
        const candidate = `${base}-${i}`;
        if (!isTaken(candidate)) {
            return { name: candidate, baseName: base, collided: true };
        }
    }
    return { name: null, baseName: base, collided: true, error: 'exhausted collision suffixes' };
}

module.exports = { deriveName, deriveBaseName, slugify, sourceExists };
