import { createHash }    from "node:crypto";
import { XMLParser }     from "fast-xml-parser";
import type { CorporateEvent } from "../types.js";
import { classifyRNS }         from "../classifier.js";

// GlobeNewswire UK RSS — confirmed 200, free, no auth
// FCA NSM returns 403 (S3-backed, requires auth)
const GNW_UK_RSS = "https://www.globenewswire.com/RssFeed/country/United-Kingdom";

const PARSER = new XMLParser({
  ignoreAttributes:   false,
  attributeNamePrefix: "@_",
  isArray: (tag) => ["item", "category"].includes(tag),
});

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
  const res = await fetch(GNW_UK_RSS, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GlobeNewswire UK HTTP ${res.status}`);
  const xml  = await res.text();
  const data = PARSER.parse(xml) as { rss?: { channel?: { item?: GnwItem[] } } };
  return normaliseGnw(data?.rss?.channel?.item ?? [], "UK");
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

    // Extract tickers (domain contains "rss/stock")
    const stockCats  = (item.category ?? []).filter(c => c["@_domain"]?.includes("rss/stock"));
    const isinCats   = (item.category ?? []).filter(c => c["@_domain"]?.includes("ISIN"));
    const tickerRaw  = stockCats[0]?.["#text"] ?? null;
    const ticker     = tickerRaw ? tickerRaw.replace(/^(TSX|LSE|LON|AIM):/i, "") : null;
    const isin       = isinCats[0]?.["#text"] ?? null;
    const company    = item["dc:contributor"] ?? item.title;
    const subject    = item["dc:subject"] ?? "";
    const pubDate    = item.pubDate ? parseGnwDate(item.pubDate) : now.slice(0, 10);

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

function parseGnwDate(raw: string): string {
  try {
    return new Date(raw).toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
