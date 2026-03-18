import streamlit as st
import pandas as pd
import numpy as np
import time
import random
import requests
import io
import json

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

for k, v in {"df_clean": None, "embedded_2d": None, "feature_matrix": None, "done": False}.items():
    if k not in st.session_state:
        st.session_state[k] = v

# ============================================================
# EMBEDDING
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
# RECLUSTER (skip embeddings + UMAP)
# ============================================================
def build_cluster_profile(df_sel, dimensions):
    """Top 2 values per dimension for a cluster."""
    lines = []
    for dim in dimensions:
        if dim not in df_sel.columns:
            continue
        top = df_sel[dim].str.strip().value_counts().head(2).index.tolist()
        if top:
            lines.append(f"  {dim}: {' / '.join(top)}")
    return "
".join(lines)

def name_all_clusters_with_llm(cluster_profiles: dict, api_key: str) -> dict:
    """
    Send ALL cluster profiles to Gemini in ONE call so it can assign
    distinctive names relative to each other — same abstraction level,
    no duplicates. Returns {label: name}.
    """
    block = ""
    labels_ordered = sorted(cluster_profiles.keys())
    for label in labels_ordered:
        size, profile = cluster_profiles[label]
        block += f"
CLUSTER {label} ({size} companies):
{profile}
"

    prompt = f"""You are a market intelligence analyst naming clusters of companies.

Below are {len(labels_ordered)} clusters with their dominant characteristics.
Assign each cluster a SHORT, DISTINCTIVE name (2-5 words) that:
- Captures what makes THIS cluster unique vs. the others
- Is at the same level of abstraction as all other names
- Reads like a market category (e.g. "Embedded Lending Infrastructure", "SMB Expense Automation")
- Has NO duplicates — every name must be different

{block}

Return ONLY a JSON object mapping cluster number to name, like:
{{"0": "Name Here", "1": "Other Name", ...}}
No explanation, no markdown, just the JSON."""

    try:
        resp = requests.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={api_key}",
            json={"contents": [{"parts": [{"text": prompt}]}]},
            timeout=30,
        )
        if resp.status_code == 200:
            raw = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
            # Strip markdown code fences if present
            raw = re.sub(r"^```json|^```|```$", "", raw.strip(), flags=re.MULTILINE).strip()
            names = json.loads(raw)
            return {int(k): v for k, v in names.items()}
    except Exception as e:
        st.warning(f"Cluster naming failed: {e}")
    return {}

def run_clustering(df_clean, embedded_2d, min_cluster_size, min_samples,
                   cluster_selection_epsilon):
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=min_cluster_size,
        min_samples=min_samples,
        cluster_selection_epsilon=cluster_selection_epsilon,
        cluster_selection_method="leaf",
        metric="euclidean",
    )
    labels     = clusterer.fit_predict(embedded_2d)
    n_clusters = len([l for l in set(labels) if l >= 0])
    n_outliers = int((labels == -1).sum())

    dimensions = [d for d in DIMENSIONS if d in df_clean.columns]

    # Build profiles for all clusters
    cluster_profiles = {}
    for label in sorted(set(labels)):
        if label == -1:
            continue
        mask   = labels == label
        df_sel = df_clean.loc[mask]
        cluster_profiles[label] = (int(mask.sum()), build_cluster_profile(df_sel, dimensions))

    # Assign placeholder numeric names — LLM naming is a separate step
    cluster_names = {-1: "Outliers"}
    for label in sorted(set(labels)):
        if label == -1:
            continue
        cluster_names[label] = f"Cluster {label}"

    df_clean = df_clean.copy()
    df_clean["Cluster"] = [cluster_names[l] for l in labels]
    df_clean["_x"]      = embedded_2d[:, 0]
    df_clean["_y"]      = embedded_2d[:, 1]
    return df_clean, n_clusters, n_outliers

# ============================================================
# UI
# ============================================================
st.title("◈ Company Clustering")
st.caption("Gemini Embeddings · HDBSCAN · UMAP")
st.divider()

api_key  = st.text_input("Gemini API Key", type="password", placeholder="AIza...")
uploaded = st.file_uploader("CSV oder Excel hochladen", type=["csv", "xlsx", "xls"])

df_input    = None
company_col = "name"
desc_col    = None

