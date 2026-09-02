# QA-TICKET — the template of the sprint's QA round-1 ticket

The cutter files this ticket with the sprint (RULES `cutter` 8). Label `qa-run`; the board sends it to a Mac lane
in the role `qa` once every dependency is merged. The walker files findings as `qa` tickets and, if there were
any, the round-2 ticket from the same text (RULES `qa` 5).

```
Title: QA R1 — <sprint title>

Part of #<umbrella>.
depends on: #<unit 1>, #<unit 2>, … (every unit of the sprint)

## Walk
Site: https://autopase.lv — PRODUCTION. Real browser: headed Chromium via Playwright, header
`x-autopase-monitor` from the lane's `.env.local`, user agent `autopase-route-health/1.0`. A Vercel
checkpoint page = say so in the report and stop that probe.
Deployed commit: read it from <where the site exposes it, e.g. the /api/health build field> and compare with
`origin/main`.
Locales: RU, LV, EN. Viewports: 1280×900, 1024×800, 1023×800, 820×1000, 390×844, 360×800.
Cabinet: every unit that touches the cabinet (`/kabinets-v2`, listing add/edit/publish, photos, contacts,
messages) is walked in the LIVE cabinet, signed in as the QA account: `node ~/kitchens/autopase.lv/qa/qa-login.mjs`
prints a single-use sign-in link (valid 2 h) — open it in the browser, then go to `/ru/kabinets-v2`.
Walk the real flow end to end (add a listing by URL and by hand, upload a photo, see it rendered, publish).
The internal preview page (`/internal/account-questionnaire-preview`) is a supplement, never the proof.
Leave the QA account clean: delete the listings you created before closing the ticket.

## Surfaces (one line per unit: ticket, title, URL or path, mock path if the ticket names one)
- #<unit> <title> — <URL> — mock: <path or none>
- …

## Checks
- Content counted, not status codes (a page that renders zero items is a finding).
- Screenshot beside the mock where one exists; list every difference.
- Console clean of errors; numbers (scrollWidth / clientWidth) where the ticket claims geometry.
- Every interaction the unit tickets describe, on every locale and viewport listed.

## Finish
Findings as `qa` tickets (one per defect, at once); the round comment on #<umbrella>; the report;
then close this ticket (RULES `qa` 4–7).
```
