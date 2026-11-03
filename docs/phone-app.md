# The phone app's sign-in

The owner opens the dashboard on a phone over Tailscale ([dashboard-tailnet.md](dashboard-tailnet.md)). In a browser, every sign-in is a texted link that opens in Safari, and anything private asks for another one after 10 minutes (`FRESH_MINUTES` in `src/dashboard/server.ts`). The pocketBrain app for iOS and Android shows the same owner pages and signs in its own way: it pairs once with a phone link, then Face ID makes a sign-in fresh again. The hub gives the app no other data route: it loads the same pages, under the same cookie, CSRF and Host rules.

## First run

A phone that isn't paired opens on one question: "pocketBrain lives on your computer. Your phone opens it." with **I have it on a computer** and **Not yet** (`mobile/src/FirstRun.tsx`; which screen, `firstScreen` in `mobile/src/first.ts`). I have it goes to the pair screen and is remembered, so the question is asked once; a pair link opened from outside the app counts as I have it. Not yet shows three steps with a Copy button each: paste `curl -fsSL https://pocketbrain.dev/install.sh | sh` into Terminal on a Mac, Linux or Windows (WSL) computer, run `pocketbrain init`, then run `pocketbrain dashboard phone-link` and paste the link into the app. **Send these steps to my computer** opens the phone's own share sheet with the steps in words and pocketbrain.dev; the app sends nothing itself. The screen also says the computer needs to be on when the app is used. The pair screen's "No pocketBrain on a computer yet?" goes back to the steps. A paired phone never sees these screens. Pictures: `mobile/shots/first-welcome.png`, `first-steps.png`.

## Pairing

**In one command:** `pocketbrain phone` on the hub machine, with Tailscale signed in on the computer and on the phone under the same account. It reads `tailscale status`, lists your account's phones (iPhone or Android, never another person's device) and asks which one is yours (`--device <name>` answers it ahead). Then it shows the lines it would set in `rules/` (`dashboard_tailnet`, `dashboard_tailnet_devices` with that phone, and `dashboard_tailnet_login`, this computer's own Tailscale login, only when none is set) and writes them only on your yes (`--yes` for an assistant running it), as one owner commit; it never changes another key or a login you set. It runs `tailscale serve --bg --https=8443 http://127.0.0.1:8788` (never funnel); if Serve isn't on for your tailnet yet, it shows Tailscale's own message with its link and stops. It restarts the hub when something changed (on a Mac under launchd; elsewhere it says to restart `pocketbrain start`; `--no-restart` skips it). Last, it prints a QR of the app's pair link: point the iPhone's camera at it and tap the banner. On a hub already set up it changes nothing and prints only the QR. The steps below are what it does, by hand.

1. Get a phone link: `pocketbrain dashboard phone-link` on the hub machine, or the signed-out page's "Text me a sign-in link". It is the same link a browser uses: one use, a day. With your Tailscale login set (`dashboard_tailnet_login`), the command prints the `tailscale serve` https address, which the app accepts; without it, the tailnet listener's plain one, which the app refuses.
2. Open it in the app. The link's page has "Open in the pocketBrain app", which hands the app the hub's address and the link's key (`pocketbrain://pair?hub=…&key=…`).
3. The app posts the key to `POST /app/pair` with a name for the phone. The hub spends the link, signs the phone in for 30 days and answers with a **device key**, which the app keeps in the phone's keychain behind Face ID.

The hub keeps only the device key's hash, with the phone's name, when it paired, when it last signed in with Face ID and the sign-ins it made, in `.git/pb-app-phones.json` (0600, never in a note). At most 5 phones are kept; pairing a sixth removes the oldest and ends its sign-ins.

## Face ID instead of another link

When a page asks for a sign-in from the last 10 minutes, the app asks for Face ID, then asks `POST /app/nonce` for a one-time nonce for its sign-in and posts it with the device key to `POST /app/fresh`. The hub makes the sign-in fresh only when all of these hold: the request is the app's own (the `x-pocketbrain-app: 1` header and no Origin, so no web page can send it, the hub's own included); the cookie is a live sign-in this phone made (at pairing); the nonce was given to that sign-in in the last 2 minutes and not used yet; and the phone has made a sign-in fresh fewer than 12 times this hour (`APP_FRESH_PER_HOUR`). Face ID never makes a sign-in, never sets a cookie and never moves the 30 days: a sign-in still ends 30 days after pairing, and then the phone pairs again with a phone link (audit v11, G642). A key the hub doesn't know, or one used on a sign-in its phone didn't make, answers 401 with nothing set, the same as no key. After 10 such answers in an hour the door waits an hour for every key, the real one too.

Both doors open only where a phone link works: on the tailnet listener and through `tailscale serve`, from the devices you listed. A pairing request from a web page must come from the hub's own address; the Face ID doors (`/app/nonce`, `/app/fresh`) take no web page at all. The app's own requests carry no Origin. Neither key is ever logged, kept in clear or sent back in an answer (`test/phone-app.test.ts`).

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

