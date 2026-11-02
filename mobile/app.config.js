// SPDX-License-Identifier: AGPL-3.0-only
// One app, three builds side by side on a phone (docs/phone-app.md): development, preview, production.
const APP_ENV = process.env.APP_ENV || "development";
const PROJECT_ID = process.env.EAS_PROJECT_ID || "39086ad4-9075-4a3c-a13e-1fbabb1899f9";
const ENV = {
  development: { name: "pocketBrain (dev)", id: "dev.pocketbrain.app.dev" },
  preview: { name: "pocketBrain (test)", id: "dev.pocketbrain.app.preview" },
  production: { name: "pocketBrain", id: "dev.pocketbrain.app" },
}[APP_ENV] ?? { name: "pocketBrain (dev)", id: "dev.pocketbrain.app.dev" };

module.exports = {
  expo: {
    name: ENV.name,
    slug: "pocketbrain",
    scheme: "pocketbrain",
    version: "0.1.0",
    orientation: "portrait",
    userInterfaceStyle: "light",
    backgroundColor: "#EEEDE8",
    // The logo with the film's eyes on Night (docs/phone-app.md, The icon); made by scripts/phone-icons.ts.
    icon: "./assets/icon.png",
    splash: { image: "./assets/splash-icon.png", resizeMode: "contain", backgroundColor: "#121212" },
    ios: {
      bundleIdentifier: ENV.id,
      supportsTablet: false,
      infoPlist: {
        NSFaceIDUsageDescription: "Face ID unlocks the key that signs you in to your brain.",
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: { package: ENV.id, allowBackup: false, adaptiveIcon: { foregroundImage: "./assets/adaptive-icon.png", backgroundColor: "#121212" } },
    // Over the air (docs/phone-app.md, Native build or over the air): a JS-only change ships with
    // `npm run update:production`; an update reaches only builds whose native code has the same
    // fingerprint, so a change that adds a native module needs a new build. Launch never waits on
    // the network: the app opens what it has and takes a new update on the next launch.
    runtimeVersion: { policy: "fingerprint" },
    updates: { url: `https://u.expo.dev/${PROJECT_ID}`, fallbackToCacheTimeout: 0 },
    plugins: ["expo-secure-store", ["expo-local-authentication", { faceIDPermission: "Face ID unlocks the key that signs you in to your brain." }]],
    // The Expo (EAS) project the owner's cloud builds run under; a copy built on another Expo
    // account sets EAS_PROJECT_ID to its own (docs/phone-app.md, Building it).
    extra: { appEnv: APP_ENV, eas: { projectId: PROJECT_ID } },
  },
};
