import streamlit as st
import pandas as pd
import numpy as np
import time
import random
import requests
import io
import json
import re

from sklearn.preprocessing import normalize
from sklearn.metrics import silhouette_score, davies_bouldin_score
import plotly.express as px
import plotly.graph_objects as go

try:
    import hdbscan
except ImportError:
    import subprocess; subprocess.run(["pip", "install", "hdbscan", "-q"]); import hdbscan

try:
    import umap
except ImportError:
    import subprocess; subprocess.run(["pip", "install", "umap-learn", "-q"]); import umap

# ============================================================
# CONFIG
# ============================================================
st.set_page_config(page_title="Company Clustering", page_icon="◈", layout="wide")

DIMENSIONS = [
    "Problem Solved", "Target Beneficiary", "The How",
    "Innovation Cluster", "Value Shift", "Ecosystem Role", "Scalability Lever",
]

# IMPROVEMENT 1: Per-dimension weights
# Not all dimensions are equally informative for separating companies.
# "Problem Solved" and "The How" carry the most discriminative signal;
# "Ecosystem Role" is often too broad to differentiate well.
DIMENSION_WEIGHTS = {
    "Problem Solved":     1.4,
    "Target Beneficiary": 1.2,
    "The How":            1.3,
    "Innovation Cluster": 1.0,
    "Value Shift":        0.9,
    "Ecosystem Role":     0.7,
    "Scalability Lever":  0.8,
}

EMBED_MODEL = "gemini-embedding-001"
EMBED_URL   = f"https://generativelanguage.googleapis.com/v1beta/models/{EMBED_MODEL}:embedContent"
GEN_URL     = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"

_defaults = {
    "df_clean": None, "embedded_2d": None, "feature_matrix": None,
    "done": False, "cluster_metrics": None,
}
for k, v in _defaults.items():
    st.session_state.setdefault(k, v)


# ============================================================
# EMBEDDING HELPERS
# ============================================================
def get_embedding(text: str, api_key: str, dim: int = 768) -> np.ndarray:
    text = str(text).strip()[:8000]
    if len(text) < 3:
        return np.zeros(dim)
    payload = {
        "model": f"models/{EMBED_MODEL}",
        "content": {"parts": [{"text": text}]},
        "taskType": "CLUSTERING",
        "outputDimensionality": dim,
    }
    for attempt in range(5):
        try:
            resp = requests.post(f"{EMBED_URL}?key={api_key}", json=payload, timeout=30)
            if resp.status_code == 429:
                time.sleep((2 ** attempt) + random.uniform(0, 1))
                continue
            if resp.status_code != 200:
                st.warning(f"Embedding API error {resp.status_code}: {resp.text[:200]}")
                return np.zeros(dim)
            v = np.array(resp.json()["embedding"]["values"])
            norm = np.linalg.norm(v)
            time.sleep(0.05)
            return v / norm if norm > 0 else v
        except requests.exceptions.Timeout:
            time.sleep(2 ** attempt)
        except Exception as e:
            st.warning(f"Embedding exception: {e}")
            return np.zeros(dim)
    return np.zeros(dim)


# IMPROVEMENT 2: Per-dimension embeddings
# Instead of joining all fields into "Problem Solved: X | The How: Y | ...",
# we embed each field independently and concatenate the weighted vectors.
# This means the model attends fully to each field in isolation — it's not
# trying to parse a pipe-delimited blob. Fields that share vocabulary across
# dimensions (e.g. "API" appearing in both "The How" and "Scalability Lever")
# no longer bleed into each other.
def get_per_dimension_embedding(
    row: pd.Series,
    available_dims: list[str],
    api_key: str,
    dim_per_field: int = 256,
) -> np.ndarray:
    """
    Embed each dimension field separately, scale by its weight, concatenate.
    Using dim_per_field=256 keeps total vector size manageable:
    7 dims × 256 = 1792-d → still tractable for UMAP/HDBSCAN at 2000 companies.
    """
    parts = []
    for d in available_dims:
        val = str(row.get(d, "")).strip()
        vec = get_embedding(val if val else "unknown", api_key, dim=dim_per_field)
        weight = DIMENSION_WEIGHTS.get(d, 1.0)
        parts.append(vec * weight)

    if not parts:
        return np.zeros(dim_per_field)

    combined = np.concatenate(parts)
    norm = np.linalg.norm(combined)
    return combined / norm if norm > 0 else combined


def get_description_embedding(text: str, api_key: str) -> np.ndarray:
    return get_embedding(text, api_key, dim=768)


