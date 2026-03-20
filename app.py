import streamlit as st
from utils import SESSION_DEFAULTS

st.set_page_config(page_title="Company Clustering", page_icon="🗂️", layout="wide")

# ── Shared session state ───────────────────────────────────────────────────────
for k, v in SESSION_DEFAULTS.items():
    st.session_state.setdefault(k, v)

# ── Routing logic ──────────────────────────────────────────────────────────────
_confirmed = st.session_state.get("clusters_confirmed", False)
_has_data  = (
    st.session_state.get("df_clean") is not None
    or st.session_state.get("feature_matrix") is not None
)

_setup_page  = st.Page("pages/setup.py",         title="Setup",           icon="⚙️",  default=not _has_data)
_embed_page  = st.Page("pages/embed_cluster.py", title="Embed & Cluster", icon="⚡",  default=_has_data and not _confirmed)
_review_page = st.Page("pages/clusters.py",      title="Review & Edit",   icon="🗂️", default=_confirmed)

pg = st.navigation([_setup_page, _embed_page, _review_page])
pg.run()
