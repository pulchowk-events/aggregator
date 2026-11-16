// scripts/batch/lib/transport-extension.js
//
// Thin wrapper around deepseek-connect's createServer + createClient.
// One instance per paste run. start() binds an OS-assigned port and
// probes readiness; chat() and open() dispatch single-attempt requests
// (retry policy lives in paste-extension.js, not here — the transport
// reports errors as-is and the loop decides whether to resend).
//
// Per deepseek-connect/docs/integration-guide.md#extensiontransport-implementation.

'use strict';

const { createServer } = require('deepseek-connect');
const { createClient } = require('deepseek-connect/client');

class ExtensionTransport {
    constructor(opts = {}) {
        this.token = opts.token || process.env.EXTENSION_TOKEN;
        if (!this.token) {
            throw new Error('ExtensionTransport: EXTENSION_TOKEN required');
        }
        // Default port must match what the extension popup is configured
        // for. port: 0 (OS-assigned) is wrong here — the extension only
        // polls the port it was told about, and won't discover a random
        // one. EXTENSION_PORT from .env is the source of truth.
        const defaultPort = parseInt(process.env.EXTENSION_PORT, 10) || 7331;
        this.port = opts.port != null ? opts.port : defaultPort;
        this.server = createServer({
            token: this.token,
            port: this.port,
            log: opts.log || (() => {}),  // silence; the wizard renders its own UI
        });
        this.client = null;
        this.started = false;
        this.ownsServer = false;
        this.boundPort = this.port;
    }

    // Attach-or-own: try to bind the configured port. If it's free, the
    // wizard owns the server and must stop it in shutdown(). If it's
    // taken, attach to the existing server (another deepseek-connect or
    // an external wizard already running) and leave it alone on cleanup.
    // The extension has exactly one port configured, so this is the only
    // sensible behaviour.
    async start() {
        try {
            this.boundPort = await this.server.start();
            this.ownsServer = true;
        } catch (err) {
            if (err.code === 'EADDRINUSE') {
                this.boundPort = this.port;
                this.ownsServer = false;
            } else {
                throw err;
            }
        }
        this.client = createClient({ token: this.token, port: this.boundPort });
        this.started = true;
        // Readiness probe: throws DSCError('extension_disconnected') if
        // no extension is polling this port within the client timeout.
        await this.client.tabs();
        return this.boundPort;
    }

    // open({ chatName })                        -> sidebar walk OR fresh /
    // open({ chatName, url })                   -> direct nav, skip sidebar
    // open({ chatName, url, provider })         -> provider-scoped (default: deepseek)
    async open({ chatName, url, provider } = {}) {
        return this.client.open({ chatName, url, provider });
    }

    async chat({ chatName, prompt, timeoutMs, provider }) {
        const result = await this.client.chat({
            messages: [{ role: 'user', content: prompt }],
            chat: chatName,
            provider,
            timeoutMs: timeoutMs || 180000,
        });
        return result;
    }

    async shutdown() {
        if (!this.started) return;
        this.started = false;
        if (this.ownsServer) await this.server.stop();
    }
}

module.exports = { ExtensionTransport };