# ============================================================
# CLUSTER NAMING
# ============================================================
def build_cluster_profile(df_sel: pd.DataFrame, dimensions: list[str]) -> str:
    lines = []
    for dim in dimensions:
        if dim not in df_sel.columns:
            continue
        top = (
            df_sel[dim].dropna().str.strip()
            .replace("", pd.NA).dropna()
            .value_counts().head(3).index.tolist()
        )
        if top:
            lines.append(f"  {dim}: {' / '.join(top)}")
    return "\n".join(lines)


def name_all_clusters(cluster_profiles: dict, api_key: str) -> dict[int, str]:
    labels_ordered = sorted(cluster_profiles.keys())
    block = ""
    for label in labels_ordered:
        size, profile = cluster_profiles[label]
        block += f"\nCLUSTER {label} ({size} companies):\n{profile}\n"

    prompt = (
        f"You are a market intelligence analyst naming clusters of companies.\n\n"
        f"Below are {len(labels_ordered)} clusters with their dominant characteristics.\n"
        "Assign each cluster a SHORT, DISTINCTIVE name (2-5 words) that:\n"
        "- Captures what makes THIS cluster unique vs. the others\n"
        "- Is at the same level of abstraction as all other names\n"
        "- Reads like a market category (e.g. Embedded Lending Infrastructure, SMB Expense Automation)\n"
        "- Has NO duplicates — every name must be different\n\n"
        + block +
        "\nReturn ONLY a JSON object mapping cluster number to name, like:\n"
        '{"0": "Name Here", "1": "Other Name", ...}\n'
        "No explanation, no markdown, just the JSON."
    )
    try:
        resp = requests.post(
            f"{GEN_URL}?key={api_key}",
            json={"contents": [{"parts": [{"text": prompt}]}]},
            timeout=30,
        )
        if resp.status_code == 200:
            raw = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
            raw = re.sub(r"```json|```", "", raw).strip()
            names = json.loads(raw)
            return {int(k): v for k, v in names.items()}
        else:
            st.warning(f"Naming API error {resp.status_code}: {resp.text[:200]}")
    except json.JSONDecodeError as e:
        st.warning(f"Cluster naming returned invalid JSON: {e}")
    except Exception as e:
        st.warning(f"Cluster naming failed: {e}")
    return {}


# ============================================================
# CLUSTERING + METRICS
# ============================================================
def run_clustering(
    df_clean: pd.DataFrame,
    feature_matrix: np.ndarray,
    min_cluster_size: int,
    min_samples: int,
    cluster_epsilon: float,
    umap_vis_dims: int = 2,
    umap_cluster_dims: int = 15,
) -> tuple[pd.DataFrame, np.ndarray, int, int, dict]:
    """
    IMPROVEMENT 3: Cluster in high-D space, visualise in 2D.
    HDBSCAN previously ran on the 2D UMAP projection — a lossy visualisation
    artefact. Now we reduce to `umap_cluster_dims` (default 15) for clustering,
    then separately reduce to 2D for the scatter plot.
    """
    if len(df_clean) != len(feature_matrix):
        st.error(
            f"Row mismatch: DataFrame {len(df_clean)} rows vs "
            f"embeddings {len(feature_matrix)}. Re-run full pipeline."
        )
        st.stop()

    n = len(feature_matrix)

    # --- UMAP for clustering (high-D) ---
    actual_cluster_dims = min(umap_cluster_dims, n - 2, feature_matrix.shape[1])
    with st.spinner(f"UMAP {feature_matrix.shape[1]}D → {actual_cluster_dims}D for clustering…"):
        reducer_nd = umap.UMAP(
            n_components=actual_cluster_dims,
            n_neighbors=min(15, n - 1),
            min_dist=0.0,   # tighter packing — better for clustering
            metric="cosine",
            random_state=42,
        )
        embedded_nd = reducer_nd.fit_transform(feature_matrix)

    # --- UMAP for visualisation (2D) ---
    with st.spinner("UMAP → 2D for visualisation…"):
        reducer_2d = umap.UMAP(
            n_components=2,
            n_neighbors=min(15, n - 1),
            min_dist=0.05,
            metric="cosine",
            random_state=42,
        )
        embedded_2d = reducer_2d.fit_transform(feature_matrix)

    # --- HDBSCAN on high-D embeddings ---
    with st.spinner("HDBSCAN on high-D space…"):
        clusterer = hdbscan.HDBSCAN(
            min_cluster_size=min_cluster_size,
            min_samples=min_samples,
            cluster_selection_epsilon=cluster_epsilon,
            cluster_selection_method="leaf",
            metric="euclidean",
            prediction_data=True,   # enables soft membership
        )
        labels = clusterer.fit_predict(embedded_nd)

    n_clusters = len([l for l in set(labels) if l >= 0])
    n_outliers  = int((labels == -1).sum())

    # IMPROVEMENT 4: Cluster quality metrics
    metrics = {}
    non_outlier_mask = labels != -1
    if non_outlier_mask.sum() > 1 and n_clusters >= 2:
        try:
            metrics["silhouette"] = round(
                float(silhouette_score(embedded_nd[non_outlier_mask], labels[non_outlier_mask])), 3
            )
        except Exception:
            metrics["silhouette"] = None
        try:
            metrics["davies_bouldin"] = round(
                float(davies_bouldin_score(embedded_nd[non_outlier_mask], labels[non_outlier_mask])), 3
            )
        except Exception:
            metrics["davies_bouldin"] = None

    # IMPROVEMENT 5: Outlier scores for soft membership display
    # outlier_scores_ range 0–1; 0 = core cluster member, 1 = likely noise
    outlier_scores = (
        clusterer.outlier_scores_
        if hasattr(clusterer, "outlier_scores_") and clusterer.outlier_scores_ is not None
        else np.zeros(n)
    )

    cluster_names = {-1: "Outliers"}
    for label in sorted(set(labels)):
        if label >= 0:
            cluster_names[label] = f"Cluster {label}"

    df_out = df_clean.copy()
    df_out["Cluster"]       = [cluster_names[l] for l in labels]
    df_out["Outlier score"] = np.round(outlier_scores, 3)
    df_out["_x"]            = embedded_2d[:, 0]
    df_out["_y"]            = embedded_2d[:, 1]

    return df_out, embedded_2d, n_clusters, n_outliers, metrics


