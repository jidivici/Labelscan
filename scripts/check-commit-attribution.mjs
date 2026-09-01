import { execFileSync } from 'node:child_process';

const [baseRef, requestedHead = 'HEAD'] = process.argv.slice(2);
const forbiddenIdentity = /(?:claude|anthropic)/i;
const attributionTrailer = /^(?:co-authored-by|on-behalf-of|signed-off-by):\s*(.+)$/gim;

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function resolveCommit(ref) {
  if (!ref || /^0+$/.test(ref)) return null;
  try {
    return git(['rev-parse', '--verify', `${ref}^{commit}`]);
  } catch {
    return null;
  }
}

const head = resolveCommit(requestedHead);
if (!head) {
  console.error(`Commit attribution scan failed: invalid head revision ${requestedHead}`);
  process.exit(2);
}

const base = resolveCommit(baseRef);
const revision = base ? `${base}..${head}` : head;
const commits = git(['rev-list', revision]).split('\n').filter(Boolean);
const findings = [];

for (const commit of commits) {
  const metadata = execFileSync(
    'git',
    ['show', '--no-patch', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', commit],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const [authorName, authorEmail, committerName, committerEmail, ...bodyParts] =
    metadata.split('\0');
  const body = bodyParts.join('\0');
  const identities = [
    ['author', `${authorName} <${authorEmail}>`],
    ['committer', `${committerName} <${committerEmail}>`],
  ];

  for (const [role, identity] of identities) {
    if (forbiddenIdentity.test(identity)) {
      findings.push(`${commit}: ${role} identity contains a forbidden attribution`);
    }
  }

  attributionTrailer.lastIndex = 0;
  for (const match of body.matchAll(attributionTrailer)) {
    if (forbiddenIdentity.test(match[1])) {
      findings.push(
        `${commit}: ${match[0].split(':', 1)[0]} trailer contains a forbidden attribution`,
      );
    }
  }
}

if (findings.length > 0) {
  console.error('Commit attribution scan failed:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

const scope = base ? `${base.slice(0, 12)}..${head.slice(0, 12)}` : head.slice(0, 12);
console.log(`Commit attribution scan: ${commits.length} commit(s) checked in ${scope}`);
