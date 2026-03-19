import streamlit as st
from cluster_review import render_cluster_review
from cluster_chat import render_cluster_chat
from dimension_extraction import extract_dimensions, EXTRACTED_DIMENSIONS, _BATCH_SIZE as _DIM_BATCH_SIZE
import pandas as pd
import numpy as np
import time
import random
import requests
import io
import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed

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
    "Problem Solved", "Customer Segment", "Core Mechanism",
    "Tech Category", "Business Model", "Value Shift",
    "Ecosystem Role", "Scalability Lever",
]

# IMPROVEMENT 1: Per-dimension weights
# Not all dimensions are equally informative for separating companies.
# "Problem Solved" and "Core Mechanism" carry the most discriminative signal;
# "Ecosystem Role" is often too broad to differentiate well.
DIMENSION_WEIGHTS = {
    "Problem Solved":   1.4,
    "Customer Segment": 1.2,
    "Core Mechanism":   1.3,
    "Tech Category":    1.1,
    "Business Model":   1.2,
    "Value Shift":      0.9,
    "Ecosystem Role":   0.7,
    "Scalability Lever": 0.8,
}

EMBED_MODEL = "gemini-embedding-001"
EMBED_URL   = f"https://generativelanguage.googleapis.com/v1beta/models/{EMBED_MODEL}:embedContent"
GEN_URL     = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"

# Parallel workers for embedding calls.
# gemini-embedding-001 is TPM-governed with generous limits on paid tier.
# 429s are retried with exponential backoff in get_embedding() — no manual throttle needed.
# Reduce if you consistently see 429 errors on a free-tier key.
_EMBED_WORKERS = 10

