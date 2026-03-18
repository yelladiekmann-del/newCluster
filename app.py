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
import plotly.express as px

try:
    import hdbscan
except ImportError:
    import subprocess
    subprocess.run(["pip", "install", "hdbscan", "-q"])
    import hdbscan

try:
    import umap
except ImportError:
    import subprocess
    subprocess.run(["pip", "install", "umap-learn", "-q"])
    import umap

# ============================================================
# CONFIG
# ============================================================
st.set_page_config(page_title="Company Clustering", page_icon="◈", layout="wide")

DIMENSIONS = [
    "Problem Solved", "Target Beneficiary", "The How",
    "Innovation Cluster", "Value Shift", "Ecosystem Role", "Scalability Lever",
]
EMBED_MODEL = "gemini-embedding-001"
EMBED_URL   = f"https://generativelanguage.googleapis.com/v1beta/models/{EMBED_MODEL}:embedContent"
GEN_URL     = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent"

# FIX 1: Use setdefault for cleaner session state initialisation
_defaults = {"df_clean": None, "embedded_2d": None, "feature_matrix": None, "done": False}
for k, v in _defaults.items():
    st.session_state.setdefault(k, v)

# ============================================================
# HELPERS
# ============================================================
def get_embedding(text: str, api_key: str) -> np.ndarray:
    text = str(text).strip()[:8000]
    if len(text) < 3:
        return np.zeros(768)
    payload = {
        "model": f"models/{EMBED_MODEL}",
        "content": {"parts": [{"text": text}]},
        "taskType": "CLUSTERING",
        "outputDimensionality": 768,
    }
    for attempt in range(5):
        try:
            resp = requests.post(f"{EMBED_URL}?key={api_key}", json=payload, timeout=30)
            if resp.status_code == 429:
                time.sleep((2 ** attempt) + random.uniform(0, 1))
                continue
            if resp.status_code != 200:
                # FIX 2: Log the actual error instead of silently swallowing it
                st.warning(f"Embedding API error {resp.status_code}: {resp.text[:200]}")
                return np.zeros(768)
            v    = np.array(resp.json()["embedding"]["values"])
            norm = np.linalg.norm(v)
            time.sleep(0.05)
            return v / norm if norm > 0 else v
        except requests.exceptions.Timeout:
            time.sleep(2 ** attempt)
        except Exception as e:
            # FIX 2: Log unexpected errors
            st.warning(f"Embedding exception: {e}")
            return np.zeros(768)
    return np.zeros(768)


def build_cluster_profile(df_sel: pd.DataFrame, dimensions: list[str]) -> str:
    lines = []
    for dim in dimensions:
        if dim not in df_sel.columns:
            continue
        # FIX 3: dropna before value_counts to avoid NaN contaminating profiles
        top = (
            df_sel[dim]
            .dropna()
            .str.strip()
            .replace("", pd.NA)
            .dropna()
            .value_counts()
            .head(2)
            .index
            .tolist()
        )
        if top:
            lines.append(f"  {dim}: {' / '.join(top)}")
    return "\n".join(lines)


def name_all_clusters(cluster_profiles: dict, api_key: str) -> dict[int, str]:
    """One Gemini call for ALL clusters — names are distinctive relative to each other."""
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


def run_clustering(
    df_clean: pd.DataFrame,
    embedded_2d: np.ndarray,
    min_cluster_size: int,
    min_samples: int,
    cluster_epsilon: float,
) -> tuple[pd.DataFrame, int, int]:
    # FIX 4: Guard against empty/mismatched input
    if len(df_clean) != len(embedded_2d):
        st.error(
            f"Row mismatch: DataFrame has {len(df_clean)} rows but "
            f"embeddings have {len(embedded_2d)}. Re-run full pipeline."
        )
        st.stop()

    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=min_cluster_size,
        min_samples=min_samples,
        cluster_selection_epsilon=cluster_epsilon,
        cluster_selection_method="leaf",
        metric="euclidean",
    )
    labels     = clusterer.fit_predict(embedded_2d)
    n_clusters = len([l for l in set(labels) if l >= 0])
    n_outliers = int((labels == -1).sum())

    cluster_names = {-1: "Outliers"}
    for label in sorted(set(labels)):
        if label >= 0:
            cluster_names[label] = f"Cluster {label}"

    df_out = df_clean.copy()
    df_out["Cluster"] = [cluster_names[l] for l in labels]
    df_out["_x"]      = embedded_2d[:, 0]
    df_out["_y"]      = embedded_2d[:, 1]
    return df_out, n_clusters, n_outliers


def build_text_for_row(row: pd.Series, desc_col: str | None, available_dims: list[str], use_desc: bool) -> str:
    """FIX 5: Extracted helper — avoids duplicated logic between start and recluster paths."""
    if use_desc and desc_col:
        text = str(row.get(desc_col, "")).strip()
        if text:
            return text
    return " | ".join(str(row.get(d, "")) for d in available_dims)


