import streamlit as st
from utils import SESSION_DEFAULTS

st.set_page_config(page_title="Company Clustering", page_icon="◈", layout="wide")

# ── Shared session state (runs on every navigation) ──────────────────────────
for k, v in SESSION_DEFAULTS.items():
    st.session_state.setdefault(k, v)

# ── API key in sidebar (persists across all pages via widget key) ─────────────
with st.sidebar:
    st.text_input(
        "Gemini API Key",
        type="password",
        placeholder="AIza…",
        key="api_key",
        help="Required for embeddings, cluster naming, chat, and re-sort.",
    )

# ── Navigation ────────────────────────────────────────────────────────────────
_clustered = (
    st.session_state.get("df_clean") is not None
    and "Cluster" in getattr(st.session_state.get("df_clean"), "columns", [])
)

_setup_page    = st.Page("pages/setup.py",    title="Setup",    icon="⚙️",  default=not _clustered)
_clusters_page = st.Page("pages/clusters.py", title="Clusters", icon="◈",   default=_clustered)
_chat_page     = st.Page("pages/chat.py",     title="Chat",     icon="💬")

pg = st.navigation([_setup_page, _clusters_page, _chat_page])
pg.run()
