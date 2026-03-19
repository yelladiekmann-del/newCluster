import streamlit as st
import pandas as pd
import numpy as np
from sklearn.preprocessing import normalize

_OUTLIER_LABEL = "Outliers"


# ============================================================
# HELPERS
# ============================================================

def _build_auto_description(df_cluster: pd.DataFrame, dimensions: list[str], top_n: int = 2) -> str:
    parts = []
    for dim in dimensions:
        if dim not in df_cluster.columns:
            continue
        top = (
            df_cluster[dim].dropna().str.strip()
            .replace("", pd.NA).dropna()
            .value_counts().head(top_n).index.tolist()
        )
        if top:
            parts.append(f"**{dim}:** {' / '.join(top)}")
    return "  \n".join(parts) if parts else "_No dimension data available._"


def _render_outlier_cluster(df_outliers: pd.DataFrame, company_col: str, dimensions: list[str]) -> None:
    n = len(df_outliers)
    with st.expander(f"Outliers — {n} {'company' if n == 1 else 'companies'} (read-only)"):
        show_cols = [c for c in [company_col, "Outlier score"] + dimensions if c in df_outliers.columns]
        st.dataframe(df_outliers[show_cols], width="stretch", hide_index=True)


def _render_named_cluster(
    cluster_name: str,
    df_cluster: pd.DataFrame,
    company_col: str,
    dimensions: list[str],
) -> None:
    n = len(df_cluster)
    st.markdown(f"### {cluster_name} &nbsp; <sup style='font-size:0.6em;color:gray'>{n} companies</sup>", unsafe_allow_html=True)

    description = _build_auto_description(df_cluster, dimensions)
    st.markdown(description)

    col_name, col_core = st.columns([1, 2])
    with col_name:
        st.text_input(
            "Edit name",
            value=st.session_state["cr_name_edits"].get(cluster_name, cluster_name),
            key=f"cr_name_{cluster_name}",
            label_visibility="collapsed",
            placeholder="Cluster name…",
        )
    with col_core:
        company_options = (
            df_cluster[company_col].dropna().tolist()
            if company_col in df_cluster.columns
            else []
        )
        st.multiselect(
            "Core companies (optional)",
            options=company_options,
            default=st.session_state["cr_core_companies"].get(cluster_name, []),
            key=f"cr_core_{cluster_name}",
            label_visibility="collapsed",
            placeholder="Mark core companies…",
        )

    with st.expander(f"All {n} companies"):
        show_cols = [c for c in [company_col, "Outlier score"] + dimensions if c in df_cluster.columns]
        st.dataframe(df_cluster[show_cols], width="stretch", hide_index=True)

    st.divider()


def _collect_edits(cluster_names: list[str]) -> tuple[dict[str, str], dict[str, list[str]]]:
    name_edits = {}
    core_selections = {}
    for name in cluster_names:
        edited = st.session_state.get(f"cr_name_{name}", "").strip()
        name_edits[name] = edited if edited else name
        core_selections[name] = st.session_state.get(f"cr_core_{name}", [])
    return name_edits, core_selections


def _apply_name_edits(df_clean: pd.DataFrame, name_edits: dict[str, str]) -> pd.DataFrame:
    df_out = df_clean.copy()
    df_out["Cluster"] = df_out["Cluster"].map(lambda c: name_edits.get(c, c))
    return df_out


def _compute_centroids(
    df_clean: pd.DataFrame,
    feature_matrix: np.ndarray,
    core_selections: dict[str, list[str]],
    company_col: str,
) -> dict[str, np.ndarray]:
    centroids = {}
    cluster_names = [c for c in df_clean["Cluster"].unique() if c != _OUTLIER_LABEL]

    for cluster_name in cluster_names:
        mask = df_clean["Cluster"] == cluster_name
        indices = df_clean.index[mask].tolist()

        cores = core_selections.get(cluster_name, [])
        if cores and company_col in df_clean.columns:
            core_mask = mask & df_clean[company_col].isin(cores)
            core_indices = df_clean.index[core_mask].tolist()
            if core_indices:
                indices = core_indices

        vecs = feature_matrix[indices]
        centroid = vecs.mean(axis=0)
        norm = np.linalg.norm(centroid)
        centroids[cluster_name] = centroid / norm if norm > 0 else centroid

    return centroids


