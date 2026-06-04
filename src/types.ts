export type Jurisdiction = "US" | "UK" | "CA" | "AU";
export type EventType    = "earnings" | "dividend" | "split" | "merger_acquisition" | "other";
export type DataSource   = "SEC_EDGAR" | "LSE_RNS" | "SEDAR" | "ASX";

export interface CorporateEvent {
  id:                string;   // SHA-256(source + source_url)[:24]
  company:           string;   // normalised company name
  ticker:            string | null;
  isin:              string | null;
  jurisdiction:      Jurisdiction;
  event_type:        EventType;
  event_date:        string | null;   // ISO date — the actual corporate event (ex-div, earnings day…)
  announcement_date: string;          // ISO date — when filed / announced
  source:            DataSource;
  source_url:        string;
  raw_title:         string;
  details:           Record<string, unknown>;  // type-specific structured fields (stored as JSON)
  normalized_at:     string;
  is_amendment:      boolean;          // true for 8-K/A, correction filings
  amends_id:         string | null;    // id of the original event this corrects, if resolvable
}

export interface PollState {
  source:         DataSource;
  last_polled_at: string | null;
  last_item_date: string | null;
  status:         "ok" | "error" | "never";
  error:          string | null;
}

export interface PipelineHealth {
  sources:                  PollSourceHealth[];
  total_events:             number;
  events_last_24h:          number;
  events_by_type:           Record<string, number>;
  events_by_jurisdiction:   Record<string, number>;
}

export interface PollSourceHealth {
  source:          DataSource;
  jurisdiction:    Jurisdiction;
  last_polled_at:  string | null;
  status:          "ok" | "error" | "never";
  events_indexed:  number;
  last_event_date: string | null;
  error:           string | null;
}
