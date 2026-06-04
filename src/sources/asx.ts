import { createHash }    from "node:crypto";
import type { CorporateEvent } from "../types.js";
import { classifyASX }         from "../classifier.js";

// Confirmed working: /companies/ (plural), not /company/
// Response: { data: { symbol, displayName, items: [...] } }
// `url` field in items is always "" — construct from documentKey
const ASX_BASE = "https://asx.api.markitdigital.com/asx-research/1.0/companies";

interface ASXItem {
  announcementType?: string;
  date?:             string;
  headline?:         string;
  isPriceSensitive?: boolean;
  documentKey?:      string;
  url?:              string;
}

interface ASXResponse {
  data?: {
    displayName?: string;
    symbol?:      string;
    items?:       ASXItem[];
  };
}

// ASX200 top companies for background polling
// (no bulk-recent endpoint found — /companies/X/announcements requires a code)
const ASX_POLL_CODES = [
  "BHP","CBA","CSL","ANZ","WBC","NAB","WES","MQG","RIO","TLS",
  "FMG","WOW","GMG","REA","RMD","TCL","ALL","NST","CPU","STO",
  "AGL","QBE","IAG","AMP","MPL","ORG","WDS","OZL","AMC","COL",
];

export async function fetchRecentASX(): Promise<CorporateEvent[]> {
  // Fetch from a rotating window of major ASX companies
  // No confirmed bulk-recent endpoint exists on the MarkitDigital API
  const dayOfMonth  = new Date().getDate();
  const batchStart  = (dayOfMonth % 3) * 10;        // rotate which 10 we check each poll
  const batch       = ASX_POLL_CODES.slice(batchStart, batchStart + 10);

  const results = await Promise.allSettled(
    batch.map(code => fetchCompanyASX(code)),
  );

  const events: CorporateEvent[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") events.push(...r.value);
  }
  return events;
}

export async function fetchCompanyASX(asxCode: string): Promise<CorporateEvent[]> {
  const code = asxCode.toUpperCase().replace(/\.AX$/i, "");
  const url  = `${ASX_BASE}/${code}/announcements?count=20`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`ASX HTTP ${res.status} for ${code}`);
  const data = await res.json() as ASXResponse;
  return normalise(data, code);
}

function normalise(data: ASXResponse, asxCode: string): CorporateEvent[] {
  const items   = data?.data?.items ?? [];
  const company = data?.data?.displayName ?? asxCode;
  const ticker  = data?.data?.symbol ?? asxCode;
  const now     = new Date().toISOString();
  const events: CorporateEvent[] = [];

  // Drop events older than 60 days — the API returns up to 20 announcements
  // per company regardless of date, so without this filter the first poll
  // floods the feed with months-old events that show up as "recent" by
  // normalized_at even though their announcement_date is long past.
  const cutoff = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);

  for (const item of items) {
    if (!item.headline || !item.date) continue;

    const annDate = item.date.slice(0, 10);
    if (annDate < cutoff) continue;   // skip events older than 60 days

    const docKey  = item.documentKey ?? "";
    // url field is always empty in API response — use ASX display URL
    const srcUrl  = docKey
      ? `https://www.asx.com.au/asx/statistics/displayAnnouncement.do?display=pdf&idsId=${docKey}`
      : `https://www.asx.com.au/asx/1/company/${asxCode}/announcements`;

    const annType = item.announcementType ?? "";

    events.push({
      id:                createHash("sha256").update(`ASX:${docKey || srcUrl}`).digest("hex").slice(0, 24),
      company,
      ticker,
      isin:              null,
      jurisdiction:      "AU",
      event_type:        classifyASX(annType, item.headline),
      event_date:        null,
      announcement_date: annDate,
      source:            "ASX",
      source_url:        srcUrl,
      raw_title:         item.headline,
      details: {
        announcement_type: annType,
        is_price_sensitive: item.isPriceSensitive,
        document_key:      docKey,
        asx_code:          ticker,
      },
      normalized_at: now,
      is_amendment:  false,
      amends_id:     null,
    });
  }
  return events;
}
