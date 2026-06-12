import "dotenv/config";
import express, { type Request, type Response } from "express";
import { createContextMiddleware }               from "@ctxprotocol/sdk";
import { DatabaseSync }                          from "node:sqlite";
import { mkdirSync }                             from "node:fs";

import { EventsDB }                       from "./db.js";
import { Poller }                         from "./poller.js";
import { fetchCompanyEdgarEvents, fetchEdgarHistorical } from "./sources/edgar.js";
import { fetchCompanyRNS }                from "./sources/rns.js";
import { fetchCompanyASX }                from "./sources/asx.js";
import { fetchCompanySEDAR }              from "./sources/sedar.js";
import type { CorporateEvent }            from "./types.js";

// ── Init ──────────────────────────────────────────────────────────────────

mkdirSync("./data", { recursive: true });
const DB_PATH = process.env["DB_PATH"] ?? "./data/events.sqlite";
const db      = new EventsDB(DB_PATH);
const poller  = new Poller(db);
poller.start();

const app  = express();
app.use(express.json());
const PORT = parseInt(process.env["PORT"] ?? "3000", 10);

// ── Output schemas ────────────────────────────────────────────────────────

const EVENT_SCHEMA = {
  type: "object",
  properties: {
    id:                { type: "string"                  },
    company:           { type: "string"                  },
    ticker:            { type: ["string","null"]          },
    isin:              { type: ["string","null"]          },
    jurisdiction:      { type: "string", enum: ["US","UK","CA","AU"] },
    event_type:        { type: "string", enum: ["earnings","dividend","split","merger_acquisition","other"] },
    event_date:        { type: ["string","null"]          },
    announcement_date: { type: "string"                  },
    source:            { type: "string", enum: ["SEC_EDGAR","LSE_RNS","SEDAR","ASX"] },
    source_url:        { type: "string"                  },
    raw_title:         { type: "string"                  },
    details:           { type: "object"                  },
    normalized_at:     { type: "string"                  },
    is_amendment:      { type: "boolean", description: "true for 8-K/A or correction filings" },
    amends_id:         { type: ["string","null"], description: "id of the original event this corrects, if resolved" },
  },
  required: ["id","company","jurisdiction","event_type","announcement_date","source","source_url","raw_title"],
};

const EVENTS_LIST_SCHEMA = {
  type: "object",
  properties: {
    events:       { type: "array",  items: EVENT_SCHEMA    },
    total_found:  { type: "number"                         },
    query_params: { type: "object"                         },
    note:         { type: "string"                         },
  },
  required: ["events","total_found"],
};

const HEALTH_SOURCE_SCHEMA = {
  type: "object",
  properties: {
    source:          { type: "string" },
    jurisdiction:    { type: "string" },
    last_polled_at:  { type: ["string","null"] },
    status:          { type: "string", enum: ["ok","error","never"] },
    events_indexed:  { type: "number" },
    last_event_date: { type: ["string","null"] },
    error:           { type: ["string","null"] },
  },
  required: ["source","jurisdiction","status","events_indexed"],
};

// ── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "get_company_events",
    description: [
      "Retrieve corporate events for a specific company across US, UK, Canadian, and Australian markets.",
      "Accepts ticker symbols (AAPL, BHP.AX, RIO.L), ISIN codes, or company name substrings.",
      "Returns earnings dates, dividend announcements, stock splits, and M&A announcements.",
      "Data is sourced from SEC EDGAR (US), FCA NSM/RNS (UK), SEDAR+ (CA), and ASX (AU).",
      "Replaces Refinitiv Datastream ($10k–22k/yr) and Bloomberg Terminal corporate actions module ($24k/yr).",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Ticker symbol (AAPL, BHP, RIO), ISIN (US0378331005), or company name substring (Apple, BHP Group).",
          examples: ["AAPL", "BHP", "RIO", "US0378331005", "Apple Inc"],
        },
        jurisdiction: {
          type: "array",
          items: { type: "string", enum: ["US","UK","CA","AU"] },
          description: "Filter to specific jurisdictions. Omit for all.",
          default: ["US","UK","CA","AU"],
        },
        event_type: {
          type: "array",
          items: { type: "string", enum: ["earnings","dividend","split","merger_acquisition","other"] },
          description: "Filter by event type. Omit for all types.",
        },
        days_back: {
          type: "number",
          description: "How many calendar days back to search. Default 30, max 365.",
          default: 30,
          minimum: 1,
          maximum: 365,
        },
        limit: {
          type: "number",
          description: "Max events to return. Default 20, max 100.",
          default: 20,
          minimum: 1,
          maximum: 100,
        },
      },
      required: ["query"],
      examples: [
        { query: "AAPL", days_back: 90 },
        { query: "BHP", jurisdiction: ["AU"], event_type: ["dividend","earnings"] },
      ],
    },
    outputSchema: EVENTS_LIST_SCHEMA,
    _meta: { surface: "both", queryEligible: true },
  },

  {
    name: "search_events",
    description: [
      "Search and filter corporate events by type, jurisdiction, and date range across all four markets.",
      "Best for: screening for all earnings in a date range, all M&A activity in a jurisdiction,",
      "or building a corporate calendar for a portfolio of positions.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        event_type: {
          type: "array",
          items: { type: "string", enum: ["earnings","dividend","split","merger_acquisition","other"] },
          description: "Event types to include. Omit for all.",
          default: ["earnings","dividend","split","merger_acquisition"],
        },
        jurisdiction: {
          type: "array",
          items: { type: "string", enum: ["US","UK","CA","AU"] },
          description: "Jurisdictions to include. Omit for all.",
          default: ["US","UK","CA","AU"],
        },
        from_date: {
          type: "string",
          description: "Start date ISO 8601 (YYYY-MM-DD). Defaults to 30 days ago.",
          examples: ["2024-01-01"],
        },
        to_date: {
          type: "string",
          description: "End date ISO 8601 (YYYY-MM-DD). Defaults to today.",
          examples: ["2024-01-31"],
        },
        limit:  { type: "number", default: 50,  minimum: 1, maximum: 200 },
        offset: { type: "number", default: 0,   minimum: 0,              },
      },
      required: [],
      examples: [
        { event_type: ["earnings"], jurisdiction: ["US"], from_date: "2024-01-01" },
        { event_type: ["dividend"], limit: 100 },
      ],
    },
    outputSchema: EVENTS_LIST_SCHEMA,
    _meta: { surface: "both", queryEligible: true },
  },

  {
    name: "get_recent_events",
    description: [
      "Return the most recent corporate events across all jurisdictions, ordered by ingestion time.",
      "Useful for a live feed view: 'what happened in the last 24 hours across US, UK, Canada, Australia?'",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        hours: {
          type: "number",
          description: "Lookback window in hours. Default 24, max 72.",
          default: 24,
          minimum: 1,
          maximum: 72,
        },
        event_type: {
          type: "array",
          items: { type: "string", enum: ["earnings","dividend","split","merger_acquisition","other"] },
          description: "Filter by event type. Omit for all.",
        },
        jurisdiction: {
          type: "array",
          items: { type: "string", enum: ["US","UK","CA","AU"] },
          description: "Filter by jurisdiction. Omit for all.",
        },
      },
      required: [],
      examples: [
        { hours: 24 },
        { hours: 48, event_type: ["earnings","dividend"], jurisdiction: ["US","UK"] },
      ],
    },
    outputSchema: EVENTS_LIST_SCHEMA,
    _meta: { surface: "both", queryEligible: true },
  },

  {
    name: "get_pipeline_health",
    description: [
      "Return ingestion pipeline status: last poll time per source, event counts, and any errors.",
      "Use this to verify data freshness before relying on get_recent_events for time-sensitive decisions.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      examples: [{}],
    },
    outputSchema: {
      type: "object",
      properties: {
        sources:                 { type: "array", items: HEALTH_SOURCE_SCHEMA },
        total_events:            { type: "number" },
        events_last_24h:         { type: "number" },
        events_by_type:          { type: "object", additionalProperties: { type: "number" } },
        events_by_jurisdiction:  { type: "object", additionalProperties: { type: "number" } },
      },
      required: ["sources","total_events","events_last_24h"],
    },
    _meta: { surface: "both", queryEligible: false },
  },

  {
    name: "fetch_historical_events",
    description: [
      "Fetch historical 8-K filings for a US company from SEC EDGAR, going back years or decades.",
      "EDGAR history extends to the early 1990s for all public US companies.",
      "Useful for multi-year earnings records, historical M&A activity, or long-term dividend history.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Ticker (AAPL) or company name (Apple Inc). US-listed companies only.",
          default: "AAPL",
          examples: ["AAPL", "MSFT", "JPM", "Berkshire Hathaway"],
        },
        from_date: {
          type: "string",
          description: "Start date YYYY-MM-DD. EDGAR history goes to early 1990s.",
          default: "2024-01-01",
          examples: ["2010-01-01", "2000-01-01"],
        },
        to_date: {
          type: "string",
          description: "End date YYYY-MM-DD. Defaults to today.",
          examples: ["2024-12-31"],
        },
        limit: {
          type: "number",
          description: "Max events to return per page. Default 100, max 200.",
          default: 100,
          minimum: 1,
          maximum: 200,
        },
        offset: {
          type: "number",
          description: "Number of events to skip for pagination. Use with limit to page through results when has_more is true.",
          default: 0,
          minimum: 0,
        },
      },
      required: ["query", "from_date"],
      examples: [
        { query: "AAPL", from_date: "2015-01-01" },
        { query: "JPM",  from_date: "2010-01-01", to_date: "2020-12-31", limit: 200, offset: 0 },
        { query: "JPM",  from_date: "2010-01-01", to_date: "2020-12-31", limit: 200, offset: 200 },
      ],
    },
    outputSchema: EVENTS_LIST_SCHEMA,
    _meta: { surface: "both", queryEligible: true },
  },
];

