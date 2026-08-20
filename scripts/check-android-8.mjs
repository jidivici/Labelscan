import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const base = require('../app.json');
const resolveConfig = require('../app.config.js');
const eas = require('../eas.json');

const previousProfile = process.env.LABELSCAN_BUILD_PROFILE;
process.env.LABELSCAN_BUILD_PROFILE = 'production';
const config = resolveConfig({ config: base.expo });
if (previousProfile === undefined) delete process.env.LABELSCAN_BUILD_PROFILE;
else process.env.LABELSCAN_BUILD_PROFILE = previousProfile;

const buildProperties = config.plugins.find(
  (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-build-properties',
);
const androidBuild = buildProperties?.[1]?.android;
const checks = [
  ['Expo SDK 54', base.expo.sdkVersion === '54.0.0'],
  ['Android minimum API 26 (Android 8)', androidBuild?.minSdkVersion === 26],
  ['HTTP clair interdit en production', androidBuild?.usesCleartextTraffic === false],
  ['R8 actif en release', androidBuild?.enableMinifyInReleaseBuilds === true],
  ['Ressources inutilisées retirées', androidBuild?.enableShrinkResourcesInReleaseBuilds === true],
  ['Sauvegarde Android désactivée', config.android?.allowBackup === false],
  ['Permission caméra déclarée', config.android?.permissions?.includes('android.permission.CAMERA')],
  ['Jetons dans SecureStore', config.plugins.includes('expo-secure-store')],
  [
    'URL API production HTTPS',
    eas.build.production.env.EXPO_PUBLIC_API_BASE_URL === 'https://label-scan.fr',
  ],
];

for (const [label, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}`);
const failed = checks.filter(([, passed]) => !passed);
if (failed.length) {
  console.error(`\nCompatibilité Android 8 refusée : ${failed.length} contrôle(s) en échec.`);
  process.exitCode = 1;
} else {
  console.log('\nContrat Android 8 prêt pour un build natif de validation.');
}
