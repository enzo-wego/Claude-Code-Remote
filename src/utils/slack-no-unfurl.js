'use strict';

/**
 * Suppress Slack link previews (unfurls) on every message the bot posts.
 *
 * Slack's default is to unfurl all links posted by apps, plus media inside
 * Block Kit blocks. Our messages are dense with Slack permalinks, Google
 * Drive/Sheets links, GitHub links and internal URLs, so each post dragged a
 * pile of preview cards along with it — and any bare hostname that happened to
 * appear inside masked PII or a log line got its own card too. Setting BOTH
 * `unfurl_links: false` and `unfurl_media: false` is the documented way to turn
 * all of that off (see chat.postMessage → "Unfurling content").
 *
 * Why patch the client instead of every call site: there are 60+
 * `chat.postMessage` calls spread across socket.js, cli-hook-notify.js, the MCP
 * poster and the monitor services, plus Bolt's own `say()` helper and its
 * per-team pooled clients. Patching `WebClient.prototype.apiCall` covers all of
 * them, including call sites added later.
 *
 * Ordering matters: `@slack/web-api` binds each method with
 * `self.apiCall.bind(self, method)` in the WebClient constructor, so the
 * prototype must be patched BEFORE any client (or Bolt `App`) is constructed.
 * Call `installNoUnfurl()` at the top of each entry point.
 */

const { WebClient } = require('@slack/web-api');

// Methods that accept unfurl flags. chat.update deliberately excluded — Slack
// does not accept unfurl args there, and editing a message does not unfurl.
const UNFURLABLE_METHODS = new Set([
    'chat.postMessage',
    'chat.postEphemeral',
    'chat.scheduleMessage',
]);

let installed = false;

/**
 * Idempotently patch the Slack WebClient so posting methods default to
 * no-unfurl. A call site that explicitly passes `unfurl_links`/`unfurl_media`
 * still wins, so a future message can opt back into previews on purpose.
 */
function installNoUnfurl() {
    if (installed) return;

    const originalApiCall = WebClient.prototype.apiCall;

    WebClient.prototype.apiCall = function apiCall(method, options) {
        if (UNFURLABLE_METHODS.has(method) && options && typeof options === 'object') {
            return originalApiCall.call(this, method, {
                unfurl_links: false,
                unfurl_media: false,
                ...options,
            });
        }
        return originalApiCall.call(this, method, options);
    };

    installed = true;
}

module.exports = { installNoUnfurl };
