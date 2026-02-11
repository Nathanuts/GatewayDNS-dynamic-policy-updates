# GatewayDNS Dynamic Policy Updates

A Cloudflare Worker that dynamically updates Cloudflare Gateway DNS policies based on real-time aircraft positions. Each aircraft in the fleet has a dedicated DNS resolver IP, and the worker automatically moves that IP between region-specific Gateway Lists as the aircraft crosses regional boundaries.

## How It Works

```
Every 1 minute (cron trigger):
  For each aircraft in the fleet:
    1. Fetch live position (lat/lon) from Flightradar24 API
    2. Reverse geocode coordinates to country via OpenCage API
    3. Map country to a region (SEA, EU, NA, etc.)
    4. Compare with previous region stored in KV
    5. If region changed:
       - PATCH Cloudflare Gateway List: remove resolver IP from old region list
       - PATCH Cloudflare Gateway List: append resolver IP to new region list
    6. Update KV state
```

### Architecture Diagram

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Cron Trigger │───▶│  FR24 API    │───▶│  OpenCage    │
│  (1 min)      │    │  (lat/lon)   │    │  (country)   │
└──────────────┘    └──────────────┘    └──────┬───────┘
                                               │
                                               ▼
                                     ┌──────────────────┐
                                     │  determineRegion  │
                                     │  (country → region)│
                                     └────────┬─────────┘
                                              │
                         ┌────────────────────┼────────────────────┐
                         ▼                    ▼                    ▼
                  ┌─────────────┐    ┌──────────────┐    ┌──────────────┐
                  │  KV Store   │    │  CF Gateway  │    │  CF Gateway  │
                  │  (state)    │    │  List: OLD   │    │  List: NEW   │
                  │             │    │  remove IP   │    │  append IP   │
                  └─────────────┘    └──────────────┘    └──────────────┘
```

### Region Mapping

Aircraft positions are mapped to 9 regions based on country ISO codes:

| Region | Code  | Coverage |
|--------|-------|----------|
| Southeast Asia | `SEA` | SG, MY, TH, VN, PH, ID, MM, KH, LA, BN, TL |
| Northeast Asia | `NEA` | JP, KR, CN, TW, HK, MO, MN |
| South Asia | `SA` | IN, LK, BD, PK, MV, NP, BT, AF |
| Oceania | `OCE` | AU, NZ, PG, FJ, and Pacific Islands |
| Middle East | `ME` | AE, QA, SA, OM, BH, KW, IQ, IR, JO, LB, IL, PS, YE |
| Europe | `EU` | GB, FR, DE, IT, ES, and all EU/European countries, TR, RU |
| Africa | `AF` | ZA, KE, EG, NG, ET, and other African countries |
| North America | `NA` | US, CA, MX, Caribbean, Central America |
| Latin America | `LATAM` | BR, AR, CL, CO, PE, and other South American countries |

If the aircraft is **over water** (no country detected), it retains its previous region to prevent policy flapping.

### Gateway Lists & Rules

The system uses **Cloudflare Zero Trust Gateway Lists** (type: IP) — one per region. Each list holds the resolver IPs of aircraft currently in that region.

**Gateway Rules** are created manually in the Cloudflare dashboard, each referencing a region list:

```
Rule: "SIA-rDNS-SEA"
  Traffic selector: dns.src_ip in $sia-rdns-sea-list
  Action: configured DNS policy for SEA region
```

When an aircraft moves from EU to NA:
1. Worker removes its resolver IP from the `SIA-rDNS-EU` list
2. Worker appends its resolver IP to the `SIA-rDNS-NA` list
3. The Gateway Rule for NA now matches that aircraft's DNS traffic

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install`)
- Cloudflare account with Zero Trust enabled
- API keys for Flightradar24 and OpenCage

### 1. Install Dependencies

```bash
npm install
```

### 2. Create Gateway Lists

