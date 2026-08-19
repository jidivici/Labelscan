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
function advisoryIdsFor(name, visiting = new Set()) {
  if (visiting.has(name)) return new Set();
  const vulnerability = report.vulnerabilities?.[name];
  if (!vulnerability) return new Set();

  const nextVisiting = new Set(visiting).add(name);
  const ids = new Set();
  for (const via of vulnerability.via ?? []) {
    if (typeof via === 'string') {
      for (const id of advisoryIdsFor(via, nextVisiting)) ids.add(id);
      continue;
    }
    if (['high', 'critical'].includes(via.severity)) {
      for (const id of JSON.stringify(via).match(/GHSA-[a-z0-9-]+/gi) ?? []) ids.add(id);
    }
  }
  return ids;
}

for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
  if (!['high', 'critical'].includes(vulnerability.severity)) continue;
  const ids = [...advisoryIdsFor(name)];
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
