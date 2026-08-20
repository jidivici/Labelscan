import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const forbiddenFiles = [
  /(^|\/)credentials\.local\.json$/,
  /\.(?:jks|p8|p12|pem|key|mobileprovision)$/i,
];

const secretPatterns = [
  { name: 'Anthropic API key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'Google API key', pattern: /AIza[0-9A-Za-z_-]{30,}/g },
  { name: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/g },
  {
    name: 'private key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
];

const findings = [];
for (const file of tracked) {
  const trackedEnvironment =
    /(^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith('.example');
  if (trackedEnvironment || forbiddenFiles.some((pattern) => pattern.test(file))) {
    findings.push(`${file}: secret-bearing filename must not be tracked`);
    continue;
  }
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const { name, pattern } of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) findings.push(`${file}: ${name}`);
  }
}

if (findings.length > 0) {
  console.error('Tracked secret scan failed:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Tracked secret scan: ${tracked.length} files checked, no high-signal secret found`);
