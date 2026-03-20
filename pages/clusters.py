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
page_header("Review & Edit", "Inspect, rename, merge, delete, and chat about your clusters.")

# Top stat row: 3 metrics + quality badge
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

# ── Cluster cards (click to inspect companies) ─────────────────────────────────
named_clusters       = [c for c in df["Cluster"].unique() if c != "Outliers"]
cluster_descriptions = st.session_state.get("cr_cluster_descriptions") or {}

# Cluster color map from Plotly Bold palette
_bold_colors = px.colors.qualitative.Bold
_color_map = {
    cname: _bold_colors[i % len(_bold_colors)]
    for i, cname in enumerate(sorted(named_clusters))
}

if named_clusters:
    n_card_cols = min(4, len(named_clusters))
    card_rows = [
        named_clusters[i:i + n_card_cols]
        for i in range(0, len(named_clusters), n_card_cols)
    ]
    for card_row in card_rows:
        cols = st.columns(len(card_row))
        for col, cname in zip(cols, card_row):
            n = int((df["Cluster"] == cname).sum())
            desc = cluster_descriptions.get(cname, "")
            first_sentence = desc.split(".")[0].strip() + "." if desc else "—"
            border_color = _color_map.get(cname, "#26B4D2")
            with col:
                # Clickable card via button (invisible, overlaid via label)
                _is_selected = st.session_state.get("selected_cluster") == cname
                _card_bg     = "#f0fbfe" if _is_selected else "#ffffff"
                _border_w    = "2px" if _is_selected else "1px"
                st.markdown(
                    f"<div style='border-top:3px solid {border_color};"
                    f"border-left:{_border_w} solid #e4eaf2;"
                    f"border-right:{_border_w} solid #e4eaf2;"
                    f"border-bottom:{_border_w} solid #e4eaf2;"
                    f"border-radius:12px;padding:14px 16px;"
                    f"background:{_card_bg};margin-bottom:4px;"
                    f"position:relative'>"
                    f"<div style='display:flex;justify-content:space-between;"
                    f"align-items:flex-start'>"
                    f"<b style='font-size:13px;color:#0d1f2d'>{cname}</b>"
                    f"<span style='color:#aac0d1;font-size:13px'>→</span>"
                    f"</div>"
                    f"<span class='hy-chip hy-chip-cyan' style='margin:4px 0 6px'>"
                    f"{n} companies</span><br>"
                    f"<small style='color:#7496b2;display:-webkit-box;"
                    f"-webkit-line-clamp:2;-webkit-box-orient:vertical;"
                    f"overflow:hidden;line-height:1.5'>{first_sentence}</small>"
                    f"</div>",
                    unsafe_allow_html=True,
                )
                if st.button(
                    "View companies",
                    key=f"card_click_{cname}",
                    help=f"Inspect companies in {cname}",
                ):
                    st.session_state["selected_cluster"] = cname
                    st.rerun()

# ── Company list dialog for selected cluster ───────────────────────────────────
_sel_cluster = st.session_state.get("selected_cluster")
if _sel_cluster and _sel_cluster in named_clusters:
    @st.dialog(f"{_sel_cluster}", width="large")
    def _cluster_companies_dialog():
        df_c = df[df["Cluster"] == _sel_cluster].reset_index(drop=True)
        st.caption(f"{len(df_c)} companies · click column headers to sort")
        show_cols = [c for c in [company_col, "Outlier score"] + dimensions if c in df_c.columns]
        st.dataframe(df_c[show_cols], use_container_width=True, hide_index=True, height=400)
        if st.button("Close", key="close_cluster_dialog"):
            st.session_state["selected_cluster"] = None
            st.rerun()

    _cluster_companies_dialog()

st.divider()

# ── Export (prominent) ─────────────────────────────────────────────────────────
show_cols_dl = [
    c for c in [company_col, "Cluster", "Outlier score"] + DIMENSIONS if c in df.columns
]
st.download_button(
    "⬇ Download cluster results",
    df[show_cols_dl].to_csv(index=False),
    "cluster_results.csv", "text/csv",
    width="stretch",
    type="primary",
    key="export_dl",
)

st.divider()

# ── Edit (left) | AI Assistant (right) ────────────────────────────────────────
col_edit, col_chat = st.columns([3, 2])

with col_edit:
    render_cluster_review(
        df_clean=st.session_state.df_clean,
        company_col=company_col,
        dimensions=dimensions,
        api_key=api_key,
    )

with col_chat:
    st.markdown(
        '<div style="font-size:14px;font-weight:700;color:#0d1f2d;'
        'letter-spacing:-0.01em;margin-bottom:2px">AI Assistant</div>'
        f'<div style="font-size:11px;color:#7496b2;margin-bottom:12px">'
        f'Full knowledge of {n_comp} companies across {n_clust} clusters</div>',
        unsafe_allow_html=True,
    )
    render_cluster_chat(
        df_clean=st.session_state.df_clean,
        company_col=company_col,
        dimensions=dimensions,
        api_key=api_key,
    )
