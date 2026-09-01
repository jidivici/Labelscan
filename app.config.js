module.exports = ({ config }) => {
  const developmentBuild = process.env.LABELSCAN_BUILD_PROFILE === 'development';
  const plugins = (config.plugins ?? []).filter((plugin) => {
    const name = Array.isArray(plugin) ? plugin[0] : plugin;
    return name !== 'expo-build-properties';
  });

  return {
    ...config,
    plugins: [
      ...plugins,
      [
        'expo-build-properties',
        {
          android: {
            // Product contract: only maintained Android generations are supported.
            minSdkVersion: 33,
            // Fail closed: only an explicit development profile may use LAN HTTP.
            usesCleartextTraffic: developmentBuild,
            enableMinifyInReleaseBuilds: true,
            enableShrinkResourcesInReleaseBuilds: true,
          },
        },
      ],
    ],
  };
};
