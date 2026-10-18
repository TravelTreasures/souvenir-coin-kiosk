# Souvenir Coin Kiosk — Central Fleet Admin

A centralized web application to monitor and manage many Souvenir Coin kiosks from one place.
Zero external dependencies (runs on Node's built-in server) and a JSON-file data store, so you
can run it immediately on any machine with Node 18+.

> This is the central server from the fleet plan (`../FLEET_ARCHITECTURE.md`). For a large
> production fleet, the JSON store can be swapped for PostgreSQL — the API stays the same.

---

## Run it (local test)

```bash
cd fleet-admin
npm start
```

Then open **http://localhost:9090** and sign in.

- Default login: username **`admin`**, password **`fleet-admin`**.
- On first start it **seeds demo data** (5 kiosks across 3 destinations, sample sales and
  alerts) so every dashboard is populated. To reset, delete the `data/` folder and restart.

Set the first admin's credentials and port:
```bash
FLEET_ADMIN_USER=admin FLEET_ADMIN_PASSWORD=YourStrongPass FLEET_PORT=9090 npm start
```

### Users & roles

The dashboard has named user accounts (passwords hashed with Node's scrypt):

- **Admin** — full control (pricing, onboarding, status, alerts, maintenance, user management).
- **Viewer** — read-only access to all dashboards.

Admins manage accounts in **Users** (top of the fleet view): add users, set role, reset
passwords, delete. Change the default admin's password there after first login. Kiosks are
unaffected — they authenticate with their own per-kiosk API keys, not user logins.

---

## What's included

**Main dashboard** — every kiosk in one view: name/ID, location, online/offline, last
communication, operational status (Active / Maintenance / Out of Service), and quick metrics
(sales today, hopper levels, open alerts). Click a kiosk to drill in. Auto-refreshes (~8s).

**Kiosk detail dashboard** — per-kiosk: info & location, real-time health, coin inventory per
hopper, transaction history, sales reporting (today/week/month/all), alerts (with resolve),
maintenance log (add/view), connectivity status, software version, and the ability to change
operational status.

**Global reporting** — totals across all kiosks: sales, revenue, transactions, coins in
hoppers, kiosks online, open alerts, and revenue by location.

**Site pricing** — set a coin price per location; kiosks pull and confirm it.

**Coin Images** (admin) — **per kiosk**: pick a kiosk, then upload its own Coin 1 and Coin 2
(each location has distinct coins). Uploading publishes straight to that kiosk; a per-kiosk
version history lets you revert. Kiosks download and display their own images on next sync
(bundled defaults are used until an image is set).

**Users & roles** — Admin (full control) vs Viewer (read-only); managed in the Users screen.

**Kiosk profile management** — each kiosk's detail page (Overview) shows its **API key**
(copy any time), a **Regenerate key** action (invalidates the old key), and a **Delete kiosk**
action that removes the profile and all its data. Admin only.

**Audit & backup** (admin) — the **Audit** screen records every admin change (who/what/when);
**Download backup** exports the whole dataset as a timestamped JSON file.

**Onboarding** — "Add Kiosk" creates a kiosk record and generates its API key.

---

## How kiosks connect (next step)

The server already exposes ingest endpoints (authenticated with each kiosk's API key):

| Endpoint | Purpose |
|---|---|
| `POST /api/ingest/heartbeat` | status, hopper counts, connectivity, version |
| `POST /api/ingest/sync` | upload new transactions/alerts (deduplicated) |
| `GET /api/ingest/config` | pull this kiosk's destination/coin config |

The kiosk app needs a small **sync client** (in its Electron main process) that calls these on
a timer using the kiosk's API key. That's the next build step (fleet Phase 2 — connect the
kiosk). Until then, the demo seed data drives the dashboards.

---

## Security / deployment

- Set a strong `FLEET_ADMIN_PASSWORD`.
- The server is plain HTTP — for internet access put it behind HTTPS (a managed host like
  Render/Railway/Fly, or a reverse proxy / Cloudflare Tunnel).
- Staff use a password → session token; kiosks use per-kiosk API keys (revocable by removing
  the kiosk).
