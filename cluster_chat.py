import streamlit as st
import pandas as pd
import requests

_OUTLIER_LABEL = "Outliers"
_GEN_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
_DESC_COL = "Description"
_MAX_HISTORY_TURNS = 20
_DESC_CHAR_LIMIT_NORMAL = 200
_DESC_CHAR_LIMIT_LARGE = 80
_LARGE_DATASET_THRESHOLD = 1500


# ============================================================
# CONTEXT BUILDING
# ============================================================

def _build_context_hash(df_clean: pd.DataFrame) -> str:
    return str(df_clean["Cluster"].value_counts().to_dict())


def _fetch_market_context(
    cluster_names: list[str],
    df_clean: pd.DataFrame,
    company_col: str,
    api_key: str,
    user_context: str = "",
) -> str:
    """
    Make one Gemini call with Google Search grounding to get a live market
    landscape overview. When user_context is provided (from onboarding), the
    search is tailored to that specific buyer/use-case context.
    """
    # One sample company per cluster
    samples = []
    for name in cluster_names:
        row = df_clean[df_clean["Cluster"] == name].iloc[0] if (df_clean["Cluster"] == name).any() else None
        if row is not None:
            samples.append(str(row.get(company_col, name)))

    context_line = (
        f"This analysis is being conducted for: {user_context}\n\n"
        if user_context else ""
    )
    focus_line = (
        f"Pay special attention to what would matter most for: {user_context}\n"
        if user_context else ""
    )

    prompt = (
        "You are a market research analyst. A startup/company portfolio has been organized into these market segments:\n\n"
        f"Segments: {', '.join(cluster_names)}\n"
        f"Sample companies: {', '.join(samples)}\n\n"
        f"{context_line}"
        "Search the web and provide a focused market landscape overview (200–300 words):\n"
        "1. What broader market domain does this portfolio represent?\n"
        "2. What key segments are typically present in this space — including any that may be MISSING from the segments above?\n"
        "3. Major incumbent players or solution categories buyers evaluate\n"
        f"4. Common buyer pain points and evaluation criteria\n"
        f"{focus_line}\n"
        "This context will be used to answer portfolio gap-analysis and market completeness questions."
    )
    try:
        resp = requests.post(
            f"{_GEN_URL}?key={api_key}",
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "tools": [{"google_search": {}}],
            },
            timeout=60,
        )
        if resp.status_code == 200:
            return resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    except Exception:
        pass
    return ""


def _build_system_context(
    df_clean: pd.DataFrame,
    company_col: str,
    dimensions: list[str],
    market_context: str = "",
    cluster_descriptions: dict = {},
) -> str:
    n_total = len(df_clean)
    n_outliers = int((df_clean["Cluster"] == _OUTLIER_LABEL).sum())
    named_clusters = [c for c in df_clean["Cluster"].unique() if c != _OUTLIER_LABEL]
    n_clusters = len(named_clusters)

    desc_limit = _DESC_CHAR_LIMIT_LARGE if n_total > _LARGE_DATASET_THRESHOLD else _DESC_CHAR_LIMIT_NORMAL
    large_note = " (truncated for brevity)" if n_total > _LARGE_DATASET_THRESHOLD else ""

    lines = [
        "You are an expert market analyst assistant with complete knowledge of a company clustering analysis.",
        "Answer conversationally, like a knowledgeable colleague talking through insights — not a report writer.",
        "Use plain prose. Avoid bullet points, headers, and numbered lists unless the user explicitly asks for a structured breakdown.",
        "Always ground your answers in specific companies and cluster characteristics from the data.",
        "",
        "=== ANALYSIS OVERVIEW ===",
        f"- {n_total} companies across {n_clusters} named clusters ({n_outliers} outliers)",
    ]

    lines += ["", "=== CLUSTERS ==="]

    for cluster_name in sorted(named_clusters, key=lambda c: -(df_clean["Cluster"] == c).sum()):
        df_c = df_clean[df_clean["Cluster"] == cluster_name]
        n = len(df_c)
        lines.append(f"\n## {cluster_name} ({n} companies)")

        # User-provided description (if any)
        user_desc = cluster_descriptions.get(cluster_name, "")
        if user_desc:
            lines.append(f"Description: {user_desc}")

        # Dimension characteristics
        char_parts = []
        for dim in dimensions:
            if dim not in df_c.columns:
                continue
            top = (
                df_c[dim].dropna().str.strip()
                .replace("", pd.NA).dropna()
                .value_counts().head(2).index.tolist()
            )
            if top:
                char_parts.append(f"{dim}: {' / '.join(top)}")
        if char_parts:
            lines.append("Characteristics: " + " | ".join(char_parts))

        # Company list
        lines.append(f"Companies{large_note}:")
        for _, row in df_c.iterrows():
            name = str(row.get(company_col, "Unknown"))
            desc = str(row.get(_DESC_COL, "")).strip()
            if desc:
                lines.append(f"  - {name}: {desc[:desc_limit]}")
            else:
                lines.append(f"  - {name}")

    # Outliers
    df_out = df_clean[df_clean["Cluster"] == _OUTLIER_LABEL]
    if len(df_out) > 0:
        lines += ["", f"=== OUTLIERS ({len(df_out)} companies) ==="]
        for _, row in df_out.iterrows():
            lines.append(f"  - {str(row.get(company_col, 'Unknown'))}")

    if market_context:
        lines += ["", "=== LIVE MARKET INTELLIGENCE (web search) ===", market_context]

    return "\n".join(lines)