# ============================================================
# UI
# ============================================================
st.title("◈ Company Clustering v1.5")
st.caption("Gemini Embeddings · HDBSCAN · UMAP")
st.divider()

api_key  = st.text_input("Gemini API Key", type="password", placeholder="AIza...")
uploaded = st.file_uploader("CSV or Excel file", type=["csv", "xlsx", "xls"])

df_input    = None
company_col = "name"
desc_col    = None

if uploaded:
    try:
        if uploaded.name.endswith(".csv"):
            df_input = pd.read_csv(uploaded)
        else:
            df_input = pd.read_excel(uploaded)
        st.success(f"✔ {len(df_input)} rows · {len(df_input.columns)} columns loaded")

        col1, col2 = st.columns(2)
        with col1:
            idx = df_input.columns.tolist().index("name") if "name" in df_input.columns else 0
            company_col = st.selectbox("Company column", df_input.columns.tolist(), index=idx)
        with col2:
            desc_options = ["(none — use dimensions)"] + df_input.columns.tolist()
            # FIX 6: Safe default index — don't crash if "Description" is absent
            desc_default = desc_options.index("Description") if "Description" in desc_options else 0
            desc_sel     = st.selectbox("Description column (optional)", desc_options, index=desc_default)
            desc_col     = None if desc_sel.startswith("(none") else desc_sel

        with st.expander("Preview"):
            st.dataframe(df_input.head(5), use_container_width=True, hide_index=True)

    except Exception as e:
        st.error(f"Could not load file: {e}")

st.divider()
st.subheader("Clustering Parameters")

col1, col2, col3 = st.columns(3)
with col1:
    min_cluster_size = st.slider("Min Cluster Size", 2, 30, 5)
with col2:
    min_samples = st.slider("Min Samples", 1, 20, 3)
with col3:
    cluster_epsilon = st.slider("Cluster Epsilon", 0.0, 2.0, 0.0, step=0.1)

st.divider()

col_a, col_b, col_c = st.columns(3)
with col_a:
    start = st.button(
        "▶  Run Embeddings + Clustering", type="primary", use_container_width=True,
        disabled=(df_input is None or not api_key),
    )
with col_b:
    recluster = st.button(
        "↺  Re-cluster only", use_container_width=True,
        disabled=(st.session_state.embedded_2d is None or st.session_state.df_clean is None),
        help="Skips embeddings and UMAP.",
    )
with col_c:
    name_btn = st.button(
        "🏷  Name clusters", use_container_width=True,
        disabled=(st.session_state.df_clean is None),
        help="One Gemini call — names all clusters at once. Click when you're happy with the clusters.",
    )

# ============================================================
# PIPELINE — FULL RUN
# ============================================================
if start and df_input is not None:
    st.session_state.done     = False
    st.session_state.df_clean = None

    available_dims = [d for d in DIMENSIONS if d in df_input.columns]
    use_desc = bool(
        desc_col
        and desc_col in df_input.columns
        and df_input[desc_col].astype(str).str.strip().ne("").any()
    )

    # FIX 7: Only filter on dimensions if they exist; otherwise keep all rows
    if available_dims:
        mask     = df_input[available_dims].apply(lambda r: any(str(v).strip() for v in r), axis=1)
        df_clean = df_input[mask].reset_index(drop=True)
    else:
        df_clean = df_input.reset_index(drop=True)

    # FIX 8: Warn early if no usable text source exists at all
    if not available_dims and not use_desc:
        st.error("No dimension columns or description column found. Cannot build embeddings.")
        st.stop()

    total = len(df_clean)
    st.info(f"{total} companies will be processed")

    # --- Embeddings ---
    st.subheader("1 · Embeddings")
    prog    = st.progress(0)
    status  = st.empty()
    vectors = []
    errors  = 0

    for i in range(total):
        row  = df_clean.iloc[i]
        text = build_text_for_row(row, desc_col, available_dims, use_desc)
        vec  = get_embedding(text, api_key)
        vectors.append(vec)
        if np.all(vec == 0):
            errors += 1
        prog.progress((i + 1) / total)
        status.caption(f"{i+1}/{total} · {str(row.get(company_col, ''))[:40]} · ✗ {errors}")

    prog.empty()
    status.empty()

    # FIX 9: Abort if ALL embeddings failed — clustering would be meaningless noise
    if errors == total:
        st.error("All embeddings failed. Check your API key and network connection.")
        st.stop()

    feature_matrix = normalize(np.array(vectors))
    st.success(f"✔ {total} embeddings ({errors} errors)")

    # --- UMAP ---
    st.subheader("2 · UMAP")
    with st.spinner("UMAP 768D → 2D…"):
        reducer     = umap.UMAP(n_components=2, n_neighbors=15, min_dist=0.05, metric="cosine", random_state=42)
        embedded_2d = reducer.fit_transform(feature_matrix)
    st.success("✔ UMAP done")

    # --- Clustering ---
    st.subheader("3 · Clustering")
    with st.spinner("HDBSCAN…"):
        df_clean, n_clusters, n_outliers = run_clustering(
            df_clean, embedded_2d, min_cluster_size, min_samples, cluster_epsilon
        )
    st.success(f"✔ {n_clusters} clusters · {n_outliers} outliers — now click '🏷 Name clusters'")

    st.session_state.df_clean       = df_clean
    st.session_state.embedded_2d    = embedded_2d
    st.session_state.feature_matrix = feature_matrix
    st.session_state.done           = True