if uploaded:
    try:
        if uploaded.name.endswith(".csv"):
            df_input = pd.read_csv(uploaded)
        else:
            df_input = pd.read_excel(uploaded)
        st.success(f"✔ {len(df_input)} Zeilen · {len(df_input.columns)} Spalten geladen")

        col1, col2 = st.columns(2)
        with col1:
            company_col = st.selectbox(
                "Unternehmensspalte", df_input.columns.tolist(),
                index=df_input.columns.tolist().index("name") if "name" in df_input.columns else 0
            )
        with col2:
            desc_options = ["(keine – Dimensionen verwenden)"] + df_input.columns.tolist()
            desc_default = desc_options.index("Description") if "Description" in desc_options else 0
            desc_sel     = st.selectbox("Beschreibungsspalte (optional)", desc_options, index=desc_default)
            desc_col     = None if desc_sel.startswith("(keine") else desc_sel

        with st.expander("Vorschau"):
            st.dataframe(df_input.head(5), width='stretch', hide_index=True)

    except Exception as e:
        st.error(f"Datei konnte nicht geladen werden: {e}")

# Embeddings upload (skip re-embedding)
with st.expander("⚡ Gespeicherte Embeddings laden (optional – überspringt Embedding-Schritt)"):
    embeddings_file = st.file_uploader("Embeddings .npz hochladen", type=["npz"], key="emb_upload")
    if embeddings_file:
        try:
            npz = np.load(io.BytesIO(embeddings_file.read()))
            st.session_state.embedded_2d   = npz["embedded_2d"]
            st.session_state.feature_matrix = npz["feature_matrix"]
            st.session_state.done = False  # reset results but keep embeddings
            st.success(f"✔ Embeddings geladen – {st.session_state.embedded_2d.shape[0]} Unternehmen. Jetzt 'Nur neu clustern' klicken.")
        except Exception as e:
            st.error(f"Fehler beim Laden: {e}")

st.divider()
st.subheader("Clustering Parameter")

col1, col2, col3 = st.columns(3)
with col1:
    min_cluster_size = st.slider(
        "Min. Cluster Größe", 2, 30, 5,
        help="Wie viele Unternehmen mindestens in einem Cluster sein müssen. Kleiner = mehr Cluster."
    )
with col2:
    min_samples = st.slider(
        "Min. Samples", 1, 20, 3,
        help="Wie dicht ein Punkt sein muss um als Core-Point zu gelten. Kleiner = mehr Cluster, mehr Outlier."
    )
with col3:
    cluster_epsilon = st.slider(
        "Cluster Epsilon", 0.0, 2.0, 0.0, step=0.1,
        help="Zusammenführen von Clustern die näher als Epsilon sind. 0 = aus."
    )

st.divider()
col_a, col_b = st.columns([3, 1])
with col_a:
    start = st.button(
        "▶  Embeddings + Clustering starten", type="primary", width='stretch',
        disabled=(df_input is None or not api_key)
    )
with col_b:
    recluster = st.button(
        "↺  Nur neu clustern", width='stretch',
        disabled=(st.session_state.embedded_2d is None),
        help="Überspringt Embeddings und UMAP – nur Clustering mit neuen Parametern."
    )

# ============================================================
# PIPELINE
# ============================================================
if start and df_input is not None:
    st.session_state.done = False
    st.session_state.df   = None

    available_dims = [d for d in DIMENSIONS if d in df_input.columns]
    use_desc       = (desc_col and desc_col in df_input.columns and
                      df_input[desc_col].astype(str).str.strip().ne("").any())

    if available_dims:
        mask     = df_input[available_dims].apply(lambda r: any(str(v).strip() for v in r), axis=1)
        df_clean = df_input[mask].reset_index(drop=True)
    else:
        df_clean = df_input.reset_index(drop=True)

    total = len(df_clean)
    st.info(f"{total} Unternehmen werden verarbeitet")

    # --- EMBEDDINGS ---
    st.subheader("1 · Embeddings")
    prog    = st.progress(0)
    status  = st.empty()
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
    st.success(f"✔ {total} Embeddings ({errors} Fehler)")

    # --- UMAP: einmal 768D → 2D (für Clustering + Visualisierung) ---
    st.subheader("2 · UMAP Dimensionsreduktion")
    with st.spinner("UMAP 768D → 2D…"):
        reducer = umap.UMAP(
            n_components=2,
            n_neighbors=15,
            min_dist=0.05,
            metric="cosine",
            random_state=42,
        )
        embedded_2d = reducer.fit_transform(feature_matrix)

    st.success("✔ UMAP fertig")

    # --- HDBSCAN direkt auf 2D ---
    st.subheader("3 · HDBSCAN Clustering")
    with st.spinner("Clustering…"):
        clusterer = hdbscan.HDBSCAN(
            min_cluster_size=min_cluster_size,
            min_samples=min_samples,
            cluster_selection_epsilon=cluster_epsilon,
            cluster_selection_method="leaf",
            metric="euclidean",
        )
        labels = clusterer.fit_predict(embedded_2d)

    n_clusters = len([l for l in set(labels) if l >= 0])
    n_outliers = int((labels == -1).sum())
    st.success(f"✔ {n_clusters} Cluster · {n_outliers} Outlier ({n_outliers/total*100:.0f}%)")

    if n_clusters == 0:
        st.warning("Keine Cluster gefunden – Min. Cluster Größe oder Min. Samples reduzieren.")

    df_clean, n_clusters, n_outliers = run_clustering(
        df_clean, embedded_2d, min_cluster_size, min_samples, cluster_epsilon
    )
    st.success(f"✔ {n_clusters} Cluster · {n_outliers} Outlier ({n_outliers/total*100:.0f}%)")

    st.session_state.df_clean       = df_clean
    st.session_state.embedded_2d    = embedded_2d
    st.session_state.feature_matrix = feature_matrix
    st.session_state.done           = True