def _reassign_companies(
    df_clean: pd.DataFrame,
    feature_matrix: np.ndarray,
    centroids: dict[str, np.ndarray],
    similarity_threshold: float,
) -> pd.DataFrame:
    cluster_names = list(centroids.keys())
    C = np.array([centroids[n] for n in cluster_names])  # [n_clusters, dim]

    # feature_matrix is already L2-normalized → cosine similarity = dot product
    sim_matrix = feature_matrix @ C.T  # [n_companies, n_clusters]

    new_labels = []
    for i in range(len(df_clean)):
        best_idx = int(np.argmax(sim_matrix[i]))
        best_sim = float(sim_matrix[i, best_idx])
        new_labels.append(cluster_names[best_idx] if best_sim >= similarity_threshold else _OUTLIER_LABEL)

    df_out = df_clean.copy()
    df_out["Cluster"] = new_labels
    if "Outlier score" in df_out.columns:
        df_out["Outlier score"] = np.nan  # HDBSCAN scores no longer valid
    return df_out


# ============================================================
# PUBLIC ENTRY POINT
# ============================================================

def render_cluster_review(
    df_clean: pd.DataFrame,
    feature_matrix: np.ndarray,
    company_col: str,
    dimensions: list[str],
    similarity_threshold: float = 0.3,
) -> "pd.DataFrame | None":
    if len(df_clean) != len(feature_matrix):
        st.error(
            f"Row mismatch: DataFrame has {len(df_clean)} rows but "
            f"feature_matrix has {len(feature_matrix)}. Cannot run cluster review."
        )
        return None

    st.session_state.setdefault("cr_name_edits", {})
    st.session_state.setdefault("cr_core_companies", {})

    st.subheader("Cluster Review & Edit")
    st.caption(
        "Inspect each cluster, rename it, and optionally mark core companies that best represent it. "
        "Hit **Rerun** to re-verify all company assignments using centroid similarity — "
        "companies too distant from any cluster centre become Outliers."
    )

    # Separate named clusters from outliers
    all_clusters = df_clean["Cluster"].unique().tolist()
    named_clusters = sorted(
        [c for c in all_clusters if c != _OUTLIER_LABEL],
        key=lambda c: -(df_clean["Cluster"] == c).sum(),  # largest first
    )
    df_outliers = df_clean[df_clean["Cluster"] == _OUTLIER_LABEL]

    # Render each named cluster
    for cluster_name in named_clusters:
        df_cluster = df_clean[df_clean["Cluster"] == cluster_name].reset_index(drop=True)
        _render_named_cluster(cluster_name, df_cluster, company_col, dimensions)

    # Render outliers
    if len(df_outliers) > 0:
        _render_outlier_cluster(df_outliers.reset_index(drop=True), company_col, dimensions)

    # Buttons
    col_apply, col_rerun = st.columns(2)
    with col_apply:
        apply_btn = st.button("Apply name edits", key="cr_apply", width="stretch")
    with col_rerun:
        rerun_btn = st.button(
            "Rerun (reassign companies)", key="cr_rerun", type="primary", width="stretch",
            help=(
                "Recomputes cluster centroids and reassigns every company by cosine similarity. "
                "Companies below the similarity threshold become Outliers."
            ),
        )

    # Collect current widget values
    name_edits, core_selections = _collect_edits(named_clusters)

    # Persist for next render cycle
    st.session_state["cr_name_edits"] = name_edits
    st.session_state["cr_core_companies"] = core_selections

    if apply_btn:
        updated = _apply_name_edits(df_clean, name_edits)
        st.session_state.df_clean = updated
        st.session_state["cr_name_edits"] = {}
        st.session_state["cr_core_companies"] = {}
        st.rerun()

    if rerun_btn:
        # Apply name edits first so centroids use the new names
        df_named = _apply_name_edits(df_clean, name_edits)
        named_after_edit = [name_edits.get(n, n) for n in named_clusters]
        core_after_edit = {name_edits.get(n, n): v for n, v in core_selections.items()}

        with st.spinner("Computing cluster centroids…"):
            centroids = _compute_centroids(df_named, feature_matrix, core_after_edit, company_col)

        with st.spinner("Reassigning companies…"):
            df_out = _reassign_companies(df_named, feature_matrix, centroids, similarity_threshold)

        n_outliers = int((df_out["Cluster"] == _OUTLIER_LABEL).sum())
        st.success(
            f"Reassigned {len(df_out)} companies — "
            f"{len(df_out) - n_outliers} in clusters, {n_outliers} outliers. "
            "Outlier score column reset (scores from HDBSCAN are no longer valid)."
        )

        st.session_state["cr_name_edits"] = {}
        st.session_state["cr_core_companies"] = {}
        return df_out

    return None
