import type { EventType } from "./types.js";

// ── Keyword sets ──────────────────────────────────────────────────────────

const EARNINGS_KW  = /\b(earnings|results|revenue|EPS|quarterly|annual report|profit|loss|income|Q[1-4]\b|half.year|full.year|financial results|operations)\b/i;
const DIVIDEND_KW  = /\b(dividend|distribution|per.share|ex.div|record date|payment date|DPS|yield)\b/i;
const SPLIT_KW     = /\b(stock split|share split|subdivision|consolidation|reverse split|1.for|2.for|3.for|4.for|5.for)\b/i;
const MA_KW        = /\b(merger|acquisition|acqui|takeover|scheme of arrangement|tender offer|buyout|divestiture|disposal|bid|offer for|acquire|combining|combination)\b/i;

// ── EDGAR item codes ──────────────────────────────────────────────────────
// https://www.sec.gov/fast-answers/answersform8khtm.html

const EDGAR_EARNINGS_ITEMS = new Set(["2.02"]);
const EDGAR_MA_ITEMS       = new Set(["1.01", "1.02", "2.01", "2.04"]);

// ── Public classifiers ────────────────────────────────────────────────────

/** Classify an SEC EDGAR 8-K by its item codes and title. */
export function classifyEdgar8K(items: string, title: string): EventType {
  const parts = items ? items.split(",").map(s => s.trim()) : [];

  if (parts.some(p => EDGAR_EARNINGS_ITEMS.has(p))) return "earnings";
  if (parts.some(p => EDGAR_MA_ITEMS.has(p)) || MA_KW.test(title)) return "merger_acquisition";
  if (DIVIDEND_KW.test(title)) return "dividend";
  if (SPLIT_KW.test(title))    return "split";
  if (EARNINGS_KW.test(title)) return "earnings";
  return "other";
}

/** Classify an LSE RNS announcement by category and headline. */
export function classifyRNS(category: string, headline: string): EventType {
  const text = `${category} ${headline}`;
  if (/\b(results|half.year|full.year|preliminary|profit|revenue|earnings|Q[1-4]\s+results)\b/i.test(text)) return "earnings";
  if (MA_KW.test(text))      return "merger_acquisition";
  if (DIVIDEND_KW.test(text)) return "dividend";
  if (SPLIT_KW.test(text))    return "split";
  return "other";
}

/** Classify an ASX announcement by its type string and headline. */
export function classifyASX(annType: string, headline: string): EventType {
  const text = `${annType} ${headline}`;
  if (/\b(quarterly report|quarterly activities|activities report|half.year|annual report|results|appendix 4[CDEQ]|4E|4D|profit|revenue)\b/i.test(text)) return "earnings";
  if (/\b(dividend|distribution|DRP|DRIP)\b/i.test(text))       return "dividend";
  if (/\b(split|consolidation|subdivision|bonus issue)\b/i.test(text)) return "split";
  if (/\b(scheme|takeover|merger|acquisition|offer|bid)\b/i.test(text)) return "merger_acquisition";
  return "other";
}

/** Classify a SEDAR+ filing by its document type and title. */
export function classifySEDAR(docType: string, title: string): EventType {
  const text = `${docType} ${title}`;
  if (/\b(financial statements|MD&A|management.s discussion|AIF|annual information|quarterly)\b/i.test(text)) return "earnings";
  if (DIVIDEND_KW.test(text))  return "dividend";
  if (SPLIT_KW.test(text))     return "split";
  if (MA_KW.test(text))        return "merger_acquisition";
  return "other";
}

/** Generic keyword fallback. */
export function classifyByText(text: string): EventType {
  if (EARNINGS_KW.test(text))  return "earnings";
  if (DIVIDEND_KW.test(text))  return "dividend";
  if (SPLIT_KW.test(text))     return "split";
  if (MA_KW.test(text))        return "merger_acquisition";
  return "other";
}
