import streamlit as st
import pandas as pd
import numpy as np
import time
import random
import requests
import json
import io

import gspread
from google.oauth2.service_account import Credentials

from sklearn.manifold import TSNE
from sklearn.preprocessing import normalize
import plotly.express as px
import plotly.graph_objects as go

try:
    import hdbscan
except ImportError:
    import subprocess
    subprocess.run(["pip", "install", "hdbscan", "-q"])
    import hdbscan

# ============================================================
# PAGE CONFIG
# ============================================================
st.set_page_config(
    page_title="Company Cluster Intelligence",
    page_icon="◈",
    layout="wide",
    initial_sidebar_state="expanded"
)

# ============================================================
# STYLING
# ============================================================
st.markdown("""
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@400;600;700;800&display=swap');

html, body, [class*="css"] {
    font-family: 'DM Mono', monospace;
}

h1, h2, h3 { font-family: 'Syne', sans-serif !important; }

.stApp { background: #0a0a0f; }

section[data-testid="stSidebar"] {
    background: #0f0f18 !important;
    border-right: 1px solid #1e1e2e !important;
}

.block-container { padding: 2rem 2.5rem 4rem; }

/* Header */
.app-header {
    display: flex;
    align-items: baseline;
    gap: 14px;
    margin-bottom: 2rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid #1e1e2e;
}
.app-title {
    font-family: 'Syne', sans-serif;
    font-size: 2rem;
    font-weight: 800;
    color: #e8e8f0;
    letter-spacing: -0.03em;
    margin: 0;
}
.app-badge {
    background: #00ff9d18;
    border: 1px solid #00ff9d44;
    color: #00ff9d;
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem;
    padding: 3px 10px;
    border-radius: 2px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
}

/* Metric cards */
.metric-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin: 1.5rem 0;
}
.metric-card {
    background: #0f0f18;
    border: 1px solid #1e1e2e;
    border-radius: 4px;
    padding: 1.2rem 1.4rem;
}
.metric-label {
    font-size: 0.65rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #555570;
    margin-bottom: 6px;
}
.metric-value {
    font-family: 'Syne', sans-serif;
    font-size: 1.8rem;
    font-weight: 700;
    color: #e8e8f0;
    line-height: 1;
}
.metric-value.accent { color: #00ff9d; }

/* Status log */
.log-box {
    background: #0a0a0f;
    border: 1px solid #1e1e2e;
    border-radius: 4px;
    padding: 1rem 1.2rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.75rem;
    color: #8888aa;
    max-height: 220px;
    overflow-y: auto;
}
.log-ok   { color: #00ff9d; }
.log-warn { color: #ffcc44; }
.log-err  { color: #ff4466; }
.log-info { color: #6688ff; }

/* Step indicator */
.steps {
    display: flex;
    gap: 0;
    margin-bottom: 2rem;
    border: 1px solid #1e1e2e;
    border-radius: 4px;
    overflow: hidden;
}
.step {
    flex: 1;
    padding: 0.6rem 0.8rem;
    font-size: 0.65rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    text-align: center;
    color: #333350;
    background: #0a0a0f;
    border-right: 1px solid #1e1e2e;
}
.step:last-child { border-right: none; }
.step.active { color: #00ff9d; background: #00ff9d0a; }
.step.done   { color: #6688ff; background: #6688ff08; }

/* Buttons */
.stButton > button {
    font-family: 'DM Mono', monospace !important;
    font-size: 0.75rem !important;
    letter-spacing: 0.08em !important;
    text-transform: uppercase !important;
    border-radius: 3px !important;
    border: 1px solid #00ff9d44 !important;
    color: #00ff9d !important;
    background: transparent !important;
    padding: 0.5rem 1.4rem !important;
    transition: all 0.15s !important;
}
.stButton > button:hover {
    background: #00ff9d12 !important;
    border-color: #00ff9d !important;
}

/* Sidebar labels */
.sidebar-section {
    font-size: 0.62rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #555570;
    margin: 1.4rem 0 0.5rem;
    padding-bottom: 0.3rem;
    border-bottom: 1px solid #1e1e2e;
}


/* API Key card */
.key-card {
    background: #0f0f18;
    border: 1px solid #1e1e2e;
    border-radius: 6px;
    padding: 2.5rem 2.8rem;
    max-width: 520px;
    margin: 3rem auto;
}
.key-card-title {
    font-family: "Syne", sans-serif;
    font-size: 1.2rem;
    font-weight: 700;
    color: #e8e8f0;
    margin-bottom: 0.4rem;
}
.key-card-sub {
    font-size: 0.72rem;
    color: #555570;
    margin-bottom: 1.6rem;
    line-height: 1.6;
}
.key-link {
    color: #6688ff;
    text-decoration: none;
}
.key-status-ok {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: #00ff9d10;
    border: 1px solid #00ff9d33;
    color: #00ff9d;
    font-size: 0.68rem;
    padding: 4px 12px;
    border-radius: 2px;
    letter-spacing: 0.08em;
    margin-top: 0.8rem;
}

/* Cluster chip */
.cluster-chip {
    display: inline-block;
    background: #6688ff18;
    border: 1px solid #6688ff33;
    color: #6688ff;
    font-size: 0.65rem;
    padding: 2px 8px;
    border-radius: 2px;
    margin: 2px;
    font-family: 'DM Mono', monospace;
}

[data-testid="stMetricValue"] { font-family: 'Syne', sans-serif !important; }
</style>
""", unsafe_allow_html=True)

