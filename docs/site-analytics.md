# Site analytics without tracking

The launch site counts how many people look and how many install, and nothing about who they are. The counter is `site/analytics.ts`, a Cloudflare Worker that sits in front of the site's few routes. It isn't part of the `pocketbrain` package and never touches a brain.

## What it counts

One record per UTC day (`day:YYYY-MM-DD` in Workers KV), with four totals:

| Total | Where it comes from |
| --- | --- |
| `views` | one per page view, by page. Only the pages listed in `PAGES` get their own line; any other path, query string or fragment counts as `other`, so stray paths can't fill the store |
| `installs` | one per download of `/install.sh`. A download is not a finished install: `curl ... \| sh` that fails later still counted |
| `from` | the referrer's host only (`news.ycombinator.com`, `linkedin.com`), lower-cased with `www.` dropped. Its path and query, links back to the site itself and anything that isn't an `http(s)` address are left out |
| `countries` | Cloudflare's two-letter `CF-IPCountry`, counted, never stored per visitor |

## What it never does

- It reads no IP address, user agent, cookie, `Accept-Language` or screen size, and keeps no id, hash or fingerprint, not even a daily one. So there are no "unique visitors": a person who looks twice counts twice.
- It sets no cookie and the beacon (`/count.js`) uses no browser storage, so the site needs no consent banner.
- The beacon sends only the page's path and `document.referrer`, once per view, with `navigator.sendBeacon`.

The tests in `test/site-analytics.test.ts` pin both lists: a hit with an address, a browser string and a cookie leaves none of them in the store, and no response sets a cookie.

## Routes

| Route | Does |
| --- | --- |
| `POST /hit` | the beacon's page view; answers 204 |
| `GET /count.js` | the beacon, one line; the page loads it with `<script defer src="/count.js"></script>` |
| `GET /install.sh` | fetches the installer from `INSTALL_SCRIPT_URL`, serves it unchanged and counts it. If the fetch fails it answers 502 and counts nothing |
| `GET /git/...` | redirects to `SOURCE_REPO_URL` with the same path, so the installer clones from `https://pocketbrain.dev/git` and git follows it to the public source. Counts nothing; an empty `SOURCE_REPO_URL` turns it off |
| `GET /stats` | the last 30 days, newest first, plus totals. Needs `Authorization: Bearer <STATS_TOKEN>`; an empty token turns it off |

Everything else is 404, so the worker is routed only on those paths and the site itself is served as usual.

## Limits

- Two hits on the same day at the same instant can lose one count: KV has no atomic increment. For a launch site's totals that is close enough; a busier site would move the record to a Durable Object.
- Bots that run JavaScript count as views, and every `curl` of the installer counts as an install, CI included.

## Setting it up

Deploying it puts it on the public domain, so it's the owner's step, done once:

1. Create a KV namespace: `wrangler kv namespace create COUNTS`.
2. Create `site/wrangler.toml` with `main = "analytics.ts"`, the KV binding `COUNTS`, the vars `PAGES`, `INSTALL_SCRIPT_URL` and `SOURCE_REPO_URL` (the public repository's `.git` address), and routes for `/hit`, `/count.js`, `/install.sh`, `/git*` and `/stats` on the site's domain.
3. Set the token as a secret, never in the file: `wrangler secret put STATS_TOKEN`.
4. `wrangler deploy` from `site/`, then add the beacon tag to the site's pages.
5. Check: `curl -s -H "Authorization: Bearer $TOKEN" https://<site>/stats`.
