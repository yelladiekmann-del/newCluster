"""Setup page — upload, extract dimensions, configure embeddings, run clustering."""

import io
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
import pandas as pd
import plotly.express as px
import streamlit as st

from dimension_extraction import (
    EXTRACTED_DIMENSIONS,
    _BATCH_SIZE as _DIM_BATCH_SIZE,
    extract_dimensions,
)
from sklearn.preprocessing import normalize

from utils import (
    DIMENSION_WEIGHTS,
    DIMENSIONS,
    _EMBED_WORKERS,
    _fmt_secs,
    build_cluster_profile,
    find_optimal_params,
    get_description_embedding,
    get_per_dimension_embedding,
    name_all_clusters,
    run_clustering,
)

# ── Read shared state ─────────────────────────────────────────────────────────
api_key = st.session_state.get("api_key", "")

# ── Header ────────────────────────────────────────────────────────────────────
st.title("◈ Company Clustering")
st.caption("Gemini Embeddings · HDBSCAN · UMAP")
st.divider()

# ── Step 1: Data ──────────────────────────────────────────────────────────────
st.subheader("1 · Data")

uploaded = st.file_uploader("CSV or Excel file", type=["csv", "xlsx", "xls"])

df_input    = None
company_col = st.session_state.get("company_col", "name")
desc_col    = st.session_state.get("desc_col", None)

if uploaded:
    try:
        df_input = pd.read_csv(uploaded) if uploaded.name.endswith(".csv") else pd.read_excel(uploaded)
        st.success(f"✔ {len(df_input)} rows · {len(df_input.columns)} columns loaded")

        col1, col2, col_prev = st.columns([2, 2, 1])
        with col1:
            idx = df_input.columns.tolist().index("name") if "name" in df_input.columns else 0
            company_col = st.selectbox("Company column", df_input.columns.tolist(), index=idx)
            st.session_state["company_col"] = company_col
        with col2:
            desc_options = ["(none — use dimensions)"] + df_input.columns.tolist()
            desc_default = desc_options.index("Description") if "Description" in desc_options else 0
            desc_sel     = st.selectbox("Description column (optional)", desc_options, index=desc_default)
            desc_col     = None if desc_sel.startswith("(none") else desc_sel
            st.session_state["desc_col"] = desc_col
        with col_prev:
            st.write("")
            st.write("")
            if st.button("👁 Preview", use_container_width=True):
                st.session_state["_show_preview"] = True

        @st.dialog("Data preview")
        def _preview_dialog():
            st.dataframe(df_input.head(10), use_container_width=True, hide_index=True)
            if st.button("Close"):
                st.rerun()

        if st.session_state.pop("_show_preview", False):
            _preview_dialog()

        # ── Dimensions ───────────────────────────────────────────────────────
        st.divider()
        st.subheader("2 · Dimensions")

        _fresh = (
            st.session_state["df_enriched"] is not None
            and st.session_state["df_enriched_src"] == uploaded.name
        )
        _dims_in_csv = all(d in df_input.columns for d in EXTRACTED_DIMENSIONS)

        if _fresh:
            df_input = st.session_state["df_enriched"]
            col_msg, col_regen, col_dl = st.columns([4, 1, 1])
            with col_msg:
                st.success(
                    f"✔ Dimensions extracted — {len(EXTRACTED_DIMENSIONS)} columns ready."
                )
            with col_regen:
                if st.button("↺ Regenerate", key="regen_dims"):
                    st.session_state["df_enriched"] = None
                    st.rerun()
            with col_dl:
                csv_bytes = df_input.to_csv(index=False).encode()
                st.download_button(
                    "⬇ Download",
                    data=csv_bytes,
                    file_name="companies_with_dimensions.csv",
                    mime="text/csv",
                    key="dl_enriched",
                )

        elif _dims_in_csv:
            st.success(
                f"✔ All {len(EXTRACTED_DIMENSIONS)} dimension columns found in file — no extraction needed."
            )

        elif desc_col:
            st.caption(
                f"Uses Gemini to extract **{len(EXTRACTED_DIMENSIONS)} dimensions** from each "
                f"company description (~{max(1, len(df_input) // _DIM_BATCH_SIZE)} API calls for "
                f"{len(df_input)} companies). Save the enriched CSV afterwards to skip this step next time."
            )
            dim_pills = "  ·  ".join(f"`{d}`" for d in EXTRACTED_DIMENSIONS)
            st.markdown(dim_pills)
            if st.button(
                "⚡ Generate dimensions", key="gen_dims", type="primary",
                disabled=not bool(api_key),
            ):
                enriched = extract_dimensions(df_input, company_col, desc_col, api_key)
                st.session_state["df_enriched"] = enriched
                st.session_state["df_enriched_src"] = uploaded.name
                st.rerun()
        else:
            st.info("Select a description column above to enable dimension extraction.")

    except Exception as e:
        st.error(f"Could not load file: {e}")

