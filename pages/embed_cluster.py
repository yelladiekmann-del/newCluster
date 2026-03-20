"""Embed & Cluster page — generate embeddings, run HDBSCAN, confirm when happy."""

import io
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
import pandas as pd
import plotly.express as px
import streamlit as st
from sklearn.preprocessing import normalize

from utils import (
    DIMENSION_WEIGHTS,
    DIMENSIONS,
    GEN_URL,
    _EMBED_WORKERS,
    _fmt_secs,
    build_cluster_profile,
    find_optimal_params,
    generate_cluster_descriptions,
    get_per_dimension_embedding,
    name_all_clusters,
    run_clustering,
)

# ── Gate ─────────────────────────────────────────────────────────────────────
api_key     = st.session_state.get("api_key", "")
df_clean    = st.session_state.get("df_clean")
company_col = st.session_state.get("company_col", "name")
desc_col    = st.session_state.get("desc_col", None)

if df_clean is None and st.session_state.get("feature_matrix") is None:
    st.title("⚡ Embed & Cluster")
    st.info("Upload your data first — go to **Setup** to get started.")
    if st.button("Go to Setup →", type="primary"):
        st.switch_page("pages/setup.py")
    st.stop()

st.title("⚡ Embed & Cluster")

has_api_key    = bool(api_key)
has_embeddings = st.session_state.get("feature_matrix") is not None
npz_preloaded  = st.session_state.get("npz_preloaded", False)
_clustered     = (
    df_clean is not None
    and "Cluster" in getattr(df_clean, "columns", [])
)

custom_weights = st.session_state.get("custom_weights") or dict(DIMENSION_WEIGHTS)

# ── STEP 1: Embed ─────────────────────────────────────────────────────────────
st.subheader("Step 1 · Embed")

available_dims = [d for d in DIMENSIONS if df_clean is not None and d in df_clean.columns]


@st.dialog("Confirm re-embed", width="large")
def _reembed_dialog():
    st.warning(
        "Generating new embeddings will replace the uploaded embeddings. "
        "This may take several minutes. Any existing clustering will also be cleared."
    )
    col_ok, col_no = st.columns(2)
    with col_ok:
        if st.button("Yes, re-embed", type="primary", width="stretch"):
            st.session_state["_reembed_confirmed"] = True
            st.rerun()
    with col_no:
        if st.button("Cancel", width="stretch", key="reembed_cancel"):
            st.rerun()


@st.dialog("Dimension weights", width="large")
def _weights_dialog():
    st.caption("Increase the weight of dimensions that matter most for your clustering goal.")
    w = {}
    cols = st.columns(4)
    for i, dim in enumerate(DIMENSIONS):
        with cols[i % 4]:
            w[dim] = st.slider(
                dim, 0.0, 2.0,
                float(custom_weights.get(dim, DIMENSION_WEIGHTS[dim])),
                step=0.1,
            )
    if st.button("Apply", type="primary"):
        st.session_state["custom_weights"] = w
        st.rerun()
    if st.button("Reset to defaults"):
        st.session_state["custom_weights"] = dict(DIMENSION_WEIGHTS)
        st.rerun()


if has_embeddings and npz_preloaded and not st.session_state.get("_reembed_confirmed"):
    n_emb = st.session_state["feature_matrix"].shape[0]
    st.success(f"✔ Embeddings loaded from uploaded file — {n_emb} companies, dim {st.session_state['feature_matrix'].shape[1]}.")
    col_skip, col_reembed = st.columns([2, 1])
    with col_skip:
        st.info("Ready to cluster. Scroll to Step 2, or re-embed if you want different embeddings.")
    with col_reembed:
        if st.button("↺ Re-embed from scratch", width="stretch"):
            _reembed_dialog()

elif has_embeddings and not npz_preloaded:
    n_emb = st.session_state["feature_matrix"].shape[0]
    st.success(f"✔ {n_emb} companies embedded (dim {st.session_state['feature_matrix'].shape[1]}). Ready to cluster.")
    col_dl, col_reembed = st.columns([2, 1])
    with col_dl:
        _buf = io.BytesIO()
        np.savez_compressed(
            _buf,
            embedded_2d=st.session_state.get("embedded_2d", np.zeros((n_emb, 2))),
            feature_matrix=st.session_state["feature_matrix"],
            df_json=np.frombuffer(
                st.session_state["df_clean"].to_json().encode(), dtype=np.uint8
            ) if st.session_state.get("df_clean") is not None else np.array([]),
        )
        _buf.seek(0)
        st.download_button(
            "⬇ Save embeddings (.npz)",
            _buf, "embeddings.npz", "application/octet-stream",
            width="stretch",
            key="dl_emb_step1",
        )
    with col_reembed:
        if st.button("↺ Re-embed", width="stretch"):
            if _clustered:
                _reembed_dialog()
            else:
                st.session_state["_reembed_confirmed"] = True
                st.rerun()

