# The dashboard on your phone, over Tailscale

The owner dashboard listens on the hub machine's loopback address only (`127.0.0.1:8788`). The Cloudflare tunnel never points at it. To open it from your phone, put the phone and the hub on your Tailscale network and opt in. The dashboard then also listens on the hub's Tailscale address, and only the devices you list can open it.

## Turn it on

`pocketbrain phone` does all of this section and the https one below in one command, for a phone ([phone-app.md](phone-app.md#pairing)). By hand:

On the hub machine, run this with your phone's Tailscale address (the Tailscale app shows it under the phone's name):

```
pocketbrain dashboard tailnet on --device 100.121.236.72
```

It writes two owner settings and commits them as you. They go in `rules/hub.yaml` once the brain has one, otherwise in `rules/policy.yaml`:

```yaml
dashboard_tailnet: true
dashboard_tailnet_devices: [100.121.236.72]
```

Run it again with another `--device` to add a device. `pocketbrain dashboard tailnet off` turns it off and keeps the list. Restart the hub to apply either.

`dashboard_tailnet_devices` lists the Tailscale addresses (`100.x.y.z`) of the devices that may open the dashboard. The Tailscale app shows each device's address under its name. A Tailscale account can hold other machines too, such as a box an assistant runs on, so being signed in to your account is not enough: a device that isn't listed gets "This device isn't one of the devices you listed". With the list empty or missing, no device gets in, and `pocketbrain doctor` warns. The hub machine itself needs no entry; on it, use the localhost link as before.

Or start it by hand with `pocketbrain start --dashboard-tailnet` or `pocketbrain dashboard --tailnet`.

Restart the hub. It keeps a second login link, for the tailnet, beside the local one in `.git/pb-dashboard-login` in the brain folder (owner-only, never committed, a new one at each restart; `cat` it on the Mac). The hub's log names the address and that file, never the link: launchd keeps the log (audit v10, G609). The simplest way onto the phone is `pocketbrain dashboard phone-link` (below), a link that works once. The tailnet link looks like:

```
http://mini.tail1234.ts.net:8788/login?key=…
```

Open a link once on the phone, in Safari, while Tailscale is connected. Use the link as printed: the full name (`<machine>.<tailnet>.ts.net`) or the Tailscale address work, but the short machine name (`http://mini:8788`) gets "only answers on this computer's own address". The phone stays signed in for 30 days, across hub restarts and closing Safari; the login link itself changes at each hub restart. The link holds the login key, so treat it like a password. Sending it to yourself (a message to your own number) is fine; don't paste it anywhere shared.

**Signed out on the phone later?** The page there has *Text me a sign-in link*. It texts a fresh link to your own phone over your text channel (`transport` in `rules/escalation.yaml`), but only a channel that reaches your phone directly (iMessage or Twilio from this Mac); a channel an assistant relays, such as Instinct, never carries one, and the page says so. Opening a phone link shows a *Sign in* button and spends nothing, so a message preview can't use it up; the button spends it. Opening a link again while signed in goes to the home page. A phone link works once, lasts a day, survives hub restarts, and opens only from your listed devices on the tailnet, never on localhost. At most 3 are sent an hour. On the Mac, `pocketbrain dashboard phone-link` prints one instead. Unused links are kept in `.git/pb-phone-links.json` (by hash, owner-only), the newest 5.

Safari's Share, then Add to Home Screen, gives the dashboard an icon. The dashboard declares no web-app manifest, so the icon opens it in Safari itself, with the same sign-in.

If Tailscale isn't up when the hub starts, the log says so and the dashboard stays on localhost. Restart the hub once Tailscale is up.

### Over HTTPS with `tailscale serve`

For a real certificate (and for links other features may send), also serve the dashboard over HTTPS on its own port. Add your Tailscale login next to those settings (in `rules/hub.yaml`, or `rules/policy.yaml` without one):

```yaml
dashboard_tailnet: true
dashboard_tailnet_login: you@example.com   # the login `tailscale whois` shows for your phone
```

and run this once on the hub:

```
tailscale serve --bg --https=8443 http://127.0.0.1:8788
```

The port is 8443, not 443, because a `tailscale funnel` (the public door some setups use for agents) may already hold 443, and serve and funnel share a port's settings. The same file keeps a third login link, `https://<machine>.<tailnet>.ts.net:8443/login?key=…`. Without `dashboard_tailnet_login` the HTTPS path stays off.

Never use `tailscale funnel` for the dashboard: that publishes it on the internet. The dashboard refuses funnel traffic anyway (see below).

## What protects it

The second listener binds the hub's Tailscale IPv4 address on the same port, and only when you opt in. On top of what the dashboard already does on localhost (login link, HttpOnly cookie, CSRF token on every action, no-store, strict CSP), it:

- Sets the sign-in cookie `SameSite=Lax` here (localhost keeps `Strict`), so the phone's browser keeps it when a link is opened from Messages. Every action still needs the session's CSRF token and a same-origin `Origin`, and no page changes anything on a GET.

- Answers only connections from a device in `dashboard_tailnet_devices`, by the connection's own address, never a header. The address must also sit in the tailnet's ranges (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). Tailscale gives each device a fixed address, so another machine on your account, or a neighbour on a carrier-grade NAT link that also uses `100.64.0.0/10`, gets 403 unless it holds a listed address.
- Accepts only this machine's tailnet names as `Host`, and as `Origin` on actions: its Tailscale address and its MagicDNS name, both from `tailscale status --json` (never guessed from an interface in `100.64.0.0/10`, which is also carrier-grade NAT). A public name, a loopback name or another `*.ts.net` name gets 421 (DNS rebinding).
- Never lends its names to the loopback listener, and the loopback listener never lends its names to the tailnet one. A page on one can't post to the other.
- Through `tailscale serve`, the loopback listener accepts `<name>:8443` as `Host`, and `https://<name>:8443` as `Origin`, only when `Tailscale-User-Login` equals `dashboard_tailnet_login` and `X-Forwarded-For` is a listed device. Tailscale sets the first to the tailnet user and the second to the device's tailnet address, replacing any copy the client sent. Another tailnet user gets 403, and so does another machine on your own account. A request carrying `Tailscale-Funnel-Request` or any `Cf-*` header (Cloudflare) gets 403. The bare name or `<name>:443` gets 421. The strip-and-set behaviour is from Tailscale's documentation and source for serve's identity and forwarding headers, not tested here against a live tailnet. Another process on the hub could forge either header on loopback, so the login key and cookie still apply on top. `X-Forwarded-For` counts only on this path, where Tailscale wrote it; nowhere else.
- The sign-in cookie on the HTTPS path is also `Secure`.
- `pocketbrain doctor` fails if `dashboard_tailnet_login` is set but `tailscale serve status` shows nothing serving https on 8443 to the dashboard (the hub's health probe raises the same as a `phone_door` alert, G629; Serve has to be on for your tailnet too, which Tailscale's own enable link turns on), and if it shows a funnel on 8443 or the dashboard port, or a tunnel rule forwards to them, and warns when `dashboard_tailnet_login` is set while the tailnet dashboard is off, or when the tailnet dashboard is on with no device listed.
- If the hub can't bind the Tailscale address, the log says so and the dashboard stays on localhost; the hub keeps running.
- The pocketBrain phone app signs in on these same two paths only: it pairs with a phone link and then uses Face ID instead of another link. See [phone-app.md](phone-app.md).
- An action's redirect goes back to the page it came from only when that is a path on the dashboard itself; anything starting `//` goes to `/`.

The Cloudflare tunnel ingress (`pocketbrain hub tunnel-config`) still points at the agents' port only, and no dashboard path matches it. Red-team cases `rt-dash-tailnet-not-public`, `rt-dash-tailnet-serve-owner-only`, `rt-dash-tailnet-own-devices`, `rt-dash-tailnet-bind-and-sources` and `rt-dash-redirect-stays-home` (gaps G99–G105, G139–G141), and `test/dashboard-tailnet.test.ts` pin all of this.

## Not done here

- The device list is by address. A device that gets a new Tailscale address (removed and added back) needs its new address listed.
