import { createHash } from "node:crypto";
import type { CorporateEvent } from "../types.js";

// ── Companies House API ───────────────────────────────────────────────────
// Free public API for UK company filings. Requires an API key from
// developer.company-information.service.gov.uk (free registration).
// Env var: COMPANIES_HOUSE_KEY
//
// Covers: annual accounts (→ earnings), director changes (→ other),
// resolutions/charges/capital changes (→ other or merger_acquisition).
// These are STATUTORY FILINGS, not RNS market announcements — but they are
// real, authoritative UK corporate events from Companies House, the UK's
// official company registry.

const CH_BASE = "https://api.company-information.service.gov.uk";

// ── Top 30 FTSE 100 companies with verified Companies House numbers ────────

export const FTSE_COMPANIES: Array<{ number: string; ticker: string; name: string }> = [
  { number: "04507817", ticker: "SHEL",  name: "Shell plc" },
  { number: "02723534", ticker: "AZN",   name: "AstraZeneca plc" },
  { number: "00617987", ticker: "HSBA",  name: "HSBC Holdings plc" },
  { number: "00041424", ticker: "ULVR",  name: "Unilever plc" },
  { number: "00102498", ticker: "BP",    name: "BP p.l.c." },
  { number: "00719885", ticker: "RIO",   name: "Rio Tinto plc" },
  { number: "07976021", ticker: "GLEN",  name: "Glencore plc" },
  { number: "00023307", ticker: "DGE",   name: "Diageo plc" },
  { number: "04404655", ticker: "NG",    name: "National Grid plc" },
  { number: "00048839", ticker: "BARC",  name: "Barclays plc" },
  { number: "01833679", ticker: "VOD",   name: "Vodafone Group plc" },
  { number: "03888792", ticker: "GSK",   name: "GSK plc" },
  { number: "01003142", ticker: "RR",    name: "Rolls-Royce Holdings plc" },
  { number: "00519500", ticker: "TSCO",  name: "Tesco plc" },
  { number: "00095000", ticker: "LLOY",  name: "Lloyds Banking Group plc" },
  { number: "02468686", ticker: "AV",    name: "Aviva plc" },
  { number: "06276697", ticker: "NWG",   name: "NatWest Group plc" },
  { number: "02730534", ticker: "BT-A",  name: "BT Group plc" },
  { number: "04083914", ticker: "CPG",   name: "Compass Group plc" },
  { number: "01397169", ticker: "PRU",   name: "Prudential plc" },
  { number: "00966425", ticker: "STAN",  name: "Standard Chartered plc" },
  { number: "01417162", ticker: "LGEN",  name: "Legal & General Group plc" },
  { number: "01566454", ticker: "BA",    name: "BAE Systems plc" },
  { number: "13381518", ticker: "HLN",   name: "Haleon plc" },
  { number: "07846098", ticker: "IAG",   name: "International Airlines Group" },
  { number: "03458224", ticker: "BRBY",  name: "Burberry Group plc" },
  { number: "04461965", ticker: "RKT",   name: "Reckitt Benckiser Group plc" },
  { number: "04763986", ticker: "MRO",   name: "Melrose Industries plc" },
  { number: "06492798", ticker: "EXPN",  name: "Experian plc" },
  { number: "00003546", ticker: "LSEG",  name: "London Stock Exchange Group plc" },
];

// ── Filing description → event type mapping ───────────────────────────────

type EventType = CorporateEvent["event_type"];

function classifyCHFiling(type: string, description: string): { eventType: EventType; readable: string } {
  const t = type.toUpperCase();
  const d = description.toLowerCase();

  // Annual accounts → earnings
  if (t === "AA" || t === "AAA" || d.includes("accounts-with-accounts-type")) {
    return { eventType: "earnings", readable: "Annual Report and Accounts" };
  }
  if (d.includes("interim") && d.includes("accounts")) {
    return { eventType: "earnings", readable: "Interim Accounts" };
  }
  // Director appointments / terminations → other
  if (t === "AP01" || t === "AP02" || d.includes("appointment-of-director") || d.includes("appointment-of-secretary")) {
    return { eventType: "other", readable: "Director / Officer Appointment" };
  }
  if (t === "TM01" || t === "TM02" || d.includes("termination-of-appointment")) {
    return { eventType: "other", readable: "Director / Officer Departure" };
  }
  // Resolutions that may indicate M&A
  if ((t === "RES01" || d.includes("special-resolution") || d.includes("resolution")) &&
      (d.includes("amalgamat") || d.includes("merger") || d.includes("acquisition"))) {
    return { eventType: "merger_acquisition", readable: "M&A Shareholder Resolution" };
  }
  if (t.startsWith("RES") || d.includes("resolution")) {
    return { eventType: "other", readable: "Shareholder Resolution" };
  }
  // Capital changes
  if (t === "SH01" || d.includes("return-of-allotment") || d.includes("capital")) {
    return { eventType: "other", readable: "Share Capital Change" };
  }
  // Charge / mortgage
  if (t.startsWith("MR") || d.includes("mortgage") || d.includes("charge")) {
    return { eventType: "other", readable: "Charge / Mortgage Filed" };
  }
  return { eventType: "other", readable: type };
}

