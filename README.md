# corporate-events-mcp

Cross-jurisdiction corporate events normalization via MCP. A single consistent schema covering earnings dates, dividend announcements, stock splits, and M&A announcements across US (SEC EDGAR), UK (GlobeNewswire/RNS), Canada (GlobeNewswire/CNW), and Australia (ASX Market Announcements).

Replaces Refinitiv Datastream ($10,000-22,000/yr), Bloomberg Terminal corporate actions module ($24,000/yr), and FactSet corporate events data ($8,000-15,000/yr) with a programmatic, agent-callable API.

## What it is

| Signal | Source | Coverage |
|--------|--------|---------|
| Earnings, dividends, splits, M&A | SEC EDGAR EFTS + submissions API | All public US companies, back to early 1990s |
| Regulatory announcements | GlobeNewswire UK RSS | UK/LSE-listed companies (sparse; FCA NSM requires auth) |
| Press releases, material changes | GlobeNewswire Canada RSS | TSX/TSX-V companies with ISIN and ticker |
| Market announcements | ASX MarkitDigital API | ASX200 + on-demand per code |
| Amendment resolution | In-process DB linkage | 8-K/A linked to original 8-K via amends_id |

No mobile device data. No scraping official registries. All sources are free and public.

## Data Sources

| Source | Jurisdiction | Auth | Poll Interval |
|--------|-------------|------|--------------|
| SEC EDGAR EFTS + submissions API | US | None (User-Agent header required) | Hourly |
| GlobeNewswire country/United-Kingdom RSS | UK | None | 2 hours |
| GlobeNewswire country/Canada RSS | CA | None | 12 hours |
| ASX MarkitDigital /companies/{code}/announcements | AU | None | 6 hours (rotating ASX200 batch) |

## MCP Tools

### `get_company_events`
Events for a specific company by ticker, ISIN, or company name substring. On-demand enrichment fires all four sources in parallel if the company is not cached.

**Input:** `{ "query": "AAPL", "jurisdiction": ["US"], "event_type": ["earnings"], "days_back": 90, "limit": 20 }`

### `search_events`
Filter events by type, jurisdiction, and date range. Served from SQLite — sub-10ms warm.

**Input:** `{ "event_type": ["dividend","earnings"], "jurisdiction": ["AU","CA"], "from_date": "2026-01-01", "limit": 50 }`

### `get_recent_events`
Latest events across all jurisdictions ordered by ingestion time.

**Input:** `{ "hours": 24, "event_type": ["merger_acquisition"] }`

### `get_pipeline_health`
Last poll time per source, event counts, status (ok/error/never). Verify freshness before time-sensitive queries.

**Input:** `{}` (no parameters)

### `fetch_historical_events`
Historical 8-K filings for a US company from SEC EDGAR back to the early 1990s. Walks `filings.files[]` pagination. US only.

**Input:** `{ "query": "JPM", "from_date": "2015-01-01", "to_date": "2016-12-31", "limit": 200 }`

## Normalized Event Schema

```json
{
  "id": "a3f9b2c1d4e5f6a7b8c9d0e1",
  "company": "Apple Inc.",
  "ticker": "AAPL",
  "isin": null,
  "jurisdiction": "US",
  "event_type": "earnings",
  "event_date": null,
  "announcement_date": "2026-04-30",
  "source": "SEC_EDGAR",
  "source_url": "https://www.sec.gov/Archives/edgar/data/320193/.../aapl-20260430.htm",
  "raw_title": "8-K — 2.02,9.01",
  "details": { "form_type": "8-K", "items": ["2.02", "9.01"], "accession": "0000320193-26-000011" },
  "normalized_at": "2026-06-04T00:00:00.000Z",
  "is_amendment": false,
  "amends_id": null
}
```

## Amendment Flagging

`is_amendment: true` is set when form type is `8-K/A`. After upsert, `resolveAmendments()` queries the DB for the most recent prior `8-K` from the same company with matching item types and sets `amends_id` to link them.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No (default 3000) | Server port |
| `DB_PATH` | No (default ./data/events.sqlite) | SQLite database path |

No external API keys required.

## Running Locally

```bash
npm install
npm run dev
```

Ticker cache loads ~10 seconds after startup (10,365 US tickers). EDGAR polling runs immediately.

```bash
# Pipeline health
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_pipeline_health","arguments":{}}}' \
  | python3 -c "import sys,json; h=json.load(sys.stdin)['result']['structuredContent']; [print(f'  {s[\"source\"]:12} {s[\"status\"]} events={s[\"events_indexed\"]}') for s in h['sources']]"

# AAPL events
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_company_events","arguments":{"query":"AAPL","days_back":90}}}' \
  | python3 -c "import sys,json; r=json.load(sys.stdin)['result']['structuredContent']; [print(e['announcement_date'], e['event_type'], e['raw_title'][:50]) for e in r['events'][:5]]"

# Historical depth
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"fetch_historical_events","arguments":{"query":"JPM","from_date":"2015-01-01","to_date":"2016-12-31"}}}' \
  | python3 -c "import sys,json; r=json.load(sys.stdin)['result']['structuredContent']; print('Total:', r['total_found'])"
```

## Deployment (Railway)

Push to GitHub, connect repo in Railway. Set `DB_PATH=/data/events.sqlite` and add a volume mounted at `/data` to persist events across restarts.

## Coverage Notes and Limitations

**US (SEC EDGAR):** Full coverage, hourly polling, historical depth to early 1990s.

**Australia (ASX):** ASX MarkitDigital API confirmed working at `/companies/{code}/announcements`. Background polling rotates 30 ASX200 codes in batches of 10 per cycle. On-demand fetch available for any ASX code.

**Canada (GlobeNewswire):** GlobeNewswire Canada RSS confirmed working with real TSX tickers and ISIN codes. SEDAR+ does not have a confirmed accessible public API endpoint.

**UK (GlobeNewswire):** GlobeNewswire UK country feed is sparse. FCA NSM returns HTTP 403. Investegate XML returns 404. UK coverage is best-effort — events_indexed may remain at 0 during quiet periods.

**Not implemented:** Exchange-validated settlement data (DTCC/CREST/CHESS are commercial), real-time intraday corrections, historical depth for non-US jurisdictions.

## Not Financial Advice

This tool provides factual corporate event data from official and proxy sources. It does not constitute financial or investment advice.
