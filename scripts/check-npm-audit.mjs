import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const allowlistPath = process.argv[2] ?? 'security/npm-audit-allowlist.json';
const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));
const today = new Date().toISOString().slice(0, 10);
const allowed = new Map();
for (const exception of allowlist.exceptions ?? []) {
  if (!exception.owner || !exception.expires || !exception.rationale) {
    throw new Error(`Incomplete npm audit exception: ${JSON.stringify(exception)}`);
  }
  if (exception.expires < today) continue;
  for (const id of exception.advisories) allowed.set(id, exception);
}

const audit = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
});
let report;
try {
  report = JSON.parse(audit.stdout || '{}');
} catch {
  process.stderr.write(audit.stderr || audit.stdout);
  process.exit(2);
}

const failures = [];
for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
  if (!['high', 'critical'].includes(vulnerability.severity)) continue;
  const serialized = JSON.stringify(vulnerability.via ?? []);
  const ids = [...new Set(serialized.match(/GHSA-[a-z0-9-]+/gi) ?? [])];
  const unknown = ids.filter((id) => !allowed.has(id));
  if (ids.length === 0 || unknown.length > 0) {
    failures.push({ name, severity: vulnerability.severity, advisories: ids, unknown });
  }
}
if (failures.length) {
  console.error('Unknown or expired high/critical npm advisories:', failures);
  process.exit(1);
}
console.log('npm audit: no unknown high/critical advisories');
