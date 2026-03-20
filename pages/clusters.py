"""Review & Edit page — inspect, edit, chat, and export confirmed clusters."""

import pandas as pd
import plotly.express as px
import streamlit as st

from cluster_chat import render_cluster_chat
from cluster_review import render_cluster_review
from styles import inject_global_css, page_header
from utils import DIMENSIONS

inject_global_css()

# ── Gate ─────────────────────────────────────────────────────────────────────
_confirmed = st.session_state.get("clusters_confirmed", False)
_clustered = (
    st.session_state.get("df_clean") is not None
    and "Cluster" in getattr(st.session_state.get("df_clean"), "columns", [])
)

if not _confirmed or not _clustered:
    page_header("Review & Edit", "Inspect, rename, merge, and chat about your clusters.")
    st.info(
        "Confirm your clustering first — go to **Embed & Cluster**, run the pipeline, "
        "and click **Confirm clusters** when you're happy."
    )
    col_a, col_b = st.columns(2)
    with col_a:
        if st.button("Go to Setup →", width="stretch"):
            st.switch_page("pages/setup.py")
    with col_b:
        if st.button("Go to Embed & Cluster →", type="primary", width="stretch"):
            st.switch_page("pages/embed_cluster.py")
    st.stop()

# ── State ─────────────────────────────────────────────────────────────────────
df          = st.session_state.df_clean
metrics     = st.session_state.get("cluster_metrics") or {}
api_key     = st.session_state.get("api_key", "")
company_col = st.session_state.get("company_col", "name")
dimensions  = [d for d in DIMENSIONS if d in df.columns]

# ── Quality signal ─────────────────────────────────────────────────────────────
sil = metrics.get("silhouette")
db  = metrics.get("davies_bouldin")


def _quality_signal(sil, db):
    signals = []
    if sil is not None:
        signals.append("good" if sil >= 0.5 else ("fair" if sil >= 0.3 else "poor"))
    if db is not None:
        signals.append("good" if db < 1.0 else ("fair" if db < 1.5 else "poor"))
    if not signals:
        return "n/a", "#888"
    if "poor" in signals:
        return "Poor", "#d9534f"
    if "fair" in signals:
        return "Fair", "#f0ad4e"
    return "Good", "#5cb85c"


q_label, q_color = _quality_signal(sil, db)
sil_str  = f"{sil:.3f}" if sil is not None else "n/a"
db_str   = f"{db:.3f}" if db is not None else "n/a"
n_comp   = len(df)
n_clust  = df["Cluster"].nunique() - (1 if "Outliers" in df["Cluster"].values else 0)
n_out    = int((df["Cluster"] == "Outliers").sum())

# ── Header ─────────────────────────────────────────────────────────────────────
_hdr_col, _export_col = st.columns([4, 1])
with _hdr_col:
    page_header("Review & Edit", "Inspect, rename, merge, delete, and chat about your clusters.")
with _export_col:
    show_cols_dl = [
        c for c in [company_col, "Cluster", "Outlier score"] + DIMENSIONS if c in df.columns
    ]
    st.markdown('<div style="padding-top:14px">', unsafe_allow_html=True)
    st.download_button(
        "Download results",
        df[show_cols_dl].to_csv(index=False),
        "cluster_results.csv", "text/csv",
        width="stretch",
        key="export_dl",
    )
    st.markdown('</div>', unsafe_allow_html=True)

# ── Stats row ─────────────────────────────────────────────────────────────────
stat_col1, stat_col2, stat_col3, stat_qual = st.columns(4)
with stat_col1:
    st.metric("Companies", n_comp)
with stat_col2:
    st.metric("Clusters", n_clust)
with stat_col3:
    st.metric("Outliers", n_out)
with stat_qual:
    st.markdown(
        f'<div style="padding-top:8px">'
        f'<div style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;'
        f'color:#7496b2;margin-bottom:4px">Cluster Quality</div>'
        f'<div style="font-size:18px;font-weight:700;color:{q_color}">{q_label}</div>'
        f'<div style="font-family:IBM Plex Mono,monospace;font-size:11px;color:#7496b2">'
        f'Sil {sil_str} · DB {db_str}</div>'
        f'</div>',
        unsafe_allow_html=True,
    )

# ── UMAP scatter — unchanged ───────────────────────────────────────────────────
hover_cols = [c for c in [company_col, "Outlier score"] + DIMENSIONS if c in df.columns]
fig = px.scatter(
    df, x="_x", y="_y", color="Cluster",
    hover_data=hover_cols,
    color_discrete_sequence=px.colors.qualitative.Bold,
    height=480,
)
fig.update_traces(marker=dict(size=7, opacity=0.80))
fig.update_layout(
    margin=dict(l=0, r=0, t=20, b=0),
    xaxis=dict(title="", showticklabels=False, showgrid=False, zeroline=False),
    yaxis=dict(title="", showticklabels=False, showgrid=False, zeroline=False),
    dragmode="lasso",
)
st.plotly_chart(fig, use_container_width=True)

# ── SECTION 1: Cluster overview cards ─────────────────────────────────────────
CLUSTER_COLORS = [
    "#26B4D2", "#F76664", "#7A6ECC", "#F7D864",
    "#4AC596", "#e8845c", "#516e81", "#7496b2",
    "#a78bfa", "#34d399", "#fb923c", "#60a5fa",
]

