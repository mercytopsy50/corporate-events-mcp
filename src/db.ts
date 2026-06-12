import { DatabaseSync } from "node:sqlite";
import { createHash }   from "node:crypto";
import type { CorporateEvent, DataSource, PollState, PipelineHealth } from "./types.js";

// ── Schema ────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id                TEXT PRIMARY KEY,
  company           TEXT NOT NULL,
  ticker            TEXT,
  isin              TEXT,
  jurisdiction      TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  event_date        TEXT,
  announcement_date TEXT NOT NULL,
  source            TEXT NOT NULL,
  source_url        TEXT NOT NULL UNIQUE,
  raw_title         TEXT NOT NULL,
  details           TEXT NOT NULL,
  normalized_at     TEXT NOT NULL,
  is_amendment      INTEGER NOT NULL DEFAULT 0,
  amends_id         TEXT
);
CREATE INDEX IF NOT EXISTS idx_ev_company      ON events (company COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_ev_ticker       ON events (ticker  COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_ev_type         ON events (event_type);
CREATE INDEX IF NOT EXISTS idx_ev_jurisdiction ON events (jurisdiction);
CREATE INDEX IF NOT EXISTS idx_ev_ann_date     ON events (announcement_date DESC);
CREATE INDEX IF NOT EXISTS idx_ev_event_date   ON events (event_date DESC);

CREATE TABLE IF NOT EXISTS poll_state (
  source         TEXT PRIMARY KEY,
  last_polled_at TEXT,
  last_item_date TEXT,
  status         TEXT NOT NULL DEFAULT 'never',
  error          TEXT
);

CREATE TABLE IF NOT EXISTS ticker_cache (
  ticker       TEXT PRIMARY KEY,
  cik          TEXT NOT NULL,
  company_name TEXT NOT NULL,
  cached_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS historical_cache (
  cache_key  TEXT PRIMARY KEY,
  result     TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

// ── DB wrapper ────────────────────────────────────────────────────────────

export class EventsDB {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  // ── helpers ──────────────────────────────────────────────────────────

  static makeId(source: string, sourceUrl: string): string {
    return createHash("sha256").update(`${source}:${sourceUrl}`).digest("hex").slice(0, 24);
  }

  // ── event writes ─────────────────────────────────────────────────────

  upsertEvent(ev: CorporateEvent): void {
    this.db.prepare(`
      INSERT INTO events
        (id,company,ticker,isin,jurisdiction,event_type,event_date,
         announcement_date,source,source_url,raw_title,details,normalized_at,
         is_amendment,amends_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_url) DO UPDATE SET
        event_type    = excluded.event_type,
        event_date    = excluded.event_date,
        raw_title     = excluded.raw_title,
        details       = excluded.details,
        normalized_at = excluded.normalized_at,
        is_amendment  = excluded.is_amendment,
        amends_id     = excluded.amends_id
    `).run(
      ev.id, ev.company, ev.ticker, ev.isin, ev.jurisdiction, ev.event_type,
      ev.event_date, ev.announcement_date, ev.source, ev.source_url,
      ev.raw_title, JSON.stringify(ev.details), ev.normalized_at,
      ev.is_amendment ? 1 : 0, ev.amends_id,
    );
  }

  upsertEvents(events: CorporateEvent[]): void {
    for (const ev of events) this.upsertEvent(ev);
  }

  // ── event reads ──────────────────────────────────────────────────────

  getCompanyEvents(opts: {
    query:        string;
    jurisdictions?: string[];
    eventTypes?:    string[];
    daysBack?:      number;
    limit?:         number;
  }): CorporateEvent[] {
    const days  = opts.daysBack ?? 30;
    const limit = Math.min(opts.limit ?? 20, 100);
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const q     = `%${opts.query}%`;

    const conditions: string[] = [
      "(company LIKE ? OR ticker LIKE ? OR isin LIKE ?)",
      "announcement_date >= ?",
    ];
    const params: unknown[]  = [q, q, q, since];

    if (opts.jurisdictions?.length) {
      conditions.push(`jurisdiction IN (${opts.jurisdictions.map(() => "?").join(",")})`);
      params.push(...opts.jurisdictions);
    }
    if (opts.eventTypes?.length) {
      conditions.push(`event_type IN (${opts.eventTypes.map(() => "?").join(",")})`);
      params.push(...opts.eventTypes);
    }

    params.push(limit);
    const rows = this.db.prepare(`
      SELECT * FROM events WHERE ${conditions.join(" AND ")}
      ORDER BY announcement_date DESC LIMIT ?
    `).all(...(params as Parameters<typeof this.db.prepare>[0][])) as Record<string, unknown>[];
    return rows.map(this.hydrate);
  }

  searchEvents(opts: {
    eventTypes?:    string[];
    jurisdictions?: string[];
    fromDate?:      string;
    toDate?:        string;
    limit?:         number;
    offset?:        number;
  }): CorporateEvent[] {
    const limit  = Math.min(opts.limit ?? 50, 200);
    const offset = opts.offset ?? 0;
    const conditions: string[] = [];
    const params: unknown[]    = [];

    if (opts.fromDate) { conditions.push("announcement_date >= ?"); params.push(opts.fromDate); }
    if (opts.toDate)   { conditions.push("announcement_date <= ?"); params.push(opts.toDate);   }
    if (opts.eventTypes?.length) {
      conditions.push(`event_type IN (${opts.eventTypes.map(() => "?").join(",")})`);
      params.push(...opts.eventTypes);
    }
    if (opts.jurisdictions?.length) {
      conditions.push(`jurisdiction IN (${opts.jurisdictions.map(() => "?").join(",")})`);
      params.push(...opts.jurisdictions);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit, offset);
    const rows = this.db.prepare(`
      SELECT * FROM events ${where}
      ORDER BY announcement_date DESC LIMIT ? OFFSET ?
    `).all(...(params as Parameters<typeof this.db.prepare>[0][])) as Record<string, unknown>[];
    return rows.map(this.hydrate);
  }

  getRecentEvents(opts: {
    hours?:         number;
    eventTypes?:    string[];
    jurisdictions?: string[];
  }): CorporateEvent[] {
    const hours = Math.min(opts.hours ?? 24, 72);
    // Filter by announcement_date, not normalized_at.
    // normalized_at reflects ingestion time — on first startup the ASX poller
    // fetches the last 20 announcements per company regardless of date, so
    // old events get stored with a fresh normalized_at. Filtering by
    // announcement_date returns events that were actually announced recently.
    const since = new Date(Date.now() - hours * 3_600_000).toISOString().slice(0, 10);
    const conditions: string[] = ["announcement_date >= ?"];
    const params: unknown[]    = [since];

    if (opts.eventTypes?.length) {
      conditions.push(`event_type IN (${opts.eventTypes.map(() => "?").join(",")})`);
      params.push(...opts.eventTypes);
    }
    if (opts.jurisdictions?.length) {
      conditions.push(`jurisdiction IN (${opts.jurisdictions.map(() => "?").join(",")})`);
      params.push(...opts.jurisdictions);
    }

    params.push(200);
    const rows = this.db.prepare(`
      SELECT * FROM events WHERE ${conditions.join(" AND ")}
      ORDER BY normalized_at DESC LIMIT ?
    `).all(...(params as Parameters<typeof this.db.prepare>[0][])) as Record<string, unknown>[];
    return rows.map(this.hydrate);
  }

  // ── pipeline health ───────────────────────────────────────────────────

  getHealth(): PipelineHealth {
    const SOURCES: Array<{ source: DataSource; jurisdiction: "US" | "UK" | "CA" | "AU" }> = [
      { source: "SEC_EDGAR", jurisdiction: "US" },
      { source: "LSE_RNS",  jurisdiction: "UK" },
      { source: "SEDAR",    jurisdiction: "CA" },
      { source: "ASX",      jurisdiction: "AU" },
    ];

    const since24h = new Date(Date.now() - 86_400_000).toISOString();

    const sources = SOURCES.map(({ source, jurisdiction }) => {
      const ps = this.db.prepare(
        "SELECT * FROM poll_state WHERE source = ?",
      ).get(source) as Record<string, unknown> | undefined;

      const count = (this.db.prepare(
        "SELECT COUNT(*) AS c FROM events WHERE source = ?",
      ).get(source) as { c: number }).c;

      const lastDate = (this.db.prepare(
        "SELECT MAX(announcement_date) AS d FROM events WHERE source = ?",
      ).get(source) as { d: string | null }).d;

      return {
        source,
        jurisdiction,
        last_polled_at:  (ps?.last_polled_at as string | null) ?? null,
        status:          (ps?.status as "ok" | "error" | "never") ?? "never",
        events_indexed:  count,
        last_event_date: lastDate,
        error:           (ps?.error as string | null) ?? null,
      };
    });

    const total       = (this.db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;
    const last24h     = (this.db.prepare("SELECT COUNT(*) AS c FROM events WHERE normalized_at >= ?").get(since24h) as { c: number }).c;
    const byTypeRows  = this.db.prepare("SELECT event_type, COUNT(*) AS c FROM events GROUP BY event_type").all() as Array<{ event_type: string; c: number }>;
    const byJuriRows  = this.db.prepare("SELECT jurisdiction, COUNT(*) AS c FROM events GROUP BY jurisdiction").all() as Array<{ jurisdiction: string; c: number }>;

    return {
      sources,
      total_events:            total,
      events_last_24h:         last24h,
      events_by_type:          Object.fromEntries(byTypeRows.map(r => [r.event_type, r.c])),
      events_by_jurisdiction:  Object.fromEntries(byJuriRows.map(r => [r.jurisdiction, r.c])),
    };
  }

  // ── Historical result cache (24h TTL) ────────────────────────────────────

  getCachedHistorical(key: string): { events: CorporateEvent[]; hasMore: boolean; partial?: boolean } | null {
    const row = this.db.prepare(
      "SELECT result FROM historical_cache WHERE cache_key = ? AND expires_at > ?",
    ).get(key, Date.now()) as { result: string } | undefined;
    if (!row) return null;
    try { return JSON.parse(row.result); } catch { return null; }
  }

  setCachedHistorical(key: string, result: { events: CorporateEvent[]; hasMore: boolean; partial?: boolean }): void {
    const ttl = 24 * 60 * 60 * 1000;
    this.db.prepare(`
      INSERT INTO historical_cache (cache_key, result, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET result = excluded.result, expires_at = excluded.expires_at
    `).run(key, JSON.stringify(result), Date.now() + ttl);
  }

  // Full event array cache — keyed without offset/limit so all pagination
  // variants for the same company+range share one EDGAR fetch.
  getCachedHistoricalFull(key: string): CorporateEvent[] | null {
    const row = this.db.prepare(
      "SELECT result FROM historical_cache WHERE cache_key = ? AND expires_at > ?",
    ).get(key, Date.now()) as { result: string } | undefined;
    if (!row) return null;
    try { return JSON.parse(row.result) as CorporateEvent[]; } catch { return null; }
  }

  setCachedHistoricalFull(key: string, events: CorporateEvent[]): void {
    const ttl = 24 * 60 * 60 * 1000;
    this.db.prepare(`
      INSERT INTO historical_cache (cache_key, result, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET result = excluded.result, expires_at = excluded.expires_at
    `).run(key, JSON.stringify(events), Date.now() + ttl);
  }

  // ── Jurisdiction health (inline zero-result pipeline status) ─────────────
  // Called automatically by search_events / get_recent_events when total=0
  // so the model gets pipeline health in the same response and never needs
  // a separate get_pipeline_health call just to verify the pipeline is alive.

  getJurisdictionHealth(jurisdictions: string[]): Record<string, {
    source: string; last_polled_at: string | null; status: string;
    events_indexed: number; last_event_date: string | null;
  }> {
    const JURI_SOURCE: Record<string, DataSource> = {
      US: "SEC_EDGAR", UK: "LSE_RNS", CA: "SEDAR", AU: "ASX",
    };
    const result: Record<string, unknown> = {};
    for (const j of jurisdictions) {
      const source = JURI_SOURCE[j];
      if (!source) continue;
      const ps    = this.db.prepare("SELECT * FROM poll_state WHERE source = ?").get(source) as Record<string, unknown> | undefined;
      const count = (this.db.prepare("SELECT COUNT(*) AS c FROM events WHERE source = ?").get(source) as { c: number }).c;
      const last  = (this.db.prepare("SELECT MAX(announcement_date) AS d FROM events WHERE source = ?").get(source) as { d: string | null }).d;
      result[j]   = {
        source,
        last_polled_at:  (ps?.last_polled_at as string | null) ?? null,
        status:          (ps?.status as string) ?? "never",
        events_indexed:  count,
        last_event_date: last,
      };
    }
    return result as Record<string, { source: string; last_polled_at: string | null; status: string; events_indexed: number; last_event_date: string | null }>;
  }

  // ── poll state ────────────────────────────────────────────────────────

  getPollState(source: DataSource): PollState {
    const row = this.db.prepare("SELECT * FROM poll_state WHERE source = ?").get(source) as Record<string, unknown> | undefined;
    return {
      source,
      last_polled_at: (row?.last_polled_at as string | null) ?? null,
      last_item_date: (row?.last_item_date as string | null) ?? null,
      status:         (row?.status as "ok" | "error" | "never") ?? "never",
      error:          (row?.error as string | null) ?? null,
    };
  }

  setPollState(source: DataSource, state: Omit<PollState, "source">): void {
    this.db.prepare(`
      INSERT INTO poll_state (source, last_polled_at, last_item_date, status, error)
      VALUES (?,?,?,?,?)
      ON CONFLICT(source) DO UPDATE SET
        last_polled_at = excluded.last_polled_at,
        last_item_date = excluded.last_item_date,
        status         = excluded.status,
        error          = excluded.error
    `).run(source, state.last_polled_at, state.last_item_date, state.status, state.error);
  }

  // ── ticker cache ──────────────────────────────────────────────────────

  getTickerByCIK(cik: string): { ticker: string; company_name: string } | null {
    const row = this.db.prepare(
      "SELECT ticker, company_name FROM ticker_cache WHERE cik = ? LIMIT 1"
    ).get(cik) as { ticker: string; company_name: string } | undefined;
    return row ?? null;
  }

  getCachedCIK(ticker: string): { cik: string; company_name: string } | null {
    const TTL_H = 24;
    const since = new Date(Date.now() - TTL_H * 3_600_000).toISOString();
    const row   = this.db.prepare(
      "SELECT * FROM ticker_cache WHERE ticker = ? AND cached_at >= ?",
    ).get(ticker.toUpperCase(), since) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { cik: row.cik as string, company_name: row.company_name as string };
  }

  cacheTickerMap(entries: Array<{ ticker: string; cik: string; company_name: string }>): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO ticker_cache (ticker, cik, company_name, cached_at)
      VALUES (?,?,?,?)
      ON CONFLICT(ticker) DO UPDATE SET cik = excluded.cik, company_name = excluded.company_name, cached_at = excluded.cached_at
    `);
    for (const e of entries) stmt.run(e.ticker, e.cik, e.company_name, now);
  }

  searchTickerCache(query: string): Array<{ ticker: string; cik: string; company_name: string }> {
    const rows = this.db.prepare(
      "SELECT ticker, cik, company_name FROM ticker_cache WHERE company_name LIKE ? LIMIT 10",
    ).all(`%${query}%`) as Array<{ ticker: string; cik: string; company_name: string }>;
    return rows;
  }

  close(): void {
    this.db.close();
  }

  setAmendsId(id: string, amendsId: string): void {
    this.db.prepare("UPDATE events SET amends_id = ? WHERE id = ?").run(amendsId, id);
  }

  // ── amendment resolution ──────────────────────────────────────────────

  // Find the most recent non-amendment event from the same company with the
  // same item types, filed before this amendment's date — used to link
  // 8-K/A filings back to the 8-K they correct.
  findOriginalForAmendment(
    company:      string,
    eventType:    string,
    beforeDate:   string,
    itemsJson:    string,
  ): string | null {
    const row = this.db.prepare(`
      SELECT id FROM events
      WHERE company = ? AND event_type = ? AND announcement_date < ?
        AND is_amendment = 0 AND source = 'SEC_EDGAR'
        AND json_extract(details, '$.items') = json(?4)
      ORDER BY announcement_date DESC
      LIMIT 1
    `).get(company, eventType, beforeDate, itemsJson) as { id: string } | undefined;
    return row?.id ?? null;
  }

  // ── private ───────────────────────────────────────────────────────────

  private hydrate(row: Record<string, unknown>): CorporateEvent {
    return {
      id:                row.id                as string,
      company:           row.company           as string,
      ticker:            (row.ticker           as string | null) ?? null,
      isin:              (row.isin             as string | null) ?? null,
      jurisdiction:      row.jurisdiction      as CorporateEvent["jurisdiction"],
      event_type:        row.event_type        as CorporateEvent["event_type"],
      event_date:        (row.event_date       as string | null) ?? null,
      announcement_date: row.announcement_date as string,
      source:            row.source            as CorporateEvent["source"],
      source_url:        row.source_url        as string,
      raw_title:         row.raw_title         as string,
      details:           JSON.parse(row.details as string) as Record<string, unknown>,
      normalized_at:     row.normalized_at     as string,
      is_amendment:      Boolean(row.is_amendment),
      amends_id:         (row.amends_id        as string | null) ?? null,
    };
  }
}