// ── Tool handler ──────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {

    case "get_company_events": {
      const query        = String(args.query ?? "");
      const jurisdictions = args.jurisdiction as string[] | undefined;
      const eventTypes    = args.event_type   as string[] | undefined;
      const daysBack      = Number(args.days_back ?? 30);
      const limit         = Number(args.limit ?? 20);

      if (!query.trim()) throw new Error("query is required");

      // First: check our SQLite cache
      let events = db.getCompanyEvents({ query, jurisdictions, eventTypes, daysBack, limit });

      // On-demand enrichment: if very few results and the query looks like a ticker, fetch from source
      if (events.length < 3 && query.length <= 10 && /^[A-Z0-9.]+$/i.test(query)) {
        const ticker = query.toUpperCase().replace(".AX", "").replace(".L", "");
        await enrichFromSources(ticker, query);
        events = db.getCompanyEvents({ query, jurisdictions, eventTypes, daysBack, limit });
      }

      return {
        events,
        total_found:    events.length,
        query_params:   { query, daysBack, limit },
      };
    }

    case "search_events": {
      const today = new Date().toISOString().slice(0, 10);
      const from  = addDays(today, -90);
      const events = db.searchEvents({
        eventTypes:    args.event_type    as string[] | undefined,
        jurisdictions: args.jurisdiction  as string[] | undefined,
        fromDate:      (args.from_date    as string | undefined) ?? from,
        toDate:        (args.to_date      as string | undefined) ?? today,
        limit:         Number(args.limit  ?? 50),
        offset:        Number(args.offset ?? 0),
      });
      // When 0 results, inline pipeline health for the queried jurisdictions so
      // the model can verify data freshness without a separate get_pipeline_health call.
      const juris2 = (args.jurisdiction as string[] | undefined) ?? ["US","UK","CA","AU"];
      const pipelineStatus2 = events.length === 0
        ? db.getJurisdictionHealth(juris2)
        : null;
      return { events, total_found: events.length, pipeline_status: pipelineStatus2, query_params: args };
    }

    case "get_recent_events": {
      const events = db.getRecentEvents({
        hours:         Number(args.hours ?? 24),
        eventTypes:    args.event_type    as string[] | undefined,
        jurisdictions: args.jurisdiction  as string[] | undefined,
      });
      const juris3 = (args.jurisdiction as string[] | undefined) ?? ["US","UK","CA","AU"];
      const pipelineStatus3 = events.length === 0
        ? db.getJurisdictionHealth(juris3)
        : null;
      return { events, total_found: events.length, pipeline_status: pipelineStatus3, query_params: args };
    }

    case "fetch_historical_events": {
      const query    = String(args.query ?? "").trim();
      const fromDate = String(args.from_date ?? "");
      const toDate   = String(args.to_date   ?? new Date().toISOString().slice(0, 10));
      const limit    = Math.min(Number(args.limit  ?? 100), 200);
      const offset   = Math.max(Number(args.offset ?? 0),   0);

      if (!query) throw new Error("query is required");
      if (!fromDate.match(/^\d{4}-\d{2}-\d{2}$/)) throw new Error("from_date must be YYYY-MM-DD");

      // Look up CIK
      const ticker  = query.toUpperCase();
      const cached  = db.getCachedCIK(ticker);
      let cik: string | null = cached?.cik ?? null;
      let companyName        = cached?.company_name ?? query;

      if (!cik) {
        const matches = db.searchTickerCache(query);
        if (matches[0]) { cik = matches[0].cik; companyName = matches[0].company_name; }
      }

      if (!cik) {
        return {
          events:       [],
          total_found:  0,
          has_more:     false,
          offset,
          query_params: { query, fromDate, toDate, limit, offset },
          note:         `Ticker '${query}' not found in cache. The SEC ticker map loads on startup (~30s). Retry after the server has fully initialised.`,
        };
      }

      const { events, hasMore, partial, allEvents } = await (async () => {
        // Cache the full event array keyed by (cik, fromDate, toDate) only —
        // no offset or limit in the key. This means the first call for any
        // (company, date range) fetches EDGAR once (36s). All subsequent calls
        // at any offset or limit — including the model paginating through pages —
        // are served from the same cached array in <1ms.
        const fullKey    = `hist-full:${cik}:${fromDate}:${toDate}`;
        const cachedFull = db.getCachedHistoricalFull(fullKey);

        if (cachedFull) {
          const slice = cachedFull.slice(offset, offset + limit);
          return { events: slice, hasMore: cachedFull.length > offset + limit, partial: false, allEvents: cachedFull };
        }

        // Cold path: fetch with limit=500 so we get all events in one EDGAR
        // fetch (most companies have <500 8-Ks in any multi-year range).
        const result = await fetchEdgarHistorical(cik!, companyName, ticker, fromDate, toDate, 500, 0);
        if (!result.partial) {
          db.setCachedHistoricalFull(fullKey, result.events);
        }
        const slice = result.events.slice(offset, offset + limit);
        return { events: slice, hasMore: result.hasMore || result.events.length > offset + limit, partial: result.partial, allEvents: result.events };
      })();

      db.upsertEvents(events);
      resolveAmendments(events);

      const byType:  Record<string, number> = {};
      const byYear:  Record<string, number> = {};
      let   amendmentCount = 0;
      for (const ev of events) {
        byType[ev.event_type] = (byType[ev.event_type] ?? 0) + 1;
        const yr = ev.announcement_date.slice(0, 4);
        byYear[yr] = (byYear[yr] ?? 0) + 1;
        if (ev.is_amendment) amendmentCount++;
      }

      // Lean event shape — fields commented out are available via get_company_events
      // for drill-down. Keeping the bulk response small prevents platform truncation,
      // which is what forces the model into expensive code_interpreter processing.
      type EvDetails = Record<string, unknown>;
      const leanEvents = events
        .slice()
        .sort((a, b) => a.announcement_date.localeCompare(b.announcement_date))
        .map(ev => ({
          id:                ev.id,
          announcement_date: ev.announcement_date,
          event_type:        ev.event_type,
          raw_title:         ev.raw_title,
          source_url:        ev.source_url,
          is_amendment:      ev.is_amendment,
          amends_id:         ev.amends_id,
          // fields omitted from bulk response to reduce response size:
          // company:        ev.company,
          // ticker:         ev.ticker,
          // isin:           ev.isin,
          // jurisdiction:   ev.jurisdiction,
          // event_date:     ev.event_date,
          // source:         ev.source,
          // normalized_at:  ev.normalized_at,
          // details: {
          //   form_type:         (ev.details as EvDetails)["form_type"],
          //   items:             (ev.details as EvDetails)["items"],
          //   item_descriptions: (ev.details as EvDetails)["item_descriptions"],
          //   accession:         (ev.details as EvDetails)["accession"],
          //   filing_url:        (ev.details as EvDetails)["filing_url"],
          // },
        }));

      // Pre-computed subsets — O(1) path lookup for the evidence engine instead
      // of an O(N) scan through the full events array.
      const earningsEvents   = leanEvents.filter(e => e.event_type === "earnings");
      const amendmentEvents  = leanEvents.filter(e => e.is_amendment);

      // range_summary covers ALL events in the date range across all pages —
      // not just this page. This means the model never needs to paginate just
      // to compute totals; a single call gives the complete picture.
      const rangeByType:  Record<string, number> = {};
      const rangeByYear:  Record<string, number> = {};
      let   rangeAmendments = 0;
      for (const ev of (allEvents ?? events)) {
        rangeByType[ev.event_type] = (rangeByType[ev.event_type] ?? 0) + 1;
        const yr = ev.announcement_date.slice(0, 4);
        rangeByYear[yr] = (rangeByYear[yr] ?? 0) + 1;
        if (ev.is_amendment) rangeAmendments++;
      }

      return {
        events:           leanEvents,
        earnings_events:  earningsEvents,
        amendments:       amendmentEvents,
        events_in_page:   events.length,
        has_more:         hasMore,
        total_is_known:   !hasMore,
        offset,
        range_summary: {
          total_events:    (allEvents ?? events).length,
          by_event_type:   rangeByType,
          by_year:         rangeByYear,
          amendment_count: rangeAmendments,
          earliest_date:   (allEvents ?? events).length ? (allEvents ?? events)[(allEvents ?? events).length - 1]!.announcement_date : null,
          latest_date:     (allEvents ?? events)[0]?.announcement_date ?? null,
          complete:        !partial,
        },
        summary: {
          by_event_type:   byType,
          by_year:         byYear,
          amendment_count: amendmentCount,
          earliest_date:   events.length ? events[events.length - 1]!.announcement_date : null,
          latest_date:     events[0]?.announcement_date ?? null,
          note:            hasMore ? "page-scoped — see range_summary for complete date range totals" : "complete",
        },
        search_context: `All 8-K and 8-K/A filings for ${companyName} (${ticker}) between ${fromDate} and ${toDate} from SEC EDGAR. range_summary contains complete statistics for ALL ${(allEvents ?? events).length} events across the full date range — use it for totals and breakdowns without paginating. Pre-computed subsets: earnings_events (${earningsEvents.length} items on this page) and amendments (${amendmentEvents.length} items on this page) are available as top-level keys.${hasMore ? ` This page contains ${events.length} events (offset ${offset}). has_more: true — further events exist; use offset=${offset + limit} to retrieve the next page.` : " This is the complete result set for this date window."}${partial ? " partial: true means the 45s fetch budget was reached — narrow the date range for complete coverage." : ""}`,
        query_params: { query, fromDate, toDate, limit, offset },
      };
    }

    case "get_pipeline_health":
      return db.getHealth();

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Amendment resolution ──────────────────────────────────────────────────
// After inserting events, link 8-K/A amendments back to their original 8-K
// by finding the most recent non-amendment event from the same company with
// the same item types filed before this amendment.