if recluster and st.session_state.embedded_2d is not None:
    with st.spinner("Neu clustern…"):
        df_result, n_c, n_o = run_clustering(
            st.session_state.df_clean,
            st.session_state.embedded_2d,
            min_cluster_size, min_samples, cluster_epsilon
        )
    st.session_state.df_clean = df_result
    st.success(f"✔ {n_c} Cluster · {n_o} Outlier")

# ============================================================
# CLUSTER NAMING (separate step)
# ============================================================
if name_btn and st.session_state.df_clean is not None:
    if not api_key:
        st.error("Gemini API Key fehlt")
    else:
        df_to_name = st.session_state.df_clean
        dimensions = [d for d in DIMENSIONS if d in df_to_name.columns]

        # Build profiles
        labels_arr = df_to_name["Cluster"].values
        unique_clusters = [c for c in df_to_name["Cluster"].unique() if c != "Outliers"]
        cluster_profiles = {}
        for i, cname in enumerate(unique_clusters):
            mask   = df_to_name["Cluster"] == cname
            df_sel = df_to_name.loc[mask]
            cluster_profiles[i] = (int(mask.sum()), build_cluster_profile(df_sel, dimensions))

        with st.spinner(f"Benenne {len(cluster_profiles)} Cluster mit einem Gemini-Call…"):
            llm_names = name_all_clusters_with_llm(cluster_profiles, api_key)

        if llm_names:
            # Map old placeholder names to new LLM names
            name_map = {cname: llm_names.get(i, cname) for i, cname in enumerate(unique_clusters)}
            name_map["Outliers"] = "Outliers"
            df_to_name = df_to_name.copy()
            df_to_name["Cluster"] = df_to_name["Cluster"].map(name_map)
            st.session_state.df_clean = df_to_name
            st.success(f"✔ {len(llm_names)} Cluster benannt")
        else:
            st.warning("Naming fehlgeschlagen – Cluster behalten numerische Namen")

# ============================================================
# RESULTS
# ============================================================
if st.session_state.done and st.session_state.df_clean is not None:
    df = st.session_state.df_clean

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
        height=650,
    )
    fig.update_traces(marker=dict(size=7, opacity=0.80))
    fig.update_layout(
        margin=dict(l=0, r=0, t=20, b=0),
        xaxis=dict(title="", showticklabels=False, showgrid=False, zeroline=False),
        yaxis=dict(title="", showticklabels=False, showgrid=False, zeroline=False),
        legend=dict(title="Cluster", itemsizing="constant"),
        dragmode="lasso",   # lasso selection by default
    )
    fig.update_layout(newshape=dict(line_color="#00ff9d"))
    st.plotly_chart(fig, width='stretch')
    st.caption("Tipp: Lasso-Tool (oben rechts im Chart) zum Auswählen von Gruppen verwenden.")

    show_cols = [c for c in [company_col, "Cluster"] + DIMENSIONS if c in df.columns]
    st.dataframe(df[show_cols], width='stretch', hide_index=True)

    col_dl1, col_dl2 = st.columns(2)
    with col_dl1:
        st.download_button(
            "⬇  Ergebnisse als CSV",
            df[show_cols].to_csv(index=False),
            "cluster_results.csv", "text/csv",
            width="stretch",
        )
    with col_dl2:
        if st.session_state.embedded_2d is not None and st.session_state.feature_matrix is not None:
            buf = io.BytesIO()
            np.savez_compressed(
                buf,
                embedded_2d=st.session_state.embedded_2d,
                feature_matrix=st.session_state.feature_matrix,
            )
            buf.seek(0)
            st.download_button(
                "⬇  Embeddings speichern (.npz)",
                buf,
                "embeddings.npz", "application/octet-stream",
                width="stretch",
                help="Lade diese Datei beim nächsten Mal hoch um den Embedding-Schritt zu überspringen.",
            )