# ============================================================
# CONSTANTS
# ============================================================
DIMENSIONS = [
    "Problem Solved",
    "Target Beneficiary",
    "The How",
    "Innovation Cluster",
    "Value Shift",
    "Ecosystem Role",
    "Scalability Lever",
]

EMBED_MODEL = "gemini-embedding-001"
EMBED_URL   = f"https://generativelanguage.googleapis.com/v1beta/models/{EMBED_MODEL}:embedContent"

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

# ============================================================
# SESSION STATE
# ============================================================
for key, default in {
    "df": None,
    "feature_matrix": None,
    "labels": None,
    "cluster_names": None,
    "pipeline_done": False,
    "log": [],
    "api_key": "",
}.items():
    if key not in st.session_state:
        st.session_state[key] = default

# Pre-fill from secrets if available
if not st.session_state.api_key:
    try:
        st.session_state.api_key = st.secrets.get("GEMINI_API_KEY", "")
    except Exception:
        pass

# ============================================================
# HELPERS
# ============================================================
def log(msg: str, level: str = "info"):
    ts  = time.strftime("%H:%M:%S")
    icons = {"ok": "✔", "warn": "⚠", "err": "✗", "info": "·"}
    st.session_state.log.append((ts, level, f"{icons.get(level,'·')} {msg}"))

def get_gspread_client():
    try:
        creds_dict = dict(st.secrets["gcp_service_account"])
        creds = Credentials.from_service_account_info(creds_dict, scopes=SCOPES)
        return gspread.authorize(creds)
    except Exception as e:
        st.error(f"Google Sheets Auth Fehler: {e}")
        return None

def get_embedding(text: str, api_key: str) -> np.ndarray:
    text = str(text).strip()
    if len(text) < 3:
        return np.zeros(768)
    payload = {
        "model": f"models/{EMBED_MODEL}",
        "content": {"parts": [{"text": text[:8000]}]},  # max context
        "taskType": "CLUSTERING",
        "outputDimensionality": 768,
    }
    for attempt in range(5):
        try:
            resp = requests.post(
                f"{EMBED_URL}?key={api_key}",
                json=payload,
                timeout=30
            )
            if resp.status_code == 429:
                wait = (2 ** attempt) + random.uniform(0, 1)
                time.sleep(wait)
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

