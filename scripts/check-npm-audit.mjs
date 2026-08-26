import { spawnSync } from 'node:child_process';

const audit = spawnSync('npm', ['audit', '--json'], {
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

const vulnerabilities = report.metadata?.vulnerabilities ?? {};
const total = Number(vulnerabilities.total ?? 0);
if (total !== 0 || Object.keys(report.vulnerabilities ?? {}).length !== 0) {
  console.error('npm audit found vulnerabilities; exceptions are not permitted:', vulnerabilities);
  process.exit(1);
}
console.log('npm audit: 0 vulnerabilities');
