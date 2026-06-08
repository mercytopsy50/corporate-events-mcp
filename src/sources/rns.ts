import { createHash }    from "node:crypto";
import { XMLParser }     from "fast-xml-parser";
import type { CorporateEvent } from "../types.js";
import { classifyRNS }         from "../classifier.js";

// ── Investegate — aggregates London Stock Exchange RNS announcements ──────
// Confirmed working: investegate.co.uk has free public RSS for RNS filings.
// GlobeNewswire UK country feed (previous source) returns zero items.

const INVESTEGATE_RSS = "https://www.investegate.co.uk/articlelister.aspx?source=RNS&returnCount=50";
const INVESTEGATE_FALLBACK = "https://www.investegate.co.uk/Index.aspx?mode=4&returnCount=50";

const PARSER = new XMLParser({
  ignoreAttributes:   false,
  attributeNamePrefix: "@_",
  isArray: (tag) => ["item", "category"].includes(tag),
});

interface InvItem {
  title?:    string;
  link?:     string;
  pubDate?:  string;
  description?: string;
  category?:    string | string[];
  author?:   string;
  "dc:creator"?: string;
}

interface GnwCategory {
  "@_domain": string;
  "#text":    string;
}

interface GnwItem {
  title?:           string;
  link?:            string;
  pubDate?:         string;
  "dc:subject"?:    string;
  "dc:contributor"?: string;
  category?:        GnwCategory[];
}

export async function fetchRecentRNS(_since: string): Promise<CorporateEvent[]> {
  // Try Investegate feeds in order
  for (const url of [INVESTEGATE_RSS, INVESTEGATE_FALLBACK]) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; CorporateEventsFeed/1.0)",
          "Accept": "application/rss+xml, application/xml, text/xml, */*",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const raw = await res.text();
      if (!raw || raw.length < 100) continue;

      const events = parseInvestegateFeed(raw);
      if (events.length > 0) return events;
    } catch { /* try next URL */ }
  }
  return [];
}

function parseInvestegateFeed(xml: string): CorporateEvent[] {
  const now    = new Date().toISOString();
  const events: CorporateEvent[] = [];

  try {
    const data = PARSER.parse(xml) as {
      rss?: { channel?: { item?: InvItem[] } };
      feed?: { entry?: InvItem[] };
    };

    const items: InvItem[] = data?.rss?.channel?.item ?? data?.feed?.entry ?? [];

    for (const item of items) {
      if (!item.title || !item.link) continue;

      const title   = typeof item.title === "string" ? item.title : String(item.title);
      const link    = typeof item.link  === "string" ? item.link  : String(item.link);
      const pubDate = item.pubDate ? parseDate(item.pubDate) : now.slice(0, 10);

      // Extract company from description or author fields
      const company = item["dc:creator"] ?? item.author ?? extractCompany(title);
      const cats    = Array.isArray(item.category) ? item.category : item.category ? [item.category] : [];
      const subject = cats.join(" ");

      events.push({
        id:                createHash("sha256").update(`LSE_RNS:${link}`).digest("hex").slice(0, 24),
        company:           String(company ?? "Unknown"),
        ticker:            null,
        isin:              null,
        jurisdiction:      "UK",
        event_type:        classifyRNS(subject, title),
        event_date:        null,
        announcement_date: pubDate,
        source:            "LSE_RNS",
        source_url:        link,
        raw_title:         title,
        details:           { subject, source_feed: "investegate" },
        normalized_at:     now,
        is_amendment:      false,
        amends_id:         null,
      });
    }
  } catch { /* parse failure — return empty */ }

  return events;
}

// Extract company name from headline patterns like "ACME PLC: Results for year ended..."
function extractCompany(title: string): string {
  const colon = title.indexOf(":");
  if (colon > 0 && colon < 60) return title.slice(0, colon).trim();
  return title.slice(0, 40).trim();
}

export async function fetchCompanyRNS(ticker: string): Promise<CorporateEvent[]> {
  // GlobeNewswire supports searching by ticker/exchange for UK companies
  const url = `https://www.globenewswire.com/RssFeed/keyword/${encodeURIComponent(ticker)}`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return [];
  const xml  = await res.text();
  const data = PARSER.parse(xml) as { rss?: { channel?: { item?: GnwItem[] } } };
  // Filter to UK/LSE items
  const items = (data?.rss?.channel?.item ?? []).filter(item =>
    item.category?.some(c => c["#text"]?.includes(".L") || c["@_domain"]?.includes("ISIN"))
  );
  return normaliseGnw(items, "UK");
}

function normaliseGnw(items: GnwItem[], jurisdiction: "UK" | "CA"): CorporateEvent[] {
  const now    = new Date().toISOString();
  const events: CorporateEvent[] = [];

  for (const item of items) {
    if (!item.title || !item.link) continue;

    const stockCats  = (item.category ?? []).filter(c => c["@_domain"]?.includes("rss/stock"));
    const isinCats   = (item.category ?? []).filter(c => c["@_domain"]?.includes("ISIN"));
    const tickerRaw  = stockCats[0]?.["#text"] ?? null;
    const ticker     = tickerRaw ? tickerRaw.replace(/^(TSX|LSE|LON|AIM):/i, "") : null;
    const isin       = isinCats[0]?.["#text"] ?? null;
    const company    = item["dc:contributor"] ?? item.title;
    const subject    = item["dc:subject"] ?? "";
    const pubDate    = item.pubDate ? parseDate(item.pubDate) : now.slice(0, 10);

    events.push({
      id:                createHash("sha256").update(`LSE_RNS:${item.link}`).digest("hex").slice(0, 24),
      company:           company ?? "Unknown",
      ticker,
      isin,
      jurisdiction,
      event_type:        classifyRNS(subject, item.title),
      event_date:        null,
      announcement_date: pubDate,
      source:            "LSE_RNS",
      source_url:        item.link,
      raw_title:         item.title,
      details:           { subject, ticker_raw: tickerRaw },
      normalized_at:     now,
      is_amendment:      false,
      amends_id:         null,
    });
  }
  return events;
}

function parseDate(raw: string): string {
  try {
    return new Date(raw).toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

