# The phone app's sign-in

The owner opens the dashboard on a phone over Tailscale ([dashboard-tailnet.md](dashboard-tailnet.md)). In a browser, every sign-in is a texted link that opens in Safari, and anything private asks for another one after 10 minutes (`FRESH_MINUTES` in `src/dashboard/server.ts`). The pocketBrain app for iOS and Android shows the same owner pages and signs in its own way: it pairs once with a phone link, then Face ID makes a sign-in fresh again. The hub gives the app no other data route: it loads the same pages, under the same cookie, CSRF and Host rules.

## Pairing

1. Get a phone link: `pocketbrain dashboard phone-link` on the hub machine, or the signed-out page's "Text me a sign-in link". It is the same link a browser uses: one use, a day.
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
