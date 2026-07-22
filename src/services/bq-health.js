/**
 * BigQuery Auth Health Monitor
 *
 * Thin wrapper over the generic CredentialHealthMonitor. The bot runs `bq`
 * during investigations; BQ now authenticates via the ADC shim
 * (/usr/local/bin/bq → Application Default Credentials), which is durable but
 * can still eventually need an interactive `gcloud auth application-default
 * login`. This detects that and DMs the owner (no auto-recovery — login is
 * interactive), instead of it silently surfacing mid-incident (as on
 * 2026-07-21, payment p9y0yhtbd5).
 *
 * Kept as its own class so start-slack-socket.js's existing wiring and the
 * `bqCommand` option name don't change.
 */

const { CredentialHealthMonitor } = require('./credential-health');

class BqHealthMonitor extends CredentialHealthMonitor {
    constructor({ bqCommand, checkArgs, intervalMs, timeoutMs, slackClient, ownerUserId }) {
        super({
            name: 'BigQuery',
            logName: 'BqHealth',
            command: bqCommand || 'bq',
            checkArgs: Array.isArray(checkArgs) && checkArgs.length
                ? checkArgs
                : ['query', '--use_legacy_sql=false', '--max_rows=1', 'SELECT 1 AS ok'],
            recoveryCommand: 'gcloud auth application-default login',
            recoveryNote: 'BQ now authenticates via ADC (see /usr/local/bin/bq shim). '
                + 'The bot cannot self-recover (login is interactive). '
                + 'BQ-dependent investigations will fail or fall back until refreshed.',
            intervalMs, timeoutMs, slackClient, ownerUserId,
        });
    }
}

module.exports = { BqHealthMonitor };