function resolveAmendments(events: CorporateEvent[]): void {
  for (const ev of events) {
    if (!ev.is_amendment) continue;
    const items    = (ev.details.items as string[] | undefined) ?? [];
    const amendsId = db.findOriginalForAmendment(
      ev.company, ev.event_type, ev.announcement_date, JSON.stringify(items),
    );
    if (amendsId && amendsId !== ev.id) {
      db.setAmendsId(ev.id, amendsId);
    }
  }
}

// ── On-demand source enrichment ───────────────────────────────────────────

async function enrichFromSources(ticker: string, originalQuery: string): Promise<void> {
  const cached = db.getCachedCIK(ticker);
  const fetches: Promise<CorporateEvent[]>[] = [];

  // US: look up via ticker→CIK cache
  if (cached) {
    fetches.push(fetchCompanyEdgarEvents(cached.cik, cached.company_name, ticker).catch(() => []));
  } else {
    // Try name search in ticker cache
    const matches = db.searchTickerCache(originalQuery);
    if (matches.length > 0 && matches[0]) {
      fetches.push(fetchCompanyEdgarEvents(matches[0].cik, matches[0].company_name, matches[0].ticker).catch(() => []));
    }
  }

  // UK: try as a London ticker (strip .L suffix)
  fetches.push(fetchCompanyRNS(ticker).catch(() => []));

  // AU: try as an ASX code (strip .AX suffix)
  fetches.push(fetchCompanyASX(ticker).catch(() => []));

  // CA: try as a company name/ticker search
  fetches.push(fetchCompanySEDAR(originalQuery).catch(() => []));

  const results = await Promise.allSettled(fetches);
  for (const r of results) {
    if (r.status === "fulfilled") db.upsertEvents(r.value);
  }
  // Resolve amendment links for any newly stored EDGAR events
  const allNew = results.flatMap(r => r.status === "fulfilled" ? r.value : []);
  resolveAmendments(allNew);
}

