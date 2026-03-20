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

# ── UMAP scatter ───────────────────────────────────────────────────────────────
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


@st.dialog("Companies", width="large")
def _companies_dialog(cname, df_cluster, cluster_company_col, color):
    n = len(df_cluster)
    df_cluster = df_cluster.reset_index(drop=True)

    st.markdown(
        f'<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">'
        f'<div style="width:12px;height:12px;border-radius:50%;background:{color}"></div>'
        f'<span style="font-size:15px;font-weight:700;color:#0d1f2d">{cname}</span>'
        f'<span style="font-size:11px;color:#7496b2;background:#f7f9fc;border:1px solid #e4eaf2;'
        f'border-radius:20px;padding:2px 10px">{n} companies</span>'
        f'</div>',
        unsafe_allow_html=True,
    )

    _desc_col = "Description" if "Description" in df_cluster.columns else None
    _url_cols = ["website", "url", "URL", "Website", "web", "Website URL", "homepage", "Homepage"]
    _url_col  = next((c for c in _url_cols if c in df_cluster.columns), None)
    _has_details = bool(_desc_col or _url_col)

    st.caption("Click a row to view description and website." if _has_details else "")
    event = st.dataframe(
        df_cluster[[cluster_company_col]],
        use_container_width=True,
        hide_index=True,
        on_select="rerun",
        selection_mode="single-row",
        height=min(320, max(80, 35 * n + 38)),
        key="co_dlg_df",
    )

    if _has_details and event.selection.rows:
        row = df_cluster.iloc[event.selection.rows[0]]
        st.markdown(
            f'<div style="margin-top:12px;padding:14px 16px;background:#f7f9fc;'
            f'border:1px solid #e4eaf2;border-radius:10px">',
            unsafe_allow_html=True,
        )
        st.markdown(f"**{row[cluster_company_col]}**")
        if _desc_col:
            desc = str(row.get(_desc_col, "") or "").strip()
            if desc and desc.lower() not in ("nan", "none"):
                st.markdown(desc)
        if _url_col:
            raw_url = str(row.get(_url_col, "") or "").strip()
            if raw_url and raw_url.lower() not in ("nan", "none", ""):
                href = raw_url if raw_url.startswith(("http://", "https://")) else f"https://{raw_url}"
                st.markdown(f"[Visit website →]({href})")
        st.markdown("</div>", unsafe_allow_html=True)

    st.markdown("<div style='height:8px'></div>", unsafe_allow_html=True)
    if st.button("Close", key="co_dlg_close"):
        st.session_state["selected_cluster"] = None
        st.rerun()


# Trigger company list dialog if a card was clicked
_sel = st.session_state.get("selected_cluster")
if _sel and _sel in named_clusters:
    _companies_dialog(
        _sel,
        df[df["Cluster"] == _sel],
        company_col,
        _color_map.get(_sel, "#26B4D2"),
    )

st.markdown('<div class="hy-section-title">Cluster overview</div>', unsafe_allow_html=True)
st.caption("Click any card to see all companies in that cluster.")

if named_clusters:
    _n_cols = 4
    _card_rows = [named_clusters[i:i + _n_cols] for i in range(0, len(named_clusters), _n_cols)]
    for _card_row in _card_rows:
        _cols = st.columns(_n_cols)
        for _ci, _cname in enumerate(_card_row):
            _n    = int((df["Cluster"] == _cname).sum())
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
                if st.button(" ", key=f"card_{_cname}", use_container_width=True):
                    st.session_state["selected_cluster"] = _cname

# ── SECTION 2: AI Assistant ────────────────────────────────────────────────────
st.divider()
st.markdown('<div class="hy-section-title">AI Assistant</div>', unsafe_allow_html=True)
st.caption(f"Ask anything about your {n_comp} companies across {n_clust} clusters.")
render_cluster_chat(
    df_clean=st.session_state.df_clean,
    company_col=company_col,
    dimensions=dimensions,
    api_key=api_key,
)

# ── SECTION 3: Cluster editor ──────────────────────────────────────────────────
st.divider()
st.markdown('<div class="hy-section-title">Cluster editor</div>', unsafe_allow_html=True)
st.caption("Review and refine each cluster — rename, merge, delete, or reassign companies with Gemini.")
render_cluster_review(
    df_clean=st.session_state.df_clean,
    company_col=company_col,
    dimensions=dimensions,
    api_key=api_key,
    color_map=_color_map,
)

# ── CTA ────────────────────────────────────────────────────────────────────────
st.divider()
_cta_l, _cta_r = st.columns([4, 1])
with _cta_r:
    if st.button("Continue to Analytics →", type="primary", use_container_width=True):
        st.switch_page("pages/analytics.py")
