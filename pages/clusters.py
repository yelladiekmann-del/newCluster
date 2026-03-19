"""Clusters page — review, edit, and visualise cluster assignments."""

import pandas as pd
import plotly.express as px
import streamlit as st

from cluster_review import render_cluster_review
from utils import DIMENSIONS, build_cluster_profile, name_all_clusters

# ── Gate ─────────────────────────────────────────────────────────────────────
_clustered = (
    st.session_state.get("df_clean") is not None
    and "Cluster" in getattr(st.session_state.get("df_clean"), "columns", [])
)

if not _clustered:
    st.title("🗂️ Clusters")
    st.info("Run clustering first — go to **Setup** to upload your data and run the pipeline.")
    if st.button("Go to Setup →", type="primary"):
        st.switch_page("pages/setup.py")
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

# ── Slim header bar ────────────────────────────────────────────────────────────
st.title("🗂️ Clusters")

col_name_btn, col_stats, col_quality = st.columns([2, 3, 2])
with col_name_btn:
    name_btn = st.button(
        "🏷 Name clusters",
        disabled=not bool(api_key),
        help="One Gemini call — names all clusters at once.",
    )
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

# Handle Name clusters
if name_btn:
    if not api_key:
        st.error("Gemini API key missing.")
    else:
        _df_to_name = st.session_state.df_clean
        _dims_n = [d for d in DIMENSIONS if d in _df_to_name.columns]
        _unique_cl = sorted(
            [c for c in _df_to_name["Cluster"].unique() if c != "Outliers"],
            key=lambda x: int(x.split()[-1]) if x.split()[-1].isdigit() else 0,
        )
        _profiles = {
            i: (int((_df_to_name["Cluster"] == c).sum()), build_cluster_profile(_df_to_name[_df_to_name["Cluster"] == c], _dims_n))
            for i, c in enumerate(_unique_cl)
        }
        with st.spinner(f"Naming {len(_profiles)} clusters… (~5–10s)"):
            _llm_names = name_all_clusters(_profiles, api_key)
        if _llm_names:
            _name_map = {c: _llm_names.get(i, c) for i, c in enumerate(_unique_cl)}
            _name_map["Outliers"] = "Outliers"
            _df_named = _df_to_name.copy()
            _df_named["Cluster"] = _df_named["Cluster"].map(_name_map)
            st.session_state.df_clean = _df_named
            df = _df_named
        else:
            st.warning("Naming failed — keeping numeric labels")

# ── UMAP scatter plot (leads) ──────────────────────────────────────────────────
hover_cols = [c for c in [company_col, "Outlier score"] + DIMENSIONS if c in df.columns]
fig = px.scatter(
    df, x="_x", y="_y", color="Cluster",
    hover_data=hover_cols,
    color_discrete_sequence=px.colors.qualitative.Bold,
    height=520,
)
fig.update_traces(marker=dict(size=7, opacity=0.80))
fig.update_layout(
    margin=dict(l=0, r=0, t=20, b=0),
    xaxis=dict(title="", showticklabels=False, showgrid=False, zeroline=False),
    yaxis=dict(title="", showticklabels=False, showgrid=False, zeroline=False),
    dragmode="lasso",
)
st.plotly_chart(fig, use_container_width=True)

# ── Cluster cards (interactive legend below UMAP) ─────────────────────────────
named_clusters = [c for c in df["Cluster"].unique() if c != "Outliers"]
dims_present   = [d for d in DIMENSIONS if d in df.columns]

if named_clusters and dims_present:
    n_card_cols = min(4, len(named_clusters))
    card_rows = [named_clusters[i:i + n_card_cols] for i in range(0, len(named_clusters), n_card_cols)]
    for card_row in card_rows:
        cols = st.columns(len(card_row))
        for col, cname in zip(cols, card_row):
            n = int((df["Cluster"] == cname).sum())
            top_vals = []
            for d in dims_present[:2]:
                tv = (
                    df.loc[df["Cluster"] == cname, d]
                    .dropna().str.strip().replace("", pd.NA).dropna()
                    .value_counts().head(1).index.tolist()
                )
                if tv:
                    top_vals.append(tv[0])
            dim_str = " / ".join(top_vals) if top_vals else "—"
            with col:
                st.markdown(
                    f"<div style='border:1px solid #e0e0e0;border-radius:8px;"
                    f"padding:10px 12px;margin:2px 0'>"
                    f"<b>{cname}</b><br>"
                    f"<span style='color:#888'>{n} companies</span><br>"
                    f"<small style='color:#555'>{dim_str}</small>"
                    f"</div>",
                    unsafe_allow_html=True,
                )

