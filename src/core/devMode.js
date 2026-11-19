// src/core/devMode.js
// DEV_MODE gate. Reads env.DEV_MODE (parsed once in src/config/env.js).
// Command handlers call `await requireProdMode(name, interaction)` first thing.
// Integration entry points call `noteBlocked(funcName)` and return early.
'use strict';

const { MessageFlags } = require('discord.js');
const env = require('../config/env');

function isDevMode() {
    return env.DEV_MODE === true;
}

// Returns true if the caller may proceed (prod mode). Returns false after
// replying ephemerally when DEV_MODE is on. ALWAYS call with `await`:
// an un-awaited call is a truthy Promise and silently fails open.
async function requireProdMode(commandName, interaction) {
    if (!isDevMode()) return true;
    const payload = {
        content: `DEV_MODE=true — /${commandName} disabled. Unset DEV_MODE to enable.`,
        flags: MessageFlags.Ephemeral,
    };
    try {
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
        else await interaction.reply(payload);
    } catch (err) {
        console.error(`[devMode] failed to send DEV_MODE notice for /${commandName}:`, err && err.message);
    }
    return false;
}

// Belt-and-braces helper for non-command entry points (cron/boot paths).
// Returns true when the caller must refuse. Audit entry is throttled per
// function (10 min) so scheduled ticks cannot flood the audit log.
const lastLogged = new Map();
const LOG_THROTTLE_MS = 10 * 60 * 1000;

function noteBlocked(func, details = {}) {
    if (!isDevMode()) return false;
    const now = Date.now();
    if (now - (lastLogged.get(func) || 0) > LOG_THROTTLE_MS) {
        lastLogged.set(func, now);
        console.warn(`[devMode] ${func} refused (DEV_MODE=true)`);
        try {
            const r = require('./auditLogger').auditLog('dev_mode_blocked', `DEV_MODE refused ${func}`, { func, ...details });
            if (r && typeof r.catch === 'function') r.catch(() => {});
        } catch (_) { /* audit must never break the guard */ }
    }
    return true;
}

module.exports = { isDevMode, requireProdMode, noteBlocked };
