import streamlit as st
import pandas as pd
import numpy as np
import time
import random
import requests

from sklearn.manifold import TSNE
from sklearn.preprocessing import normalize
import plotly.express as px

try:
    import hdbscan
except ImportError:
    import subprocess
    subprocess.run(["pip", "install", "hdbscan", "-q"])
    import hdbscan

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

# ============================================================
# SESSION STATE
# ============================================================
for k, v in {"df": None, "done": False}.items():
    if k not in st.session_state:
        st.session_state[k] = v

# ============================================================
# HELPERS
# ============================================================
def get_sheet_id(url: str) -> str:
    import re
    match = re.search(r"/d/([a-zA-Z0-9-_]+)", url)
    return match.group(1) if match else None

def get_worksheet_gid(sheet_id: str, worksheet_name: str) -> str:
    """Fetches the sheet metadata to find the gid for a named worksheet."""
    try:
        meta_url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
        resp = requests.get(meta_url, timeout=10)
        import re
        # Find gid associated with the worksheet name
        pattern = rf"{re.escape(worksheet_name)}.*?gid=(\d+)"
        match = re.search(pattern, resp.text)
        if match:
            return match.group(1)
        # Try reverse order
        pattern2 = rf"gid=(\d+).*?{re.escape(worksheet_name)}"
        match2 = re.search(pattern2, resp.text)
        if match2:
            return match2.group(1)
    except Exception:
        pass
    return None

def sheet_url_to_csv(url: str, worksheet_name: str = "") -> str:
    """Converts a Google Sheets URL to a direct CSV export URL."""
    import re
    sheet_id = get_sheet_id(url)
    if not sheet_id:
        return url

    # 1. If URL already has gid, use it
    gid_match = re.search(r"gid=(\d+)", url)
    if gid_match:
        gid = gid_match.group(1)
    # 2. If worksheet name given, look it up
    elif worksheet_name:
        gid = get_worksheet_gid(sheet_id, worksheet_name) or "0"
    else:
        gid = "0"

    return f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={gid}"

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
                return np.zeros(768)
            v    = np.array(resp.json()["embedding"]["values"])
            norm = np.linalg.norm(v)
            time.sleep(0.05)
            return v / norm if norm > 0 else v
        except requests.exceptions.Timeout:
            time.sleep(2 ** attempt)
        except Exception:
            return np.zeros(768)
    return np.zeros(768)

# ============================================================
# UI
# ============================================================
st.title("◈ Company Clustering")
st.caption("Gemini Embeddings · HDBSCAN · t-SNE")
st.divider()

api_key    = st.text_input("Gemini API Key", type="password", placeholder="AIza...")
sheet_url  = st.text_input("Google Sheets URL", placeholder="https://docs.google.com/spreadsheets/d/...")
worksheet_name = st.text_input("Worksheet / Tab Name", value="IMPORT Companies",
    help="Name des Tabs unten im Sheet. Tipp: direkt zum Tab navigieren und dann die URL kopieren – dann wird dieser Schritt übersprungen.")
st.caption("Das Sheet muss öffentlich sein: Freigeben → Jeder mit dem Link → Betrachter")

col1, col2 = st.columns(2)
with col1:
    company_col = st.text_input("Unternehmensspalte", value="name")
with col2:
    desc_col = st.text_input("Beschreibungsspalte", value="Description")

st.divider()
start = st.button("▶  Pipeline starten", type="primary", use_container_width=True)