# ============================================================
# UI
# ============================================================
st.title("◈ Company Clustering v2.0")
st.caption("Gemini Embeddings · HDBSCAN · UMAP")
st.divider()

api_key  = st.text_input("Gemini API Key", type="password", placeholder="AIza...")
uploaded = st.file_uploader("CSV or Excel file", type=["csv", "xlsx", "xls"])

df_input    = None
company_col = "name"
desc_col    = None

if uploaded:
    try:
        df_input = pd.read_csv(uploaded) if uploaded.name.endswith(".csv") else pd.read_excel(uploaded)
        st.success(f"✔ {len(df_input)} rows · {len(df_input.columns)} columns loaded")

        col1, col2 = st.columns(2)
        with col1:
            idx = df_input.columns.tolist().index("name") if "name" in df_input.columns else 0
            company_col = st.selectbox("Company column", df_input.columns.tolist(), index=idx)
        with col2:
            desc_options = ["(none — use dimensions)"] + df_input.columns.tolist()
            desc_default = desc_options.index("Description") if "Description" in desc_options else 0
            desc_sel     = st.selectbox("Description column (optional)", desc_options, index=desc_default)
            desc_col     = None if desc_sel.startswith("(none") else desc_sel

        with st.expander("Preview"):
            st.dataframe(df_input.head(5), width='stretch', hide_index=True)
    except Exception as e:
        st.error(f"Could not load file: {e}")

st.divider()

# --- Embedding mode ---
st.subheader("Embedding strategy")
embed_mode = st.radio(
    "How to build embeddings",
    ["Per-dimension (recommended)", "Description column", "All dimensions joined"],
    horizontal=True,
    help=(
        "Per-dimension: each field embedded separately and concatenated — best cluster quality. "
        "Description: uses a free-text description field directly. "
        "Joined: legacy behaviour, pipes all dimensions into one string."
    ),
)

# --- Dimension weights (shown only in per-dimension mode) ---
if embed_mode == "Per-dimension (recommended)":
    with st.expander("Dimension weights (optional)"):
        st.caption("Increase the weight of dimensions that matter most for your clustering goal.")
        custom_weights = {}
        cols = st.columns(len(DIMENSIONS))
        for i, dim in enumerate(DIMENSIONS):
            with cols[i]:
                custom_weights[dim] = st.slider(
                    dim, 0.0, 2.0, DIMENSION_WEIGHTS.get(dim, 1.0), step=0.1, key=f"w_{dim}"
                )
else:
    custom_weights = DIMENSION_WEIGHTS

st.divider()
st.subheader("Clustering parameters")

col1, col2, col3, col4 = st.columns(4)
with col1:
    min_cluster_size  = st.slider(
        "Min cluster size", 2, 30, 5,
        help=(
            "Minimum number of companies to form a cluster. "
            "Lower → more, smaller clusters (risk: noise gets its own cluster). "
            "Higher → fewer, larger clusters (risk: real sub-groups get merged or dropped as outliers). "
            "Start around 5 and increase if you're getting too many tiny clusters."
        ),
    )
