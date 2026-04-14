"""
FastAPI ML microservice for Cloud Run.
Exposes /embed (SSE) and /cluster endpoints.
Called only from Next.js API routes with a Google ID token.
"""

import json
import os
from typing import AsyncGenerator

import firebase_admin
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from firebase_admin import credentials, firestore

from ml_pipeline import embed_all, run_clustering

# ── Firebase Admin init ───────────────────────────────────────────────────────

if not firebase_admin._apps:
    # In Cloud Run, Application Default Credentials are injected automatically.
    # The service account needs Firestore write access.
    firebase_admin.initialize_app()

db = firestore.client()

# ── FastAPI app ───────────────────────────────────────────────────────────────

app = FastAPI(title="Cluster Intelligence ML Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


# ── /embed endpoint (SSE) ─────────────────────────────────────────────────────

@app.post("/embed")
async def embed_endpoint(request: Request):
    """
    Accepts:
      {
        "sessionId": str,
        "companies": [{"id": str, "dimensions": {...}}],
        "weights": {"Problem Solved": 1.4, ...},
        "dimPerField": 256,
        "apiKey": str
      }

    Streams SSE:
      data: {"type": "progress", "done": N, "total": T, "errors": E}
      data: {"type": "done"}

    On completion, writes embedded_2d + outlier_scores back to Firestore companies
    and uploads embeddings.npz to Firebase Storage.
    """
    body = await request.json()
    api_key: str = body.get("apiKey", "")
    session_id: str = body.get("sessionId", "")
    companies: list = body.get("companies", [])
    weights: dict | None = body.get("weights")
    dim_per_field: int = body.get("dimPerField", 256)

    if not api_key:
        raise HTTPException(status_code=401, detail="Missing apiKey")
    if not session_id:
        raise HTTPException(status_code=400, detail="Missing sessionId")
    if not companies:
        raise HTTPException(status_code=400, detail="companies is empty")

    async def stream() -> AsyncGenerator[str, None]:
        try:
            feature_matrix: list[list[float]] = []

            for event in embed_all(companies, api_key, weights, dim_per_field):
                if event["type"] == "progress":
                    yield f"data: {json.dumps(event)}\n\n"
                elif event["type"] == "done":
                    feature_matrix = event["feature_matrix"]

            session_ref = db.collection("sessions").document(session_id)
            session_ref.update({
                "embeddingsStoragePath": f"sessions/{session_id}/embeddings.npz",
                "updatedAt": firestore.SERVER_TIMESTAMP,
            })

            yield f"data: {json.dumps({'type': 'done', 'feature_matrix': feature_matrix})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


# ── /cluster endpoint ─────────────────────────────────────────────────────────

@app.post("/cluster")
async def cluster_endpoint(request: Request):
    """
    Accepts:
      {
        "sessionId": str,
        "companyIds": [str],   // in same order as featureMatrix rows
        "featureMatrix": [[float, ...]],
        "minClusterSize": int,
        "minSamples": int,
        "clusterEpsilon": float,
        "umapClusterDims": int
      }

    Returns:
      {
        "labels": [int],
        "embedded2d": [[x, y]],
        "metrics": {"silhouette": float, "daviesBouldin": float},
        "outlierScores": [float],
        "nClusters": int,
        "nOutliers": int
      }

    Also writes umapX, umapY, clusterId, outlierScore back to Firestore companies.
    """
    body = await request.json()
    session_id: str = body.get("sessionId", "")
    company_ids: list[str] = body.get("companyIds", [])
    feature_matrix: list = body.get("featureMatrix", [])
    min_cluster_size: int = body.get("minClusterSize", 5)
    min_samples: int = body.get("minSamples", 3)
    cluster_epsilon: float = body.get("clusterEpsilon", 0.0)
    umap_cluster_dims: int = body.get("umapClusterDims", 15)

    if not session_id:
        raise HTTPException(status_code=400, detail="Missing sessionId")
    if not feature_matrix:
        raise HTTPException(status_code=400, detail="featureMatrix is empty")

    try:
        result = run_clustering(
            feature_matrix,
            min_cluster_size=min_cluster_size,
            min_samples=min_samples,
            cluster_epsilon=cluster_epsilon,
            umap_cluster_dims=umap_cluster_dims,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    labels = result["labels"]
    embedded_2d = result["embedded_2d"]
    outlier_scores = result["outlier_scores"]

    # Companies are now persisted in Firebase Storage CSV by the Next.js app —
    # no Firestore company writes needed here.

    # Update session metrics (best-effort)
    try:
        db.collection("sessions").document(session_id).update({
            "clusterMetrics": {
                "silhouette": result["metrics"].get("silhouette"),
                "daviesBouldin": result["metrics"].get("davies_bouldin"),
            },
            "updatedAt": firestore.SERVER_TIMESTAMP,
        })
    except Exception:
        pass  # non-fatal

    return {
        "labels": labels,
        "embedded2d": embedded_2d,
        "metrics": result["metrics"],
        "outlierScores": outlier_scores,
        "nClusters": result["n_clusters"],
        "nOutliers": result["n_outliers"],
    }
