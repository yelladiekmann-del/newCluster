"""Shared constants, helper functions, and session state defaults.

All pure-Python and Streamlit-agnostic functions live here so they can be
imported by every page without circular dependencies.
"""

import io
import json
import random
import re
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
import requests
import streamlit as st
from sklearn.metrics import davies_bouldin_score, silhouette_score
from sklearn.preprocessing import normalize

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

# ── Constants ───────────────────────────────────────────────────────────────

DIMENSIONS = [
    "Problem Solved", "Customer Segment", "Core Mechanism",
    "Tech Category", "Business Model", "Value Shift",
    "Ecosystem Role", "Scalability Lever",
]

DIMENSION_WEIGHTS = {
    "Problem Solved":    1.4,
    "Customer Segment":  1.2,
    "Core Mechanism":    1.3,
    "Tech Category":     1.1,
    "Business Model":    1.2,
    "Value Shift":       0.9,
    "Ecosystem Role":    0.7,
    "Scalability Lever": 0.8,
}

EMBED_MODEL    = "gemini-embedding-001"
EMBED_URL      = f"https://generativelanguage.googleapis.com/v1beta/models/{EMBED_MODEL}:embedContent"
GEN_URL        = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
_EMBED_WORKERS = 10

SESSION_DEFAULTS: dict = {
    "df_clean":              None,
    "embedded_2d":           None,
    "feature_matrix":        None,
    "done":                  False,
    "cluster_metrics":       None,
    "confirm_rerun_pending": False,
    "df_enriched":           None,
    "df_enriched_src":       None,
    "autotune_result":       None,
    # persisted UI selections
    "company_col":           "name",
    "desc_col":              None,
    "embed_mode":            "Per-dimension (recommended)",
    "custom_weights":        None,   # None → use DIMENSION_WEIGHTS defaults
}


# ── Formatting ───────────────────────────────────────────────────────────────

def _fmt_secs(s: int) -> str:
    if s < 60:
        return f"~{s}s"
    m, sec = divmod(s, 60)
    return f"~{m}m {sec}s" if sec else f"~{m}m"


# ── Embedding ────────────────────────────────────────────────────────────────

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


def get_per_dimension_embedding(
    row: pd.Series,
    available_dims: list[str],
    api_key: str,
    dim_per_field: int = 256,
    weights: dict | None = None,
) -> np.ndarray:
    _weights = weights if weights is not None else DIMENSION_WEIGHTS

    def _embed_dim(d):
        val = str(row.get(d, "")).strip()
        vec = get_embedding(val if val else "unknown", api_key, dim=dim_per_field)
        return vec * _weights.get(d, 1.0)

    with ThreadPoolExecutor(max_workers=len(available_dims)) as ex:
        parts = list(ex.map(_embed_dim, available_dims))

    if not parts:
        return np.zeros(dim_per_field)

    combined = np.concatenate(parts)
    norm = np.linalg.norm(combined)
    return combined / norm if norm > 0 else combined


def get_description_embedding(text: str, api_key: str) -> np.ndarray:
    return get_embedding(text, api_key, dim=768)


# ── Cluster naming ───────────────────────────────────────────────────────────

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


# ── Clustering ───────────────────────────────────────────────────────────────

def run_clustering(
    df_clean: pd.DataFrame,
    feature_matrix: np.ndarray,
    min_cluster_size: int,
    min_samples: int,
    cluster_epsilon: float,
    umap_vis_dims: int = 2,
    umap_cluster_dims: int = 15,
) -> tuple[pd.DataFrame, np.ndarray, int, int, dict]:
    if len(df_clean) != len(feature_matrix):
        st.error(
            f"Row mismatch: DataFrame {len(df_clean)} rows vs "
            f"embeddings {len(feature_matrix)}. Re-run full pipeline."
        )
        st.stop()

    n = len(feature_matrix)

    actual_cluster_dims = min(umap_cluster_dims, n - 2, feature_matrix.shape[1])
    _umap_eta = _fmt_secs(max(5, int(n * 0.05)))
    with st.spinner(f"UMAP {feature_matrix.shape[1]}D → {actual_cluster_dims}D for clustering… ({_umap_eta})"):
        reducer_nd = umap.UMAP(
            n_components=actual_cluster_dims,
            n_neighbors=min(15, n - 1),
            min_dist=0.0,
            metric="cosine",
            random_state=42,
        )
        embedded_nd = reducer_nd.fit_transform(feature_matrix)

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

    with st.spinner("HDBSCAN on high-D space… (usually <5s)"):
        clusterer = hdbscan.HDBSCAN(
            min_cluster_size=min_cluster_size,
            min_samples=min_samples,
            cluster_selection_epsilon=cluster_epsilon,
            cluster_selection_method="leaf",
            metric="euclidean",
            prediction_data=True,
        )
        labels = clusterer.fit_predict(embedded_nd)

    n_clusters = len([l for l in set(labels) if l >= 0])
    n_outliers  = int((labels == -1).sum())

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

    outlier_scores = (
        clusterer.outlier_scores_
        if hasattr(clusterer, "outlier_scores_") and clusterer.outlier_scores_ is not None
        else np.zeros(n)
    )

    cluster_names_map = {-1: "Outliers"}
    for label in sorted(set(labels)):
        if label >= 0:
            cluster_names_map[label] = f"Cluster {label}"

    df_out = df_clean.copy()
    df_out["Cluster"]       = [cluster_names_map[l] for l in labels]
    df_out["Outlier score"] = np.round(outlier_scores, 3)
    df_out["_x"]            = embedded_2d[:, 0]
    df_out["_y"]            = embedded_2d[:, 1]

    return df_out, embedded_2d, n_clusters, n_outliers, metrics


def find_optimal_params(feature_matrix: np.ndarray, umap_cluster_dims: int) -> dict:
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
        best.pop("_combined")
        return best
    return {"min_cluster_size": 5, "min_samples": 3, "cluster_epsilon": 0.0,
            "n_clusters": 0, "silhouette": 0.0, "davies_bouldin": 999.0}