with col2:
    min_samples       = st.slider(
        "Min samples", 1, 20, 3,
        help=(
            "Controls how conservative HDBSCAN is about calling a point a core point. "
            "Higher → stricter core membership, more companies labelled as outliers, tighter clusters. "
            "Lower → more permissive, fewer outliers, but clusters may be looser. "
            "Rule of thumb: keep it ≤ Min cluster size. Set to 1 for the most inclusive clustering."
        ),
    )
with col3:
    cluster_epsilon   = st.slider(
        "Cluster epsilon", 0.0, 2.0, 0.0, step=0.1,
        help=(
            "Merges clusters that are closer than this distance threshold (like a DBSCAN fallback). "
            "0 = pure HDBSCAN hierarchy, no merging. "
            "Increase gradually if you're getting too many clusters that look nearly identical. "
            "Too high → everything collapses into one cluster."
        ),
    )
with col4:
    umap_cluster_dims = st.slider(
        "UMAP cluster dims", 5, 50, 15,
        help="Dimensions used for HDBSCAN (not the scatter plot). Higher = more signal preserved, slower."
    )

st.divider()

col_a, col_b, col_c = st.columns(3)
with col_a:
    start = st.button(
        "▶  Run embeddings + clustering", type="primary", width='stretch',
        disabled=(df_input is None or not api_key),
    )
with col_b:
    recluster = st.button(
        "↺  Re-cluster only", width='stretch',
        disabled=(st.session_state.feature_matrix is None or st.session_state.df_clean is None),
        help="Skips embeddings. Re-runs UMAP + HDBSCAN with current parameters.",
    )
with col_c:
    name_btn = st.button(
        "🏷  Name clusters", width='stretch',
        disabled=(not st.session_state.done or st.session_state.df_clean is None),
        help="One Gemini call — names all clusters at once.",
    )

# ============================================================
# PIPELINE — FULL RUN
# ============================================================
if start and df_input is not None:
    st.session_state.done           = False
    st.session_state.df_clean       = None
    st.session_state.cluster_metrics = None

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
    st.info(f"{total} companies will be processed")

    # --- Embeddings ---
    st.subheader("1 · Embeddings")
    prog   = st.progress(0)
    status = st.empty()
    vectors, errors = [], 0

    for i in range(total):
        row     = df_clean.iloc[i]
        name_str = str(row.get(company_col, ""))[:40]

        if embed_mode == "Per-dimension (recommended)":
            vec = get_per_dimension_embedding(row, available_dims, api_key, dim_per_field=256)
        elif embed_mode == "Description column" and use_desc:
            text = str(row.get(desc_col, "")).strip()
            vec  = get_description_embedding(text or "unknown", api_key)
        else:
            text = " | ".join(str(row.get(d, "")) for d in available_dims)
            vec  = get_description_embedding(text, api_key)

        vectors.append(vec)
        if np.all(vec == 0):
            errors += 1

        prog.progress((i + 1) / total)
        status.caption(f"{i+1}/{total} · {name_str} · ✗ {errors}")

    prog.empty(); status.empty()

    if errors == total:
        st.error("All embeddings failed. Check your API key and network connection.")
        st.stop()

    feature_matrix = normalize(np.array(vectors))
    st.success(f"✔ {total} embeddings ({errors} errors) — vector dim: {feature_matrix.shape[1]}")

    # --- Clustering + UMAP ---
    st.subheader("2 · UMAP + Clustering")
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

# ============================================================
# RECLUSTER
# ============================================================
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
    st.success(f"✔ {n_c} clusters · {n_o} outliers")

# ============================================================
# CLUSTER NAMING
# ============================================================
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

        with st.spinner(f"Naming {len(cluster_profiles)} clusters…"):
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