_defaults = {
    "df_clean": None, "embedded_2d": None, "feature_matrix": None,
    "done": False, "cluster_metrics": None, "confirm_rerun_pending": False,
    "df_enriched": None, "df_enriched_src": None, "autotune_result": None,
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
    def _embed_dim(d):
        val = str(row.get(d, "")).strip()
        vec = get_embedding(val if val else "unknown", api_key, dim=dim_per_field)
        return vec * DIMENSION_WEIGHTS.get(d, 1.0)

    with ThreadPoolExecutor(max_workers=len(available_dims)) as ex:
        parts = list(ex.map(_embed_dim, available_dims))

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
    _umap_eta = _fmt_secs(max(5, int(n * 0.05)))
    with st.spinner(f"UMAP {feature_matrix.shape[1]}D → {actual_cluster_dims}D for clustering… ({_umap_eta})"):
        reducer_nd = umap.UMAP(
            n_components=actual_cluster_dims,
            n_neighbors=min(15, n - 1),
            min_dist=0.0,   # tighter packing — better for clustering
            metric="cosine",
            random_state=42,
        )
        embedded_nd = reducer_nd.fit_transform(feature_matrix)

    # --- UMAP for visualisation (2D) ---
    _umap2d_eta = _fmt_secs(max(3, int(n * 0.03)))
    with st.spinner(f"UMAP → 2D for visualisation… ({_umap2d_eta})"):
        reducer_2d = umap.UMAP(
            n_components=2,
            n_neighbors=min(15, n - 1),
            min_dist=0.05,
            metric="cosine",
            random_state=42,
        )
        embedded_2d = reducer_2d.fit_transform(feature_matrix)

    # --- HDBSCAN on high-D embeddings ---
    with st.spinner("HDBSCAN on high-D space… (usually <5s)"):
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
# AUTOTUNE — suggest optimal HDBSCAN params via grid search
# ============================================================
def find_optimal_params(feature_matrix: np.ndarray, umap_cluster_dims: int) -> dict:
    """
    Run UMAP once then sweep a 3-axis HDBSCAN grid (min_cluster_size ×
    min_samples × cluster_epsilon). Selects the combo maximising a combined
    score: 0.6 × silhouette + 0.4 × (1 / (1 + davies_bouldin)).
    Both metrics are given real weight — silhouette is primary but DB
    meaningfully affects the result, not just a tiebreaker.
    """
    n = len(feature_matrix)
    actual_dims = min(umap_cluster_dims, n - 2, feature_matrix.shape[1])
    reducer = umap.UMAP(
        n_components=actual_dims,
        n_neighbors=min(15, n - 1),
        min_dist=0.0,
        metric="cosine",
        random_state=42,
    )
    embedded = reducer.fit_transform(feature_matrix)

    sizes = [s for s in [3, 5, 7, 10, 15] if s <= max(2, n // 3)]
    if not sizes:
        sizes = [max(2, n // 5)]

    best: dict | None = None
    for mcs in sizes:
        for ms in [1, 3, 5]:
            if ms > mcs:
                continue
            for eps in [0.0, 0.2, 0.5]:
                try:
                    labels = hdbscan.HDBSCAN(
                        min_cluster_size=mcs,
                        min_samples=ms,
                        cluster_selection_epsilon=eps,
                        cluster_selection_method="leaf",
                        metric="euclidean",
                    ).fit_predict(embedded)
                    nc = len([l for l in set(labels) if l >= 0])
                    mask = labels != -1
                    if nc < 2 or mask.sum() < 2:
                        continue
                    sil = float(silhouette_score(embedded[mask], labels[mask]))
                    db  = float(davies_bouldin_score(embedded[mask], labels[mask]))
                    # Combined score: silhouette 60% + normalised DB 40%
                    combined = sil * 0.6 + (1.0 / (1.0 + db)) * 0.4
                    if best is None or combined > best["_combined"]:
                        best = {
                            "min_cluster_size": mcs, "min_samples": ms,
                            "cluster_epsilon": eps, "n_clusters": nc,
                            "silhouette": round(sil, 3),
                            "davies_bouldin": round(db, 3),
                            "_combined": combined,
                        }
                except Exception:
                    continue

    if best:
        best.pop("_combined")  # internal only
        return best
    return {"min_cluster_size": 5, "min_samples": 3, "cluster_epsilon": 0.0,
            "n_clusters": 0, "silhouette": 0.0, "davies_bouldin": 999.0}


# ============================================================
# HELPERS — UI
# ============================================================
def _fmt_secs(s: int) -> str:
    """Format a number of seconds as a human-readable estimate string."""
    if s < 60:
        return f"~{s}s"
    m, sec = divmod(s, 60)
    return f"~{m}m {sec}s" if sec else f"~{m}m"


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

        # ── Generate dimensions ──────────────────────────────────────────────
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
                    f"✔ Dimensions extracted — {len(EXTRACTED_DIMENSIONS)} columns ready. "
                    "These will be used for embedding."
                )
            with col_regen:
                if st.button("↺ Regenerate", key="regen_dims", help="Re-run extraction"):
                    st.session_state["df_enriched"] = None
                    st.rerun()
            with col_dl:
                csv_bytes = df_input.to_csv(index=False).encode()
                st.download_button(
                    "⬇ Download enriched CSV",
                    data=csv_bytes,
                    file_name="companies_with_dimensions.csv",
                    mime="text/csv",
                    key="dl_enriched",
                )

        elif _dims_in_csv:
            st.info(
                f"All {len(EXTRACTED_DIMENSIONS)} dimension columns found in the uploaded file — "
                "no extraction needed."
            )

        elif desc_col:
            with st.expander("⚡ Generate dimensions from descriptions", expanded=True):
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
                    help="Requires an API key." if not api_key else None,
                ):
                    enriched = extract_dimensions(df_input, company_col, desc_col, api_key)
                    st.session_state["df_enriched"] = enriched
                    st.session_state["df_enriched_src"] = uploaded.name
                    st.rerun()

    except Exception as e:
        st.error(f"Could not load file: {e}")

with st.expander("⚡ Load saved embeddings (skips embedding step)"):
    emb_file = st.file_uploader("Upload embeddings.npz", type=["npz"], key="emb_upload")
    if emb_file:
        try:
            npz = np.load(io.BytesIO(emb_file.read()))
            st.session_state.embedded_2d    = npz["embedded_2d"]
            st.session_state.feature_matrix = npz["feature_matrix"]
            # Only initialise df_clean if it hasn't been set yet.
            # Once clustering runs it will have a Cluster column — don't overwrite it.
            if st.session_state.df_clean is None:
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

st.divider()

# Use enriched df (with extracted dimensions) if available for the current file
if (
    uploaded is not None
    and st.session_state["df_enriched"] is not None
    and st.session_state["df_enriched_src"] == uploaded.name
    and df_input is not None
):
    df_input = st.session_state["df_enriched"]

# --- Shared button gates (computed early so sections can use them) ---
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
_reviewed = st.session_state.get("cr_rerun_report") is not None

# --- Embedding mode (only shown when CSV loaded and no embeddings yet) ---
embed_mode    = "Per-dimension (recommended)"
custom_weights = DIMENSION_WEIGHTS

if has_csv and not has_embeddings:
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
    st.divider()
elif has_embeddings and not _clustered:
    st.info("Embeddings loaded from file — click **↺ Re-cluster only** to continue.")

# --- Clustering parameters (only shown when CSV is loaded) ---
if has_csv:
    st.subheader("Clustering parameters")

    # Autotune banner (shown after a suggestion has been applied)
    _at = st.session_state.get("autotune_result")
    if _at and _at.get("n_clusters", 0) > 0:
        st.success(
            f"✨ Suggested: min\_cluster\_size={_at['min_cluster_size']}, "
            f"min\_samples={_at['min_samples']}, "
            f"cluster\_epsilon={_at.get('cluster_epsilon', 0.0)} → "
            f"{_at['n_clusters']} clusters · silhouette={_at['silhouette']:.3f} · DB={_at['davies_bouldin']:.3f}"
        )

    # Read autotune suggestions (plain session state keys, not widget keys)
    _at_mcs = st.session_state.get("_autotune_mcs", 5)
    _at_ms  = st.session_state.get("_autotune_ms",  3)
    _at_eps = st.session_state.get("_autotune_eps", 0.0)

    col1, col2, col3, col4 = st.columns(4)
    with col1:
        min_cluster_size  = st.slider(
            "Min cluster size", 2, 30, _at_mcs,
            help=(
                "Minimum number of companies to form a cluster. "
                "Lower → more, smaller clusters (risk: noise gets its own cluster). "
                "Higher → fewer, larger clusters (risk: real sub-groups get merged or dropped as outliers). "
                "Start around 5 and increase if you're getting too many tiny clusters."
            ),
        )
    with col2:
        min_samples       = st.slider(
            "Min samples", 1, 20, _at_ms,
            help=(
                "Controls how conservative HDBSCAN is about calling a point a core point. "
                "Higher → stricter core membership, more companies labelled as outliers, tighter clusters. "
                "Lower → more permissive, fewer outliers, but clusters may be looser. "
                "Rule of thumb: keep it ≤ Min cluster size. Set to 1 for the most inclusive clustering."
            ),
        )
    with col3:
        cluster_epsilon   = st.slider(
            "Cluster epsilon", 0.0, 2.0, _at_eps, step=0.1,
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

    if st.session_state.get("feature_matrix") is not None:
        if st.button(
            "✨ Suggest optimal settings",
            help="Runs UMAP + sweeps HDBSCAN parameter combinations to maximise silhouette score (~10–20s)",
        ):
            with st.spinner("Scanning parameter space… (~10–20s)"):
                _result = find_optimal_params(st.session_state.feature_matrix, umap_cluster_dims)
            st.session_state["autotune_result"] = _result
            # Use separate keys (not widget keys) so Streamlit accepts the assignment
            st.session_state["_autotune_mcs"] = _result["min_cluster_size"]
            st.session_state["_autotune_ms"]  = _result["min_samples"]
            st.session_state["_autotune_eps"] = 0.0
            st.rerun()

    st.divider()
else:
    min_cluster_size, min_samples, cluster_epsilon, umap_cluster_dims = 5, 3, 0.0, 15

# --- Workflow status ---
if has_csv:
    steps = [
        ("Data loaded",      has_csv),
        ("Embeddings ready", has_embeddings),
        ("Clustered",        _clustered),
        ("Named",            _named),
        ("Reviewed",         _reviewed),
    ]
    scols = st.columns(len(steps))
    for scol, (label, done) in zip(scols, steps):
        with scol:
            st.caption(f"{'✅' if done else '⬜'} {label}")

# --- Load-bearing expander (fixes Streamlit widget-tree sync) ---
with st.expander("ℹ️ Session status", expanded=False):
    st.write({
        "has_api_key":    has_api_key,
        "has_csv":        has_csv,
        "has_embeddings": has_embeddings,
        "_clustered":     _clustered,
        "_named":         _named,
        "_reviewed":      _reviewed,
    })

# --- Buttons row OR confirmation dialog ---
if st.session_state.get("confirm_rerun_pending"):
    st.warning("Running again will discard all current clustering results, names, and review edits.")
    col_confirm, col_cancel = st.columns(2)
    with col_confirm:
        _confirmed = st.button("Confirm — discard and re-run", type="primary", width="stretch")
    with col_cancel:
        _cancelled = st.button("Cancel", width="stretch")

    if _cancelled:
        st.session_state["confirm_rerun_pending"] = False
        st.rerun()

    if _confirmed:
        st.session_state["confirm_rerun_pending"] = False

    start    = _confirmed
    recluster = False
    name_btn  = False
else:
    col_a, col_b, col_c = st.columns(3)
    with col_a:
        _run_clicked = st.button(
            "▶  Run embeddings + clustering", type="primary", width='stretch',
            disabled=not (has_api_key and has_csv),
        )
        if _run_clicked and _clustered:
            st.session_state["confirm_rerun_pending"] = True
            st.rerun()
        start = _run_clicked and not _clustered
    with col_b:
        recluster = st.button(
            "↺  Re-cluster only", width='stretch',
            disabled=not has_embeddings,
            help="Skips embeddings. Re-runs UMAP + HDBSCAN with current parameters.",
        )
    with col_c:
        name_btn = st.button(
            "🏷  Name clusters", width='stretch',
            disabled=not (has_api_key and _clustered),
            help="One Gemini call — names all clusters at once.",
        )

# ============================================================
# PIPELINE — FULL RUN
# ============================================================
if start and df_input is not None:
    st.session_state.done            = False
    st.session_state.df_clean       = None
    st.session_state.cluster_metrics = None
    st.session_state["autotune_result"] = None
    st.session_state["_autotune_mcs"] = 5
    st.session_state["_autotune_ms"]  = 3
    st.session_state["_autotune_eps"] = 0.0

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
    st.info(f"{total} companies will be processed — embedding est. {_fmt_secs(_embed_eta)} ({_EMBED_WORKERS} parallel workers)")

    # --- Embeddings ---
    st.subheader("1 · Embeddings")
    prog   = st.progress(0)
    status = st.empty()
    _embed_start = time.time()

    # Worker: pure computation only — no st.* calls (Streamlit requires main thread)
    def _embed_one(i):
        row = df_clean.iloc[i]
        if embed_mode == "Per-dimension (recommended)":
            vec = get_per_dimension_embedding(row, available_dims, api_key, dim_per_field=256)
        elif embed_mode == "Description column" and use_desc:
            text = str(row.get(desc_col, "")).strip()
            vec  = get_description_embedding(text or "unknown", api_key)
        else:
            text = " | ".join(str(row.get(d, "")) for d in available_dims)
            vec  = get_description_embedding(text, api_key)
        return i, vec

    # Main thread collects results and drives all UI updates
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
            _elapsed = time.time() - _embed_start
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
    st.rerun()

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
    st.rerun()

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

# ============================================================
# RESULTS
# ============================================================
if st.session_state.df_clean is not None and "Cluster" in st.session_state.df_clean.columns:
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

    st.divider()
    reviewed_df = render_cluster_review(
        df_clean=st.session_state.df_clean,
        company_col=company_col,
        dimensions=DIMENSIONS,
        api_key=api_key,
    )
    if reviewed_df is not None:
        st.session_state.df_clean = reviewed_df
        st.rerun()

    st.divider()
    render_cluster_chat(
        df_clean=st.session_state.df_clean,
        company_col=company_col,
        dimensions=DIMENSIONS,
        api_key=api_key,
        cluster_metrics=st.session_state.cluster_metrics or {},
    )

