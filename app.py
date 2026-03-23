import base64
import pathlib

import streamlit as st
from utils import SESSION_DEFAULTS
from styles import inject_global_css

def _logo_b64() -> str | None:
    for name in ("logo.png", "logo.jpg", "logo.jpeg", "logo.svg"):
        p = pathlib.Path(__file__).parent / "static" / name
        if p.exists():
            return base64.b64encode(p.read_bytes()).decode()
    return None

st.set_page_config(page_title="Cluster Intelligence", page_icon="🗂️", layout="wide")

inject_global_css()

# ── Shared session state ───────────────────────────────────────────────────────
for k, v in SESSION_DEFAULTS.items():
    st.session_state.setdefault(k, v)

# ── Routing logic ──────────────────────────────────────────────────────────────
_confirmed = st.session_state.get("clusters_confirmed", False)
_has_data  = (
    st.session_state.get("df_clean") is not None
    or st.session_state.get("feature_matrix") is not None
)
_has_embeddings = st.session_state.get("feature_matrix") is not None

# Pipeline progress (0–4 steps)
_steps_done = sum([
    bool(st.session_state.get("api_key")),
    _has_data,
    _has_embeddings,
    _confirmed,
])

_setup_page     = st.Page("pages/setup.py",         title="Setup",           default=not _has_data)
_embed_page     = st.Page("pages/embed_cluster.py", title="Embed & Cluster", default=_has_data and not _confirmed)
_review_page    = st.Page("pages/clusters.py",      title="Review & Edit",   default=_confirmed)
_analytics_page = st.Page("pages/analytics.py",     title="Analytics")

# ── Sidebar branding ───────────────────────────────────────────────────────────
_b64 = _logo_b64()
_logo_tag = (
    f'<img src="data:image/png;base64,{_b64}" '
    f'width="52" height="52" style="border-radius:10px;flex-shrink:0">'
    if _b64 else
    '<div style="width:36px;height:36px;border-radius:10px;border:2px solid #26B4D2;'
    'display:flex;align-items:center;justify-content:center;'
    'font-size:16px;font-weight:700;color:#26B4D2;background:#001f2b;flex-shrink:0">hy</div>'
)

with st.sidebar:
    st.markdown(
        f"""
        <div style="display:flex;align-items:center;gap:0;padding:16px 0 12px 0">
          {_logo_tag}
          <div>
            <div style="font-size:13px;font-weight:700;color:#eef2f7;letter-spacing:-0.01em">
              Cluster Intelligence
            </div>
            <div style="font-size:10px;color:#516e81;letter-spacing:0.02em">
              Powered by Gemini
            </div>
          </div>
        </div>
        """,
        unsafe_allow_html=True,
    )

    # Pipeline progress bar
    _pct = int(_steps_done / 4 * 100)
    _bar_filled = "#26B4D2"
    _bar_bg     = "#0a4e66"
    st.markdown(
        f"""
        <div style="margin-bottom:18px">
          <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.06em;
               color:#516e81;margin-bottom:5px">Pipeline · {_steps_done}/4 complete</div>
          <div style="height:4px;border-radius:2px;background:{_bar_bg}">
            <div style="height:4px;border-radius:2px;background:{_bar_filled};
                 width:{_pct}%;transition:width 0.3s"></div>
          </div>
        </div>
        """,
        unsafe_allow_html=True,
    )

    # Nav links — ordered below progress bar (native nav hidden via CSS)
    st.page_link(_setup_page,     label="Setup")
    st.page_link(_embed_page,     label="Embed & Cluster")
    st.page_link(_review_page,    label="Review & Edit")
    st.page_link(_analytics_page, label="Analytics")

    # Status indicator at bottom
    _api_ok  = bool(st.session_state.get("api_key"))
    _row_count = len(st.session_state["df_clean"]) if st.session_state.get("df_clean") is not None else 0
    _api_color  = "#26B4D2" if _api_ok  else "#516e81"
    _api_label  = "API connected" if _api_ok else "No API key"
    _data_label = f"{_row_count} companies" if _row_count else "No data loaded"
    st.markdown(
        f"""
        <div style="border-top:1px solid #0a4e66;padding-top:12px;margin-top:10px">
          <div style="font-size:10px;color:{_api_color};margin-bottom:3px">
            ● {_api_label}
          </div>
          <div style="font-size:10px;color:#516e81">{_data_label}</div>
        </div>
        """,
        unsafe_allow_html=True,
    )

pg = st.navigation([_setup_page, _embed_page, _review_page, _analytics_page])
pg.run()
