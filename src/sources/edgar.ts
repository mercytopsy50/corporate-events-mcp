import { createHash }    from "node:crypto";
import type { CorporateEvent } from "../types.js";
import { classifyEdgar8K }    from "../classifier.js";

const UA          = "CorporateEventsMCP/1.0 (grants@ctxprotocol.com)";
const EFTS_BASE   = "https://efts.sec.gov/LATEST/search-index";
const DATA_BASE   = "https://data.sec.gov/submissions";
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

// ── Types ─────────────────────────────────────────────────────────────────

interface EftsSource {
  ciks?:          string[];
  display_names?: string[];   // e.g. "CONMED Corp  (CNMD)  (CIK 0000816956)"
  file_date?:     string;
  period_ending?: string;
  form?:          string;
  adsh?:          string;     // accession number (dashes included)
  items?:         string[];   // ARRAY of item codes e.g. ["1.01","2.03","9.01"]
}

interface EftsHit { _source: EftsSource }
interface EftsResponse { hits?: { hits?: EftsHit[] } }

interface SubmissionsResponse {
  name:     string;
  tickers?: string[];
  filings: {
    recent: {
      form:            string[];
      filingDate:      string[];
      primaryDocument: string[];
      accessionNumber: string[];
      items:           string[];   // comma-separated string in submissions API
    };
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Parse "CONMED Corp  (CNMD)  (CIK 0000816956)" → { company, ticker } */
function parseDisplayName(raw: string): { company: string; ticker: string | null } {
  const m = raw.match(/^(.+?)\s+\(([A-Z0-9.-]+)\)\s+\(CIK/);
  if (m) return { company: m[1]!.trim(), ticker: m[2]! };
  return { company: raw.split("(")[0]!.trim(), ticker: null };
}

// ── Ticker → CIK map ──────────────────────────────────────────────────────

export interface TickerEntry {
  ticker:       string;
  cik:          string;
  company_name: string;
}

export async function fetchTickerMap(): Promise<TickerEntry[]> {
  const res = await fetch(TICKERS_URL, {
    headers: { "User-Agent": UA },
    signal:  AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`EDGAR ticker map HTTP ${res.status}`);
  const raw = await res.json() as Record<string, { cik_str: number; ticker: string; title: string }>;
  return Object.values(raw).map(e => ({
    ticker:       e.ticker.toUpperCase(),
    cik:          String(e.cik_str).padStart(10, "0"),
    company_name: e.title,
  }));
}

// ── Recent 8-K poll via EFTS ──────────────────────────────────────────────

export async function fetchRecentEdgar8Ks(since: string): Promise<CorporateEvent[]> {
  const today = new Date().toISOString().slice(0, 10);
  const url   = `${EFTS_BASE}?forms=8-K,8-K%2FA&dateRange=custom&startdt=${since}&enddt=${today}&from=0&size=50`;

  const res  = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`EDGAR EFTS HTTP ${res.status}`);
  const data = await res.json() as EftsResponse;
  const hits  = data?.hits?.hits ?? [];
  const now   = new Date().toISOString();
  const events: CorporateEvent[] = [];

  for (const hit of hits) {
    const s = hit._source;

    // items is a string[] in EFTS — join for classifier
    const itemsArr    = Array.isArray(s.items) ? s.items : [];
    const itemsStr    = itemsArr.join(",");
    const displayName = s.display_names?.[0] ?? "Unknown";
    const { company, ticker } = parseDisplayName(displayName);
    const cik         = s.ciks?.[0] ?? "";
    const adsh        = s.adsh ?? "";
    const fileDate    = s.file_date ?? today;
    const formType    = s.form ?? "8-K";
    const eventType   = classifyEdgar8K(itemsStr, company);

    // Build filing URL from accession (remove dashes for folder path)
    const accFolder   = adsh.replace(/-/g, "");
    const srcUrl      = `https://www.sec.gov/Archives/edgar/data/${cik.replace(/^0+/, "")}/${accFolder}/`;

    events.push({
      id:                createHash("sha256").update(`SEC_EDGAR:${adsh}`).digest("hex").slice(0, 24),
      company,
      ticker,
      isin:              null,
      jurisdiction:      "US",
      event_type:        eventType,
      event_date:        s.period_ending ?? null,
      announcement_date: fileDate,
      source:            "SEC_EDGAR",
      source_url:        srcUrl,
      raw_title:         `${formType}: ${describeItems(itemsArr)}`,
      details: {
        form_type:         formType,
        items:             itemsArr,
        item_descriptions: Object.fromEntries(itemsArr.map(c => [c, ITEM_DESCRIPTIONS[c] ?? `Item ${c}`])),
        accession:         adsh,
        filing_url:        srcUrl,
      },
      normalized_at: now,
      is_amendment:  formType.endsWith("/A"),
      amends_id:     null,
    });
  }
  return events;
}

// ── Company-specific lookup via submissions API ───────────────────────────

export async function fetchCompanyEdgarEvents(
  cik:         string,
  companyName: string,
  ticker:      string | null,
): Promise<CorporateEvent[]> {
  const paddedCIK = cik.padStart(10, "0");
  const res       = await fetch(`${DATA_BASE}/CIK${paddedCIK}.json`, {
    headers: { "User-Agent": UA },
    signal:  AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`EDGAR submissions HTTP ${res.status} for CIK ${cik}`);

  const data   = await res.json() as SubmissionsResponse;
  const recent = data.filings?.recent;
  if (!recent) return [];

  const now    = new Date().toISOString();
  const events: CorporateEvent[] = [];

  for (let i = 0; i < recent.form.length; i++) {
    const form = recent.form[i]!;
    if (form !== "8-K" && form !== "8-K/A") continue;

    const fileDate = recent.filingDate[i]!;
    const accNum   = recent.accessionNumber[i]!;
    // submissions API items is comma-separated string per filing
    const items    = recent.items[i] ?? "";
    const doc      = recent.primaryDocument[i] ?? "";
    const accFmt   = accNum.replace(/\./g, "");
    const srcUrl   = `https://www.sec.gov/Archives/edgar/data/${paddedCIK.replace(/^0+/, "")}/${accFmt}/${doc}`;

      const itemsArr    = items.split(",").map(s => s.trim()).filter(Boolean);
      const description = describeItems(itemsArr);
    events.push({
      id:                createHash("sha256").update(`SEC_EDGAR:${accNum}`).digest("hex").slice(0, 24),
      company:           companyName,
      ticker,
      isin:              null,
      jurisdiction:      "US",
      event_type:        classifyEdgar8K(items, companyName),
      event_date:        null,
      announcement_date: fileDate,
      source:            "SEC_EDGAR",
      source_url:        srcUrl,
      raw_title:         `${form}${isAmendmentForm(form) ? "/A" : ""}: ${description}`,
      details: {
        form_type:         form,
        items:             itemsArr,
        item_descriptions: Object.fromEntries(itemsArr.map(c => [c, ITEM_DESCRIPTIONS[c] ?? `Item ${c}`])),
        accession:         accNum,
        filing_url:        `https://www.sec.gov/Archives/edgar/data/${paddedCIK.replace(/^0+/, "")}/${accFmt}/`,
      },
      normalized_at: now,
      is_amendment:  form === '8-K/A',
      amends_id:     null,
    });

    if (events.length >= 50) break;
  }
  return events;
}

// ── Amendment flag helper ─────────────────────────────────────────────────

/** Returns true if the form type is an amendment (8-K/A). */
export function isAmendmentForm(form: string): boolean {
  return form.endsWith("/A");
}

// ── Historical fetch — pages through all submissions back to fromDate ────
// EDGAR submissions API: main file has filings.recent (~40 latest) plus
// filings.files[] pointing to older batches. We walk pages until fromDate.

interface SubmissionsPage {
  form:            string[];
  filingDate:      string[];
  primaryDocument: string[];
  accessionNumber: string[];
  items:           string[];
}

interface SubmissionsWithFiles {
  name:    string;
  filings: { recent: SubmissionsPage; files?: Array<{ name: string }> };
}

function buildEventsFromPage(
  page:      SubmissionsPage,
  company:   string,
  ticker:    string | null,
  paddedCIK: string,
): CorporateEvent[] {
  const now    = new Date().toISOString();
  const events: CorporateEvent[] = [];
  const cikClean = paddedCIK.replace(/^0+/, "");

  for (let i = 0; i < page.form.length; i++) {
    const form = page.form[i]!;
    if (form !== "8-K" && form !== "8-K/A") continue;

    const fileDate    = page.filingDate[i]!;
    const accNum      = page.accessionNumber[i]!;
    const items       = page.items[i] ?? "";
    const doc         = page.primaryDocument[i] ?? "";
    const accFmt      = accNum.replace(/\./g, "");
    const srcUrl      = `https://www.sec.gov/Archives/edgar/data/${cikClean}/${accFmt}/${doc}`;
    const isAmend     = form === "8-K/A";

    events.push({
      id:                createHash("sha256").update(`SEC_EDGAR:${accNum}`).digest("hex").slice(0, 24),
      company,
      ticker,
      isin:              null,
      jurisdiction:      "US",
      event_type:        classifyEdgar8K(items, company),
      event_date:        null,
      announcement_date: fileDate,
      source:            "SEC_EDGAR",
      source_url:        srcUrl,
      raw_title:         `${form}${isAmend ? "/A" : ""}: ${describeItems(items.split(",").map(s => s.trim()).filter(Boolean))}`,
      details: {
        form_type:         form,
        items:             items.split(",").map(s => s.trim()).filter(Boolean),
        item_descriptions: Object.fromEntries(items.split(",").map(s => s.trim()).filter(Boolean).map(c => [c, ITEM_DESCRIPTIONS[c] ?? `Item ${c}`])),
        accession:         accNum,
        filing_url:        `https://www.sec.gov/Archives/edgar/data/${cikClean}/${accFmt}/`,
        is_amendment:      isAmend,
      },
      normalized_at: now,
      is_amendment:  isAmend,
      amends_id:     null,   // resolved post-insert via DB lookup in server.ts
    });

    if (events.length >= 500) break;
  }
  return events;
}

export async function fetchEdgarHistorical(
  cik:       string,
  company:   string,
  ticker:    string | null,
  fromDate:  string,
  toDate:    string,
  maxEvents: number = 200,
  offset:    number = 0,
): Promise<{ events: CorporateEvent[]; hasMore: boolean }> {
  const paddedCIK = cik.padStart(10, "0");
  const all: CorporateEvent[] = [];

  const res = await fetch(`${DATA_BASE}/CIK${paddedCIK}.json`, {
    headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`EDGAR submissions HTTP ${res.status}`);
  const root = await res.json() as SubmissionsWithFiles;

  // Process recent page — filter to date window
  const recentPage = root.filings.recent;
  const recentEvents = buildEventsFromPage(recentPage, company, ticker, paddedCIK)
    .filter(e => e.announcement_date >= fromDate && e.announcement_date <= toDate);
  all.push(...recentEvents);

  // Walk older pages if fromDate is before the oldest recent filing
  const oldestRecent = recentPage.filingDate.at(-1) ?? "9999-01-01";
  const pages        = root.filings.files ?? [];

  for (const page of pages) {
    if (all.length >= maxEvents) break;
    if (oldestRecent <= fromDate) break;  // already past our window

    const pr = await fetch(`${DATA_BASE}/${page.name}`, {
      headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!pr?.ok) continue;

    const pd = await pr.json() as SubmissionsPage;
    const pg = buildEventsFromPage(pd, company, ticker, paddedCIK)
      .filter(e => e.announcement_date >= fromDate && e.announcement_date <= toDate);
    all.push(...pg);
  }

  return { events: all.slice(offset, offset + maxEvents), hasMore: all.length > offset + maxEvents };
}

// ── SEC 8-K item code descriptions ───────────────────────────────────────
// Maps official item codes to plain-English descriptions so agents can
// reason about what each filing covers without needing SEC documentation.

const ITEM_DESCRIPTIONS: Record<string, string> = {
  "1.01": "Entry into Material Definitive Agreement",
  "1.02": "Termination of Material Definitive Agreement",
  "1.03": "Bankruptcy or Receivership",
  "1.04": "Mine Safety",
  "2.01": "Completion of Acquisition or Disposition of Assets",
  "2.02": "Results of Operations and Financial Condition",
  "2.03": "Creation of Direct Financial Obligation",
  "2.04": "Triggering Events Accelerating Repayment",
  "2.05": "Costs Associated with Exit or Disposal Activities",
  "2.06": "Material Impairments",
  "3.01": "Notice of Delisting or Failure to Satisfy Listing Rule",
  "3.02": "Unregistered Sales of Equity Securities",
  "3.03": "Material Modification to Rights of Security Holders",
  "4.01": "Changes in Registrant's Certifying Accountant",
  "4.02": "Non-Reliance on Previously Issued Financial Statements",
  "5.01": "Changes in Control of Registrant",
  "5.02": "Departure/Appointment of Directors or Officers",
  "5.03": "Amendments to Articles of Incorporation or Bylaws",
  "5.04": "Temporary Suspension of Trading Under Employee Benefit Plan",
  "5.05": "Amendments to the Registrant's Code of Ethics",
  "5.06": "Change in Shell Company Status",
  "5.07": "Submission of Matters to a Vote of Security Holders",
  "5.08": "Shareholder Nominations Pursuant to Exchange Act Rule 14a-11",
  "6.01": "ABS Informational and Computational Material",
  "6.02": "Change of Servicer or Trustee",
  "6.03": "Change in Credit Enhancement or Other External Support",
  "6.04": "Failure to Make a Required Distribution",
  "6.05": "Securities Act Updating Disclosure",
  "7.01": "Regulation FD Disclosure",
  "8.01": "Other Events",
  "9.01": "Financial Statements and Exhibits",
};

/** Convert an items array to a human-readable description string. */
export function describeItems(items: string[]): string {
  if (!items.length) return "General filing";
  const descs = items
    .map(code => ITEM_DESCRIPTIONS[code.trim()] ?? `Item ${code}`)
    .filter(d => d !== "Financial Statements and Exhibits"); // 9.01 is always present, not informative
  return descs.length ? descs.join("; ") : "Financial Statements and Exhibits";
}