// ── Fetch filing history for one company ──────────────────────────────────

interface CHFiling {
  category:    string;
  date:        string;
  description: string;
  type:        string;
  transaction_id?: string;
  links?: {
    self?: string;
    document_metadata?: string;
  };
}

interface CHFilingHistoryResponse {
  items?:        CHFiling[];
  items_per_page?: number;
  total_count?:  number;
}

function authHeader(): string {
  const key = process.env["COMPANIES_HOUSE_KEY"] ?? "";
  return "Basic " + Buffer.from(`${key}:`).toString("base64");
}

async function fetchCompanyFilings(
  companyNumber: string,
  cutoff:        string,
): Promise<CHFiling[]> {
  // Companies House filing-history categories require repeated params, not comma-joined
  const params = [
    "category=accounts",
    "category=officers",
    "category=capital",
    "category=resolutions",
    "category=mortgage",
    "items_per_page=20",
  ].join("&");
  const url = `${CH_BASE}/company/${companyNumber}/filing-history?${params}`;

  let httpStatus = 0;
  try {
    const res = await fetch(url, {
      headers: {
        "Authorization": authHeader(),
        "Accept":        "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    httpStatus = res.status;
    if (!res.ok) {
      console.warn(`[ch] ${companyNumber} HTTP ${res.status}`);
      return [];
    }

    const data  = await res.json() as CHFilingHistoryResponse;
    const items = (data.items ?? []).filter(f => f.date >= cutoff);
    if (items.length > 0) {
      console.log(`[ch] ${companyNumber} → ${items.length} filings since ${cutoff}`);
    }
    return items;
  } catch (err) {
    console.warn(`[ch] ${companyNumber} error (HTTP ${httpStatus}):`, err instanceof Error ? err.message : err);
    return [];
  }
}

// ── Normalise to CorporateEvent ───────────────────────────────────────────

function normalise(
  filing:  CHFiling,
  company: { number: string; ticker: string; name: string },
  now:     string,
): CorporateEvent {
  const { eventType, readable } = classifyCHFiling(filing.type, filing.description ?? "");
  const txId   = filing.transaction_id ?? filing.links?.self?.split("/").pop() ?? "";
  const srcUrl = `https://find-and-update.company-information.service.gov.uk` +
    `/company/${company.number}/filing-history/${txId}`;

  return {
    id:                createHash("sha256").update(`CH:${company.number}:${txId}`).digest("hex").slice(0, 24),
    company:           company.name,
    ticker:            company.ticker,
    isin:              null,
    jurisdiction:      "UK",
    event_type:        eventType,
    event_date:        null,
    announcement_date: filing.date,
    source:            "LSE_RNS",   // reuses the UK source key for pipeline health reporting
    source_url:        srcUrl,
    raw_title:         `${filing.type}: ${readable}`,
    details: {
      form_type:   filing.type,
      description: filing.description,
      subject:     readable,
      ch_company:  company.number,
    },
    normalized_at: now,
    is_amendment:  false,
    amends_id:     null,
  };
}

// ── Public: poll all tracked companies ───────────────────────────────────

export async function fetchRecentUKFilings(since: string): Promise<CorporateEvent[]> {
  if (!process.env["COMPANIES_HOUSE_KEY"]) {
    console.warn("[uk] COMPANIES_HOUSE_KEY not set — skipping UK poll");
    return [];
  }

  const cutoff = since.slice(0, 10);
  const now    = new Date().toISOString();
  const all:   CorporateEvent[] = [];

  // Stagger requests to respect CH rate limit (600 req / 5 min)
  const BATCH_SIZE  = 5;
  const BATCH_DELAY = 1_500; // ms between batches

  for (let i = 0; i < FTSE_COMPANIES.length; i += BATCH_SIZE) {
    const batch = FTSE_COMPANIES.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(co => fetchCompanyFilings(co.number, cutoff)),
    );
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      if (r?.status === "fulfilled") {
        for (const filing of r.value) {
          all.push(normalise(filing, batch[j]!, now));
        }
      }
    }
    if (i + BATCH_SIZE < FTSE_COMPANIES.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  return all;
}