def run_pipeline(df: pd.DataFrame, api_key: str, company_col: str,
                 desc_col: str, use_desc: bool,
                 min_cluster_size: int, n_components: int):

    total = len(df)
    log(f"Pipeline gestartet – {total} Unternehmen", "info")

    # --- EMBEDDINGS ---
    log(f"Starte Embeddings ({EMBED_MODEL})", "info")
    all_vectors = []
    errors      = 0
    prog        = st.progress(0, text="Vektorisierung läuft…")

    for i in range(total):
        row = df.iloc[i]
        if use_desc and desc_col and str(row.get(desc_col, "")).strip():
            text = str(row[desc_col])
        else:
            text = " | ".join([str(row.get(d, "")) for d in DIMENSIONS if d in df.columns])

        vec = get_embedding(text, api_key)
        all_vectors.append(vec)
        if np.all(vec == 0):
            errors += 1

        pct = (i + 1) / total
        prog.progress(pct, text=f"Embedding {i+1}/{total} — {str(row.get(company_col,''))[:30]}")

    prog.empty()
    feature_matrix = normalize(np.array(all_vectors))
    log(f"Embeddings fertig – {errors} Fehler", "ok" if errors == 0 else "warn")

    # --- CLUSTERING ---
    log(f"HDBSCAN Clustering (min_cluster_size={min_cluster_size})", "info")
    clusterer = hdbscan.HDBSCAN(min_cluster_size=min_cluster_size, metric="euclidean")
    labels    = clusterer.fit_predict(feature_matrix)

    unique_labels = sorted(set(labels))
    n_clusters    = len([l for l in unique_labels if l >= 0])
    n_outliers    = int((labels == -1).sum())
    log(f"{n_clusters} Cluster, {n_outliers} Outlier ({n_outliers/total*100:.1f}%)", "ok")

    # --- CLUSTER NAMING ---
    cluster_names = {}
    for label in unique_labels:
        if label == -1:
            cluster_names[label] = "Outliers"
            continue
        mask = labels == label
        if "Innovation Cluster" in df.columns:
            top = df.loc[mask, "Innovation Cluster"].value_counts().idxmax()
            cluster_names[label] = top if top else f"Cluster {label}"
        else:
            cluster_names[label] = f"Cluster {label}"

    df["Cluster"]       = [cluster_names[l] for l in labels]
    df["Cluster_ID"]    = labels

    # --- t-SNE ---
    log(f"t-SNE Projektion (perplexity={min(total-1,30)})", "info")
    perplexity = min(total - 1, 30)
    tsne       = TSNE(n_components=2, perplexity=perplexity, random_state=42, n_iter=1000)
    proj       = tsne.fit_transform(feature_matrix)
    df["_x"]   = proj[:, 0]
    df["_y"]   = proj[:, 1]
    log("Pipeline abgeschlossen", "ok")

    return df, feature_matrix, labels, cluster_names

# ============================================================
# SIDEBAR
# ============================================================
with st.sidebar:
    st.markdown('<p class="sidebar-section">API Keys</p>', unsafe_allow_html=True)
    sidebar_key = st.text_input("Gemini API Key", type="password",
                             value=st.session_state.api_key,
                             help="Wird nur für diese Session gespeichert",
                             key="sidebar_api_key")
    if sidebar_key:
        st.session_state.api_key = sidebar_key
    api_key = st.session_state.api_key

    st.markdown('<p class="sidebar-section">Datenquelle</p>', unsafe_allow_html=True)
    source = st.radio("", ["Google Sheets", "CSV Upload"], label_visibility="collapsed")

    if source == "Google Sheets":
        sheet_name = st.text_input("Sheet Name", value="Copy of COMPANIES")
        ws_name    = st.text_input("Worksheet", value="IMPORT Companies")
        writeback  = st.toggle("Ergebnisse zurückschreiben", value=True)
    else:
        uploaded = st.file_uploader("CSV hochladen", type=["csv"])

    st.markdown('<p class="sidebar-section">Spalten</p>', unsafe_allow_html=True)
    company_col = st.text_input("Unternehmensspalte", value="name")
    desc_col    = st.text_input("Beschreibungsspalte (optional)", value="Description",
                                 help="Wenn befüllt, wird die volle Beschreibung eingebettet")
    use_desc    = st.toggle("Beschreibung statt Dimensionen einbetten",
                             value=True,
                             help="Empfohlen – mehr Kontext = bessere Embeddings")

    st.markdown('<p class="sidebar-section">Clustering</p>', unsafe_allow_html=True)
    min_cluster_size = st.slider("Min. Cluster Größe", 2, 20, 5)

    st.markdown("---")
    run_btn = st.button("◈  Pipeline starten", use_container_width=True)

# ============================================================
# HEADER
# ============================================================
st.markdown("""
<div class="app-header">
  <span class="app-title">Company Cluster Intelligence</span>
  <span class="app-badge">gemini-embedding-001</span>
</div>
""", unsafe_allow_html=True)