# ── Load saved embeddings ─────────────────────────────────────────────────────
with st.expander("⚡ Load saved embeddings (skips embedding step)"):
    emb_file = st.file_uploader("Upload embeddings.npz", type=["npz"], key="emb_upload")
    if emb_file:
        try:
            npz = np.load(io.BytesIO(emb_file.read()))
            st.session_state.embedded_2d    = npz["embedded_2d"]
            st.session_state.feature_matrix = npz["feature_matrix"]
            if st.session_state.df_clean is None:
                if df_input is not None:
                    st.session_state.df_clean = df_input.copy()
                elif "df_json" in npz:
                    st.session_state.df_clean = pd.read_json(
                        io.StringIO(npz["df_json"].tobytes().decode())
                    )
            st.success(
                f"✔ Embeddings loaded — {st.session_state.embedded_2d.shape[0]} companies. "
                "Click '↺ Re-cluster only'."
            )
        except Exception as e:
            st.error(f"Error loading embeddings: {e}")

# ── Apply enriched df ─────────────────────────────────────────────────────────
if (
    uploaded is not None
    and st.session_state["df_enriched"] is not None
    and st.session_state["df_enriched_src"] == uploaded.name
    and df_input is not None
):
    df_input = st.session_state["df_enriched"]

# ── Gate flags ────────────────────────────────────────────────────────────────
has_api_key    = bool(api_key)
has_csv        = df_input is not None
has_embeddings = st.session_state.feature_matrix is not None
_clustered     = (
    st.session_state.df_clean is not None
    and "Cluster" in st.session_state.df_clean.columns
)
_named = (
    _clustered
    and not any(
        str(c).startswith("Cluster ")
        for c in st.session_state.df_clean["Cluster"].unique()
    )
)

st.divider()

# ── Step 3: Embedding & Parameters ───────────────────────────────────────────
st.subheader("3 · Embedding & Clustering")

embed_mode     = st.session_state.get("embed_mode", "Per-dimension (recommended)")
custom_weights = st.session_state.get("custom_weights") or dict(DIMENSION_WEIGHTS)

if has_csv and not has_embeddings:
    col_strat, col_adv = st.columns([3, 1])
    with col_strat:
        embed_mode = st.radio(
            "Embedding strategy",
            ["Per-dimension (recommended)", "Description column", "All dimensions joined"],
            horizontal=True,
            index=["Per-dimension (recommended)", "Description column", "All dimensions joined"].index(
                st.session_state.get("embed_mode", "Per-dimension (recommended)")
            ),
        )
        st.session_state["embed_mode"] = embed_mode
    with col_adv:
        st.write("")
        if st.button("⚙ Weights…", disabled=(embed_mode != "Per-dimension (recommended)")):
            st.session_state["_show_weights"] = True

    @st.dialog("Dimension weights")
    def _weights_dialog():
        st.caption("Increase the weight of dimensions that matter most for your clustering goal.")
        w = {}
        cols = st.columns(4)
        for i, dim in enumerate(DIMENSIONS):
            with cols[i % 4]:
                w[dim] = st.slider(dim, 0.0, 2.0, custom_weights.get(dim, DIMENSION_WEIGHTS[dim]), step=0.1)
        if st.button("Apply", type="primary"):
            st.session_state["custom_weights"] = w
            st.rerun()
        if st.button("Reset to defaults"):
            st.session_state["custom_weights"] = dict(DIMENSION_WEIGHTS)
            st.rerun()

    if st.session_state.pop("_show_weights", False):
        _weights_dialog()

elif has_embeddings and not _clustered:
    st.info("Embeddings loaded from file — click **↺ Re-cluster only** to continue.")