// ── Health endpoint ───────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  const health = db.getHealth();
  const mem    = process.memoryUsage();
  const memory_mb = {
    rss:       Math.round(mem.rss       / 1024 / 1024),
    heap_used: Math.round(mem.heapUsed  / 1024 / 1024),
    external:  Math.round(mem.external  / 1024 / 1024),
  };
  console.log(`[health] rss=${memory_mb.rss}MB heap=${memory_mb.heap_used}MB events=${health.total_events}`);
  res.json({ status: "ok", service: "corporate-events-mcp", version: "1.0.0", health, memory_mb });
});

// ── MCP JSON-RPC endpoint ─────────────────────────────────────────────────

app.post(
  "/mcp",
  ...(process.env["NODE_ENV"] === "production" ? [createContextMiddleware()] : []),
  async (req: Request, res: Response) => {
    const { jsonrpc, method, id, params } = (req.body ?? {}) as {
      jsonrpc?: string; method?: string; id?: unknown; params?: Record<string, unknown>;
    };

    if (jsonrpc !== "2.0") {
      return res.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid JSON-RPC" } });
    }

    try {
      // ── initialize ──────────────────────────────────────────────────────
      if (method === "initialize") {
        return res.json({
          jsonrpc: "2.0", id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities:    { tools: {} },
            serverInfo:      { name: "corporate-events-mcp", version: "1.0.0" },
          },
        });
      }

      // ── tools/list ──────────────────────────────────────────────────────
      if (method === "tools/list") {
        return res.json({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      }

      // ── tools/call ──────────────────────────────────────────────────────
      if (method === "tools/call") {
        const toolName = params?.["name"] as string | undefined;
        const toolArgs = (params?.["arguments"] ?? {}) as Record<string, unknown>;
        if (!toolName) {
          return res.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Missing tool name" } });
        }
        console.log(`[tool/call] ${toolName}`, JSON.stringify(toolArgs).slice(0, 200));
        const result = await callTool(toolName, toolArgs);
        const sc     = result as Record<string, unknown>;
        return res.json({
          jsonrpc: "2.0", id,
          result: {
            structuredContent: sc,
            content: [{ type: "text", text: JSON.stringify(sc) }],
          },
        });
      }

      return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });

    } catch (err) {
      console.error(`[tool/error]`, err);
      const msg = err instanceof Error ? err.message : String(err);
      return res.json({
        jsonrpc: "2.0", id,
        result: {
          isError: true,
          structuredContent: { error: { code: "TOOL_ERROR", message: msg } },
          content: [{ type: "text", text: JSON.stringify({ error: { code: "TOOL_ERROR", message: msg } }) }],
        },
      });
    }
  },
);

// ── Start ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[INFO] corporate-events-mcp listening on port ${PORT}`);
});

// ── Helpers ───────────────────────────────────────────────────────────────

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

process.on("SIGTERM", () => { db.close(); process.exit(0); });
process.on("SIGINT",  () => { db.close(); process.exit(0); });
