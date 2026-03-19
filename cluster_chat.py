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


def _build_system_context(
    df_clean: pd.DataFrame,
    company_col: str,
    dimensions: list[str],
    cluster_metrics: dict,
) -> str:
    n_total = len(df_clean)
    n_outliers = int((df_clean["Cluster"] == _OUTLIER_LABEL).sum())
    named_clusters = [c for c in df_clean["Cluster"].unique() if c != _OUTLIER_LABEL]
    n_clusters = len(named_clusters)

    sil = cluster_metrics.get("silhouette")
    db = cluster_metrics.get("davies_bouldin")
    quality = ""
    if sil is not None:
        quality += f"Silhouette score: {sil:.3f} (higher is better, >0.3 is good)"
    if db is not None:
        quality += f" | Davies-Bouldin: {db:.3f} (lower is better, <1.0 is good)"

    desc_limit = _DESC_CHAR_LIMIT_LARGE if n_total > _LARGE_DATASET_THRESHOLD else _DESC_CHAR_LIMIT_NORMAL
    large_note = " (truncated for brevity)" if n_total > _LARGE_DATASET_THRESHOLD else ""

    lines = [
        "You are an expert market analyst assistant with complete knowledge of a company clustering analysis.",
        "Answer questions accurately and specifically, always citing actual company names and cluster characteristics.",
        "Be concise but substantive. If asked about a company, state its cluster and describe it.",
        "",
        "=== ANALYSIS OVERVIEW ===",
        f"- {n_total} companies across {n_clusters} named clusters ({n_outliers} outliers)",
    ]
    if quality:
        lines.append(f"- {quality}")

    lines += ["", "=== CLUSTERS ==="]

    for cluster_name in sorted(named_clusters, key=lambda c: -(df_clean["Cluster"] == c).sum()):
        df_c = df_clean[df_clean["Cluster"] == cluster_name]
        n = len(df_c)
        lines.append(f"\n## {cluster_name} ({n} companies)")

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
    cluster_metrics: dict,
) -> None:
    st.session_state.setdefault("chat_history", [])
    st.session_state.setdefault("chat_context", "")
    st.session_state.setdefault("chat_context_hash", "")

    # Rebuild context if clusters have changed
    current_hash = _build_context_hash(df_clean)
    if current_hash != st.session_state["chat_context_hash"]:
        st.session_state["chat_context"] = _build_system_context(
            df_clean, company_col, dimensions, cluster_metrics
        )
        st.session_state["chat_context_hash"] = current_hash
        st.session_state["chat_history"] = []

    st.subheader("Ask about your clusters")
    n_companies = len(df_clean)
    n_clusters = df_clean["Cluster"].nunique() - (1 if _OUTLIER_LABEL in df_clean["Cluster"].values else 0)
    st.caption(
        f"The assistant has full knowledge of all {n_companies} companies across {n_clusters} clusters. "
        "Ask anything — cluster comparisons, company lookups, market insights, where a new company might fit."
    )

    # Render chat history
    for msg in st.session_state["chat_history"]:
        with st.chat_message(msg["role"]):
            st.markdown(msg["content"])

    # Clear button
    if st.session_state["chat_history"]:
        if st.button("Clear chat", key="chat_clear"):
            st.session_state["chat_history"] = []
            st.rerun()

    # Chat input
    prompt = st.chat_input(
        "Ask anything about the clusters or companies…",
        disabled=not api_key,
    )

    if prompt:
        st.session_state["chat_history"].append({"role": "user", "content": prompt})
        with st.chat_message("user"):
            st.markdown(prompt)

        with st.chat_message("assistant"):
            with st.spinner("Thinking…"):
                response = _call_gemini(
                    prompt,
                    st.session_state["chat_context"],
                    st.session_state["chat_history"][:-1],  # exclude the message we just added
                    api_key,
                )
            st.markdown(response)

        st.session_state["chat_history"].append({"role": "assistant", "content": response})
