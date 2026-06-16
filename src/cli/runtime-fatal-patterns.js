'use strict';

/**
 * Runtime-fatal patterns — errors that surface *mid-turn* (after the CLI is
 * already running and accepted the prompt) and guarantee the current
 * investigation cannot succeed no matter how long we wait.
 *
 * Distinct from each adapter's `fatalErrorPatterns`, which are checked during
 * startup/readiness polling to abort a CLI that never reaches a usable prompt.
 * These are checked by the response poller (`_pollForResponse` in socket.js)
 * on every tick; on match it escalates to the next CLI in the chain (or posts
 * the manual-triage notice) instead of busy-looping until the wall ceiling.
 *
 * Keep these UNAMBIGUOUSLY fatal — a false match kills a live session. Most of
 * these are environment failures (missing AWS profile / expired creds) that
 * fail every command, so escalating to the next CLI usually fails identically;
 * the value is reaching the on-call human faster, not recovering automatically.
 *
 * Shared across CLI adapters because the failures are environment-wide, not
 * CLI-specific. Each adapter re-exports this as `runtimeFatalPatterns` so a
 * future CLI-specific addition can extend the list locally.
 */
module.exports = [
    {
        // AWS named profile not configured for the user running the CLI, e.g.
        //   aws: [ERROR]: The config profile (payments_us_production) could not be found
        // Every Athena/AWS step then fails; the investigation loops forever.
        // (incident Q28U50GZKAL8DY, 2026-06-15).
        regex: /config profile \([^)]+\) could not be found|the config profile .* could not be found/i,
        reason: 'AWS profile not found — SSO/profile not configured',
    },
    {
        // AWS SSO session expired mid-investigation. The token refresh fails and
        // every subsequent call errors out.
        regex: /Error loading SSO Token|The SSO session associated with this profile has expired|Token has expired and refresh failed/i,
        reason: 'AWS SSO token expired — re-authenticate',
    },
];
