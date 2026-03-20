"""Setup page — API key, data upload, optional embeddings upload, dimension extraction."""

import io

import numpy as np
import pandas as pd
import streamlit as st

from dimension_extraction import (
    EXTRACTED_DIMENSIONS,
    _BATCH_SIZE as _DIM_BATCH_SIZE,
    extract_dimensions,
)

# ── Read shared state ─────────────────────────────────────────────────────────
api_key = st.session_state.get("api_key", "")

st.title("⚙️ Setup")
st.caption("Connect your API key, upload your data, and prepare dimensions.")

st.divider()

# ── Step 1: API Key ───────────────────────────────────────────────────────────
st.subheader("1 · API Key")

# Prevent Chrome from suggesting to save this as a login credential.
# The hidden username field before the password input confuses Chrome's heuristic.
st.markdown(
    '<input type="text" style="display:none" autocomplete="username">',
    unsafe_allow_html=True,
)
st.text_input(
    "Gemini API Key",
    type="password",
    placeholder="AIza…",
    key="api_key",
    help="Get your key from Google AI Studio (aistudio.google.com). Required for embeddings, naming, and chat.",
)
api_key = st.session_state.get("api_key", "")

if api_key:
    st.success("✔ API key set.")
else:
    st.info("Enter your Gemini API key above to continue.")

st.divider()

# ── Step 2: Data Upload ───────────────────────────────────────────────────────
st.subheader("2 · Data")

uploaded = st.file_uploader("CSV or Excel file", type=["csv", "xlsx", "xls"])

df_input    = None
company_col = st.session_state.get("company_col", "name")
desc_col    = st.session_state.get("desc_col", None)

if uploaded:
    try:
        df_input = (
            pd.read_csv(uploaded) if uploaded.name.endswith(".csv")
            else pd.read_excel(uploaded)
        )
        st.success(f"✔ {len(df_input)} rows · {len(df_input.columns)} columns loaded")

        col1, col2, col_prev = st.columns([2, 2, 1])
        with col1:
            idx = df_input.columns.tolist().index("name") if "name" in df_input.columns else 0
            company_col = st.selectbox("Company column", df_input.columns.tolist(), index=idx)
            st.session_state["company_col"] = company_col
        with col2:
            desc_options = ["(none — use dimensions)"] + df_input.columns.tolist()
            desc_default = (
                desc_options.index("Description") if "Description" in desc_options else 0
            )
            desc_sel = st.selectbox("Description column (optional)", desc_options, index=desc_default)
            desc_col = None if desc_sel.startswith("(none") else desc_sel
            st.session_state["desc_col"] = desc_col
        with col_prev:
            st.write("")
            st.write("")
            if st.button("👁 Preview", use_container_width=True):
                st.session_state["_show_preview"] = True

        @st.dialog("Data preview")
        def _preview_dialog():
            st.dataframe(df_input.head(10), use_container_width=True, hide_index=True)
            if st.button("Close"):
                st.rerun()

        if st.session_state.pop("_show_preview", False):
            _preview_dialog()

        # ── Dimension extraction ──────────────────────────────────────────────
        st.divider()
        st.subheader("3 · Dimensions")

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
                    f"✔ Dimensions extracted — {len(EXTRACTED_DIMENSIONS)} columns ready."
                )
            with col_regen:
                if st.button("↺ Regenerate", key="regen_dims"):
                    st.session_state["df_enriched"] = None
                    st.rerun()
            with col_dl:
                st.download_button(
                    "⬇ Download",
                    data=df_input.to_csv(index=False).encode(),
                    file_name="companies_with_dimensions.csv",
                    mime="text/csv",
                    key="dl_enriched",
                )

        elif _dims_in_csv:
            st.success(
                f"✔ All {len(EXTRACTED_DIMENSIONS)} dimension columns found in file — "
                "no extraction needed."
            )

        elif desc_col:
            st.caption(
                f"Uses Gemini to extract **{len(EXTRACTED_DIMENSIONS)} dimensions** from each "
                f"company description (~{max(1, len(df_input) // _DIM_BATCH_SIZE)} API calls for "
                f"{len(df_input)} companies). Save the enriched CSV afterwards to skip this next time."
            )
            dim_pills = "  ·  ".join(f"`{d}`" for d in EXTRACTED_DIMENSIONS)
            st.markdown(dim_pills)
            if st.button(
                "⚡ Generate dimensions",
                key="gen_dims",
                type="primary",
                disabled=not bool(api_key),
            ):
                enriched = extract_dimensions(df_input, company_col, desc_col, api_key)
                st.session_state["df_enriched"] = enriched
                st.session_state["df_enriched_src"] = uploaded.name
                st.rerun()
        else:
            st.info("Select a description column above to enable dimension extraction.")

        # Apply enriched df if ready
        if (
            st.session_state["df_enriched"] is not None
            and st.session_state["df_enriched_src"] == uploaded.name
        ):
            df_input = st.session_state["df_enriched"]

    except Exception as e:
        st.error(f"Could not load file: {e}")

st.divider()

# ── Step 3: Embeddings upload (optional) ──────────────────────────────────────
st.subheader("4 · Embeddings (optional)")
st.caption(
    "If you ran embeddings before, upload the saved `.npz` file to skip re-embedding. "
    "You can still re-embed on the next page if you want."
)

emb_file = st.file_uploader("Upload embeddings.npz", type=["npz"], key="emb_upload")
if emb_file:
    try:
        npz = np.load(io.BytesIO(emb_file.read()))
        st.session_state["feature_matrix"] = npz["feature_matrix"]
        st.session_state["embedded_2d"]    = npz["embedded_2d"]
        st.session_state["npz_preloaded"]  = True
        # Restore dataframe if bundled in npz and not already loaded
        if st.session_state["df_clean"] is None:
            if df_input is not None:
                st.session_state["df_clean"] = df_input.copy()
            elif "df_json" in npz:
                st.session_state["df_clean"] = pd.read_json(
                    io.StringIO(npz["df_json"].tobytes().decode())
                )
        st.success(
            f"✔ Embeddings loaded — {st.session_state['feature_matrix'].shape[0]} companies, "
            f"dim {st.session_state['feature_matrix'].shape[1]}."
        )
    except Exception as e:
        st.error(f"Error loading embeddings: {e}")

st.divider()

# ── CTA ───────────────────────────────────────────────────────────────────────
has_data = df_input is not None or st.session_state.get("feature_matrix") is not None

if df_input is not None:
    # Persist df_clean with current column selections so Page 2 can use it
    _existing = st.session_state.get("df_clean")
    # Re-save whenever the source file changes or df_clean is None
    if _existing is None or (
        hasattr(_existing, "__len__") and len(_existing) != len(df_input)
    ):
        st.session_state["df_clean"] = df_input.copy()

if has_data:
    if st.button("Next: Embed & Cluster →", type="primary", use_container_width=False):
        st.switch_page("pages/embed_cluster.py")
else:
    st.button("Next: Embed & Cluster →", type="primary", disabled=True,
              help="Upload a CSV file first.")