Create 9 Gateway Lists in the Cloudflare Zero Trust dashboard (Gateway > Lists), one per region, all of type **IP**:

- `SIA-rDNS-SEA`
- `SIA-rDNS-NEA`
- `SIA-rDNS-SA`
- `SIA-rDNS-OCE`
- `SIA-rDNS-ME`
- `SIA-rDNS-EU`
- `SIA-rDNS-AF`
- `SIA-rDNS-NA`
- `SIA-rDNS-LATAM`

Copy each list's UUID and update `REGION_LIST_IDS` in `src/index.js`.

### 3. Create Gateway Rules

Create 9 Gateway DNS rules in the Cloudflare Zero Trust dashboard (Gateway > Firewall Policies > DNS), each referencing one of the region lists:

- **Traffic selector**: `DNS Source IP in <region-list>`
- **Action**: your desired DNS policy for that region

### 4. Configure Fleet

Edit the `FLEET` array in `src/index.js` to define your aircraft:

```js
const FLEET = [
  { registration: '9V-SGA', resolver_ip: '10.0.1.1' },
  { registration: '9V-SGB', resolver_ip: '10.0.1.2' },
  // ... up to 56 aircraft
];
```

Each aircraft must have a unique `resolver_ip` that is used as its DNS source IP.

### 5. Configure Secrets

For **local development**, create a `.dev.vars` file:

```
FR24_API_KEY=your-flightradar24-api-key
OPENCAGE_API_KEY=your-opencage-api-key
CF_ACCOUNT_ID=your-cloudflare-account-id
CF_API_TOKEN=your-cloudflare-api-token
```

For **production**, set secrets via Wrangler:

```bash
npx wrangler secret put FR24_API_KEY
npx wrangler secret put OPENCAGE_API_KEY
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_API_TOKEN
```

> The `CF_API_TOKEN` needs **Gateway: Edit** permissions.

### 6. Run Locally

```bash
npx wrangler dev
```

Manually trigger the cron:

```bash
curl http://localhost:8787/cdn-cgi/handler/scheduled
```

### 7. Deploy

```bash
npx wrangler deploy
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /track?registration=9V-SGA` | Track a single aircraft (live position + region) |
| `GET /state` | View all aircraft states from KV |
| `GET /state?registration=9V-SGA` | View a single aircraft's state |
| `GET /fleet` | View fleet configuration |
| `GET /clear-state` | Clear all KV state (dev/testing) |
| `GET /clear-state?registration=9V-SGA` | Clear a single aircraft's state |

## Cloudflare API Details

The worker uses the **PATCH** method on the Gateway Lists API to append/remove items without overwriting the list:

```
PATCH /accounts/{account_id}/gateway/lists/{list_id}
```

**Append an IP:**
```json
{ "name": "SIA-rDNS-NA", "append": [{ "value": "10.0.1.1" }] }
```

**Remove an IP:**
```json
{ "name": "SIA-rDNS-EU", "remove": ["10.0.1.1"] }
```

> **Warning:** Do NOT use `PUT` on this endpoint — it overwrites the entire list.

## Example Log Output

```
[* * * * *] Processing 3 aircraft...
[* * * * *] 9V-SGA: SEA | Singapore | 1.35, 103.99
[* * * * *] 9V-SGB: REGION CHANGED EU → NA (United States of America) | IP: 10.0.1.2
[* * * * *] 9V-SGB: [DEBUG] PATCH .../gateway/lists/ee22b873-... {"name":"SIA-rDNS-EU","remove":["10.0.1.2"]}
[* * * * *] 9V-SGB: Removed 10.0.1.2 from EU list
[* * * * *] 9V-SGB: [DEBUG] PATCH .../gateway/lists/436b0564-... {"name":"SIA-rDNS-NA","append":[{"value":"10.0.1.2"}]}
[* * * * *] 9V-SGB: Added 10.0.1.2 to NA list
[* * * * *] 9V-SGC: Over water (Indian Ocean), keeping region: SA
```
