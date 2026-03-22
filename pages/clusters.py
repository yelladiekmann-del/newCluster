"""Review & Edit page — inspect, edit, chat, and export confirmed clusters."""

import pandas as pd
import plotly.express as px
import streamlit as st

from cluster_chat import render_cluster_chat
from cluster_review import render_cluster_review, show_companies_dialog
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
    page_header("Review & Edit v2", "Inspect, rename, merge, and chat about your clusters.")
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
    page_header("Review & Edit v2", "Inspect, rename, merge, delete, and chat about your clusters.")
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
_named = sorted([c for c in df["Cluster"].unique() if c != "Outliers"])
_has_outliers = "Outliers" in df["Cluster"].values
_cluster_order = _named + (["Outliers"] if _has_outliers else [])
_palette = px.colors.qualitative.Bold
_color_map = {c: _palette[i % len(_palette)] for i, c in enumerate(_named)}
if _has_outliers:
    _color_map["Outliers"] = "rgba(150,150,150,0.35)"

@st.cache_data
def _make_scatter(df, hover_cols, color_map_items, cluster_order):
    fig = px.scatter(
        df, x="_x", y="_y", color="Cluster",
        hover_data=list(hover_cols),
        color_discrete_map=dict(color_map_items),
        category_orders={"Cluster": list(cluster_order)},
        height=480,
        render_mode="webgl",
    )
    fig.update_traces(marker=dict(size=7, opacity=0.80))
    fig.update_layout(
        margin=dict(l=0, r=0, t=20, b=0),
        xaxis=dict(title="", showticklabels=False, showgrid=False, zeroline=False),
        yaxis=dict(title="", showticklabels=False, showgrid=False, zeroline=False),
        dragmode="lasso",
    )
    return fig

hover_cols = tuple(c for c in [company_col, "Outlier score"] + DIMENSIONS if c in df.columns)
_umap_sig = (df.shape[0], round(float(df["_x"].sum()), 2), round(float(df["_y"].sum()), 2))

# Auto-build only on first visit or when UMAP coordinates change (new clustering run).
# On data edits (renames, company moves) the chart stays frozen until user clicks Reload.
if "scatter_fig" not in st.session_state or st.session_state.get("scatter_umap_sig") != _umap_sig:
    st.session_state["scatter_fig"] = _make_scatter(
        df, hover_cols, tuple(sorted(_color_map.items())), tuple(_cluster_order)
    )
    st.session_state["scatter_umap_sig"] = _umap_sig

# Skip chart serialisation entirely when a dialog is about to open — the modal
# covers the chart anyway and st.plotly_chart is the most expensive render step.
_DIALOG_STATE_KEYS = (
    "cr_company_editor_cluster", "cr_move_company", "cr_company_detail",
    "cr_add_companies_cluster", "cr_merge_pending", "cr_delete_pending",
    "cr_add_cluster_pending",
)
_any_dialog = any(st.session_state.get(k) for k in _DIALOG_STATE_KEYS)

if not _any_dialog:
    st.plotly_chart(st.session_state["scatter_fig"], use_container_width=True)
    _, _reload_col = st.columns([8, 1])
    with _reload_col:
        st.markdown('<span class="hy-reload-btn-marker"></span>', unsafe_allow_html=True)
        if st.button("↻ reload chart", key="reload_scatter", type="secondary", use_container_width=True):
            _make_scatter.clear()
            st.session_state["scatter_fig"] = _make_scatter(
                df, hover_cols, tuple(sorted(_color_map.items())), tuple(_cluster_order)
            )
else:
    st.markdown('<div style="height:480px"></div>', unsafe_allow_html=True)

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
st.caption("Click a cluster to see all companies inside it.")

if named_clusters:
    _n_cols = 4
    _card_rows = [named_clusters[i:i + _n_cols] for i in range(0, len(named_clusters), _n_cols)]
    for _card_row in _card_rows:
        n_in_row = len(_card_row)

        # ── All cards in this row rendered as one CSS grid ─────────────────────
        # CSS grid makes every cell the height of the tallest cell automatically.
        # No fixed heights, no overflow:hidden, no truncation.
        _cells = []
        for _cname in _card_row:
            _n     = int((df["Cluster"] == _cname).sum())
            _desc  = cluster_descriptions.get(_cname, "")
            _first = _desc.split(".")[0].strip() + "." if _desc else ""
            _color = _color_map.get(_cname, "#26B4D2")
            _cells.append(
                f'<div class="hy-cl-card" style="border-top:3px solid {_color}">'
                f'<div class="hy-cl-name">{_cname}</div>'
                f'<span class="hy-cl-chip">{_n} companies</span>'
                f'<div class="hy-cl-desc">{_first}</div>'
                f'</div>'
            )
        # Pad incomplete last row with invisible placeholders so card widths stay consistent
        _cells += ['<div></div>'] * (_n_cols - n_in_row)

        st.markdown(
            f'<div class="hy-cl-grid" style="display:grid;grid-template-columns:repeat({_n_cols},1fr);'
            f'gap:12px;margin-bottom:0">' + "".join(_cells) + '</div>',
            unsafe_allow_html=True,
        )

        # ── "View" buttons sit flush below each card ────────────────────────────
        # CSS targets .element-container:has(.hy-cl-grid) + .element-container
        # to style these buttons as flush tab-like elements below the cards.
        _btn_cols = st.columns(_n_cols)
        for _ci, _cname in enumerate(_card_row):
            with _btn_cols[_ci]:
                if st.button("View companies →", key=f"card_{_cname}", use_container_width=True):
                    for _dk in ("cr_company_editor_cluster", "cr_move_company", "cr_company_detail",
                                "cr_add_companies_cluster", "cr_merge_pending", "cr_delete_pending",
                                "cr_add_cluster_pending"):
                        st.session_state[_dk] = None
                    show_companies_dialog(_cname, df[df["Cluster"] == _cname], company_col, _color_map.get(_cname, "#26B4D2"))

# ── SECTIONS 2 & 3: Editor + AI Assistant — two equal columns, no implied order
st.markdown(
    '<div style="font-size:10px;font-weight:600;color:#7496b2;'
    'text-transform:uppercase;letter-spacing:0.06em;margin:20px 0 12px">'
    'Edit &amp; Refine — use either tool, in any order</div>',
    unsafe_allow_html=True,
)

_editor_col, _chat_col = st.columns(2, gap="medium")

with _editor_col:
    st.markdown('<div class="hy-section-title">Cluster editor</div>', unsafe_allow_html=True)
    st.caption("Rename, merge, delete, or add clusters manually.")
    render_cluster_review(
        df_clean=st.session_state.df_clean,
        company_col=company_col,
        dimensions=dimensions,
        api_key=api_key,
        color_map=_color_map,
    )

with _chat_col:
    st.markdown('<div class="hy-section-title">AI Assistant</div>', unsafe_allow_html=True)
    st.caption(f"Ask anything about your {n_comp} companies across {n_clust} clusters.")
    render_cluster_chat(
        df_clean=st.session_state.df_clean,
        company_col=company_col,
        dimensions=dimensions,
        api_key=api_key,
    )

# ── CTA ────────────────────────────────────────────────────────────────────────
st.divider()
_cta_l, _cta_r = st.columns([4, 1])
with _cta_r:
    if st.button("Continue to Analytics →", type="primary", use_container_width=True):
        st.switch_page("pages/analytics.py")
