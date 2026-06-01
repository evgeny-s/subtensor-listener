/**
 * Generic, reusable message rendering. A notification is just a flat bag of
 * string variables plus a template that interpolates `{{ token }}` references.
 * Future notification types only need to supply their own vars (and optionally
 * their own template) — the transport and rendering stay the same.
 */

/** Flat variables available to a template. */
export type TemplateVars = Record<string, string>;

/**
 * Default template for a chain-event notification.
 *
 * Uses a unicode emoji and plain text (no `*bold*`/backticks) on purpose: when
 * delivered through a Slack *workflow* webhook, the message text arrives inside
 * a workflow variable, which Slack renders as PLAIN TEXT — it does not parse
 * mrkdwn. Unicode emoji and bullets render fine; `*`/backticks would show
 * literally. (Override via `messageTemplate` if your transport renders mrkdwn.)
 *
 * Tokens left unfilled render as empty strings, so this is safe to reuse for
 * events without a spec-version change.
 */
export const DEFAULT_TEMPLATE = [
  '🚨 {{event}} on {{network}}',
  '• Runtime: {{specVersionChange}}',
  '• Block: #{{blockNumber}}',
  '• Hash: {{blockHashShort}}',
  '• Time: {{timestampUtc}}',
  '• Explorer: {{explorerUrl}}',
].join('\n');

const TOKEN = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Renders a template by replacing every `{{ token }}` with the matching var.
 * Missing tokens become an empty string (never the literal `{{token}}`), then
 * any blank lines left behind are dropped so optional fields don't leave gaps.
 */
export function renderMessage(template: string, vars: TemplateVars): string {
  const replaced = template.replace(TOKEN, (_match, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
  return replaced
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .join('\n');
}