# Clustering sliders
_at = st.session_state.get("autotune_result")
if has_csv and _at and _at.get("n_clusters", 0) > 0:
    st.success(
        f"✨ Suggested: min_cluster_size={_at['min_cluster_size']}, "
        f"min_samples={_at['min_samples']}, "
        f"cluster_epsilon={_at.get('cluster_epsilon', 0.0)} → "
        f"{_at['n_clusters']} clusters · silhouette={_at['silhouette']:.3f} · DB={_at['davies_bouldin']:.3f}"
    )

_at_mcs = st.session_state.get("_autotune_mcs", 5)
_at_ms  = st.session_state.get("_autotune_ms",  3)
_at_eps = st.session_state.get("_autotune_eps", 0.0)

if has_csv:
    col1, col2, col3, col4 = st.columns(4)
    with col1:
        min_cluster_size = st.slider(
            "Min cluster size", 2, 30, _at_mcs,
            help=(
                "Minimum number of companies to form a cluster. "
                "Lower → more, smaller clusters. Higher → fewer, larger clusters."
            ),
        )
    with col2:
        min_samples = st.slider(
            "Min samples", 1, 20, _at_ms,
            help="Controls how conservative HDBSCAN is. Higher → stricter, more outliers.",
        )
    with col3:
        cluster_epsilon = st.slider(
            "Cluster epsilon", 0.0, 2.0, _at_eps, step=0.1,
            help="Merges clusters closer than this distance. 0 = pure HDBSCAN.",
        )
    with col4:
        umap_cluster_dims = st.slider(
            "UMAP cluster dims", 5, 50, 15,
            help="Dimensions used for HDBSCAN. Higher = more signal preserved, slower.",
        )

    if has_embeddings:
        if st.button("✨ Suggest optimal settings", help="Sweeps HDBSCAN params to maximise silhouette (~10–20s)"):
            with st.spinner("Scanning parameter space… (~10–20s)"):
                _result = find_optimal_params(st.session_state.feature_matrix, umap_cluster_dims)
            st.session_state["autotune_result"] = _result
            st.session_state["_autotune_mcs"]  = _result["min_cluster_size"]
            st.session_state["_autotune_ms"]   = _result["min_samples"]
            st.session_state["_autotune_eps"]  = 0.0
            st.rerun()
else:
    min_cluster_size, min_samples, cluster_epsilon, umap_cluster_dims = 5, 3, 0.0, 15

st.divider()

# ── Step 4: Run ───────────────────────────────────────────────────────────────
st.subheader("4 · Run")

# Confirm re-run dialog
@st.dialog("Confirm re-run")
def _confirm_rerun_dialog():
    st.warning(
        "Running again will discard all current clustering results, names, and review edits. "
        "Download your results CSV first if you want to keep them."
    )
    col_ok, col_no = st.columns(2)
    with col_ok:
        if st.button("Discard and re-run", type="primary", use_container_width=True):
            st.session_state["confirm_rerun_pending"] = True
            st.rerun()
    with col_no:
        if st.button("Cancel", use_container_width=True):
            st.rerun()

col_a, col_b, col_c = st.columns(3)
with col_a:
    _run_clicked = st.button(
        "▶ Run embeddings + clustering", type="primary", use_container_width=True,
        disabled=not (has_api_key and has_csv),
    )
    if _run_clicked and _clustered:
        _confirm_rerun_dialog()
    start = _run_clicked and not _clustered
with col_b:
    recluster = st.button(
        "↺ Re-cluster only", use_container_width=True,
        disabled=not has_embeddings,
        help="Skips embeddings. Re-runs UMAP + HDBSCAN with current parameters.",
    )
with col_c:
    name_btn = st.button(
        "🏷 Name clusters", key="name_btn_step4", use_container_width=True,
        disabled=not (has_api_key and _clustered),
        help="One Gemini call — names all clusters at once.",
    )

# Handle queued confirm-rerun
if st.session_state.get("confirm_rerun_pending") and not _run_clicked:
    start = True
    st.session_state["confirm_rerun_pending"] = False