# ============================================================
# STEP INDICATOR
# ============================================================
def step_indicator(active: int):
    steps = ["01 Daten", "02 Embeddings", "03 Clustering", "04 Visualisierung"]
    html  = '<div class="steps">'
    for i, s in enumerate(steps):
        cls = "done" if i < active else ("active" if i == active else "")
        html += f'<div class="step {cls}">{s}</div>'
    html += "</div>"
    st.markdown(html, unsafe_allow_html=True)

step_indicator(0 if not st.session_state.pipeline_done else 4)

# ============================================================
# API KEY ONBOARDING CARD
# ============================================================
if not st.session_state.api_key:
    st.markdown("""
    <div class="key-card">
      <div class="key-card-title">◈ Gemini API Key eingeben</div>
      <div class="key-card-sub">
        Um Embeddings zu generieren wird ein Gemini API Key benötigt.<br>
        Kostenlos erhältlich unter 
        <a class="key-link" href="https://aistudio.google.com/apikey" target="_blank">
          aistudio.google.com/apikey
        </a>
      </div>
    </div>
    """, unsafe_allow_html=True)

    col1, col2, col3 = st.columns([1, 2, 1])
    with col2:
        inline_key = st.text_input(
            "API Key",
            type="password",
            placeholder="AIza...",
            label_visibility="collapsed",
            key="inline_api_key"
        )
        if st.button("Key bestätigen →", use_container_width=True):
            if inline_key.startswith("AIza") and len(inline_key) > 20:
                st.session_state.api_key = inline_key
                st.rerun()
            else:
                st.error("Ungültiger Key – Gemini Keys beginnen mit 'AIza'.")
    st.stop()

elif not st.session_state.pipeline_done:
    st.markdown("""
    <div style="display:inline-flex;align-items:center;gap:6px;
         background:#00ff9d10;border:1px solid #00ff9d33;color:#00ff9d;
         font-size:0.68rem;padding:4px 12px;border-radius:2px;
         letter-spacing:0.08em;margin-bottom:1rem;">
      ✔ API KEY GESETZT
    </div>""", unsafe_allow_html=True)

# ============================================================
# DATA LOADING
# ============================================================
df_loaded = None

if source == "Google Sheets" and not run_btn and st.session_state.df is None:
    st.info("← Google Sheets konfigurieren und Pipeline starten")

elif source == "CSV Upload":
    if uploaded:
        df_loaded = pd.read_csv(uploaded)
        st.success(f"✔ {len(df_loaded)} Zeilen aus CSV geladen")
    elif not st.session_state.pipeline_done:
        st.info("← CSV hochladen und Pipeline starten")

# ============================================================
# RUN PIPELINE
# ============================================================
if run_btn:
    st.session_state.log = []
    st.session_state.pipeline_done = False

    if not api_key:
        st.error("Gemini API Key fehlt")
        st.stop()

    # Load data
    with st.spinner("Lade Daten…"):
        if source == "Google Sheets":
            gc = get_gspread_client()
            if gc:
                try:
                    ws     = gc.open(sheet_name).worksheet(ws_name)
                    data   = ws.get_all_values()
                    df_raw = pd.DataFrame(data[1:], columns=data[0])
                    log(f"{len(df_raw)} Zeilen aus Sheets geladen", "ok")
                    df_loaded = df_raw
                except Exception as e:
                    log(f"Sheets Fehler: {e}", "err")
                    st.error(str(e))
                    st.stop()
        elif uploaded:
            df_loaded = pd.read_csv(uploaded)
            log(f"{len(df_loaded)} Zeilen aus CSV geladen", "ok")
        else:
            st.error("Keine Datenquelle konfiguriert")
            st.stop()

    # Filter rows that have at least some dimension data
    available_dims = [d for d in DIMENSIONS if d in df_loaded.columns]
    if available_dims:
        mask = df_loaded[available_dims].apply(
            lambda row: any(str(v).strip() != "" for v in row), axis=1
        )
        df_loaded = df_loaded[mask].reset_index(drop=True)
    log(f"{len(df_loaded)} Unternehmen nach Filter", "ok")

    # Run
    step_indicator(1)
    result_df, feat_mat, lbls, cnames = run_pipeline(
        df_loaded.copy(), api_key, company_col, desc_col,
        use_desc, min_cluster_size, 2
    )

    st.session_state.df             = result_df
    st.session_state.feature_matrix = feat_mat
    st.session_state.labels         = lbls
    st.session_state.cluster_names  = cnames
    st.session_state.pipeline_done  = True

    # Write back to Sheets
    if source == "Google Sheets" and writeback:
        try:
            log("Schreibe Ergebnisse zurück in Sheets…", "info")
            gc      = get_gspread_client()
            ws      = gc.open(sheet_name).worksheet(ws_name)
            headers = ws.row_values(1)

            # Find or create Cluster column
            if "Cluster" not in headers:
                headers.append("Cluster")
                ws.update("A1", [headers])

            cluster_col_idx = headers.index("Cluster") + 1
            col_letter      = gspread.utils.rowcol_to_a1(1, cluster_col_idx)[:-1]

            cluster_values = [[c] for c in result_df["Cluster"].tolist()]
            ws.update(f"{col_letter}2", cluster_values)
            log(f"Cluster-Spalte in '{col_letter}' geschrieben", "ok")
        except Exception as e:
            log(f"Writeback Fehler: {e}", "warn")

    st.rerun()

