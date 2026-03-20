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
from styles import inject_global_css, page_header, step_label, chip

inject_global_css()

# ── Read shared state ─────────────────────────────────────────────────────────
api_key = st.session_state.get("api_key", "")

# ── Page header ───────────────────────────────────────────────────────────────
_hcol, _status_col = st.columns([4, 1])
with _hcol:
    page_header(
        "Setup",
        "Connect your API key, upload company data, and extract AI dimensions.",
    )
with _status_col:
    _df_c = st.session_state.get("df_clean")
    _fm   = st.session_state.get("feature_matrix")
    _all_ready = bool(api_key) and (_df_c is not None or _fm is not None)
    if _all_ready:
        st.markdown(
            '<div style="text-align:right;padding-top:14px">'
            '<span class="hy-chip hy-chip-green">✓ Ready to embed</span>'
            '</div>',
            unsafe_allow_html=True,
        )

# ── Step 1: API Key ───────────────────────────────────────────────────────────
with st.container(border=True):
    step_label(1, "Gemini API Key", done=bool(api_key))

    # Prevent Chrome from suggesting to save this as a login credential.
    st.markdown(
        '<input type="text" style="display:none" autocomplete="username">',
        unsafe_allow_html=True,
    )
    with st.form("api_key_form", border=False):
        col_in, col_btn = st.columns([6, 1])
        with col_in:
            _key_input = st.text_input(
                "Gemini API Key",
                type="password",
                placeholder="AIza…",
                value=st.session_state.get("api_key", ""),
            )
        with col_btn:
            st.write("")
            _key_submitted = st.form_submit_button("Save", width="stretch")
        if _key_submitted:
            st.session_state["api_key"] = _key_input
            api_key = _key_input

    api_key = st.session_state.get("api_key", "")

    if api_key:
        st.markdown(
            '<span class="hy-chip hy-chip-green">✓ Verified · Gemini 2.5 Flash accessible</span>',
            unsafe_allow_html=True,
        )

# ── Step 2: Data Upload ───────────────────────────────────────────────────────
with st.container(border=True):
    step_label(2, "Company Data", done=st.session_state.get("df_clean") is not None)

    uploaded = st.file_uploader("CSV or Excel file", type=["csv", "xlsx", "xls"])

    df_input    = None
    company_col = st.session_state.get("company_col", "name")
    desc_col    = st.session_state.get("desc_col", None)

    # Show persisted data status when returning to this page without re-uploading
    _df_persisted = st.session_state.get("df_clean")
    if not uploaded and _df_persisted is not None:
        st.markdown(
            f'<span class="hy-chip hy-chip-cyan">✓ Data loaded</span>&nbsp;'
            f'<span class="hy-chip hy-chip-cyan">{len(_df_persisted)} rows</span>&nbsp;'
            f'<span class="hy-chip hy-chip-cyan">Company: {company_col}</span>'
            + (f'&nbsp;<span class="hy-chip hy-chip-cyan">Description: {desc_col}</span>' if desc_col else "")
            + '<br><small style="color:#7496b2;font-size:11px">Upload a new file below to replace it.</small>',
            unsafe_allow_html=True,
        )
        df_input = _df_persisted

    if uploaded:
        try:
            df_input = (
                pd.read_csv(uploaded) if uploaded.name.endswith(".csv")
                else pd.read_excel(uploaded)
            )
            st.markdown(
                f'<span class="hy-chip hy-chip-green">✓ {len(df_input)} companies detected</span>',
                unsafe_allow_html=True,
            )

            col1, col2, col_prev = st.columns([2, 2, 1])
            with col1:
                idx = df_input.columns.tolist().index("name") if "name" in df_input.columns else 0
                company_col = st.selectbox("Company column", df_input.columns.tolist(), index=idx)
                st.session_state["company_col"] = company_col
            with col2:
                desc_options = df_input.columns.tolist()
                desc_default = desc_options.index("Description") if "Description" in desc_options else 0
                desc_col = st.selectbox("Description column", desc_options, index=desc_default)
                st.session_state["desc_col"] = desc_col
            with col_prev:
                st.write("")
                st.write("")
                if st.button("Preview", width="stretch", key="preview_btn", type="secondary"):
                    st.session_state["_show_preview"] = True

            @st.dialog("Data preview", width="large")
            def _preview_dialog():
                st.dataframe(df_input.head(10), use_container_width=True, hide_index=True)
                if st.button("Close"):
                    st.rerun()

            if st.session_state.pop("_show_preview", False):
                _preview_dialog()

            # Apply enriched df if ready
            if (
                st.session_state["df_enriched"] is not None
                and st.session_state["df_enriched_src"] == uploaded.name
            ):
                df_input = st.session_state["df_enriched"]

        except Exception as e:
            st.error(f"Could not load file: {e}")

