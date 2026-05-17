import type { CapacitorConfig } from '@capacitor/cli';

const deployedUrl = process.env.CAPACITOR_SERVER_URL;

const config: CapacitorConfig = {
  appId: 'com.timelocknotes.app',
  appName: 'TimeLock Notes',
  webDir: 'dist',
  ...(deployedUrl
    ? {
        server: {
          url: deployedUrl,
          androidScheme: 'https',
          cleartext: false,
        },
      }
    : {}),
  android: {
    backgroundColor: '#0f172a',
  },
};

export default config;
