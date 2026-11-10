// scripts/setup/supabase.js
// Supabase connection testing + schema verification for the setup wizard.
//
// The wizard needs to know two things before writing config:
//   1. Do the credentials work? (URL + service_role key valid, project reachable)
//   2. Do the expected tables exist? (events, jobs, scholarships + columns)
//
// Supabase service_role keys can't run DDL (CREATE TABLE) via the JS client.
// If a table is missing, the wizard prints the exact SQL the user needs to
// paste into the Supabase SQL editor, plus a deep link to that editor.

const { createClient } = require('@supabase/supabase-js');

// Test credentials + verify every expected table exists.
// Returns { ok, error?, tables: { name: { exists, error? } } }
async function testConnection(url, serviceKey, tableNames = ['events']) {
    let client;
    try {
        client = createClient(url, serviceKey, { auth: { persistSession: false } });
    } catch (error) {
        return { ok: false, error: `Client construction failed: ${error.message}`, tables: {} };
    }

    const tables = {};
    let anyAuthError = false;

    for (const tableName of tableNames) {
        try {
            // A SELECT with limit 1 on the target table:
            //   - success                → creds good, table exists
            //   - PGRST116 / 42P01 / 404 → creds good, table missing
            //   - 401 / 403              → creds bad
            const { error } = await client.from(tableName).select('id').limit(1);
            if (!error) {
                tables[tableName] = { exists: true };
            } else {
                const code = String(error.code || '');
                const msg = String(error.message || '');
                const isMissing = code === 'PGRST116' || code === '42P01' || /relation.*does not exist/i.test(msg) || /not found/i.test(msg);
                const isAuth = code === '401' || code === '403' || /JWT|auth|unauthorized|invalid api key/i.test(msg);
                if (isAuth) {
                    anyAuthError = true;
                    tables[tableName] = { exists: false, error: 'auth_failed', message: msg };
                } else if (isMissing) {
                    tables[tableName] = { exists: false, error: 'missing', message: msg };
                } else {
                    tables[tableName] = { exists: false, error: 'unknown', message: msg };
                }
            }
        } catch (error) {
            tables[tableName] = { exists: false, error: 'threw', message: error.message };
        }
    }

    if (anyAuthError) {
        return { ok: false, error: 'Authentication failed — check the service_role key.', tables };
    }

    const allExist = Object.values(tables).every((t) => t.exists);
    return { ok: allExist, tables };
}

// Get the deep link to the Supabase SQL editor for a project.
function getSqlEditorUrl(url) {
    try {
        const u = new URL(url);
        const ref = u.hostname.split('.')[0];
        return `https://supabase.com/dashboard/project/${ref}/sql/new`;
    } catch (e) {
        return null;
    }
}

// The DDL the wizard tells the user to paste if a table is missing.
// This is the same schema the integrations expect — see
// src/integrations/supabase.js and websiteSync/engine.js for the columns
// that are actually written to.
function getCreateTableSql(tableName) {
    if (tableName === 'events') {
        return `create table if not exists events (
  id                  text primary key,
  title               text,
  description         text,
  image               text,
  location            text,
  date                text,
  price               text,
  status              text,
  url                 text,
  registration_url    text,
  organizer           text,
  source              text,
  attendance_mode     text,
  featured            boolean default false,
  first_seen_at       bigint,
  company             text,
  employment_type     text,
  salary              text,
  experience          text,
  level               text,
  openings            int,
  application_ends_raw text,
  skills              jsonb default '[]'::jsonb,
  posted_at           bigint,
  type                text,
  uploaded_at         timestamptz default now()
);`;
    }
    if (tableName === 'scholarships') {
        return `create table if not exists scholarships (
  id                  text primary key,
  title               text,
  description         text,
  provider            text,
  deadline_raw        text,
  deadline_parsed     text,
  deadline_status     text,
  deadline_display    text,
  funding_type        text,
  funding_amount      text,
  degree_level        text,
  field_of_study      text,
  image               text,
  tags                jsonb default '[]'::jsonb,
  url                 text,
  registration_url    text,
  source              text,
  first_seen_at       bigint,
  posted_at           bigint,
  type                text
);`;
    }
    if (tableName === 'jobs') {
        return `create table if not exists jobs (
  id                  text primary key,
  bot_dedup_key       text,
  origin              text,
  title               text,
  company             text,
  description         text,
  location            text,
  salary              text,
  experience          text,
  level               text,
  openings            int,
  employment_type     text,
  attendance_mode     text,
  skills              jsonb default '[]'::jsonb,
  url                 text,
  image_url           text,
  application_ends_at timestamptz,
  application_ends_raw text,
  posted_at           timestamptz,
  updated_at          timestamptz default now(),
  verified            boolean default true
);`;
    }
    return `-- No schema template for "${tableName}"`;
}

// Website events table (different shape — has bot_dedup_key + user-collision
// columns). The bot archival and website live in SEPARATE Supabase projects.
function getWebsiteEventsTableSql() {
    return `create table if not exists events (
  id                  uuid primary key,
  bot_dedup_key       text,
  origin              text,
  title               text,
  description         text,
  event_date          timestamptz,
  form_link           text,
  image_url           text,
  category            text,
  created_by          text,
  verified            boolean default true,
  source_url          text,
  location            text,
  price               text,
  organizer           text,
  attendance_mode     text
);`;
}

module.exports = {
    testConnection,
    getSqlEditorUrl,
    getCreateTableSql,
    getWebsiteEventsTableSql
};
