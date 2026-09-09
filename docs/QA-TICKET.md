# QA-TICKET — the template of the sprint's QA round-1 ticket

The cutter files this ticket with the sprint (RULES `cutter` 8). Label `qa-run`; the board sends it to a Mac lane
in the role `qa` once its dependency is merged. The walker files one `qa` ticket per finding — the record of the
round — and, if there were any, the round-2 ticket from the same text (RULES `qa` 5). The fix is not one ticket
per finding: the cutter folds a round's findings into one fix ticket on one lane (RULES `cutter` 4).

```
Title: QA R1 — <sprint title>

Part of #<umbrella>.
depends on: #<work ticket>

## Walk
Site: https://autopase.lv — PRODUCTION. Real browser: headed Chromium via Playwright, header
`x-autopase-monitor` from the lane's `.env.local`, user agent `autopase-route-health/1.0`. A Vercel
checkpoint page = say so in the report and stop that probe.
Deployed commit: `curl -s https://autopase.lv/api/health/ready` → `revision`; compare with `origin/main` (wait up to
15 minutes for a lagging deploy, RULES qa 2).
Proof beyond the screen (RULES qa 8–9): read the rows back with the read-only DB role, check `info@autopase.lv`
with `qa-mail.mjs`, push screenshots + `REPORT.md` to `autopase-evidence/<sprint>/QA-R<n>/` and link them.
Locales: RU, LV, EN. Viewports: 1280×900, 1024×800, 1023×800, 820×1000, 390×844, 360×800.
Cabinet: every surface that touches the cabinet (`/kabinets-v2`, listing add/edit/publish, photos, contacts,
messages) is walked in the LIVE cabinet, signed in as the QA account: `node ~/kitchens/autopase.lv/qa/qa-login.mjs`
prints a single-use sign-in link (valid 2 h) — open it in the browser, then go to `/ru/kabinets-v2`.
Walk the real flow end to end (add a listing by URL and by hand, upload a photo, see it rendered, publish).
The internal preview page (`/internal/account-questionnaire-preview`) is a supplement, never the proof.
Leave the QA account clean: delete the listings you created before closing the ticket.

## Surfaces (one line per surface: ticket, title, URL or path, mock path if the ticket names one)
- #<ticket> <title> — <URL> — mock: <path or none>
- …

## Checks
- Content counted, not status codes (a page that renders zero items is a finding).
- Screenshot beside the mock where one exists; list every difference.
- Console clean of errors; numbers (scrollWidth / clientWidth) where the ticket claims geometry.
- Every interaction the sprint's tickets describe, on every locale and viewport listed.

## Finish
Findings as `qa` tickets (one per defect, at once; same-file findings carry `depends on (merged): #n - same file`, RULES common 9); the round comment on #<umbrella>; the report;
then close this ticket (RULES `qa` 4–7).
```