# ── PIPELINE — FULL RUN ───────────────────────────────────────────────────────
if start and df_input is not None:
    st.session_state.done            = False
    st.session_state.df_clean        = None
    st.session_state.cluster_metrics = None
    st.session_state["autotune_result"] = None
    st.session_state["_autotune_mcs"]   = 5
    st.session_state["_autotune_ms"]    = 3
    st.session_state["_autotune_eps"]   = 0.0

    available_dims = [d for d in DIMENSIONS if d in df_input.columns]
    use_desc = bool(
        desc_col and desc_col in df_input.columns
        and df_input[desc_col].astype(str).str.strip().ne("").any()
    )

    if embed_mode == "Per-dimension (recommended)" and not available_dims:
        st.error("No dimension columns found. Switch to 'Description column' mode or add dimension columns.")
        st.stop()
    if embed_mode == "Description column" and not use_desc:
        st.error("No usable description column. Select a column that contains text.")
        st.stop()
    if not available_dims and not use_desc:
        st.error("No dimension columns or description column found. Cannot build embeddings.")
        st.stop()

    if available_dims:
        mask     = df_input[available_dims].apply(lambda r: any(str(v).strip() for v in r), axis=1)
        df_clean = df_input[mask].reset_index(drop=True)
    else:
        df_clean = df_input.reset_index(drop=True)

    total = len(df_clean)
    _secs_per_company = 0.35 if embed_mode == "Per-dimension (recommended)" else 0.5
    _embed_eta = max(1, int((total * _secs_per_company) / _EMBED_WORKERS))
    st.info(f"{total} companies — embedding est. {_fmt_secs(_embed_eta)} ({_EMBED_WORKERS} parallel workers)")

    _weights = st.session_state.get("custom_weights") or dict(DIMENSION_WEIGHTS)

    st.subheader("Embeddings")
    prog   = st.progress(0)
    status = st.empty()
    _embed_start = __import__("time").time()

    def _embed_one(i):
        row = df_clean.iloc[i]
        if embed_mode == "Per-dimension (recommended)":
            return i, get_per_dimension_embedding(row, available_dims, api_key, dim_per_field=256, weights=_weights)
        elif embed_mode == "Description column" and use_desc:
            return i, get_description_embedding(str(row.get(desc_col, "")).strip() or "unknown", api_key)
        else:
            text = " | ".join(str(row.get(d, "")) for d in available_dims)
            return i, get_description_embedding(text, api_key)

    indexed = {}
    errors  = 0
    import time as _time
    with ThreadPoolExecutor(max_workers=_EMBED_WORKERS) as ex:
        futures = {ex.submit(_embed_one, i): i for i in range(total)}
        for done_n, future in enumerate(as_completed(futures), 1):
            i, vec = future.result()
            indexed[i] = vec
            if np.all(vec == 0):
                errors += 1
            prog.progress(done_n / total)
            _elapsed = _time.time() - _embed_start
            if done_n > 1:
                _remaining = int((_elapsed / done_n) * (total - done_n))
                status.caption(f"{done_n}/{total} · ✗ {errors} · {_fmt_secs(_remaining)} remaining")
            else:
                status.caption(f"{done_n}/{total}")

    prog.empty(); status.empty()

    vectors = [indexed[i] for i in range(total)]
    if errors == total:
        st.error("All embeddings failed. Check your API key and network connection.")
        st.stop()

    feature_matrix = normalize(np.array(vectors))
    st.success(f"✔ {total} embeddings ({errors} errors) — vector dim: {feature_matrix.shape[1]}")

    st.subheader("UMAP + Clustering")
    df_clean, embedded_2d, n_clusters, n_outliers, metrics = run_clustering(
        df_clean, feature_matrix,
        min_cluster_size, min_samples, cluster_epsilon,
        umap_cluster_dims=umap_cluster_dims,
    )
    st.success(f"✔ {n_clusters} clusters · {n_outliers} outliers")

    st.session_state.df_clean        = df_clean
    st.session_state.embedded_2d     = embedded_2d
    st.session_state.feature_matrix  = feature_matrix
    st.session_state.cluster_metrics = metrics
    st.session_state.done            = True
    st.rerun()

# ── RECLUSTER ─────────────────────────────────────────────────────────────────
if recluster and st.session_state.feature_matrix is not None:
    if st.session_state.df_clean is None:
        if df_input is not None:
            st.session_state.df_clean = df_input.copy()
        else:
            st.error("No data loaded. Upload a CSV/Excel file first.")
            st.stop()

    df_result, embedded_2d, n_c, n_o, metrics = run_clustering(
        st.session_state.df_clean,
        st.session_state.feature_matrix,
        min_cluster_size, min_samples, cluster_epsilon,
        umap_cluster_dims=umap_cluster_dims,
    )
    st.session_state.df_clean        = df_result
    st.session_state.embedded_2d     = embedded_2d
    st.session_state.cluster_metrics = metrics
    st.session_state.done            = True
    st.session_state["chat_deleted_cluster_indices"] = set()
    st.rerun()