# ── Step 3: AI Dimensions (shown when file is uploaded) ───────────────────────
if uploaded and df_input is not None:
    with st.container(border=True):
        step_label(3, "AI Dimensions", done=all(d in df_input.columns for d in EXTRACTED_DIMENSIONS))

        _fresh = (
            st.session_state["df_enriched"] is not None
            and st.session_state["df_enriched_src"] == uploaded.name
        )
        _dims_in_csv = all(d in df_input.columns for d in EXTRACTED_DIMENSIONS)

        if _fresh:
            df_input = st.session_state["df_enriched"]
            col_msg, col_regen, col_dl = st.columns([4, 1, 1])
            with col_msg:
                st.markdown(
                    f'<span class="hy-chip hy-chip-green">✓ {len(EXTRACTED_DIMENSIONS)} dimensions extracted</span>',
                    unsafe_allow_html=True,
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
            st.markdown(
                f'<span class="hy-chip hy-chip-green">✓ {len(EXTRACTED_DIMENSIONS)} dimension columns in file</span>',
                unsafe_allow_html=True,
            )

        elif desc_col:
            st.caption(
                f"Uses Gemini to extract **{len(EXTRACTED_DIMENSIONS)} dimensions** from each "
                f"company description (~{max(1, len(df_input) // _DIM_BATCH_SIZE)} API calls for "
                f"{len(df_input)} companies). Save the enriched CSV afterwards to skip this next time."
            )
            # Pill-style dimension tags
            pills_html = " ".join(
                f'<span class="hy-chip hy-chip-cyan">{d}</span>'
                for d in EXTRACTED_DIMENSIONS
            )
            st.markdown(pills_html, unsafe_allow_html=True)
            st.write("")
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

# ── Step 3/4: Deals Data (optional) ───────────────────────────────────────────
with st.container(border=True):
    _deals_loaded = st.session_state.get("df_deals") is not None
    step_label(3, "Deals Data (optional)", done=_deals_loaded)
    st.caption(
        "Upload a **Deals CSV** to unlock the Analytics page. "
        "The file must contain one row per deal and a Company ID column to link deals to companies."
    )

    _deals_persisted = st.session_state.get("df_deals")
    deals_uploaded = st.file_uploader(
        "Deals CSV or Excel file",
        type=["csv", "xlsx", "xls"],
        key="deals_upload",
    )

    if not deals_uploaded and _deals_persisted is not None:
        st.markdown(
            f'<span class="hy-chip hy-chip-green">✓ Deals loaded</span>&nbsp;'
            f'<span class="hy-chip hy-chip-cyan">{len(_deals_persisted)} rows</span>&nbsp;'
            f'<span class="hy-chip hy-chip-cyan">{len(_deals_persisted.columns)} columns</span>'
            '<br><small style="color:#7496b2;font-size:11px">Upload a new file below to replace it.</small>',
            unsafe_allow_html=True,
        )

    if deals_uploaded:
        try:
            df_deals_input = (
                pd.read_csv(deals_uploaded)
                if deals_uploaded.name.endswith(".csv")
                else pd.read_excel(deals_uploaded)
            )
            st.session_state["df_deals"] = df_deals_input
            st.markdown(
                f'<span class="hy-chip hy-chip-green">✓ {len(df_deals_input)} deals loaded</span>',
                unsafe_allow_html=True,
            )
        except Exception as e:
            st.error(f"Could not load deals file: {e}")

# ── Step 4/5: Embeddings upload (optional) ────────────────────────────────────
with st.container(border=True):
    _emb_loaded = st.session_state.get("feature_matrix") is not None
    step_label(4, "Embeddings (optional)", done=_emb_loaded)
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
            st.markdown(
                '<span class="hy-chip hy-chip-green">✓ Embeddings loaded</span>',
                unsafe_allow_html=True,
            )
        except Exception as e:
            st.error(f"Error loading embeddings: {e}")

# ── CTA ───────────────────────────────────────────────────────────────────────
has_data = df_input is not None or st.session_state.get("feature_matrix") is not None

if df_input is not None:
    # Persist df_clean with current column selections so Page 2 can use it
    _existing = st.session_state.get("df_clean")
    if _existing is None or (
        hasattr(_existing, "__len__") and len(_existing) != len(df_input)
    ):
        st.session_state["df_clean"] = df_input.copy()

_cta_col1, _cta_col2 = st.columns([3, 1])
with _cta_col2:
    if has_data:
        if st.button("Continue to Embed & Cluster →", type="primary"):
            st.switch_page("pages/embed_cluster.py")
    else:
        st.button(
            "Continue to Embed & Cluster →",
            type="primary",
            disabled=True,
            help="Upload a CSV file first.",
        )