# ============================================================
# RESULTS
# ============================================================
if st.session_state.done and st.session_state.df_clean is not None:
    df      = st.session_state.df_clean
    metrics = st.session_state.cluster_metrics or {}

    st.divider()

    # IMPROVEMENT 4: Display quality metrics with guidance
    c1, c2, c3, c4, c5 = st.columns(5)
    c1.metric("Companies", len(df))
    c2.metric("Clusters", df["Cluster"].nunique() - (1 if "Outliers" in df["Cluster"].values else 0))
    c3.metric("Outliers", int((df["Cluster"] == "Outliers").sum()))

    sil = metrics.get("silhouette")
    db  = metrics.get("davies_bouldin")
    c4.metric(
        "Silhouette score",
        f"{sil:.3f}" if sil is not None else "n/a",
        help="Range −1 to 1. Higher = better separated clusters. Above 0.3 is reasonable; above 0.5 is good.",
    )
    c5.metric(
        "Davies-Bouldin",
        f"{db:.3f}" if db is not None else "n/a",
        help="Lower = better. Measures average cluster similarity. Below 1.0 is good.",
    )

    # Scatter plot
    hover_cols = [c for c in [company_col, "Outlier score"] + DIMENSIONS if c in df.columns]
    fig = px.scatter(
        df, x="_x", y="_y", color="Cluster",
        hover_data=hover_cols,
        color_discrete_sequence=px.colors.qualitative.Bold,
        height=640,
    )
    fig.update_traces(marker=dict(size=7, opacity=0.80))
    fig.update_layout(
        margin=dict(l=0, r=0, t=20, b=0),
        xaxis=dict(title="", showticklabels=False, showgrid=False, zeroline=False),
        yaxis=dict(title="", showticklabels=False, showgrid=False, zeroline=False),
        dragmode="lasso",
    )
    st.plotly_chart(fig, width='stretch')

    # IMPROVEMENT 5: Cluster comparison table
    # Shows the top value per dimension for each cluster side-by-side,
    # making it easy to spot what distinguishes each cluster — and catch
    # cases where two clusters look identical (merge them).
    with st.expander("Cluster dimension profiles (what defines each cluster)"):
        dims_present = [d for d in DIMENSIONS if d in df.columns]
        named_clusters = [c for c in df["Cluster"].unique() if c != "Outliers"]
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
            st.dataframe(pd.DataFrame(profile_rows).set_index("Dimension"), width='stretch')

    # IMPROVEMENT 6: Outlier score distribution
    # Lets you spot "soft outliers" — companies with a high score that
    # HDBSCAN kept in a cluster but barely. These are good review candidates.
    with st.expander("Outlier score distribution (find borderline companies)"):
        if "Outlier score" in df.columns:
            st.caption(
                "Score 0 = core cluster member. Score → 1 = borderline / noise. "
                "High-scoring companies within clusters are worth reviewing manually."
            )
            fig_out = px.histogram(
                df[df["Cluster"] != "Outliers"],
                x="Outlier score", color="Cluster",
                nbins=30, barmode="overlay", opacity=0.7, height=300,
                color_discrete_sequence=px.colors.qualitative.Bold,
            )
            fig_out.update_layout(margin=dict(l=0, r=0, t=10, b=0), showlegend=False)
            st.plotly_chart(fig_out, width='stretch')

    show_cols = [c for c in [company_col, "Cluster", "Outlier score"] + DIMENSIONS if c in df.columns]
    st.dataframe(df[show_cols], width='stretch', hide_index=True)

    col_dl1, col_dl2 = st.columns(2)
    with col_dl1:
        st.download_button(
            "⬇  Download results as CSV",
            df[show_cols].to_csv(index=False),
            "cluster_results.csv", "text/csv", width='stretch',
        )
    with col_dl2:
        if st.session_state.feature_matrix is not None:
            buf = io.BytesIO()
            np.savez_compressed(
                buf,
                embedded_2d=st.session_state.embedded_2d,
                feature_matrix=st.session_state.feature_matrix,
                df_json=np.frombuffer(st.session_state.df_clean.to_json().encode(), dtype=np.uint8),
            )
            buf.seek(0)
            st.download_button(
                "⬇  Save embeddings (.npz)",
                buf, "embeddings.npz", "application/octet-stream",
                width='stretch',
                help="Upload next time to skip the embedding step.",
            )

# ============================================================
# SAVED EMBEDDINGS UPLOAD
# ============================================================
with st.expander("⚡ Load saved embeddings (skips embedding step)"):
    emb_file = st.file_uploader("Upload embeddings.npz", type=["npz"], key="emb_upload")
    if emb_file:
        try:
            npz = np.load(io.BytesIO(emb_file.read()))
            st.session_state.embedded_2d   = npz["embedded_2d"]
            st.session_state.feature_matrix = npz["feature_matrix"]
            st.session_state.done          = False
            if df_input is not None:
                st.session_state.df_clean = df_input.copy()
            elif "df_json" in npz:
                st.session_state.df_clean = pd.read_json(
                    io.StringIO(npz["df_json"].tobytes().decode())
                )
            st.success(
                f"✔ Embeddings loaded — {st.session_state.embedded_2d.shape[0]} companies. "
                "Now click '↺ Re-cluster only'."
            )
        except Exception as e:
            st.error(f"Error loading embeddings: {e}")
