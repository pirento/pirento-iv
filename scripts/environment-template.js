/** Non-secret defaults allowed in a redistributable .example.env file. */
export const TEMPLATE_DEFAULTS = Object.freeze({
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: '3001',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/?replicaSet=rs0',
  MONGODB_DATABASE: 'venturecore_workspace',
  BACKUP_ENABLED: 'false',
  BACKUP_INTERVAL_MINUTES: '1440',
  BACKUP_RETENTION_COUNT: '7',
  EMAIL_AUTOMATION: 'false',
  SHRI_SARRAF_EMAIL_AUTOMATION: 'false',
  CASHFREE_ENVIRONMENT: 'sandbox',
  SHRI_SARRAF_CASHFREE_ENVIRONMENT: 'sandbox',
  SANDBOX_ENVIRONMENT: 'test',
  IV_ALLOW_NEW_DATABASE: 'false',
});

/**
 * Inspect raw assignments instead of a last-value-wins dotenv object. Release
 * templates use single-line assignments; multiline or malformed values are held
 * for review. Results identify line numbers only and never contain input values.
 * Kept dependency-free so the readiness audit also works before npm ci.
 */
export function inspectExampleTemplate(contents) {
  const issues = [];
  const seen = new Set();
  const lines = String(contents)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      issues.push({ code: 'ENV_FORMAT', line: index + 1 });
      continue;
    }
    const [, key, raw] = match;
    if (seen.has(key)) issues.push({ code: 'ENV_DUPLICATE', line: index + 1 });
    seen.add(key);
    let value;
    if (/^["'`]/.test(raw)) {
      const quoted = /^(["'`])(.*)\1\s*(?:#.*)?$/.exec(raw);
      if (!quoted) {
        issues.push({ code: 'ENV_FORMAT', line: index + 1 });
        continue;
      }
      value = quoted[2];
    } else value = raw.split('#', 1)[0].trim();
    if (value && (!Object.hasOwn(TEMPLATE_DEFAULTS, key) || value !== TEMPLATE_DEFAULTS[key]))
      issues.push({ code: 'ENV_NON_TEMPLATE', line: index + 1 });
  }
  return issues;
}
