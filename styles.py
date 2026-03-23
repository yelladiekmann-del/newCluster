"""Global design system for the Cluster Intelligence app."""

import streamlit as st

_CSS = """
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;700&display=swap');

/* Hide Streamlit chrome */
#MainMenu, footer, header { visibility: hidden; }
.stDeployButton { display: none; }
.stAppDeployButton { display: none; }

/* Page background */
.stApp { background: #f7f9fc; font-family: 'IBM Plex Sans', sans-serif; }

/* ── Sidebar ── */
[data-testid="stSidebar"] {
  background: #001f2b !important;
  border-right: 1px solid #0a4e66;
}
/* Only plain paragraph text in sidebar (no !important — inline styles win) */
[data-testid="stSidebar"] .stMarkdown p { color: #aac0d1; }
[data-testid="stSidebar"] label,
[data-testid="stSidebar"] .stRadio label { color: #aac0d1 !important; }

/* Hide native nav — replaced by st.page_link() calls below the progress bar */
[data-testid="stSidebarNavItems"] { display: none !important; }

/* Custom page links — 01/02/03/04 step style via CSS counter on sidebar */
[data-testid="stSidebar"] { counter-reset: page-nav; }
[data-testid="stPageLink"] { margin: 1px 0 !important; }
[data-testid="stPageLink"] a {
  counter-increment: page-nav;
  display: block !important;
  border-radius: 8px !important;
  padding: 8px 12px !important;
  color: #eef2f7 !important;
  font-size: 12px !important;
  font-weight: 600 !important;
  letter-spacing: -0.01em !important;
  text-decoration: none !important;
  font-family: 'IBM Plex Sans', sans-serif !important;
  line-height: 1.3 !important;
}
[data-testid="stPageLink"] a span,
[data-testid="stPageLink"] a p {
  color: #eef2f7 !important;
  font-size: 12px !important;
  font-weight: 600 !important;
}
[data-testid="stPageLink"] a::before {
  content: "0" counter(page-nav);
  display: block;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9px;
  font-weight: 700;
  color: #516e81;
  letter-spacing: 0.08em;
  margin-bottom: 1px;
}
[data-testid="stPageLink"] a:hover {
  background: #0a4e66 !important;
  color: #ffffff !important;
}
[data-testid="stPageLink"] a:hover::before { color: #aac0d1 !important; }
[data-testid="stPageLink"] a[aria-current="page"] {
  background: #26B4D218 !important;
  color: #26B4D2 !important;
  font-weight: 700 !important;
  border-left: 2px solid #26B4D2 !important;
  padding-left: 10px !important;
}
[data-testid="stPageLink"] a[aria-current="page"]::before {
  color: #26B4D2 !important;
}

/* ── Cards — via st.container(border=True) ── */
[data-testid="stVerticalBlockBorderWrapper"] {
  border: 1px solid #e4eaf2 !important;
  border-radius: 14px !important;
  background: #ffffff !important;
  margin-bottom: 12px !important;
}
/* Legacy .hy-card class (kept for any inline HTML usage) */
.hy-card {
  background: #ffffff;
  border: 1px solid #e4eaf2;
  border-radius: 14px;
  padding: 20px 22px;
  margin-bottom: 12px;
}

/* ── Section labels ── */
.hy-step {
  display: inline-flex; align-items: center; gap: 10px;
  margin-bottom: 16px;
}
.hy-step-num {
  width: 26px; height: 26px; border-radius: 8px;
  background: #001f2b; color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700;
}
.hy-step-num.done { background: #001f2b; }
.hy-step-label { font-size: 14px; font-weight: 600; color: #0d1f2d; letter-spacing: -0.01em; }

/* ── Chips ── */
.hy-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 9px;
  border-radius: 20px; font-size: 11px; font-weight: 500;
  letter-spacing: 0.01em;
}
.hy-chip-cyan  { background: #26B4D218; border: 1px solid #26B4D230; color: #26B4D2; }
.hy-chip-green { background: #22c55e14; border: 1px solid #22c55e30; color: #16a34a; }
.hy-chip-red   { background: #ef444414; border: 1px solid #ef444430; color: #dc2626; }

/* ── Buttons — base style (all buttons) ── */
.stButton button,
[data-testid="stFormSubmitButton"] button {
  background: #001f2b !important; color: #ffffff !important;
  border: none !important; border-radius: 9px !important;
  font-family: 'IBM Plex Sans', sans-serif !important;
  font-size: 12px !important; font-weight: 600 !important;
  letter-spacing: 0.01em !important;
  padding: 8px 18px !important;
  box-shadow: 0 1px 3px #001f2b44 !important;
  transition: all 0.15s !important;
}
.stButton button:hover,
[data-testid="stFormSubmitButton"] button:hover {
  background: #0a4e66 !important;
}

/* CTA buttons (type="primary") — Streamlit 1.38 correct selector */
[data-testid="baseButton-primary"] {
  background: #26B4D2 !important; color: #001f2b !important;
  box-shadow: 0 1px 8px #26B4D255 !important;
}
[data-testid="baseButton-primary"]:hover { background: #1a8fa8 !important; }

/* Ghost buttons (type="secondary") — higher specificity than base .stButton button rule */
.stButton [data-testid="baseButton-secondary"] {
  background: transparent !important; color: #516e81 !important;
  border: 1px solid #d8e1ec !important; box-shadow: none !important;
  font-weight: 500 !important; padding: 6px 10px !important;
}
.stButton [data-testid="baseButton-secondary"]:hover {
  background: #f7f9fc !important; color: #0d1f2d !important;
}

/* ── Inputs and selects ── */
.stTextInput input {
  background: #f7f9fc !important; border: 1px solid #e4eaf2 !important;
  border-radius: 9px !important; font-size: 13px !important; color: #0d1f2d !important;
}
.stTextArea textarea,
[data-testid="stTextArea"] textarea {
  background: #f7f9fc !important; border: 1px solid #e4eaf2 !important;
  border-radius: 9px !important; font-size: 13px !important; color: #0d1f2d !important;
}
[data-baseweb="select"] {
  background: #f7f9fc !important; border: 1px solid #e4eaf2 !important;
  border-radius: 9px !important;
}
[data-baseweb="select"]:focus-within {
  border-color: #26B4D2 !important;
}

/* ── Sliders ── */
/* Track fill color comes from Streamlit's primaryColor theme (.streamlit/config.toml).
   Only the thumb and label need explicit overrides here. */
/* Value label (number above thumb) */
[data-testid="stSlider"] [role="slider"] > div {
  color: #26B4D2 !important;
  border-color: #26B4D2 !important;
}
/* Thumb — white circle with cyan border acts as separator */
[data-testid="stSlider"] [role="slider"] {
  background-color: #ffffff !important;
  border: 2px solid #26B4D2 !important;
}

/* ── Upload zone ── */
[data-testid="stFileUploader"] {
  border: 1.5px dashed #d8e1ec;
  border-radius: 10px; background: #f7f9fc;
  padding: 8px;
}

/* ── Metric numbers — monospace ── */
[data-testid="stMetricValue"] {
  font-family: 'IBM Plex Mono', monospace !important;
  font-weight: 700 !important;
  color: #0d1f2d !important;
}
[data-testid="stMetricLabel"] {
  font-size: 10px !important; text-transform: uppercase;
  letter-spacing: 0.06em; color: #7496b2 !important;
}

/* ── Dataframes / tables ── */
[data-testid="stDataFrame"] { border-radius: 10px; overflow: hidden; }

/* ── Section dividers ── */
hr { border: none; border-top: 1px solid #e4eaf2; margin: 18px 0; }

/* ── Expanders ── */
[data-testid="stExpander"] {
  border: 1px solid #e4eaf2 !important; border-radius: 10px !important;
  background: #ffffff;
}

/* ── Success / info / warning overrides ── */
[data-testid="stAlert"] { border-radius: 9px; }

/* ── Page title style ── */
.hy-page-title {
  font-size: 20px; font-weight: 700; color: #0d1f2d;
  letter-spacing: -0.03em; margin-bottom: 3px;
}
.hy-page-subtitle {
  font-size: 12px; color: #7496b2; margin-bottom: 20px;
}

/* ── Cluster cards (Review page) ── */
.hy-cluster-card {
  background: #ffffff; border: 1px solid #e4eaf2;
  border-radius: 12px; padding: 14px 16px;
  min-height: 120px;
  cursor: pointer; transition: box-shadow 0.15s, transform 0.15s;
}
.hy-cluster-card:hover {
  box-shadow: 0 4px 18px rgba(0,30,50,0.10);
  transform: translateY(-1px);
}

/* ── Analytics table group headers ── */
.hy-group-header {
  font-size: 9px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; color: #516e81;
  background: #26B4D218; border: 1px solid #26B4D218;
  border-radius: 5px; padding: 3px 6px; text-align: center;
}

/* ── Section titles (Review page) ── */
.hy-section-title {
  font-size: 13px; font-weight: 700; color: #0d1f2d;
  letter-spacing: -0.01em; margin-bottom: 2px; margin-top: 4px;
}

/* ── Reload chart button — very subtle, text-like ── */
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-reload-btn-marker) button {
  background: transparent !important;
  border: none !important;
  box-shadow: none !important;
  color: #aac0d1 !important;
  font-size: 10px !important;
  font-weight: 500 !important;
  padding: 2px 6px !important;
  letter-spacing: 0.02em !important;
}
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-reload-btn-marker) button:hover {
  color: #516e81 !important;
  background: transparent !important;
}
/* Hide the marker span */
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-reload-btn-marker) > .element-container:first-child {
  display: none !important;
}

/* ── Field labels inside cluster editor expander ── */
.hy-field-label {
  font-size: 9px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.09em; color: #7496b2;
  margin-bottom: 8px; margin-top: 2px;
  display: block;
  font-family: 'IBM Plex Mono', monospace;
}

/* ── Cluster overview cards ── */
.hy-cl-card {
  background: #fff;
  border: 1px solid #e4eaf2;
  border-radius: 11px;
  padding: 14px 15px 10px;
  transition: box-shadow 0.15s;
}
.hy-cl-card:hover {
  box-shadow: 0 4px 16px rgba(0,30,50,0.09);
}
.hy-cl-name {
  font-size: 13px; font-weight: 700;
  color: #0d1f2d; letter-spacing: -0.01em;
  line-height: 1.3; margin-bottom: 7px;
}
.hy-cl-chip {
  display: inline-flex; align-items: center;
  padding: 2px 8px;
  background: #26B4D215; border: 1px solid #26B4D230;
  border-radius: 20px; font-size: 10px;
  font-weight: 600; color: #1a8fa8;
  margin-bottom: 9px;
}
.hy-cl-desc {
  font-size: 10.5px; color: #7496b2;
  line-height: 1.55;
}

/* ── Card view buttons — the st.columns() row immediately after the card grid ── */
.element-container:has(.hy-cl-grid) + .element-container .stButton button {
  border-top-left-radius: 0 !important;
  border-top-right-radius: 0 !important;
  border-top: none !important;
  margin-top: -1px !important;
  background: #f7f9fc !important;
  color: #516e81 !important;
  font-size: 11px !important;
  font-weight: 500 !important;
  box-shadow: none !important;
  border: 1px solid #e4eaf2 !important;
  padding: 6px 12px !important;
}
.element-container:has(.hy-cl-grid) + .element-container .stButton button:hover {
  background: #eef2f7 !important;
  color: #0d1f2d !important;
}

/* ── Inline company list panel ── */
.hy-co-panel {
  background: #fff;
  border: 1px solid #e4eaf2;
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 20px;
}
.hy-co-panel-header {
  padding: 12px 16px;
  border-bottom: 1px solid #eef2f7;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.hy-co-panel-title {
  font-size: 12px; font-weight: 700; color: #0d1f2d;
}
.hy-co-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  background: #eef2f7;
  max-height: 280px;
  overflow-y: auto;
}
.hy-co-row {
  background: #fff;
  padding: 8px 12px;
  font-size: 11px;
  color: #0d1f2d;
  display: flex;
  align-items: center;
  gap: 7px;
}
.hy-co-row-alt { background: #f7f9fc; }
.hy-co-dot {
  width: 5px; height: 5px;
  border-radius: 50%; flex-shrink: 0;
}

/* ── Cluster editor row style ── */
.hy-editor-row {
  display: flex; align-items: center;
  justify-content: space-between;
  padding: 9px 13px;
  border: 1px solid #eef2f7;
  border-radius: 9px;
  margin-bottom: 6px;
  background: #f7f9fc;
}
.hy-editor-dot {
  width: 8px; height: 8px;
  border-radius: 50%; flex-shrink: 0;
}
.hy-editor-name {
  font-size: 12px; font-weight: 600; color: #0d1f2d;
}
.hy-editor-count {
  font-size: 11px; color: #aac0d1; margin-left: 4px;
}

/* ── Re-sort box ── */
.hy-resort-box {
  background: #f7f9fc;
  border: 1px solid #e4eaf2;
  border-radius: 9px;
  padding: 14px 16px;
  margin-top: 14px;
}

/* ── AI Assistant floating panel ── */
.hy-chat-float {
  background: #fff;
  border: 1px solid #e4eaf2;
  border-radius: 14px;
  overflow: hidden;
  margin-top: 16px;
  box-shadow: 0 8px 32px rgba(0,30,50,0.12);
}
.hy-chat-float-header {
  padding: 14px 18px 10px;
  border-bottom: 1px solid #eef2f7;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  background: #001f2b;
}
.hy-chat-float-title {
  font-size: 13px; font-weight: 700;
  color: #fff; letter-spacing: -0.01em;
}
.hy-chat-float-sub {
  font-size: 10px; color: #7496b2; margin-top: 2px;
}
[data-testid="stElementToolbar"] { display: none !important; }
[data-testid="InputInstructions"] { display: none !important; }

/* ── Company list in dialog ── */
.hy-co-list {
  max-height: 460px; overflow-y: auto;
  border: 1px solid #e4eaf2; border-radius: 10px; margin-top: 8px;
}
.hy-co-item {
  display: grid; grid-template-columns: 220px 1fr auto;
  align-items: baseline; gap: 12px;
  padding: 10px 14px; border-bottom: 1px solid #f0f4f8;
}
.hy-co-item:last-child { border-bottom: none; }
.hy-co-item:nth-child(even) { background: #f7f9fc; }
.hy-co-item-name { font-size: 13px; font-weight: 600; color: #0d1f2d; }
.hy-co-item-desc { font-size: 11.5px; color: #7496b2; line-height: 1.4; }
.hy-co-item-url  {
  font-size: 11px; color: #26B4D2; text-decoration: none;
  flex-shrink: 0; white-space: nowrap;
}
.hy-co-item-url:hover { text-decoration: underline; }
.hy-co-empty { padding: 20px 14px; font-size: 12px; color: #aac0d1; text-align: center; }

/* ══════════════════════════════════════════════════════════════════════════════
   HY-CR-ICON-BTN — cluster editor merge/delete icon buttons
   Scoped via the inner st.container() stVB whose DIRECT .element-container child
   carries the marker. No `all:unset`, no assumed stHB depth — just overrides the
   handful of properties that make the button look dark.
   ══════════════════════════════════════════════════════════════════════════════ */
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-icon-row-marker) button {
  background:  transparent !important;
  border:      none        !important;
  box-shadow:  none        !important;
  padding:     2px 4px     !important;
  min-height:  26px        !important;
  height:      26px        !important;
  color:       #c8d8e4     !important;
}
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-icon-row-marker) button p,
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-icon-row-marker) button span {
  color: inherit !important;
  font-size: 17px !important;
}
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-icon-row-marker) button:hover {
  background: #f0f4f8 !important;
}
/* Merge (2nd col) sharpens to grey-blue on hover */
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-icon-row-marker) [data-testid="stColumn"]:nth-child(2) button:hover {
  color: #7496b2 !important;
}
/* Delete (3rd col) sharpens to red on hover */
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-icon-row-marker) [data-testid="stColumn"]:nth-child(3) button:hover {
  color: #c0392b !important;
}

/* ══════════════════════════════════════════════════════════════════════════════
   HY-CR-ADD-BTN — cluster editor "+" add companies button (separate marker)
   ══════════════════════════════════════════════════════════════════════════════ */
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-add-row-marker) [data-testid="stColumn"]:last-child button {
  background:  transparent !important;
  border:      none        !important;
  box-shadow:  none        !important;
  padding:     2px 4px     !important;
  min-height:  26px        !important;
  height:      26px        !important;
  color:       #c8d8e4     !important;
}
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-add-row-marker) [data-testid="stColumn"]:last-child button p,
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-add-row-marker) [data-testid="stColumn"]:last-child button span {
  color: inherit !important;
  font-size: 18px !important;
}
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-add-row-marker) [data-testid="stColumn"]:last-child button:hover {
  background: #f0f4f8  !important;
  color:      #26B4D2  !important;
}

/* ══════════════════════════════════════════════════════════════════════════════
   HY-CR-CO-LIST — per-row move/delete icons inside the company list
   Scoped via hy-cr-co-list-marker; same icon style as HY-CR-ICON-BTN.
   ══════════════════════════════════════════════════════════════════════════════ */

/* Container — matches .hy-co-list */
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-co-list-marker) {
  border: 1px solid #e4eaf2 !important;
  border-radius: 10px !important;
  overflow-y: auto !important;
  max-height: 320px !important;
  margin-top: 8px;
}
/* Hide the marker span element-container */
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-co-list-marker) > .element-container:first-child {
  display: none !important;
}
/* Collapse Streamlit's default spacing so rows stay tight */
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-co-list-marker) .element-container {
  margin-bottom: 0 !important;
}
/* Each company row — matches .hy-co-item padding + border */
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-co-list-marker) [data-testid="stHorizontalBlock"] {
  align-items: center !important;
  gap: 0 !important;
  padding: 8px 14px !important;
  border-bottom: 1px solid #f0f4f8 !important;
}
/* Alternating row background — matches .hy-co-item:nth-child(even) */
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-co-list-marker) > .element-container:nth-child(even) [data-testid="stHorizontalBlock"] {
  background: #f7f9fc !important;
}
/* Vertically center content within each column */
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-co-list-marker) [data-testid="stColumn"] {
  display: flex !important;
  align-items: center !important;
}
/* Collapse the stVerticalBlock wrapper inside button columns */
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-co-list-marker) [data-testid="stColumn"] > [data-testid="stVerticalBlock"] {
  gap: 0 !important;
  padding: 0 !important;
  margin: 0 !important;
}
/* Icon buttons */
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-co-list-marker) button {
  background:  transparent !important;
  border:      none        !important;
  box-shadow:  none        !important;
  padding:     2px 4px     !important;
  min-height:  26px        !important;
  height:      26px        !important;
  color:       #c8d8e4     !important;
}
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-co-list-marker) button p,
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-co-list-marker) button span {
  color: inherit !important;
  font-size: 15px !important;
}
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-co-list-marker) button:hover {
  background: #f0f4f8 !important;
}
/* Move arrow sharpens to grey-blue on hover */
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-co-list-marker) [data-testid="stColumn"]:nth-child(2) button:hover {
  color: #7496b2 !important;
}
/* Delete bin sharpens to red on hover */
div[data-testid="stVerticalBlock"]:has(> .element-container .hy-cr-co-list-marker) [data-testid="stColumn"]:nth-child(3) button:hover {
  color: #c0392b !important;
}

/* ── Analytics Spotlight cards ── */
.hy-spot-card {
  background: #fff; border: 1px solid #e4eaf2; border-radius: 10px;
  padding: 16px 18px; position: relative; overflow: hidden;
}
.hy-spot-card::before {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
}
.hy-spot-gold::before { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
.hy-spot-teal::before { background: linear-gradient(90deg, #26B4D2, #22d3ee); }
.hy-spot-blue::before { background: linear-gradient(90deg, #6366f1, #818cf8); }
.hy-spot-tag {
  font-size: 9px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.08em; margin-bottom: 6px;
  font-family: 'IBM Plex Mono', monospace;
}
.hy-spot-gold .hy-spot-tag { color: #d97706; }
.hy-spot-teal .hy-spot-tag { color: #0e9ab5; }
.hy-spot-blue .hy-spot-tag { color: #6366f1; }
.hy-spot-name {
  font-size: 14px; font-weight: 700; color: #0d1f2d;
  letter-spacing: -0.01em; margin-bottom: 10px; line-height: 1.25;
}
.hy-spot-value {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11.5px; font-weight: 600; padding: 3px 10px; border-radius: 20px;
}
.hy-spot-gold .hy-spot-value { background: #fef3c7; color: #92400e; }
.hy-spot-teal .hy-spot-value { background: #d1fae5; color: #065f46; }
.hy-spot-blue .hy-spot-value { background: #ede9fe; color: #5b21b6; }

/* ── Analytics momentum chips (inside HTML table) ── */
.hy-mom-chip {
  display: inline-flex; align-items: center;
  padding: 2px 7px; border-radius: 4px;
  font-size: 10px; font-weight: 700;
  font-family: 'IBM Plex Mono', monospace; white-space: nowrap;
}
.hy-mom-chip-pos { background: #dcfce7; color: #15803d; }
.hy-mom-chip-neg { background: #fee2e2; color: #dc2626; }
.hy-mom-chip-neu { background: #f0f4f8; color: #7496b2; }

/* ── Analytics KPI cards ── */
.hy-kpi-card {
  background: #ffffff;
  border: 1px solid #e4eaf2;
  border-radius: 12px;
  padding: 16px 18px 14px;
  flex: 1;
}
.hy-kpi-label {
  font-size: 9px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.07em; color: #7496b2;
  font-family: 'IBM Plex Mono', monospace;
  margin-bottom: 6px;
}
.hy-kpi-value {
  font-size: 22px; font-weight: 700;
  font-family: 'IBM Plex Mono', monospace;
  color: #0d1f2d; line-height: 1.1;
}
.hy-kpi-sub {
  font-size: 10px; color: #7496b2; margin-top: 4px;
}

/* ── Analytics rank cards ── */
.hy-rank-card {
  display: flex; align-items: center; gap: 14px;
  background: #ffffff; border: 1px solid #e4eaf2;
  border-radius: 10px; padding: 12px 16px;
  margin-bottom: 8px;
}
.hy-rank-badge {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px; font-weight: 700;
  background: #001f2b; color: #ffffff;
  border-radius: 6px; padding: 3px 7px;
  flex-shrink: 0;
}
.hy-rank-badge-gold { background: #26B4D2 !important; color: #001f2b !important; }
.hy-rank-name {
  font-size: 13px; font-weight: 600; color: #0d1f2d;
  flex: 1; min-width: 0;
}
.hy-rank-bar-wrap {
  width: 140px; background: #e4eaf2;
  border-radius: 4px; height: 6px; flex-shrink: 0;
}
.hy-rank-bar { background: #26B4D2; border-radius: 4px; height: 6px; }
.hy-rank-score {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px; font-weight: 700; color: #0d1f2d;
  flex-shrink: 0; min-width: 44px; text-align: right;
}

/* ── Analytics HTML table ── */
.hy-tbl-wrap {
  overflow-x: auto; margin-bottom: 8px;
  border-radius: 10px; border: 1px solid #e4eaf2;
  box-shadow: 0 1px 4px rgba(0,0,0,0.05);
}
.hy-tbl { border-collapse: collapse; width: 100%; font-size: 11px; }
.hy-th-fixed {
  background: #f7f9fc; color: #7496b2;
  font-family: 'IBM Plex Mono', monospace; font-size: 9px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.06em;
  padding: 6px 8px; text-align: left; white-space: nowrap;
  position: sticky; left: 0; z-index: 2;
  border-bottom: 1px solid #e4eaf2;
}
.hy-th-fixed.hy-th-cluster { min-width: 180px; }
.hy-th-group {
  background: #f0f4f8; color: #aac0d1;
  font-family: 'IBM Plex Sans', sans-serif;
  font-size: 8px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.08em; text-align: center; padding: 5px 4px;
  border-bottom: 1px solid #e4eaf2;
}
.hy-th-col {
  background: #f7f9fc; color: #7496b2;
  font-family: 'IBM Plex Sans', sans-serif;
  font-size: 9px; font-weight: 700; text-align: right; padding: 5px 8px;
  white-space: nowrap; border-bottom: 1px solid #e4eaf2;
}
.hy-td {
  padding: 5px 8px; text-align: right; white-space: nowrap;
  font-family: 'IBM Plex Mono', monospace; font-size: 11px;
  color: #516e81; border-right: 1px solid #f0f4f8;
}
.hy-td-idx { color: #aac0d1; font-size: 10px; text-align: center; min-width: 24px; }
.hy-td-cluster {
  text-align: left; font-family: 'IBM Plex Sans', sans-serif;
  font-weight: 600; font-size: 11.5px; color: #0d1f2d;
  min-width: 180px; max-width: 240px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hy-tr-odd  td { background: #ffffff; }
.hy-tr-even td { background: #f7f9fc; }
/* Rank highlighting: text-based (bold/dark = best, muted = worst) */
.hy-td-rank1 { color: #0d1f2d !important; font-weight: 700 !important; }
.hy-td-rank2 { color: #0d1f2d !important; font-weight: 600 !important; }

/* ── Sort report ── */
.hy-sr-banner {
  background: #001f2b; border: 1px solid #0a4e66; border-radius: 12px;
  padding: 14px 18px; display: flex; align-items: center; gap: 20px;
  margin-bottom: 12px;
}
.hy-sr-chips { display: flex; gap: 10px; flex-wrap: wrap; flex: 1; }
.hy-sr-chip {
  display: inline-flex; align-items: center; gap: 5px;
  background: rgba(38,180,210,0.12); border: 1px solid rgba(38,180,210,0.25);
  border-radius: 20px; padding: 4px 12px;
  font-family: 'IBM Plex Sans', sans-serif; font-size: 12px; color: #aac0d1;
}
.hy-sr-chip b { color: #26B4D2; font-weight: 700; font-size: 14px; }
.hy-sr-chip.green { background: rgba(74,197,150,0.12); border-color: rgba(74,197,150,0.25); }
.hy-sr-chip.green b { color: #4AC596; }
.hy-sr-tbl { border-collapse: collapse; width: 100%; font-size: 12px; margin-top: 4px; }
.hy-sr-tbl thead th {
  background: #001f2b; color: rgba(255,255,255,0.6);
  font-family: 'IBM Plex Mono', monospace; font-size: 9px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.07em;
  padding: 7px 12px; text-align: left; border-bottom: 1px solid #0a4e66;
}
.hy-sr-tbl thead th:not(:first-child) { text-align: right; }
.hy-sr-tbl tbody td {
  padding: 6px 12px; border-bottom: 1px solid #f0f4f8;
  font-family: 'IBM Plex Mono', monospace; color: #0d1f2d; font-size: 12px;
  text-align: right;
}
.hy-sr-tbl tbody td:first-child {
  font-family: 'IBM Plex Sans', sans-serif; font-weight: 600; text-align: left;
}
.hy-sr-tbl tbody tr:nth-child(even) td { background: #f7f9fc; }
.hy-sr-tbl tbody tr:last-child td { border-bottom: none; }
.hy-sr-pos { color: #15803d !important; font-weight: 600 !important; }
.hy-sr-neg { color: #dc2626 !important; font-weight: 600 !important; }
.hy-sr-neu { color: #aac0d1 !important; }
.hy-sr-section {
  font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em;
  color: #7496b2; font-family: 'IBM Plex Mono', monospace;
  margin: 16px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #e4eaf2;
}
.hy-sr-wrap { border: 1px solid #e4eaf2; border-radius: 10px; overflow: hidden; margin-bottom: 8px; }
.hy-td-rank3 { color: #516e81 !important; }
.hy-td-rank4 { color: #aac0d1 !important; }
"""


