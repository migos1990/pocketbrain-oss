# The phone app's sign-in

The owner opens the dashboard on a phone over Tailscale ([dashboard-tailnet.md](dashboard-tailnet.md)). In a browser, every sign-in is a texted link that opens in Safari, and anything private asks for another one after 10 minutes (`FRESH_MINUTES` in `src/dashboard/server.ts`). The pocketBrain app for iOS and Android shows the same owner pages and signs in its own way: it pairs once with a phone link, then Face ID makes a sign-in fresh again. The hub gives the app no other data route: it loads the same pages, under the same cookie, CSRF and Host rules.

## Pairing

1. Get a phone link: `pocketbrain dashboard phone-link` on the hub machine, or the signed-out page's "Text me a sign-in link". It is the same link a browser uses: one use, a day. With your Tailscale login set (`dashboard_tailnet_login`), the command prints the `tailscale serve` https address, which the app accepts; without it, the tailnet listener's plain one, which the app refuses.
2. Open it in the app. The link's page has "Open in the pocketBrain app", which hands the app the hub's address and the link's key (`pocketbrain://pair?hub=…&key=…`).
3. The app posts the key to `POST /app/pair` with a name for the phone. The hub spends the link, signs the phone in for 30 days and answers with a **device key**, which the app keeps in the phone's keychain behind Face ID.

The hub keeps only the device key's hash, with the phone's name, when it paired, when it last signed in with Face ID and the sign-ins it made, in `.git/pb-app-phones.json` (0600, never in a note). At most 5 phones are kept; pairing a sixth removes the oldest and ends its sign-ins.

## Face ID instead of another link

When a page asks for a sign-in from the last 10 minutes, the app asks for Face ID and posts the device key to `POST /app/fresh`. A key the hub knows makes the phone's sign-in fresh, and counts its 30 days again; with no sign-in left (it lapsed, or the hub forgot it), the key signs the phone in afresh. A key the hub doesn't know answers 401 with nothing set, the same as no key. After 10 such answers in an hour the door waits an hour for every key, the real one too.

Both doors open only where a phone link works: on the tailnet listener and through `tailscale serve`, from the devices you listed. A request from a web page must come from the hub's own address; the app's own requests carry no Origin. Neither key is ever logged, kept in clear or sent back in an answer (`test/phone-app.test.ts`).

## Removing a phone

```
pocketbrain dashboard phones                 # names, when paired, last Face ID sign-in
pocketbrain dashboard phones remove "Robin's phone"
pocketbrain dashboard phones remove all
```

A removed phone's key stops working at once, and so does every sign-in it made, on a running hub too: the hub checks each sign-in against its kept list on every request.

## Where the hub can run

The app needs an https address the phone can reach. That is `tailscale serve` on whatever machine runs the hub: a Mac at home, a Linux box, or a small rented server (see [dashboard-tailnet.md](dashboard-tailnet.md)). The owner pages are never on the Cloudflare tunnel.

## The app

The app is in `mobile/` (Expo, React Native). It is the hub's own owner pages in a full-screen web view, plus three things a browser can't do:

- **Pair.** The link page's "Open in the pocketBrain app" button opens it with the hub's address and key; or paste the texted link on its first screen. It refuses a plain http address: use the hub's `tailscale serve` https one. The app needs Face ID or a fingerprint set up, since the device key is kept behind it (`expo-secure-store` with `requireAuthentication`, this device only).
- **Face ID instead of Sign in again.** A script in each page (`mobile/src/inject.ts`) turns the "Sign in again" button and a signed-out page into a Face ID prompt, then `POST /app/fresh` and a reload. A phone the hub no longer knows goes back to the pairing screen.
- **One cookie store.** The pairing answer's cookie lands in the phone's shared cookie store, which the web view uses (`sharedCookiesEnabled`).

`mobile/src/pair.ts` and `mobile/src/hub.ts` hold the logic and are tested in the hub's own run (`test/phone-app-client.test.ts`). The screens are not tested here yet.

### The icon

The icon is the logo on Night (near-black): the pink cloud, the light bar, and the two eyes from the launch film. `mobile/src/logo.ts` holds the shapes; `bun scripts/phone-icons.ts` makes `mobile/assets/icon.png` (the iPhone icon, edge to edge with no transparency, since the phone rounds the corners), `adaptive-icon.png` (Android's see-through foreground on a Night background) and `splash-icon.png` (the opening screen). Run it again after changing the shapes. While the hub's page loads, the app draws the logo live (`mobile/src/Mark.tsx`) and the eyes look left and right; they stay still when the phone is set to reduce motion.

### Building it

`mobile/eas.json` has three builds that sit side by side on a phone: `development` (with Expo's dev client), `preview` (internal testing) and `production`. `mobile/app.config.js` names each and gives it its own bundle id. Builds run on Expo's cloud (EAS), so no Xcode is needed:

```
cd mobile && npm install
npx eas-cli build --profile preview --platform ios      # TestFlight or an internal install
npx eas-cli build --profile preview --platform android  # an APK to install directly
```

For TestFlight, build and submit with the same `APP_ENV`, since `mobile/app.config.js` picks the bundle id from it and falls back to the development one:

```
APP_ENV=production npx eas-cli build --profile production --platform ios
APP_ENV=production npx eas-cli submit --platform ios --latest
```

These need the owner's Expo account, and for iOS an Apple Developer account; nothing is published to a store from this repo. `mobile/app.config.js` names the owner's Expo project; a copy built on another Expo account sets `EAS_PROJECT_ID` to the id `npx eas-cli init` gives it.
