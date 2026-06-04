import { EventsDB }              from "./db.js";
import { fetchTickerMap, fetchRecentEdgar8Ks } from "./sources/edgar.js";
import { fetchRecentRNS }        from "./sources/rns.js";
import { fetchRecentASX }        from "./sources/asx.js";
import { fetchRecentSEDAR }      from "./sources/sedar.js";

// Poll intervals
const INTERVALS = {
  SEC_EDGAR: 60 * 60 * 1_000,       // 1 hour
  LSE_RNS:   2  * 60 * 60 * 1_000,  // 2 hours
  ASX:       6  * 60 * 60 * 1_000,  // 6 hours
  SEDAR:     12 * 60 * 60 * 1_000,  // 12 hours
} as const;

// How far back to look on the first ever poll
const INITIAL_LOOKBACK_DAYS = 3;

export class Poller {
  private readonly db: EventsDB;

  constructor(db: EventsDB) {
    this.db = db;
  }

  start(): void {
    console.log("[poller] started");

    // Stagger initial polls to avoid hammering everything at once
    this.runEdgar();
    setTimeout(() => this.runRNS(),   15_000);
    setTimeout(() => this.runASX(),   30_000);
    setTimeout(() => this.runSEDAR(), 45_000);

    // Initialise ticker cache on first run (big one-time fetch)
    setTimeout(() => this.refreshTickerCache(), 5_000);

    setInterval(() => this.runEdgar(),       INTERVALS.SEC_EDGAR);
    setInterval(() => this.runRNS(),         INTERVALS.LSE_RNS);
    setInterval(() => this.runASX(),         INTERVALS.ASX);
    setInterval(() => this.runSEDAR(),       INTERVALS.SEDAR);
    // Refresh ticker map once a day
    setInterval(() => this.refreshTickerCache(), 24 * 60 * 60 * 1_000);
  }

  // ── Per-source runners ─────────────────────────────────────────────────

  async runEdgar(): Promise<void> {
    const ps    = this.db.getPollState("SEC_EDGAR");
    const since = ps.last_item_date
      ? addDays(ps.last_item_date, -1)                    // overlap 1 day to catch late filings
      : addDays(today(), -INITIAL_LOOKBACK_DAYS);

    try {
      console.log(`[poll] SEC_EDGAR since ${since}`);
      const events = await fetchRecentEdgar8Ks(since);
      this.db.upsertEvents(events);
      this.db.setPollState("SEC_EDGAR", {
        last_polled_at: new Date().toISOString(),
        last_item_date: today(),
        status:         "ok",
        error:          null,
      });
      console.log(`[poll] SEC_EDGAR +${events.length} events`);
    } catch (err) {
      console.error("[poll] SEC_EDGAR error:", err);
      this.db.setPollState("SEC_EDGAR", {
        last_polled_at: new Date().toISOString(),
        last_item_date: ps.last_item_date,
        status:         "error",
        error:          String(err),
      });
    }
  }

  async runRNS(): Promise<void> {
    const ps    = this.db.getPollState("LSE_RNS");
    const since = ps.last_item_date
      ? addDays(ps.last_item_date, -1)
      : addDays(today(), -INITIAL_LOOKBACK_DAYS);

    try {
      console.log(`[poll] LSE_RNS since ${since}`);
      const events = await fetchRecentRNS(since);
      this.db.upsertEvents(events);
      this.db.setPollState("LSE_RNS", {
        last_polled_at: new Date().toISOString(),
        last_item_date: today(),
        status:         "ok",
        error:          null,
      });
      console.log(`[poll] LSE_RNS +${events.length} events`);
    } catch (err) {
      console.error("[poll] LSE_RNS error:", err);
      this.db.setPollState("LSE_RNS", {
        last_polled_at: new Date().toISOString(),
        last_item_date: ps.last_item_date,
        status:         "error",
        error:          String(err),
      });
    }
  }

  async runASX(): Promise<void> {
    try {
      console.log("[poll] ASX");
      const events = await fetchRecentASX();
      this.db.upsertEvents(events);
      this.db.setPollState("ASX", {
        last_polled_at: new Date().toISOString(),
        last_item_date: today(),
        status:         "ok",
        error:          null,
      });
      console.log(`[poll] ASX +${events.length} events`);
    } catch (err) {
      console.error("[poll] ASX error:", err);
      const ps = this.db.getPollState("ASX");
      this.db.setPollState("ASX", {
        last_polled_at: new Date().toISOString(),
        last_item_date: ps.last_item_date,
        status:         "error",
        error:          String(err),
      });
    }
  }

  async runSEDAR(): Promise<void> {
    const ps    = this.db.getPollState("SEDAR");
    const since = ps.last_item_date
      ? addDays(ps.last_item_date, -1)
      : addDays(today(), -INITIAL_LOOKBACK_DAYS);

    try {
      console.log(`[poll] SEDAR+ since ${since}`);
      const events = await fetchRecentSEDAR(since);
      this.db.upsertEvents(events);
      this.db.setPollState("SEDAR", {
        last_polled_at: new Date().toISOString(),
        last_item_date: today(),
        status:         "ok",
        error:          null,
      });
      console.log(`[poll] SEDAR +${events.length} events`);
    } catch (err) {
      console.error("[poll] SEDAR error:", err);
      this.db.setPollState("SEDAR", {
        last_polled_at: new Date().toISOString(),
        last_item_date: ps.last_item_date,
        status:         "error",
        error:          String(err),
      });
    }
  }

  async refreshTickerCache(): Promise<void> {
    try {
      console.log("[ticker-cache] fetching SEC EDGAR ticker map (~4MB)");
      const entries = await fetchTickerMap();
      this.db.cacheTickerMap(entries);
      console.log(`[ticker-cache] cached ${entries.length} tickers`);
    } catch (err) {
      console.error("[ticker-cache] error:", err);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