def inject_global_css() -> None:
    """Inject the full design system CSS into the page."""
    st.markdown(f"<style>{_CSS}</style>", unsafe_allow_html=True)


def card(content_fn):
    """Wrap content in a styled card div (legacy helper — prefer st.container(border=True))."""
    st.markdown('<div class="hy-card">', unsafe_allow_html=True)
    content_fn()
    st.markdown('</div>', unsafe_allow_html=True)


def step_label(n, label, done=False):
    """Render a numbered step label."""
    done_class = "done" if done else ""
    symbol = str(n)
    st.markdown(
        f'<div class="hy-step">'
        f'<div class="hy-step-num {done_class}">{symbol}</div>'
        f'<span class="hy-step-label">{label}</span>'
        f'</div>',
        unsafe_allow_html=True,
    )


def chip(text, variant="cyan"):
    """Render an inline status chip."""
    st.markdown(
        f'<span class="hy-chip hy-chip-{variant}">{text}</span>',
        unsafe_allow_html=True,
    )


def page_header(title, subtitle=""):
    """Render the page title and optional subtitle."""
    st.markdown(f'<div class="hy-page-title">{title}</div>', unsafe_allow_html=True)
    if subtitle:
        st.markdown(f'<div class="hy-page-subtitle">{subtitle}</div>', unsafe_allow_html=True)


def mono(value):
    """Render a value in IBM Plex Mono."""
    return f'<span style="font-family:IBM Plex Mono,monospace;font-weight:700">{value}</span>'


def momentum_badge(value_str):
    """Green or red badge for momentum values like +42% or -6%."""
    is_pos = str(value_str).startswith("+")
    bg  = "#f0fdf4" if is_pos else "#fff1f0"
    col = "#15803d" if is_pos else "#dc2626"
    return (
        f'<span style="padding:2px 7px;border-radius:5px;font-size:11px;'
        f'font-weight:700;background:{bg};color:{col}">{value_str}</span>'
    )