# ============================================================
# RESULTS
# ============================================================
if st.session_state.pipeline_done and st.session_state.df is not None:
    df     = st.session_state.df
    labels = st.session_state.labels
    cnames = st.session_state.cluster_names

    total      = len(df)
    n_clusters = len([l for l in set(labels) if l >= 0])
    n_outliers = int((np.array(labels) == -1).sum())

    step_indicator(4)

    # Metrics
    st.markdown(f"""
    <div class="metric-row">
      <div class="metric-card">
        <div class="metric-label">Unternehmen</div>
        <div class="metric-value">{total}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Cluster</div>
        <div class="metric-value accent">{n_clusters}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Outlier</div>
        <div class="metric-value">{n_outliers}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Ø Cluster Größe</div>
        <div class="metric-value">{(total - n_outliers) // max(n_clusters, 1)}</div>
      </div>
    </div>
    """, unsafe_allow_html=True)

    # Scatter plot
    hover_cols = [c for c in [company_col] + DIMENSIONS if c in df.columns]

    fig = px.scatter(
        df, x="_x", y="_y",
        color="Cluster",
        hover_data=hover_cols,
        color_discrete_sequence=px.colors.qualitative.Bold,
    )
    fig.update_traces(marker=dict(size=9, opacity=0.85, line=dict(width=0.5, color="#0a0a0f")))
    fig.update_layout(
        paper_bgcolor="#0a0a0f",
        plot_bgcolor="#0a0a0f",
        font=dict(family="DM Mono, monospace", color="#8888aa", size=11),
        legend=dict(
            bgcolor="#0f0f18",
            bordercolor="#1e1e2e",
            borderwidth=1,
            font=dict(size=10),
        ),
        margin=dict(l=0, r=0, t=20, b=0),
        xaxis=dict(showgrid=True, gridcolor="#1e1e2e", zeroline=False, showticklabels=False),
        yaxis=dict(showgrid=True, gridcolor="#1e1e2e", zeroline=False, showticklabels=False),
        height=560,
    )
    st.plotly_chart(fig, use_container_width=True)

    # Tabs: table + log + download
    tab1, tab2, tab3 = st.tabs(["Tabelle", "Pipeline Log", "Export"])

    with tab1:
        show_cols = [c for c in [company_col, "Cluster"] + DIMENSIONS if c in df.columns]
        st.dataframe(
            df[show_cols],
            use_container_width=True,
            height=380,
            hide_index=True,
        )

    with tab2:
        log_html = '<div class="log-box">'
        for ts, level, msg in st.session_state.log:
            log_html += f'<div class="log-{level}">[{ts}] {msg}</div>'
        log_html += "</div>"
        st.markdown(log_html, unsafe_allow_html=True)

    with tab3:
        st.markdown("#### CSV Export")
        csv_data = df[[c for c in [company_col, "Cluster"] + DIMENSIONS if c in df.columns]].to_csv(index=False)
        st.download_button(
            label="⬇  Ergebnisse als CSV",
            data=csv_data,
            file_name="cluster_results.csv",
            mime="text/csv",
        )

# ============================================================
# LOG (während Pipeline läuft)
# ============================================================
elif st.session_state.log:
    log_html = '<div class="log-box">'
    for ts, level, msg in st.session_state.log:
        log_html += f'<div class="log-{level}">[{ts}] {msg}</div>'
    log_html += "</div>"
    st.markdown(log_html, unsafe_allow_html=True)
