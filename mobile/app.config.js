const app = require('./app.json');

module.exports = () => {
  const config = app.expo;
  const webClientId = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID;
  if (!webClientId) return config;

  const iosUrlScheme = process.env.EXPO_PUBLIC_GOOGLE_IOS_REVERSED_CLIENT_ID;
  if (!iosUrlScheme) {
    throw new Error('EXPO_PUBLIC_GOOGLE_IOS_REVERSED_CLIENT_ID is required when Google sign-in is enabled.');
  }
  return {
    ...config,
    plugins: [...config.plugins, ['react-native-nitro-google-signin', { iosUrlScheme }]],
  };
};
