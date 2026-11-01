// SPDX-License-Identifier: AGPL-3.0-only
// One app, three builds side by side on a phone (docs/phone-app.md): development, preview, production.
const APP_ENV = process.env.APP_ENV || "development";
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
    plugins: ["expo-secure-store", ["expo-local-authentication", { faceIDPermission: "Face ID unlocks the key that signs you in to your brain." }]],
    extra: { appEnv: APP_ENV },
  },
};