else:
    # No embeddings yet (or re-embed confirmed)
    if st.session_state.pop("_reembed_confirmed", False):
        # Clear old embeddings and clustering
        st.session_state["feature_matrix"]    = None
        st.session_state["embedded_2d"]       = None
        st.session_state["npz_preloaded"]     = False
        st.session_state["clusters_confirmed"] = False
        if df_clean is not None:
            cols_to_drop = [c for c in ["Cluster", "Outlier score", "_x", "_y"] if c in df_clean.columns]
            if cols_to_drop:
                st.session_state["df_clean"] = df_clean.drop(columns=cols_to_drop)
        st.rerun()

    if not available_dims:
        st.warning(
            "No dimension columns found in your data. "
            "Go back to Setup to extract dimensions."
        )
    else:
        col_emb, col_wt = st.columns([4, 1])
        with col_wt:
            if st.button("⚙ Weights…"):
                st.session_state["_show_weights"] = True

        if st.session_state.pop("_show_weights", False):
            _weights_dialog()

        _embed_disabled = not has_api_key or df_clean is None or not available_dims

        if not has_api_key:
            st.caption("Add a Gemini API key on the Setup page to enable embedding.")

        if st.button("⚡ Embed", type="primary", disabled=_embed_disabled, key="embed_btn"):
            total = len(df_clean)
            _eta = max(1, int((total * 0.35) / _EMBED_WORKERS))
            st.info(
                f"{total} companies — est. {_fmt_secs(_eta)} ({_EMBED_WORKERS} parallel workers)"
            )

            _weights = st.session_state.get("custom_weights") or dict(DIMENSION_WEIGHTS)
            prog   = st.progress(0)
            status = st.empty()
            import time as _time
            _start = _time.time()

            def _embed_one(i):
                row = df_clean.iloc[i]
                return i, get_per_dimension_embedding(
                    row, available_dims, api_key, dim_per_field=256, weights=_weights
                )

            indexed = {}
            errors  = 0
            with ThreadPoolExecutor(max_workers=_EMBED_WORKERS) as ex:
                futures = {ex.submit(_embed_one, i): i for i in range(total)}
                for done_n, future in enumerate(as_completed(futures), 1):
                    i, vec = future.result()
                    indexed[i] = vec
                    if np.all(vec == 0):
                        errors += 1
                    prog.progress(done_n / total)
                    elapsed = _time.time() - _start
                    if done_n > 1:
                        rem = int((elapsed / done_n) * (total - done_n))
                        status.caption(
                            f"{done_n}/{total} · ✗ {errors} · {_fmt_secs(rem)} remaining"
                        )
                    else:
                        status.caption(f"{done_n}/{total}")

            prog.empty()
            status.empty()

            if errors == total:
                st.error("All embeddings failed. Check your API key and network connection.")
                st.stop()

            vectors = [indexed[i] for i in range(total)]
            feature_matrix = normalize(np.array(vectors))
            st.success(
                f"✔ {total} embeddings ({errors} errors) — vector dim: {feature_matrix.shape[1]}"
            )
            st.session_state["feature_matrix"] = feature_matrix
            st.session_state["npz_preloaded"]  = False
            st.rerun()

st.divider()

# ── STEP 2: Cluster ───────────────────────────────────────────────────────────
st.subheader("Step 2 · Cluster")

if not has_embeddings:
    _reason = (
        "Add your Gemini API key on the Setup page, then click **⚡ Embed** above."
        if not has_api_key
        else "Click **⚡ Embed** above to generate embeddings, then come back here."
    )
    st.info(f"Embeddings not yet generated. {_reason}")