# ── Tabs: Profiles | Outliers | All companies ─────────────────────────────────
tab_profiles, tab_outliers, tab_companies = st.tabs(["Profiles", "Outliers", "All companies"])

with tab_profiles:
    if dims_present and named_clusters:
        profile_rows = []
        for dim in dims_present:
            row_data = {"Dimension": dim}
            for cname in sorted(named_clusters):
                top = (
                    df.loc[df["Cluster"] == cname, dim]
                    .dropna().str.strip().replace("", pd.NA).dropna()
                    .value_counts().head(1).index.tolist()
                )
                row_data[cname] = top[0] if top else "—"
            profile_rows.append(row_data)
        st.dataframe(
            pd.DataFrame(profile_rows).set_index("Dimension"),
            use_container_width=True,
        )
    else:
        st.info("No dimension data available.")

with tab_outliers:
    if "Outlier score" in df.columns:
        fig_out = px.histogram(
            df[df["Cluster"] != "Outliers"],
            x="Outlier score", color="Cluster",
            nbins=30, barmode="overlay", opacity=0.7, height=260,
            color_discrete_sequence=px.colors.qualitative.Bold,
        )
        fig_out.update_layout(margin=dict(l=0, r=0, t=10, b=0), showlegend=False)
        st.plotly_chart(fig_out, use_container_width=True)
    df_out_tab = df[df["Cluster"] == "Outliers"]
    if len(df_out_tab) > 0:
        show_out = [c for c in [company_col, "Outlier score"] + dims_present if c in df.columns]
        st.dataframe(df_out_tab[show_out], use_container_width=True, hide_index=True, height=300)
    else:
        st.info("No outliers.")

with tab_companies:
    show_cols = [c for c in [company_col, "Cluster", "Outlier score"] + DIMENSIONS if c in df.columns]
    st.dataframe(df[show_cols], use_container_width=True, hide_index=True, height=400)

st.divider()

# ── Chat action approval (if any pending from chat page) ──────────────────────
pending_actions = st.session_state.get("chat_pending_actions")
if pending_actions:
    n_act = len(pending_actions)
    st.info(f"🤖 **{n_act} suggested action{'s' if n_act != 1 else ''} from Chat** — review below before applying.")
    with st.expander("Review suggested actions", expanded=True):
        for i, action in enumerate(pending_actions):
            t = action.get("type")
            if t == "delete":
                label = f"🗑 Delete: **{action.get('cluster', '')}**"
            elif t == "merge":
                sources = action.get("sources", [])
                label = f"↔ Merge: **{' + '.join(sources)}** → **{action.get('new_name', '')}**"
            elif t == "add":
                companies = action.get("companies", [])
                label = f"➕ Add: **{action.get('name', '')}** ({len(companies)} companies)"
            else:
                continue

            col_lbl, col_btn = st.columns([8, 2])
            with col_lbl:
                st.markdown(label)
            with col_btn:
                if st.button("Execute", key=f"cl_action_exec_{i}"):
                    from cluster_chat import _execute_actions
                    _execute_actions([action], df, company_col, dimensions)
                    remaining = [a for j, a in enumerate(pending_actions) if j != i]
                    st.session_state["chat_pending_actions"] = remaining if remaining else None
                    st.rerun()

        col_all, col_dismiss = st.columns(2)
        with col_all:
            if st.button("✅ Execute all", type="primary", key="cl_action_exec_all", use_container_width=True):
                from cluster_chat import _execute_actions
                _execute_actions(pending_actions, df, company_col, dimensions)
                st.session_state["chat_pending_actions"] = None
                st.rerun()
        with col_dismiss:
            if st.button("✕ Dismiss", key="cl_action_dismiss", use_container_width=True):
                st.session_state["chat_pending_actions"] = None
                st.rerun()

    st.divider()

# ── Download ──────────────────────────────────────────────────────────────────
show_cols_dl = [c for c in [company_col, "Cluster", "Outlier score"] + DIMENSIONS if c in df.columns]
col_dl, col_chat = st.columns([2, 1])
with col_dl:
    st.download_button(
        "⬇ Download results CSV",
        df[show_cols_dl].to_csv(index=False),
        "cluster_results.csv", "text/csv",
    )
with col_chat:
    if st.button("Go to Chat →", use_container_width=True):
        st.switch_page("pages/chat.py")

st.divider()

# ── Cluster review ────────────────────────────────────────────────────────────
st.subheader("Edit Clusters")
render_cluster_review(
    df_clean=st.session_state.df_clean,
    company_col=company_col,
    dimensions=dimensions,
    api_key=api_key,
)
