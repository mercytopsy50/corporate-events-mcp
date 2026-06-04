import { createHash }    from "node:crypto";
import { XMLParser }     from "fast-xml-parser";
import type { CorporateEvent } from "../types.js";
import { classifySEDAR }       from "../classifier.js";

// GlobeNewswire Canada RSS — confirmed working (TSX tickers, ISIN, pubDate all present)
// SEDAR+ (efts.sedarplus.ca) doesn't resolve; sedarplus.ca has bot protection
const GNW_CA_RSS = "https://www.globenewswire.com/RssFeed/country/Canada";

const PARSER = new XMLParser({
  ignoreAttributes:    false,
  attributeNamePrefix: "@_",
  isArray: (tag) => ["item", "category"].includes(tag),
});

interface GnwCategory {
  "@_domain": string;
  "#text":    string;
}

interface GnwItem {
  title?:            string;
  link?:             string;
  pubDate?:          string;
  "dc:subject"?:     string;
  "dc:contributor"?: string;
  category?:         GnwCategory[];
}

export async function fetchRecentSEDAR(_since: string): Promise<CorporateEvent[]> {
  const res = await fetch(GNW_CA_RSS, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GlobeNewswire Canada HTTP ${res.status}`);
  const xml  = await res.text();
  const data = PARSER.parse(xml) as { rss?: { channel?: { item?: GnwItem[] } } };
  return normalise(data?.rss?.channel?.item ?? []);
}

export async function fetchCompanySEDAR(query: string): Promise<CorporateEvent[]> {
  const url = `https://www.globenewswire.com/RssFeed/keyword/${encodeURIComponent(query)}`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return [];
  const xml  = await res.text();
  const data = PARSER.parse(xml) as { rss?: { channel?: { item?: GnwItem[] } } };
  // Keep only items with TSX/Canadian tickers or Canadian ISINs
  const items = (data?.rss?.channel?.item ?? []).filter(item =>
    item.category?.some(c =>
      c["#text"]?.startsWith("TSX:") ||
      c["#text"]?.startsWith("TSX-V:") ||
      (c["@_domain"]?.includes("ISIN") && c["#text"]?.startsWith("CA"))
    )
  );
  return normalise(items);
}

function normalise(items: GnwItem[]): CorporateEvent[] {
  const now    = new Date().toISOString();
  const events: CorporateEvent[] = [];

  for (const item of items) {
    if (!item.title || !item.link) continue;

    const stockCats = (item.category ?? []).filter(c => c["@_domain"]?.includes("rss/stock"));
    const isinCats  = (item.category ?? []).filter(c => c["@_domain"]?.includes("ISIN"));
    const tickerRaw = stockCats[0]?.["#text"] ?? null;
    const ticker    = tickerRaw ? tickerRaw.replace(/^(TSX:|TSX-V:|CVE:)/i, "") : null;
    const isin      = isinCats[0]?.["#text"] ?? null;
    const company   = item["dc:contributor"] ?? item.title;
    const subject   = item["dc:subject"] ?? "";
    const pubDate   = item.pubDate ? parseDate(item.pubDate) : now.slice(0, 10);

    events.push({
      id:                createHash("sha256").update(`SEDAR:${item.link}`).digest("hex").slice(0, 24),
      company:           company ?? "Unknown",
      ticker,
      isin,
      jurisdiction:      "CA",
      event_type:        classifySEDAR(subject, item.title),
      event_date:        null,
      announcement_date: pubDate,
      source:            "SEDAR",
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
  try { return new Date(raw).toISOString().slice(0, 10); }
  catch { return new Date().toISOString().slice(0, 10); }
}
