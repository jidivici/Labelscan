const baseUrl = (process.argv[2] ?? process.env.LABELSCAN_PUBLIC_URL ?? 'https://label-scan.fr')
  .replace(/\/$/, '');

const results = [];

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: 'follow',
    signal: AbortSignal.timeout(10_000),
    ...options,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Some expected responses are HTML or empty.
  }
  return { response, json };
}

function check(label, condition, detail) {
  results.push({ label, passed: Boolean(condition), detail });
}

try {
  const live = await request('/v1/health/live');
  check('Liveness publique', live.response.status === 200, `HTTP ${live.response.status}`);
  check(
    'En-têtes anti-cache API',
    live.response.headers.get('cache-control')?.includes('no-store'),
    live.response.headers.get('cache-control') ?? 'absent',
  );
  check(
    'HSTS HTTPS',
    Boolean(live.response.headers.get('strict-transport-security')),
    live.response.headers.get('strict-transport-security') ?? 'absent',
  );

  for (const path of ['/docs', '/redoc', '/openapi.json']) {
    const documentation = await request(path);
    check(`${path} désactivé`, documentation.response.status === 404, `HTTP ${documentation.response.status}`);
  }

  const ready = await request('/v1/health/ready');
  check('Readiness disponible', ready.response.status === 200, `HTTP ${ready.response.status}`);
  check(
    'Readiness sans détails internes',
    ready.json && !Object.hasOwn(ready.json, 'checks'),
    ready.json ? JSON.stringify(ready.json) : 'réponse non JSON',
  );

  const protectedRoute = await request('/v1/arrivals');
  check('API métier protégée', protectedRoute.response.status === 401, `HTTP ${protectedRoute.response.status}`);

  const forgedIdentity = await request('/v1/arrivals', {
    headers: {
      'X-Actor-Id': '11111111-1111-1111-1111-111111111111',
      'X-Actor-Scopes': 'catalog:read admin',
    },
  });
  check('Identité forgée refusée', forgedIdentity.response.status === 401, `HTTP ${forgedIdentity.response.status}`);

  const foreignOrigin = await request('/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://example.invalid' },
    body: JSON.stringify({ username: 'production-security-probe', password: 'invalid-probe-password' }),
  });
  check('Origine web étrangère refusée', foreignOrigin.response.status === 403, `HTTP ${foreignOrigin.response.status}`);
} catch (error) {
  check('Connexion au serveur', false, error instanceof Error ? error.message : String(error));
}

for (const result of results) {
  console.log(`${result.passed ? 'PASS' : 'FAIL'}  ${result.label} — ${result.detail}`);
}

const failures = results.filter((result) => !result.passed);
if (failures.length > 0) {
  console.error(`\nValidation production refusée : ${failures.length} contrôle(s) en échec.`);
  process.exitCode = 1;
} else {
  console.log('\nValidation production réussie.');
}
