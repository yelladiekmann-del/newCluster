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
.hy-step-num.done { background: #26B4D2; box-shadow: 0 0 12px #26B4D244; }
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

/* Ghost buttons (type="secondary") */
[data-testid="baseButton-secondary"] {
  background: transparent !important; color: #0d1f2d !important;
  border: 1px solid #d8e1ec !important; box-shadow: none !important;
}
[data-testid="baseButton-secondary"]:hover {
  background: #f7f9fc !important;
}

/* ── Inputs and selects ── */
.stTextInput input {
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
    symbol = "✓" if done else str(n)
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
