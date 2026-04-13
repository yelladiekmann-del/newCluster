"""
ML pipeline: embeddings + clustering.
Ported directly from utils.py (Streamlit app).
All Streamlit-specific calls (st.spinner, st.error) removed.
"""

import random
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Generator

import hdbscan
import numpy as np
import requests
import umap
from sklearn.metrics import davies_bouldin_score, silhouette_score
from sklearn.preprocessing import normalize

EMBED_MODEL = "gemini-embedding-001"
EMBED_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{EMBED_MODEL}:embedContent"

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


# ── Embedding ─────────────────────────────────────────────────────────────────

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
                return np.zeros(dim)
            v = np.array(resp.json()["embedding"]["values"])
            norm = np.linalg.norm(v)
            return v / norm if norm > 0 else v
        except requests.exceptions.Timeout:
            time.sleep(2 ** attempt)
        except Exception:
            return np.zeros(dim)
    return np.zeros(dim)


def get_per_dimension_embedding(
    dimensions_dict: dict,
    api_key: str,
    dim_per_field: int = 256,
    weights: dict | None = None,
) -> np.ndarray:
    """Embed a single company's 8 dimensions and concatenate."""
    _weights = weights if weights is not None else DIMENSION_WEIGHTS
    available_dims = [d for d in DIMENSIONS if dimensions_dict.get(d)]

    if not available_dims:
        return np.zeros(dim_per_field * len(DIMENSIONS))

    def _embed_dim(d):
        val = str(dimensions_dict.get(d, "")).strip()
        vec = get_embedding(val if val else "unknown", api_key, dim=dim_per_field)
        return vec * _weights.get(d, 1.0)

    with ThreadPoolExecutor(max_workers=len(available_dims)) as ex:
        parts = list(ex.map(_embed_dim, available_dims))

    combined = np.concatenate(parts)
    norm = np.linalg.norm(combined)
    return combined / norm if norm > 0 else combined


def embed_all(
    companies: list[dict],
    api_key: str,
    weights: dict | None = None,
    dim_per_field: int = 256,
) -> Generator[dict, None, None]:
    """
    Yield SSE-style progress dicts as embeddings complete.
    Yields: {"type": "progress", "done": n, "total": N, "errors": e}
    Finally yields: {"type": "done", "feature_matrix": [[...]]}
    """
    total = len(companies)
    errors = 0
    matrix = []

    for i, company in enumerate(companies):
        dims = company.get("dimensions", {})
        vec = get_per_dimension_embedding(dims, api_key, dim_per_field, weights)
        if np.all(vec == 0):
            errors += 1
        matrix.append(vec.tolist())
        yield {"type": "progress", "done": i + 1, "total": total, "errors": errors}

    # Normalize the full matrix
    mat = np.array(matrix, dtype=np.float32)
    if mat.shape[0] > 0:
        mat = normalize(mat)

    yield {"type": "done", "feature_matrix": mat.tolist()}


# ── Clustering ────────────────────────────────────────────────────────────────

def run_clustering(
    feature_matrix: list[list[float]],
    min_cluster_size: int = 5,
    min_samples: int = 3,
    cluster_epsilon: float = 0.0,
    umap_cluster_dims: int = 15,
) -> dict:
    mat = np.array(feature_matrix, dtype=np.float32)
    n = len(mat)

    actual_cluster_dims = min(umap_cluster_dims, n - 2, mat.shape[1])

    # UMAP for clustering (high-D)
    reducer_nd = umap.UMAP(
        n_components=actual_cluster_dims,
        n_neighbors=min(15, n - 1),
        min_dist=0.0,
        metric="cosine",
        random_state=42,
    )
    embedded_nd = reducer_nd.fit_transform(mat)

    # UMAP for 2D visualisation
    reducer_2d = umap.UMAP(
        n_components=2,
        n_neighbors=min(15, n - 1),
        min_dist=0.05,
        metric="cosine",
        random_state=42,
    )
    embedded_2d = reducer_2d.fit_transform(mat)

    # HDBSCAN
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

    # Metrics
    metrics: dict = {}
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
        clusterer.outlier_scores_.tolist()
        if hasattr(clusterer, "outlier_scores_") and clusterer.outlier_scores_ is not None
        else [0.0] * n
    )

    return {
        "labels": labels.tolist(),
        "embedded_2d": embedded_2d.tolist(),
        "metrics": metrics,
        "outlier_scores": outlier_scores,
        "n_clusters": n_clusters,
        "n_outliers": int((labels == -1).sum()),
    }
