# LinkedIn People Scraper

Node.js CLI that uses **Puppeteer** and a **session cookie** you provide to open a LinkedIn **company People** URL (with your filters already applied), collect profile fields from each visible card, and save **JSON** (and optionally **CSV**) under `output/`.

### Fields per person

| Field | Description |
|--------|--------------|
| `name` | Display name |
| `profileUrl` | Canonical `https://www.linkedin.com/in/.../` link |
| `connectionDegree` | `1st`, `2nd`, or `3rd` / `3rd+` when shown on the card |
| `company1`, `company2`, `company3` | Up to three distinct **company names** taken from `/company/` links visible on that card (often only one on People search; others may be `null`) |
| `about` | Headline / secondary text from the card (heuristic; may combine short lines if no single long line exists) |

LinkedIn’s DOM changes often—if a field is often empty, adjust the heuristics in `scraper.js` (`extractPeopleData`).

## Legal notice

LinkedIn’s [User Agreement](https://www.linkedin.com/legal/user-agreement) and [robots.txt](https://www.linkedin.com/robots.txt) restrict automated access. **You** must ensure your use complies with applicable law and LinkedIn’s terms. This tool is provided as-is for legitimate, authorized scenarios only.

## Requirements

- Node.js 18+
- A valid LinkedIn session cookie string (often includes `li_at=...`)

## Install

```bash
cd linkedin-people-scraper
npm install
```

## Usage

Environment variables (optional if you pass flags):

- `LINKEDIN_COOKIE` — cookie header string, e.g. `li_at=xxxx; JSESSIONID=...`
- `LINKEDIN_URL` — full People page URL with your filters
- `MAX_PEOPLE` — default `200`
- `HEADLESS=0` — run with UI (useful for debugging)
- `PUPPETEER_NO_SANDBOX=1` — add `--no-sandbox` for Linux/Docker

CLI:

```bash
node index.js --cookie "$LINKEDIN_COOKIE" --url "https://www.linkedin.com/company/..."
node index.js --cookie "$LINKEDIN_COOKIE" --url "$LINKEDIN_URL" --max 200 --format json
node index.js --cookie "$LINKEDIN_COOKIE" --url "$LINKEDIN_URL" --format both --headed
```

Formats: `json` (default), `csv`, `both`.

### Exit codes

| Code | Meaning |
|------|--------|
| 0 | Success |
| 1 | Usage / configuration error |
| 2 | Session invalid (login / checkpoint) |
| 3 | Navigation failed after retries |
| 4 | No people extracted |

## Cookie format

Paste the same shape your browser sends: semicolon-separated `name=value` pairs. At minimum, `li_at` must be present and valid for an authenticated session.

**Security:** Never commit cookies or `.env` with secrets. `output/` is gitignored for scrape results.

## Troubleshooting

- If **0 people** are collected, LinkedIn’s HTML likely changed—adjust heuristics in `scraper.js` (`extractPeopleData`) against the current page.
- If you hit **login** or **checkpoint**, refresh your cookie from a logged-in browser session.

## Project layout

- `index.js` — CLI entry
- `config.js` — delays, limits, timeouts
- `scraper.js` — Puppeteer flow
- `utils/fileHandler.js` — JSON/CSV writes
- `utils/logger.js` — console logging