# ── CLUSTER NAMING ────────────────────────────────────────────────────────────
if name_btn and st.session_state.df_clean is not None:
    if not api_key:
        st.error("Gemini API key missing.")
    else:
        df_to_name      = st.session_state.df_clean
        dimensions      = [d for d in DIMENSIONS if d in df_to_name.columns]
        unique_clusters = sorted(
            [c for c in df_to_name["Cluster"].unique() if c != "Outliers"],
            key=lambda x: int(x.split()[-1]) if x.split()[-1].isdigit() else 0,
        )
        cluster_profiles = {
            i: (int((df_to_name["Cluster"] == c).sum()), build_cluster_profile(df_to_name[df_to_name["Cluster"] == c], dimensions))
            for i, c in enumerate(unique_clusters)
        }
        with st.spinner(f"Naming {len(cluster_profiles)} clusters… (~5–10s)"):
            llm_names = name_all_clusters(cluster_profiles, api_key)

        if llm_names:
            name_map = {c: llm_names.get(i, c) for i, c in enumerate(unique_clusters)}
            name_map["Outliers"] = "Outliers"
            df_named = df_to_name.copy()
            df_named["Cluster"] = df_named["Cluster"].map(name_map)
            st.session_state.df_clean = df_named
            st.success(f"✔ {len(llm_names)} clusters named")
        else:
            st.warning("Naming failed — keeping numeric labels")

# ── RESULTS ───────────────────────────────────────────────────────────────────
if st.session_state.df_clean is not None and "Cluster" in st.session_state.df_clean.columns:
    df      = st.session_state.df_clean
    metrics = st.session_state.cluster_metrics or {}

    st.divider()

    # ── Quality signal helper ─────────────────────────────────────────────────
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
    sil_str = f"{sil:.3f}" if sil is not None else "n/a"
    db_str  = f"{db:.3f}" if db is not None else "n/a"
    n_comp  = len(df)
    n_clust = df["Cluster"].nunique() - (1 if "Outliers" in df["Cluster"].values else 0)
    n_out   = int((df["Cluster"] == "Outliers").sum())

    # ── Slim header bar: Name clusters + compact stats + quality indicator ────
    col_name_btn, col_stats, col_quality = st.columns([2, 3, 2])
    with col_name_btn:
        name_btn_results = st.button(
            "🏷 Name clusters",
            key="name_btn_results",
            disabled=not (has_api_key and _clustered),
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

    # Handle name button from results header
    if name_btn_results:
        if not api_key:
            st.error("Gemini API key missing.")
        else:
            _df_to_name = st.session_state.df_clean
            _dims_n     = [d for d in DIMENSIONS if d in _df_to_name.columns]
            _unique_cl  = sorted(
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

    # ── UMAP scatter plot (leads) ─────────────────────────────────────────────
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

    # ── Cluster cards (interactive legend below UMAP) ─────────────────────────
    dims_present   = [d for d in DIMENSIONS if d in df.columns]
    named_clusters = [c for c in df["Cluster"].unique() if c != "Outliers"]

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

    # ── Tabs: Profiles | Outliers | All companies ─────────────────────────────
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

    # ── Downloads ─────────────────────────────────────────────────────────────
    show_cols_dl = [c for c in [company_col, "Cluster", "Outlier score"] + DIMENSIONS if c in df.columns]
    col_dl1, col_dl2, col_go = st.columns(3)
    with col_dl1:
        st.download_button(
            "⬇ Download results CSV",
            df[show_cols_dl].to_csv(index=False),
            "cluster_results.csv", "text/csv", use_container_width=True,
        )
    with col_dl2:
        if st.session_state.feature_matrix is not None:
            import io as _io
            buf = _io.BytesIO()
            import numpy as _np
            _np.savez_compressed(
                buf,
                embedded_2d=st.session_state.embedded_2d,
                feature_matrix=st.session_state.feature_matrix,
                df_json=_np.frombuffer(st.session_state.df_clean.to_json().encode(), dtype=_np.uint8),
            )
            buf.seek(0)
            st.download_button(
                "⬇ Save embeddings (.npz)",
                buf, "embeddings.npz", "application/octet-stream",
                use_container_width=True,
            )
    with col_go:
        st.write("")
        if st.button("Go to Clusters →", type="primary", use_container_width=True):
            st.switch_page("pages/clusters.py")
