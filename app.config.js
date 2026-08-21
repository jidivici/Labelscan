module.exports = ({ config }) => {
  const releaseBuild = ['preview', 'production'].includes(
    process.env.LABELSCAN_BUILD_PROFILE,
  );
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
            // Release traffic must use HTTPS. Development keeps LAN HTTP available.
            usesCleartextTraffic: !releaseBuild,
            enableMinifyInReleaseBuilds: true,
            enableShrinkResourcesInReleaseBuilds: true,
          },
        },
      ],
    ],
  };
};
