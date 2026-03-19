"""Clusters page — review, edit, and visualise cluster assignments."""

import plotly.express as px
import streamlit as st

from cluster_review import render_cluster_review
from utils import DIMENSIONS

# ── Gate ─────────────────────────────────────────────────────────────────────
_clustered = (
    st.session_state.get("df_clean") is not None
    and "Cluster" in getattr(st.session_state.get("df_clean"), "columns", [])
)

if not _clustered:
    st.title("◈ Clusters")
    st.info("Run clustering first — go to **Setup** to upload your data and run the pipeline.")
    if st.button("Go to Setup →", type="primary"):
        st.switch_page("pages/setup.py")
    st.stop()

# ── State ─────────────────────────────────────────────────────────────────────
df      = st.session_state.df_clean
metrics = st.session_state.get("cluster_metrics") or {}
api_key = st.session_state.get("api_key", "")
company_col = st.session_state.get("company_col", "name")
dimensions  = [d for d in DIMENSIONS if d in df.columns]

# ── Header ────────────────────────────────────────────────────────────────────
n_companies = len(df)
n_clusters  = df["Cluster"].nunique() - (1 if "Outliers" in df["Cluster"].values else 0)
n_outliers  = int((df["Cluster"] == "Outliers").sum())

st.title("◈ Clusters")

c1, c2, c3, c4, c5 = st.columns(5)
c1.metric("Companies", n_companies)
c2.metric("Clusters", n_clusters)
c3.metric("Outliers", n_outliers)
sil = metrics.get("silhouette")
db  = metrics.get("davies_bouldin")
c4.metric("Silhouette", f"{sil:.3f}" if sil is not None else "n/a",
          help="Range −1 to 1. Above 0.3 is reasonable; above 0.5 is good.")
c5.metric("Davies-Bouldin", f"{db:.3f}" if db is not None else "n/a",
          help="Lower = better. Below 1.0 is good.")

# ── Scatter plot ──────────────────────────────────────────────────────────────
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
show_cols = [c for c in [company_col, "Cluster", "Outlier score"] + DIMENSIONS if c in df.columns]
col_dl, col_chat = st.columns([2, 1])
with col_dl:
    st.download_button(
        "⬇ Download results CSV",
        df[show_cols].to_csv(index=False),
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
