import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const base = require('../app.json');
const packageJson = require('../package.json');
const resolveConfig = require('../app.config.js');
const eas = require('../eas.json');
const sourceConfig = fs.readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
const apiClient = fs.readFileSync(new URL('../src/services/api.ts', import.meta.url), 'utf8');

const previousProfile = process.env.LABELSCAN_BUILD_PROFILE;
process.env.LABELSCAN_BUILD_PROFILE = 'production';
const config = resolveConfig({ config: base.expo });
delete process.env.LABELSCAN_BUILD_PROFILE;
const fallbackConfig = resolveConfig({ config: base.expo });
process.env.LABELSCAN_BUILD_PROFILE = 'development';
const developmentConfig = resolveConfig({ config: base.expo });
if (previousProfile === undefined) delete process.env.LABELSCAN_BUILD_PROFILE;
else process.env.LABELSCAN_BUILD_PROFILE = previousProfile;

const buildProperties = config.plugins.find(
  (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-build-properties',
);
const androidBuild = buildProperties?.[1]?.android;
const fallbackAndroidBuild = fallbackConfig.plugins.find(
  (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-build-properties',
)?.[1]?.android;
const developmentAndroidBuild = developmentConfig.plugins.find(
  (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-build-properties',
)?.[1]?.android;
const blockedPermissions = config.android?.blockedPermissions ?? [];
const checks = [
  ['Expo SDK 57', /^\^?57\./.test(packageJson.dependencies.expo)],
  ['Android minimum API 33 (Android 13)', androidBuild?.minSdkVersion === 33],
  ['HTTP clair interdit en production', androidBuild?.usesCleartextTraffic === false],
  ['Repli sans profil interdit le HTTP clair', fallbackAndroidBuild?.usesCleartextTraffic === false],
  ['HTTP LAN réservé au profil development', developmentAndroidBuild?.usesCleartextTraffic === true],
  ['R8 actif en release', androidBuild?.enableMinifyInReleaseBuilds === true],
  ['Ressources inutilisées retirées', androidBuild?.enableShrinkResourcesInReleaseBuilds === true],
  ['Sauvegarde Android désactivée', config.android?.allowBackup === false],
  ['Permission caméra déclarée', config.android?.permissions?.includes('android.permission.CAMERA')],
  ['Permission Internet déclarée', config.android?.permissions?.includes('android.permission.INTERNET')],
  [
    'État réseau Android accessible',
    config.android?.permissions?.includes('android.permission.ACCESS_NETWORK_STATE'),
  ],
  [
    'Permissions sensibles inutiles bloquées',
    [
      'android.permission.RECORD_AUDIO',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.SYSTEM_ALERT_WINDOW',
    ].every((permission) => blockedPermissions.includes(permission)),
  ],
  ['Jetons dans SecureStore', config.plugins.includes('expo-secure-store')],
  [
    'URL API production HTTPS',
    eas.build.production.env.EXPO_PUBLIC_API_BASE_URL === 'https://label-scan.fr',
  ],
  [
    'URL API preview HTTPS',
    eas.build.preview.env.EXPO_PUBLIC_API_BASE_URL === 'https://label-scan.fr',
  ],
  [
    'Repli release hors EAS',
    sourceConfig.includes("DEFAULT_RELEASE_API_BASE_URL = 'https://label-scan.fr'"),
  ],
  [
    'Transport JSON Android Expo SDK 57',
    apiClient.includes("from 'expo/fetch'") &&
      apiClient.includes("process.env.EXPO_OS === 'android'"),
  ],
  [
    'Aucun contournement TLS obsolète',
    !config.plugins.some(
      (plugin) => Array.isArray(plugin) && plugin[0] === './plugins/with-android-legacy-tls',
    ),
  ],
];

for (const [label, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}`);
const failed = checks.filter(([, passed]) => !passed);
if (failed.length) {
  console.error(`\nContrat Android 13 refusé : ${failed.length} contrôle(s) en échec.`);
  process.exitCode = 1;
} else {
  console.log('\nContrat Android 13 prêt pour un build natif de validation.');
}
