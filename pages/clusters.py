"""Review & Edit page — inspect, edit, chat, and export confirmed clusters."""

import pandas as pd
import plotly.express as px
import streamlit as st

from cluster_chat import render_cluster_chat
from cluster_review import render_cluster_review
from utils import DIMENSIONS

# ── Gate ─────────────────────────────────────────────────────────────────────
_confirmed = st.session_state.get("clusters_confirmed", False)
_clustered = (
    st.session_state.get("df_clean") is not None
    and "Cluster" in getattr(st.session_state.get("df_clean"), "columns", [])
)

if not _confirmed or not _clustered:
    st.title("🗂️ Review & Edit")
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
st.title("🗂️ Review & Edit")

col_stats, col_quality = st.columns([3, 2])
with col_stats:
    st.markdown(
        f"<span style='color:#888'>{n_comp} companies · {n_clust} clusters · {n_out} outliers</span>",
        unsafe_allow_html=True,
    )
with col_quality:
    st.markdown(
        f"<span style='color:{q_color}; font-size:1.1em'>●</span> "
        f"**Quality: {q_label}** "
        f"<span style='color:#888; font-size:0.85em'>(Sil {sil_str} · DB {db_str})</span>",
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

# ── Cluster cards ──────────────────────────────────────────────────────────────
named_clusters       = [c for c in df["Cluster"].unique() if c != "Outliers"]
cluster_descriptions = st.session_state.get("cr_cluster_descriptions") or {}

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
            with col:
                st.markdown(
                    f"<div style='border:1px solid #e0e0e0;border-radius:8px;"
                    f"padding:10px 12px;margin:2px 0;min-height:110px'>"
                    f"<b>{cname}</b><br>"
                    f"<span style='color:#888'>{n} companies</span><br>"
                    f"<small style='color:#555;display:-webkit-box;-webkit-line-clamp:3;"
                    f"-webkit-box-orient:vertical;overflow:hidden'>{first_sentence}</small>"
                    f"</div>",
                    unsafe_allow_html=True,
                )

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

# ── Edit (left) | Chat (right) ─────────────────────────────────────────────────
col_edit, col_chat = st.columns([3, 2])

with col_edit:
    render_cluster_review(
        df_clean=st.session_state.df_clean,
        company_col=company_col,
        dimensions=dimensions,
        api_key=api_key,
    )

with col_chat:
    render_cluster_chat(
        df_clean=st.session_state.df_clean,
        company_col=company_col,
        dimensions=dimensions,
        api_key=api_key,
    )