- **Pair.** The link page's "Open in the pocketBrain app" button opens it with the hub's address and key; or paste the link on its first screen (`mobile/src/PairScreen.tsx`: the logo on Night with its eyes moving, the two steps, a field with **Paste**, which pairs at once, and **Pair**). A whole pasted text message works too: the first sign-in link in it counts. A tailnet name's plain http link (the tailnet listener on 8788) pairs at that name's https door on 8443; any other plain http address is refused. The app needs Face ID or a fingerprint set up, since the device key is kept behind it (`expo-secure-store` with `requireAuthentication`, this device only).
- **Face ID instead of Sign in again.** A script in each page (`mobile/src/inject.ts`) turns the "Sign in again" button and a signed-out page into a Face ID prompt, then `POST /app/fresh` and a reload. A phone the hub no longer knows, or whose 30-day sign-in ended, goes back to the pairing screen.
- **Never a blank screen.** Each page tells the app whether its body holds anything (`ready` or `blank`, the only words besides `fresh`). When iOS or Android drops the page while the app is in the background, the app loads it again (`mobile/src/page.ts`), and it also does that when the owner comes back after more than 10 minutes. A failed load, a 5xx from the hub, or a page that is still blank after one quiet reload shows the logo on Night with **Try again** (`mobile/src/Trouble.tsx`). The app's frame around the page (the status bar and home bar bands) is Night while the logo or Try again is up and paper once the page shows (`shell` in `mobile/src/page.ts`).
- **Pull to refresh.** Pulling the page down from the top loads it again (a GET of the same address); a small "Pull to refresh", "Release to refresh", "Loading…" label shows how far. The same page script does it (`mobile/src/inject.ts`), not the web view's built-in one, which left its spinner up without loading. A pull that starts in a text box does nothing.
- **One cookie store.** The pairing answer's cookie lands in the phone's shared cookie store, which the web view uses (`sharedCookiesEnabled`).

`mobile/src/pair.ts` and `mobile/src/hub.ts` hold the logic and are tested in the hub's own run (`test/phone-app-client.test.ts`). The screens are not tested here yet; `mobile/shots/` holds pictures of the pair screen (empty and with an error) and of Try again, made by rendering `PairScreen` with react-native-web in a scratch copy of `mobile/` at iPhone size. Take them again when the screen changes.

### The icon

The icon is the logo on Night (near-black): the pink cloud, the light bar, and the two eyes from the launch film. `mobile/src/logo.ts` holds the shapes; `bun scripts/phone-icons.ts` makes `mobile/assets/icon.png` (the iPhone icon, edge to edge with no transparency, since the phone rounds the corners), `adaptive-icon.png` (Android's see-through foreground on a Night background) and `splash-icon.png` (the opening screen). Run it again after changing the shapes. While the hub's page loads, the app draws the logo live (`mobile/src/Mark.tsx`) and the eyes look left and right; they stay still when the phone is set to reduce motion.

### The brain

In the app's own screens the logo has two legs (`LEGS` and `POSES` in `mobile/src/logo.ts`, drawn by `mobile/src/Mark.tsx`); the icon and the splash have none. It has three poses, stand, step and sit (`mobile/shots/brain-poses.png`), and it says nothing: no words on screen change. On the opening screen it shifts its weight from leg to leg while the eyes look left and right. On the pair screen it stands, looks down at the link field while that has focus, and blinks once and looks at an error when one appears. On Try again it sits looking up at the heading; tapping Try again stands it up before the page loads again. Every move is one of about 300 ms on a page load or a tap; only the opening screen loops. When the phone is set to reduce motion, poses change without moving. The hub's pages don't draw it yet.

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

### Native build or over the air

Most changes to the app ship over the air with EAS Update: the owner runs one command, and the phone picks up the new version the next time the app opens. A new build through TestFlight is needed only when the native code changes. The update is matched to builds by a fingerprint of the native code (`runtimeVersion: { policy: "fingerprint" }` in `mobile/app.config.js`), so an update never reaches a build missing what it needs; a build that doesn't match keeps what it has.

| Change | How it ships |
|---|---|
| Screens and logic in `mobile/App.tsx` and `mobile/src/` (the pair screen, Try again, the page's state, the injected script, colours, text) | Over the air |
| Images that JS loads (`require("./assets/…")` in a screen) | Over the air |
| A new package with native code (`expo-clipboard`, `expo-updates` itself), or an Expo SDK upgrade | New build |
| `mobile/app.config.js` fields the phone reads at install: name, bundle id, icon, splash (the screen before JS starts), `infoPlist`, plugins, permissions, scheme | New build |
| The hub's own pages (what the web view shows) | Neither: the hub's deploy, live on the next page load |

To ship over the air, from the build folder after pulling main:

```
cd mobile && npm install
EXPO_NO_KEYCHAIN=1 npm run update:production
```

When the fingerprint has changed, the update is published but no installed build takes it, so the phone shows nothing new. Then build and submit instead. The project's page on expo.dev shows the runtime version of each build and each update; when they differ, the change needs a build. The launch never waits on the network (`fallbackToCacheTimeout: 0`): the app opens what it has, downloads in the background, and uses the update on the next launch. An over-the-air update is still a change to the app's shell: it counts as live only once it has been seen on the owner's phone.