# ============================================================
# GEMINI CALL
# ============================================================

def _call_gemini(user_message: str, system_context: str, history: list[dict], api_key: str) -> str:
    contents = [
        {"role": "user",  "parts": [{"text": system_context}]},
        {"role": "model", "parts": [{"text": "Understood — I have full knowledge of this clustering analysis and am ready to answer your questions."}]},
    ]

    # Add last N turns of history
    recent = history[-(2 * _MAX_HISTORY_TURNS):]
    for msg in recent:
        role = "user" if msg["role"] == "user" else "model"
        contents.append({"role": role, "parts": [{"text": msg["content"]}]})

    contents.append({"role": "user", "parts": [{"text": user_message}]})

    try:
        resp = requests.post(
            f"{_GEN_URL}?key={api_key}",
            json={"contents": contents},
            timeout=60,
        )
        if resp.status_code != 200:
            return f"_(API error {resp.status_code}: {resp.text[:200]})_"
        return resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    except Exception as e:
        return f"_(Error: {e})_"


# ============================================================
# PUBLIC ENTRY POINT
# ============================================================

def render_cluster_chat(
    df_clean: pd.DataFrame,
    company_col: str,
    dimensions: list[str],
    api_key: str,
) -> None:
    st.session_state.setdefault("chat_history", [])
    st.session_state.setdefault("chat_context", "")
    st.session_state.setdefault("chat_context_hash", "")
    st.session_state.setdefault("chat_reset_notice", False)
    st.session_state.setdefault("chat_pending_msg", None)
    st.session_state.setdefault("chat_onboarded", False)
    st.session_state.setdefault("chat_analysis_context", "")

    # Reset onboarding when clusters change
    current_hash = _build_context_hash(df_clean)
    if current_hash != st.session_state["chat_context_hash"]:
        was_populated = bool(st.session_state["chat_history"])
        st.session_state["chat_context_hash"] = current_hash
        st.session_state["chat_history"] = []
        st.session_state["chat_context"] = ""
        st.session_state["chat_onboarded"] = False
        st.session_state["chat_analysis_context"] = ""
        if was_populated:
            st.session_state["chat_reset_notice"] = True

    # ── ONBOARDING ──────────────────────────────────────────────
    if not st.session_state["chat_onboarded"]:
        st.subheader("Before we start")
        st.caption(
            "Tell us who this analysis is for — this shapes the market intelligence web search "
            "and helps the assistant answer gap-analysis questions more precisely."
        )
        with st.form("chat_onboarding_form", clear_on_submit=False):
            analysis_ctx = st.text_input(
                "Who is this analysis for?",
                placeholder="e.g. a regional bank exploring fintech partnerships",
                disabled=not api_key,
            )
            ob_submitted = st.form_submit_button(
                "Start analysis →", type="primary", disabled=not api_key
            )

        if ob_submitted and analysis_ctx.strip():
            ctx = analysis_ctx.strip()
            st.session_state["chat_analysis_context"] = ctx
            named_clusters = [c for c in df_clean["Cluster"].unique() if c != _OUTLIER_LABEL]
            with st.spinner("Researching market landscape… (~5–10s)"):
                market_ctx = _fetch_market_context(
                    named_clusters, df_clean, company_col, api_key, user_context=ctx
                )
            cluster_descs = st.session_state.get("cr_cluster_descriptions", {})
            st.session_state["chat_context"] = _build_system_context(
                df_clean, company_col, dimensions,
                market_context=market_ctx,
                cluster_descriptions=cluster_descs,
            )
            st.session_state["chat_onboarded"] = True
            st.rerun()
        return  # Don't render chat until onboarding is complete

    # ── CHAT ────────────────────────────────────────────────────
    n_companies = len(df_clean)
    n_clusters = df_clean["Cluster"].nunique() - (1 if _OUTLIER_LABEL in df_clean["Cluster"].values else 0)

    col_title, col_clear = st.columns([5, 1])
    with col_title:
        st.subheader("Ask about your clusters")
    with col_clear:
        st.button(
            "Clear",
            key="chat_clear",
            disabled=not st.session_state["chat_history"],
            on_click=lambda: st.session_state.update({"chat_history": []}),
        )

    analysis_label = st.session_state.get("chat_analysis_context", "")
    st.caption(
        (f"Analysis context: _{analysis_label}_ · " if analysis_label else "")
        + f"Full knowledge of {n_companies} companies across {n_clusters} clusters. "
        "Ask anything — comparisons, company lookups, market gaps, where a new company fits."
    )

    if st.session_state.get("chat_reset_notice"):
        st.info("Chat history was reset because cluster assignments changed.")
        st.session_state["chat_reset_notice"] = False

    # Pick up any pending message from the previous submit
    pending = st.session_state.get("chat_pending_msg")

    # Messages in a bounded scrollable container
    with st.container(height=430):
        for msg in st.session_state["chat_history"]:
            with st.chat_message(msg["role"]):
                st.markdown(msg["content"])

        # Render the in-flight exchange inside the same container so it stays visible
        if pending:
            with st.chat_message("user"):
                st.markdown(pending)
            with st.chat_message("assistant"):
                with st.spinner("Thinking… (~5–15s)"):
                    response = _call_gemini(
                        pending,
                        st.session_state["chat_context"],
                        st.session_state["chat_history"],
                        api_key,
                    )
                st.markdown(response)
            st.session_state["chat_history"].append({"role": "user", "content": pending})
            st.session_state["chat_history"].append({"role": "assistant", "content": response})
            st.session_state["chat_pending_msg"] = None

    # Pre-written cluster review prompt
    _REVIEW_PROMPT = (
        "Please review all clusters in this analysis and provide structured recommendations:\n\n"
        "**1. KEEP** — List clusters that are well-defined and should remain exactly as they are. "
        "Briefly explain why each is cohesive.\n\n"
        "**2. DELETE** — List clusters that are too small, too vague, overlap heavily with another, "
        "or add no analytical value. Explain why each should be removed.\n\n"
        "**3. MERGE** — Identify pairs or groups of clusters that are too similar and should be combined. "
        "For each merge, specify which clusters to combine and suggest a name for the result.\n\n"
        "**4. ADD** — Identify important market segments that are absent from the current clustering. "
        "For each new cluster to add, provide: a proposed name, a one-sentence description, "
        "and 3–5 example companies from the dataset that would belong there.\n\n"
        "Ground all recommendations in the specific companies and cluster compositions you know."
    )
    if st.button("📋 Request cluster review", disabled=not api_key):
        st.session_state["chat_pending_msg"] = _REVIEW_PROMPT
        st.rerun()

    # Input row sits below the container — not sticky, not overlapping messages
    with st.form("chat_form", clear_on_submit=True):
        col_input, col_btn = st.columns([9, 1])
        with col_input:
            user_input = st.text_input(
                "",
                placeholder="Ask anything about the clusters or companies…",
                label_visibility="collapsed",
                disabled=not api_key,
            )
        with col_btn:
            submitted = st.form_submit_button("↑", disabled=not api_key)

    if submitted and user_input.strip():
        st.session_state["chat_pending_msg"] = user_input.strip()
        st.rerun()