# ============================================================
# PIPELINE
# ============================================================
if start:
    if not api_key:
        st.error("Gemini API Key fehlt"); st.stop()
    if not sheet_url:
        st.error("Google Sheets URL fehlt"); st.stop()

    st.session_state.done = False
    st.session_state.df   = None

    # Load sheet
    with st.spinner("Lade Daten aus Google Sheets…"):
        try:
            csv_url  = sheet_url_to_csv(sheet_url, worksheet_name)
            df_input = pd.read_csv(csv_url)
            st.success(f"✔ {len(df_input)} Zeilen geladen")
        except Exception as e:
            st.error(f"Sheet konnte nicht geladen werden: {e}")
            st.caption("Stelle sicher dass das Sheet auf 'Jeder mit dem Link' gesetzt ist.")
            st.stop()

    # Filter
    available_dims = [d for d in DIMENSIONS if d in df_input.columns]
    use_desc       = desc_col in df_input.columns and df_input[desc_col].astype(str).str.strip().ne("").any()

    if available_dims:
        mask     = df_input[available_dims].apply(lambda r: any(str(v).strip() for v in r), axis=1)
        df_clean = df_input[mask].reset_index(drop=True)
    else:
        df_clean = df_input.reset_index(drop=True)

    total = len(df_clean)
    st.info(f"{total} Unternehmen werden verarbeitet")

    # Embeddings
    st.subheader("Embeddings")
    prog   = st.progress(0)
    status = st.empty()
    vectors = []
    errors  = 0

    for i in range(total):
        row  = df_clean.iloc[i]
        text = str(row.get(desc_col, "")).strip() if use_desc else ""
        if not text:
            text = " | ".join([str(row.get(d, "")) for d in available_dims])

        vec = get_embedding(text, api_key)
        vectors.append(vec)
        if np.all(vec == 0):
            errors += 1

        prog.progress((i + 1) / total)
        status.caption(f"{i+1}/{total} · {str(row.get(company_col, ''))[:40]} · ✗ {errors} Fehler")

    prog.empty()
    status.empty()
    feature_matrix = normalize(np.array(vectors))
    st.success(f"✔ {total} Embeddings fertig ({errors} Fehler)")

    # Clustering
    with st.spinner("HDBSCAN Clustering…"):
        clusterer = hdbscan.HDBSCAN(min_cluster_size=5, metric="euclidean")
        labels    = clusterer.fit_predict(feature_matrix)

    n_clusters = len([l for l in set(labels) if l >= 0])
    n_outliers = int((labels == -1).sum())
    st.success(f"✔ {n_clusters} Cluster · {n_outliers} Outlier")

    # Name clusters
    cluster_names = {}
    for label in sorted(set(labels)):
        if label == -1:
            cluster_names[label] = "Outliers"; continue
        mask = labels == label
        if "Innovation Cluster" in df_clean.columns:
            top = df_clean.loc[mask, "Innovation Cluster"].value_counts().idxmax()
            cluster_names[label] = top or f"Cluster {label}"
        else:
            cluster_names[label] = f"Cluster {label}"

    df_clean["Cluster"] = [cluster_names[l] for l in labels]

    # t-SNE
    with st.spinner("t-SNE Projektion…"):
        proj = TSNE(n_components=2, perplexity=min(total - 1, 30),
                    random_state=42, n_iter=1000).fit_transform(feature_matrix)
    df_clean["_x"] = proj[:, 0]
    df_clean["_y"] = proj[:, 1]

    st.session_state.df   = df_clean
    st.session_state.done = True

# ============================================================
# RESULTS
# ============================================================
if st.session_state.done and st.session_state.df is not None:
    df = st.session_state.df

    st.divider()
    c1, c2, c3 = st.columns(3)
    c1.metric("Unternehmen", len(df))
    c2.metric("Cluster", df["Cluster"].nunique() - (1 if "Outliers" in df["Cluster"].values else 0))
    c3.metric("Outlier", int((df["Cluster"] == "Outliers").sum()))

    hover_cols = [c for c in [company_col] + DIMENSIONS if c in df.columns]
    fig = px.scatter(
        df, x="_x", y="_y", color="Cluster",
        hover_data=hover_cols,
        color_discrete_sequence=px.colors.qualitative.Bold,
        height=560,
    )
    fig.update_traces(marker=dict(size=9, opacity=0.85))
    fig.update_layout(margin=dict(l=0, r=0, t=20, b=0))
    st.plotly_chart(fig, use_container_width=True)

    show_cols = [c for c in [company_col, "Cluster"] + DIMENSIONS if c in df.columns]
    st.dataframe(df[show_cols], use_container_width=True, hide_index=True)

    st.download_button(
        "⬇  CSV exportieren",
        df[show_cols].to_csv(index=False),
        "cluster_results.csv", "text/csv",
    )