named_clusters       = [c for c in df["Cluster"].unique() if c != "Outliers"]
cluster_descriptions = st.session_state.get("cr_cluster_descriptions") or {}
_color_map = {
    cname: CLUSTER_COLORS[i % len(CLUSTER_COLORS)]
    for i, cname in enumerate(sorted(named_clusters))
}

st.markdown('<div class="hy-section-title">Cluster overview</div>', unsafe_allow_html=True)
st.caption("Click any card to see all companies in that cluster.")

if named_clusters:
    _n_cols = 4
    _card_rows = [named_clusters[i:i + _n_cols] for i in range(0, len(named_clusters), _n_cols)]
    for _card_row in _card_rows:
        _cols = st.columns(_n_cols)
        for _ci, _cname in enumerate(_card_row):
            _n   = int((df["Cluster"] == _cname).sum())
            _desc = cluster_descriptions.get(_cname, "")
            _first = _desc.split(".")[0].strip() + "." if _desc else ""
            _color = _color_map.get(_cname, "#26B4D2")
            with _cols[_ci]:
                st.markdown(
                    f'<div class="hy-cl-card" style="border-top:3px solid {_color}">'
                    f'<div class="hy-cl-name">{_cname}</div>'
                    f'<span class="hy-cl-chip">{_n} companies</span>'
                    f'<div class="hy-cl-desc">{_first}</div>'
                    f'<div class="hy-cl-arrow">→</div>'
                    f'</div>',
                    unsafe_allow_html=True,
                )
                # Invisible full-card click button (overlaid via CSS)
                if st.button(" ", key=f"card_{_cname}", use_container_width=True):
                    st.session_state["selected_cluster"] = _cname
                    st.rerun()

# ── SECTION 2: Inline company list panel ──────────────────────────────────────
_sel = st.session_state.get("selected_cluster")
if _sel and _sel in named_clusters:
    _sel_color = _color_map.get(_sel, "#26B4D2")
    _n_sel     = int((df["Cluster"] == _sel).sum())
    _companies = df[df["Cluster"] == _sel][company_col].tolist()

    st.markdown(
        f'<div class="hy-co-panel">'
        f'<div class="hy-co-panel-header">'
        f'<div style="display:flex;align-items:center;gap:8px">'
        f'<div style="width:10px;height:10px;border-radius:50%;'
        f'background:{_sel_color};flex-shrink:0"></div>'
        f'<span class="hy-co-panel-title">{_sel}</span>'
        f'<span class="hy-cl-chip">{_n_sel} companies</span>'
        f'</div></div></div>',
        unsafe_allow_html=True,
    )
    _cells = "".join(
        f'<div class="hy-co-row {"hy-co-row-alt" if i % 2 else ""}">'
        f'<div class="hy-co-dot" style="background:{_sel_color}"></div>{name}</div>'
        for i, name in enumerate(_companies)
    )
    st.markdown(f'<div class="hy-co-grid">{_cells}</div>', unsafe_allow_html=True)

    if st.button("✕ Close", key="close_co_panel"):
        st.session_state["selected_cluster"] = None
        st.rerun()

st.divider()

# ── SECTION 3: Cluster editor (full width) ────────────────────────────────────
st.markdown('<div class="hy-section-title">Cluster editor</div>', unsafe_allow_html=True)
st.caption("Expand a cluster to edit its description or browse companies. Use Gemini to re-sort across clusters.")
render_cluster_review(
    df_clean=st.session_state.df_clean,
    company_col=company_col,
    dimensions=dimensions,
    api_key=api_key,
)

# ── SECTION 4: AI Assistant toggle ────────────────────────────────────────────
st.divider()
st.session_state.setdefault("chat_open", False)

_fab_l, _fab_r = st.columns([6, 1])
with _fab_r:
    _btn_label = "✕ Close assistant" if st.session_state["chat_open"] else "💬 AI Assistant"
    if st.button(_btn_label, key="chat_toggle", type="primary", use_container_width=True):
        st.session_state["chat_open"] = not st.session_state["chat_open"]
        st.rerun()

if st.session_state["chat_open"]:
    st.markdown('<div class="hy-chat-float">', unsafe_allow_html=True)
    st.markdown(
        f'<div class="hy-chat-float-header">'
        f'<div class="hy-chat-float-title">AI Assistant</div>'
        f'<div class="hy-chat-float-sub">'
        f'Full knowledge of {n_comp} companies across {n_clust} clusters'
        f'</div></div>',
        unsafe_allow_html=True,
    )
    render_cluster_chat(
        df_clean=st.session_state.df_clean,
        company_col=company_col,
        dimensions=dimensions,
        api_key=api_key,
    )
    st.markdown('</div>', unsafe_allow_html=True)

# ── SECTION 5: CTA ────────────────────────────────────────────────────────────
st.divider()
_cta_l, _cta_r = st.columns([4, 1])
with _cta_r:
    if st.button("Continue to Analytics →", type="primary", use_container_width=True):
        st.switch_page("pages/analytics.py")
