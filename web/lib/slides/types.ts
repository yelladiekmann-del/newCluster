/** All text placeholders for the hy VC analysis slide template. */
export interface SlidesData {
  // ── Folie 1: Titelfolie ────────────────────────────────────────────────────
  title: string;
  client_company: string;
  document_type: string;

  // ── Folie 2: Analyse-Folie ─────────────────────────────────────────────────
  chapter: string;
  slide_title1: string;
  action_title_1: string;
  section_title1_1: string;
  section_title1_2: string;

  // KPI tiles
  invest_volume: string;  // z.B. "2,8"  (Mrd. €, fertig formatiert)
  deals: string;          // z.B. "2.345"
  companies: string;      // z.B. "1.234"
  average_funding: string; // z.B. "11,1" (Mio. €, fertig formatiert)

  // 5 Ableitungen, je Headline + Fließtext
  "ableitung1.1": string;
  "ableitung1.2": string;
  "ableitung2.1": string;
  "ableitung2.2": string;
  "ableitung3.1": string;
  "ableitung3.2": string;
  "ableitung4.1": string;
  "ableitung4.2": string;
  "ableitung5.1": string;
  "ableitung5.2": string;

  // Footer
  project: string;

  // ── Automatisch generiert (nicht im Formular) ──────────────────────────────
  /** Deal rows for the chart — mapped from dealsData via analyticsColMap */
  dealRows: DealRow[];
}

export interface DealRow {
  deal_id: string;
  company: string;
  company_id: string;
  deal_date: string;  // "YYYY-MM-DD"
  deal_size: number;  // in Mio. €
}

/** The AI-generated content returned by /api/generate-ableitungen */
export interface GeneratedAbleitungen {
  /** Action Title for the slide (≈ 15–20 words, opinion-driven, no buzzwords) */
  actionTitle: string;
  "ableitung1.1": string;
  "ableitung1.2": string;
  "ableitung2.1": string;
  "ableitung2.2": string;
  "ableitung3.1": string;
  "ableitung3.2": string;
  "ableitung4.1": string;
  "ableitung4.2": string;
  "ableitung5.1": string;
  "ableitung5.2": string;
}