else:
    # ── Clustering parameter controls ─────────────────────────────────────────
    _at = st.session_state.get("autotune_result")
    if _at and _at.get("n_clusters", 0) > 0:
        st.success(
            f"✨ Suggested: min_cluster_size={_at['min_cluster_size']}, "
            f"min_samples={_at['min_samples']}, "
            f"cluster_epsilon={_at.get('cluster_epsilon', 0.0)} → "
            f"{_at['n_clusters']} clusters · silhouette={_at['silhouette']:.3f}"
        )

    _at_mcs = st.session_state.get("_autotune_mcs", 5)
    _at_ms  = st.session_state.get("_autotune_ms",  3)
    _at_eps = st.session_state.get("_autotune_eps", 0.0)

    col1, col2, col3, col4 = st.columns(4)
    with col1:
        min_cluster_size = st.slider(
            "Min cluster size", 2, 30, _at_mcs,
            help="Minimum companies to form a cluster. Lower → more, smaller clusters.",
        )
    with col2:
        min_samples = st.slider(
            "Min samples", 1, 20, _at_ms,
            help="HDBSCAN conservatism. Higher → stricter, more outliers.",
        )
    with col3:
        cluster_epsilon = st.slider(
            "Cluster epsilon", 0.0, 2.0, _at_eps, step=0.1,
            help="Merges clusters within this distance. 0 = pure HDBSCAN.",
        )
    with col4:
        umap_cluster_dims = st.slider(
            "UMAP cluster dims", 5, 50, 15,
            help="Dimensions used for HDBSCAN. Higher = more signal preserved.",
        )

    col_cluster, col_autotune = st.columns([2, 1])
    with col_cluster:
        cluster_btn = st.button("▶ Cluster", type="primary", width="stretch")
    with col_autotune:
        autotune_btn = st.button(
            "✨ Suggest optimal",
            width="stretch",
            help="Sweeps HDBSCAN params to maximise silhouette (~10–20s)",
        )

    if autotune_btn:
        with st.spinner("Scanning parameter space… (~10–20s)"):
            _result = find_optimal_params(st.session_state["feature_matrix"], umap_cluster_dims)
        st.session_state["autotune_result"] = _result
        st.session_state["_autotune_mcs"]   = _result["min_cluster_size"]
        st.session_state["_autotune_ms"]    = _result["min_samples"]
        st.session_state["_autotune_eps"]   = 0.0
        st.rerun()

    if cluster_btn:
        _df = st.session_state.get("df_clean")
        if _df is None:
            st.error("No data available. Go to Setup and upload your CSV.")
            st.stop()
        df_result, embedded_2d, n_c, n_o, metrics = run_clustering(
            _df,
            st.session_state["feature_matrix"],
            min_cluster_size, min_samples, cluster_epsilon,
            umap_cluster_dims=umap_cluster_dims,
        )
        st.session_state["df_clean"]        = df_result
        st.session_state["embedded_2d"]     = embedded_2d
        st.session_state["cluster_metrics"] = metrics
        st.session_state["clusters_confirmed"] = False  # reset on re-cluster
        st.session_state["chat_deleted_cluster_indices"] = set()
        st.rerun()

    # ── Results (shown after clustering) ──────────────────────────────────────
    if _clustered:
        df      = st.session_state["df_clean"]
        metrics = st.session_state.get("cluster_metrics") or {}

        # Slim header: quality indicator
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

        col_stats, col_quality = st.columns([3, 2])
        with col_stats:
            st.markdown(
                f"<span style='color:#888'>{n_comp} companies · "
                f"{n_clust} clusters · {n_out} outliers</span>",
                unsafe_allow_html=True,
            )
        with col_quality:
            st.markdown(
                f"<span style='color:{q_color}; font-size:1.1em'>●</span> "
                f"**Quality: {q_label}** "
                f"<span style='color:#888; font-size:0.85em'>(Sil {sil_str} · DB {db_str})</span>",
                unsafe_allow_html=True,
            )

        # UMAP scatter
        hover_cols = [c for c in [company_col, "Outlier score"] + DIMENSIONS if c in df.columns]
        fig = px.scatter(
            df, x="_x", y="_y", color="Cluster",
            hover_data=hover_cols,
            color_discrete_sequence=px.colors.qualitative.Bold,
            height=480,
        )
        fig.update_traces(marker=dict(size=7, opacity=0.80))
        fig.update_layout(
            margin=dict(l=0, r=0, t=20, b=0),
            xaxis=dict(title="", showticklabels=False, showgrid=False, zeroline=False),
            yaxis=dict(title="", showticklabels=False, showgrid=False, zeroline=False),
            dragmode="lasso",
        )
        st.plotly_chart(fig, use_container_width=True)

        # Inspect tabs (non-core)
        dims_present   = [d for d in DIMENSIONS if d in df.columns]
        named_clusters = [c for c in df["Cluster"].unique() if c != "Outliers"]

        with st.expander("🔍 Inspect: Profiles & Outliers"):
            tab_profiles, tab_outliers = st.tabs(["Profiles", "Outliers"])

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
                    fig_out.update_layout(
                        margin=dict(l=0, r=0, t=10, b=0), showlegend=False
                    )
                    st.plotly_chart(fig_out, use_container_width=True)
                df_out_tab = df[df["Cluster"] == "Outliers"]
                if len(df_out_tab) > 0:
                    show_out = [
                        c for c in [company_col, "Outlier score"] + dims_present
                        if c in df.columns
                    ]
                    st.dataframe(
                        df_out_tab[show_out], use_container_width=True,
                        hide_index=True, height=300,
                    )
                else:
                    st.info("No outliers.")

        # Downloads
        show_cols_dl = [
            c for c in [company_col, "Cluster", "Outlier score"] + DIMENSIONS
            if c in df.columns
        ]
        col_dl1, col_dl2 = st.columns(2)
        with col_dl1:
            st.download_button(
                "⬇ Download cluster CSV",
                df[show_cols_dl].to_csv(index=False),
                "clusters_preview.csv", "text/csv",
                width="stretch",
                key="dl_cluster_csv",
            )
        with col_dl2:
            if st.session_state.get("feature_matrix") is not None:
                _buf2 = io.BytesIO()
                np.savez_compressed(
                    _buf2,
                    embedded_2d=st.session_state["embedded_2d"],
                    feature_matrix=st.session_state["feature_matrix"],
                    df_json=np.frombuffer(
                        st.session_state["df_clean"].to_json().encode(), dtype=np.uint8
                    ),
                )
                _buf2.seek(0)
                st.download_button(
                    "⬇ Save embeddings (.npz)",
                    _buf2, "embeddings.npz", "application/octet-stream",
                    width="stretch",
                    key="dl_emb_step2",
                )

        st.divider()

        # ── Confirm CTA ────────────────────────────────────────────────────────
        st.markdown(
            "Happy with these clusters? Click **Confirm** to name them and move to the "
            "review page. You can always come back to re-cluster."
        )

        if st.button(
            "✓ Confirm clusters",
            type="primary",
            width="content",
            disabled=not has_api_key,
            help="Names all clusters via Gemini, generates descriptions, then opens Review & Edit.",
            key="confirm_btn",
        ):
            _df_confirm = st.session_state["df_clean"]
            _dims_n     = [d for d in DIMENSIONS if d in _df_confirm.columns]
            _unique_cl  = sorted(
                [c for c in _df_confirm["Cluster"].unique() if c != "Outliers"],
                key=lambda x: int(x.split()[-1]) if x.split()[-1].isdigit() else 0,
            )

            _profiles = {
                i: (
                    int((_df_confirm["Cluster"] == c).sum()),
                    build_cluster_profile(_df_confirm[_df_confirm["Cluster"] == c], _dims_n),
                )
                for i, c in enumerate(_unique_cl)
            }

            with st.spinner(f"Naming {len(_profiles)} clusters… (~5–10s)"):
                _llm_names = name_all_clusters(_profiles, api_key)

            if _llm_names:
                _name_map = {c: _llm_names.get(i, c) for i, c in enumerate(_unique_cl)}
                _name_map["Outliers"] = "Outliers"
                _df_named = _df_confirm.copy()
                _df_named["Cluster"] = _df_named["Cluster"].map(_name_map)
                st.session_state["df_clean"] = _df_named

                with st.spinner("Generating cluster descriptions…"):
                    _descriptions = generate_cluster_descriptions(
                        _profiles, _llm_names, api_key
                    )

                # Pre-populate cr_cluster_descriptions with LLM-generated descriptions
                _existing_descs = st.session_state.get("cr_cluster_descriptions") or {}
                for _idx, _name in _llm_names.items():
                    if _name not in _existing_descs and _name in _descriptions:
                        _existing_descs[_name] = _descriptions[_name]
                st.session_state["cr_cluster_descriptions"] = _existing_descs
                st.session_state["clusters_confirmed"] = True
                st.switch_page("pages/clusters.py")
            else:
                st.warning(
                    "Naming failed — keeping numeric labels. "
                    "Check your API key and try again."
                )

        if not has_api_key:
            st.caption("Add a Gemini API key on the Setup page to enable Confirm.")