# ============================================================
# RECLUSTER
# ============================================================
if recluster and st.session_state.embedded_2d is not None:
    # FIX 10: df_clean could be None after a fresh .npz upload; handle gracefully
    if st.session_state.df_clean is None:
        if df_input is not None:
            st.session_state.df_clean = df_input.copy()
        else:
            st.error("No data loaded. Upload a CSV/Excel file first.")
            st.stop()

    with st.spinner("Re-clustering…"):
        df_result, n_c, n_o = run_clustering(
            st.session_state.df_clean,
            st.session_state.embedded_2d,
            min_cluster_size, min_samples, cluster_epsilon,
        )
    st.session_state.df_clean = df_result
    st.session_state.done     = True   # FIX 11: was never set on recluster — results never showed
    st.success(f"✔ {n_c} clusters · {n_o} outliers — now click '🏷 Name clusters'")

# ============================================================
# CLUSTER NAMING
# ============================================================
if name_btn and st.session_state.df_clean is not None:
    if not api_key:
        st.error("Gemini API key missing.")
    else:
        df_to_name      = st.session_state.df_clean
        dimensions      = [d for d in DIMENSIONS if d in df_to_name.columns]
        # FIX 12: Preserve original numeric order so LLM index → cluster name mapping is stable
        unique_clusters = [
            c for c in df_to_name["Cluster"].unique()
            if c != "Outliers"
        ]
        unique_clusters_sorted = sorted(unique_clusters, key=lambda x: int(x.split()[-1]) if x.split()[-1].isdigit() else 0)

        cluster_profiles = {}
        for i, cname in enumerate(unique_clusters_sorted):
            mask   = df_to_name["Cluster"] == cname
            df_sel = df_to_name.loc[mask]
            cluster_profiles[i] = (int(mask.sum()), build_cluster_profile(df_sel, dimensions))

        with st.spinner(f"Naming {len(cluster_profiles)} clusters in one Gemini call…"):
            llm_names = name_all_clusters(cluster_profiles, api_key)

        if llm_names:
            name_map = {cname: llm_names.get(i, cname) for i, cname in enumerate(unique_clusters_sorted)}
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
    df = st.session_state.df_clean

    st.divider()
    c1, c2, c3 = st.columns(3)
    c1.metric("Companies", len(df))
    c2.metric("Clusters", df["Cluster"].nunique() - (1 if "Outliers" in df["Cluster"].values else 0))
    c3.metric("Outliers", int((df["Cluster"] == "Outliers").sum()))

    hover_cols = [c for c in [company_col] + DIMENSIONS if c in df.columns]
    fig = px.scatter(
        df, x="_x", y="_y", color="Cluster",
        hover_data=hover_cols,
        color_discrete_sequence=px.colors.qualitative.Bold,
        height=620,
    )
    fig.update_traces(marker=dict(size=7, opacity=0.80))
    fig.update_layout(
        margin=dict(l=0, r=0, t=20, b=0),
        xaxis=dict(title="", showticklabels=False, showgrid=False, zeroline=False),
        yaxis=dict(title="", showticklabels=False, showgrid=False, zeroline=False),
        dragmode="lasso",
    )
    st.plotly_chart(fig, use_container_width=True)

    show_cols = [c for c in [company_col, "Cluster"] + DIMENSIONS if c in df.columns]
    st.dataframe(df[show_cols], use_container_width=True, hide_index=True)

    col_dl1, col_dl2 = st.columns(2)
    with col_dl1:
        st.download_button(
            "⬇  Download results as CSV",
            df[show_cols].to_csv(index=False),
            "cluster_results.csv", "text/csv", use_container_width=True,
        )
    with col_dl2:
        if st.session_state.feature_matrix is not None:
            buf = io.BytesIO()
            df_json = st.session_state.df_clean.to_json().encode()
            np.savez_compressed(
                buf,
                embedded_2d=st.session_state.embedded_2d,
                feature_matrix=st.session_state.feature_matrix,
                df_json=np.frombuffer(df_json, dtype=np.uint8),
            )
            buf.seek(0)
            st.download_button(
                "⬇  Save embeddings (.npz)",
                buf, "embeddings.npz", "application/octet-stream",
                use_container_width=True,
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
            st.session_state.embedded_2d    = npz["embedded_2d"]
            st.session_state.feature_matrix = npz["feature_matrix"]
            st.session_state.done           = False
            if df_input is not None:
                st.session_state.df_clean = df_input.copy()
            n = st.session_state.embedded_2d.shape[0]
            st.success(f"✔ Embeddings loaded — {n} companies. Now click '↺ Re-cluster only'.")
        except Exception as e:
            st.error(f"Error loading embeddings: {e}")
