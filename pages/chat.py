"""Chat page — full-page AI analysis workspace."""

import streamlit as st

from cluster_chat import render_cluster_chat
from utils import DIMENSIONS

# ── Gate ─────────────────────────────────────────────────────────────────────
_clustered = (
    st.session_state.get("df_clean") is not None
    and "Cluster" in getattr(st.session_state.get("df_clean"), "columns", [])
)

if not _clustered:
    st.title("💬 Chat")
    st.info("Run clustering first — go to **Setup** to upload your data and run the pipeline.")
    if st.button("Go to Setup →", type="primary"):
        st.switch_page("pages/setup.py")
    st.stop()

# ── State ─────────────────────────────────────────────────────────────────────
api_key     = st.session_state.get("api_key", "")
company_col = st.session_state.get("company_col", "name")
df          = st.session_state.df_clean
dimensions  = [d for d in DIMENSIONS if d in df.columns]

# ── Chat ──────────────────────────────────────────────────────────────────────
st.title("💬 Chat")

render_cluster_chat(
    df_clean=df,
    company_col=company_col,
    dimensions=dimensions,
    api_key=api_key,
)
