import streamlit as st
import pandas as pd
import numpy as np
import requests
import json
import re
import time

_OUTLIER_LABEL = "Outliers"
_GEN_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
_BATCH_SIZE = 20
_DESC_COL = "Description"


# ============================================================
# HELPERS — DISPLAY
# ============================================================

def _build_auto_description(df_cluster: pd.DataFrame, dimensions: list[str], top_n: int = 2) -> str:
    parts = []
    for dim in dimensions:
        if dim not in df_cluster.columns:
            continue
        top = (
            df_cluster[dim].dropna().str.strip()
            .replace("", pd.NA).dropna()
            .value_counts().head(top_n).index.tolist()
        )
        if top:
            parts.append(f"**{dim}:** {' / '.join(top)}")
    return "  \n".join(parts) if parts else "_No dimension data available._"


def _render_outlier_cluster(df_outliers: pd.DataFrame, company_col: str, dimensions: list[str]) -> None:
    n = len(df_outliers)
    with st.expander(f"Outliers — {n} {'company' if n == 1 else 'companies'} (read-only)"):
        show_cols = [c for c in [company_col, "Outlier score"] + dimensions if c in df_outliers.columns]
        st.dataframe(df_outliers[show_cols], width="stretch", hide_index=True)


def _render_named_cluster(
    cluster_name: str,
    df_cluster: pd.DataFrame,
    company_col: str,
    dimensions: list[str],
) -> None:
    n = len(df_cluster)
    col_hdr, col_del = st.columns([11, 1])
    with col_hdr:
        st.markdown(
            f"### {cluster_name} &nbsp; <sup style='font-size:0.6em;color:gray'>{n} companies</sup>",
            unsafe_allow_html=True,
        )
    with col_del:
        if st.button("🗑", key=f"cr_del_{cluster_name}", help=f"Delete cluster \"{cluster_name}\""):
            st.session_state["cr_delete_pending"] = cluster_name
            st.session_state["cr_delete_target"] = _OUTLIER_LABEL
            st.rerun()

    st.markdown(_build_auto_description(df_cluster, dimensions))

    col_name, col_core = st.columns([1, 2])
    with col_name:
        st.text_input(
            "Edit name",
            value=st.session_state["cr_name_edits"].get(cluster_name, cluster_name),
            key=f"cr_name_{cluster_name}",
            label_visibility="collapsed",
            placeholder="Cluster name…",
        )
    with col_core:
        company_options = (
            df_cluster[company_col].dropna().tolist()
            if company_col in df_cluster.columns else []
        )
        st.multiselect(
            "Core companies (optional)",
            options=company_options,
            default=[
                c for c in st.session_state["cr_core_companies"].get(cluster_name, [])
                if c in company_options
            ],
            key=f"cr_core_{cluster_name}",
            label_visibility="collapsed",
            placeholder="Mark core companies…",
        )

    with st.expander(f"All {n} companies"):
        show_cols = [c for c in [company_col, _DESC_COL, "Outlier score"] + dimensions if c in df_cluster.columns]
        st.dataframe(df_cluster[show_cols], width="stretch", hide_index=True)

    st.divider()


def _collect_edits(cluster_names: list[str]) -> tuple[dict[str, str], dict[str, list[str]]]:
    name_edits, core_selections = {}, {}
    for name in cluster_names:
        edited = st.session_state.get(f"cr_name_{name}", "").strip()
        name_edits[name] = edited if edited else name
        core_selections[name] = st.session_state.get(f"cr_core_{name}", [])
    return name_edits, core_selections


def _apply_name_edits(df_clean: pd.DataFrame, name_edits: dict[str, str]) -> pd.DataFrame:
    df_out = df_clean.copy()
    df_out["Cluster"] = df_out["Cluster"].map(lambda c: name_edits.get(c, c))
    return df_out


# ============================================================
# HELPERS — LLM REASSIGNMENT
# ============================================================

def _build_cluster_block(cluster_names: list[str], df_clean: pd.DataFrame, dimensions: list[str]) -> str:
    """Build the cluster description block for the LLM prompt."""
    lines = []
    for name in cluster_names:
        df_c = df_clean[df_clean["Cluster"] == name]
        desc = _build_auto_description(df_c, dimensions)
        # Strip markdown bold markers for the raw prompt
        desc_plain = desc.replace("**", "").replace("  \n", "; ")
        lines.append(f'"{name}": {desc_plain}')
    return "\n".join(lines)


def _llm_reassign_batch(
    batch: list[tuple[int, str, str]],   # (row_index, company_name, description)
    cluster_block: str,
    cluster_names: list[str],
    include_outliers: bool,
    api_key: str,
) -> dict[int, str]:
    """Call Gemini for one batch. Returns {row_index: cluster_name}."""
    company_lines = "\n".join(
        f'  "{i}": {name} — {desc[:600]}'
        for i, (_, name, desc) in enumerate(batch)
    )

    valid = list(cluster_names) + ([_OUTLIER_LABEL] if include_outliers else [])
    valid_str = ", ".join(f'"{v}"' for v in valid)

    outlier_instruction = (
        f'If a company clearly fits none of the segments, assign it "{_OUTLIER_LABEL}".'
        if include_outliers
        else "Every company MUST be assigned to exactly one of the segments listed."
    )

    prompt = (
        "You are a market analyst. Assign each company to the best-fitting market segment "
        "based on its description.\n\n"
        f"MARKET SEGMENTS:\n{cluster_block}\n\n"
        f"COMPANIES TO ASSIGN:\n{company_lines}\n\n"
        f"{outlier_instruction}\n"
        f"Valid segment names: [{valid_str}]\n\n"
        'Return ONLY a JSON object where keys are the company numbers (as strings) '
        'and values are the exact segment name:\n'
        '{"0": "Segment Name", "1": "Other Segment", ...}\n'
        "No explanation, no markdown, just the JSON."
    )

    try:
        resp = requests.post(
            f"{_GEN_URL}?key={api_key}",
            json={"contents": [{"parts": [{"text": prompt}]}]},
            timeout=60,
        )
        if resp.status_code != 200:
            st.warning(f"LLM batch error {resp.status_code}: {resp.text[:200]}")
            return {}
        raw = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
        raw = re.sub(r"```json|```", "", raw).strip()
        parsed = json.loads(raw)

        valid_set = set(valid)
        result = {}
        for pos_str, assigned in parsed.items():
            pos = int(pos_str)
            if 0 <= pos < len(batch):
                row_idx = batch[pos][0]
                result[row_idx] = assigned if assigned in valid_set else (
                    _OUTLIER_LABEL if include_outliers else cluster_names[0]
                )
        return result

    except json.JSONDecodeError as e:
        st.warning(f"LLM returned invalid JSON: {e}")
        return {}
    except Exception as e:
        st.warning(f"LLM reassignment batch failed: {e}")
        return {}


def _llm_reassign_all(
    df_clean: pd.DataFrame,
    company_col: str,
    dimensions: list[str],
    cluster_names: list[str],
    include_outliers: bool,
    api_key: str,
) -> dict[int, str]:
    """Reassign all eligible companies via LLM. Returns {row_index: new_cluster_name}."""
    cluster_block = _build_cluster_block(cluster_names, df_clean, dimensions)

    if include_outliers:
        eligible = df_clean
    else:
        eligible = df_clean[df_clean["Cluster"] != _OUTLIER_LABEL]

    companies = []
    for idx, row in eligible.iterrows():
        name = str(row.get(company_col, f"Row {idx}"))
        desc = str(row.get(_DESC_COL, "")).strip()
        if not desc:
            desc = " | ".join(str(row.get(d, "")) for d in dimensions if d in row.index)
        companies.append((idx, name, desc))

    results: dict[int, str] = {}
    n_batches = max(1, (len(companies) + _BATCH_SIZE - 1) // _BATCH_SIZE)
    prog = st.progress(0, text="Reassigning companies via Gemini…")

    for b in range(n_batches):
        batch = companies[b * _BATCH_SIZE: (b + 1) * _BATCH_SIZE]
        batch_result = _llm_reassign_batch(batch, cluster_block, cluster_names, include_outliers, api_key)
        results.update(batch_result)
        prog.progress((b + 1) / n_batches, text=f"Batch {b + 1} / {n_batches}…")
        time.sleep(0.15)

    prog.empty()
    return results


# ============================================================
# PUBLIC ENTRY POINT
# ============================================================

def render_cluster_review(
    df_clean: pd.DataFrame,
    company_col: str,
    dimensions: list[str],
    api_key: str,
) -> "pd.DataFrame | None":
    st.session_state.setdefault("cr_name_edits", {})
    st.session_state.setdefault("cr_core_companies", {})
    st.session_state.setdefault("cr_rerun_report", None)
    st.session_state.setdefault("cr_delete_pending", None)
    st.session_state.setdefault("cr_delete_target", _OUTLIER_LABEL)
    st.session_state.setdefault("cr_adding", False)

    st.subheader("Cluster Review & Edit")
    st.caption(
        "Inspect each cluster, rename it, and optionally mark core companies. "
        "Hit **Rerun** to re-verify all assignments using Gemini — "
        "the LLM reads each company's description and re-sorts it into the best-fitting cluster."
    )

    # Show rerun report if one was stored from the previous run
    report = st.session_state.get("cr_rerun_report")
    if report:
        with st.expander("Last rerun report", expanded=True):
            st.markdown(
                f"**{report['n_switched']}** {'company' if report['n_switched'] == 1 else 'companies'} "
                f"changed cluster. **{report['n_outliers_after']}** outliers remaining."
                + (f" **{report['pulled_in']}** outlier{'s' if report['pulled_in'] != 1 else ''} pulled into a cluster." if report['pulled_in'] > 0 else "")
            )

            # Before / after cluster size table
            all_cluster_names = sorted(set(list(report["before"].keys()) + list(report["after"].keys())))
            size_rows = []
            for name in all_cluster_names:
                before = report["before"].get(name, 0)
                after = report["after"].get(name, 0)
                diff = after - before
                size_rows.append({
                    "Cluster": name,
                    "Before": before,
                    "After": after,
                    "Change": f"+{diff}" if diff > 0 else str(diff),
                })
            import pandas as _pd
            st.dataframe(_pd.DataFrame(size_rows), width="stretch", hide_index=True)

            # Companies that switched
            if report["switches"]:
                st.markdown(f"**Companies that switched ({len(report['switches'])}):**")
                switch_df = _pd.DataFrame(report["switches"], columns=["Company", "From", "To"])
                st.dataframe(switch_df, width="stretch", hide_index=True)

        if st.button("Dismiss report", key="cr_dismiss_report"):
            st.session_state["cr_rerun_report"] = None
            st.rerun()

    all_clusters = df_clean["Cluster"].unique().tolist()
    named_clusters = sorted(
        [c for c in all_clusters if c != _OUTLIER_LABEL],
        key=lambda c: -(df_clean["Cluster"] == c).sum(),
    )
    df_outliers = df_clean[df_clean["Cluster"] == _OUTLIER_LABEL]

    # --- Delete confirmation ---
    delete_pending = st.session_state.get("cr_delete_pending")
    if delete_pending and delete_pending in named_clusters:
        n_del = int((df_clean["Cluster"] == delete_pending).sum())
        other_destinations = [_OUTLIER_LABEL] + [c for c in named_clusters if c != delete_pending]
        st.warning(
            f"Delete **{delete_pending}**? "
            f"Its {n_del} {'company' if n_del == 1 else 'companies'} will be moved to the chosen cluster."
        )
        col_dest, col_confirm, col_cancel = st.columns([3, 2, 2])
        with col_dest:
            target = st.selectbox(
                "Move companies to",
                options=other_destinations,
                key="cr_delete_target_select",
                label_visibility="collapsed",
            )
        with col_confirm:
            if st.button("Confirm delete", type="primary", key="cr_delete_confirm", width="stretch"):
                df_clean.loc[df_clean["Cluster"] == delete_pending, "Cluster"] = target
                st.session_state.df_clean = df_clean
                st.session_state["cr_delete_pending"] = None
                st.session_state["cr_name_edits"] = {}
                st.rerun()
        with col_cancel:
            if st.button("Cancel", key="cr_delete_cancel", width="stretch"):
                st.session_state["cr_delete_pending"] = None
                st.rerun()
        st.divider()

    for cluster_name in named_clusters:
        df_cluster = df_clean[df_clean["Cluster"] == cluster_name].reset_index(drop=True)
        _render_named_cluster(cluster_name, df_cluster, company_col, dimensions)

    if len(df_outliers) > 0:
        _render_outlier_cluster(df_outliers.reset_index(drop=True), company_col, dimensions)

    # --- Add new cluster ---
    if st.session_state.get("cr_adding"):
        st.subheader("New cluster")
        new_name = st.text_input(
            "Cluster name",
            key="cr_new_cluster_name",
            placeholder="e.g. Enterprise SaaS",
        )
        all_companies = df_clean[company_col].dropna().tolist() if company_col in df_clean.columns else []
        new_companies = st.multiselect(
            "Assign companies",
            options=all_companies,
            key="cr_new_cluster_companies",
            placeholder="Pick companies to include…",
        )
        col_create, col_cancel_add = st.columns(2)
        with col_create:
            if st.button("Create cluster", type="primary", key="cr_add_create", width="stretch"):
                new_name_clean = (new_name or "").strip()
                existing_names = set(df_clean["Cluster"].unique().tolist())
                if not new_name_clean:
                    st.error("Please enter a cluster name.")
                elif new_name_clean in existing_names:
                    st.error(f'"{new_name_clean}" already exists. Choose a different name.')
                elif not new_companies:
                    st.error("Select at least one company.")
                else:
                    df_clean.loc[df_clean[company_col].isin(new_companies), "Cluster"] = new_name_clean
                    st.session_state.df_clean = df_clean
                    st.session_state["cr_adding"] = False
                    st.session_state["cr_name_edits"] = {}
                    st.rerun()
        with col_cancel_add:
            if st.button("Cancel", key="cr_add_cancel", width="stretch"):
                st.session_state["cr_adding"] = False
                st.rerun()
        st.divider()
    else:
        if st.button("➕ Add new cluster", key="cr_add_btn"):
            st.session_state["cr_adding"] = True
            st.rerun()

    include_outliers = st.toggle(
        "Include outliers in reassignment",
        key="cr_include_outliers",
        help="When ON, outlier companies are also sent to Gemini and may be sorted into a cluster.",
    )

    col_apply, col_rerun = st.columns(2)
    with col_apply:
        apply_btn = st.button("Apply name edits", key="cr_apply", width="stretch")
    with col_rerun:
        rerun_btn = st.button(
            "Rerun (re-sort via Gemini)", key="cr_rerun", type="primary", width="stretch",
            help="Gemini reads each company's description and reassigns it to the best cluster.",
            disabled=not api_key,
        )

    name_edits, core_selections = _collect_edits(named_clusters)
    st.session_state["cr_name_edits"] = name_edits
    st.session_state["cr_core_companies"] = core_selections

    if apply_btn:
        updated = _apply_name_edits(df_clean, name_edits)
        st.session_state.df_clean = updated
        st.session_state["cr_name_edits"] = {}
        st.session_state["cr_core_companies"] = {}
        st.rerun()

    if rerun_btn:
        df_named = _apply_name_edits(df_clean, name_edits)
        named_after_edit = [name_edits.get(n, n) for n in named_clusters]
        old_clusters = df_named["Cluster"].copy()

        assignments = _llm_reassign_all(
            df_named, company_col, dimensions, named_after_edit, include_outliers, api_key
        )

        if not assignments:
            st.error("Reassignment returned no results. Check your API key and try again.")
            return None

        df_out = df_named.copy()
        for row_idx, new_cluster in assignments.items():
            df_out.at[row_idx, "Cluster"] = new_cluster

        # Build before/after report and store in session state (survives st.rerun)
        before_counts = old_clusters.value_counts().to_dict()
        after_counts = df_out["Cluster"].value_counts().to_dict()
        n_outliers_before = before_counts.get(_OUTLIER_LABEL, 0)
        n_outliers_after = after_counts.get(_OUTLIER_LABEL, 0)

        switch_mask = old_clusters != df_out["Cluster"]
        switches = []
        for idx in df_out.index[switch_mask]:
            company_name = str(df_out.at[idx, company_col]) if company_col in df_out.columns else str(idx)
            switches.append((company_name, old_clusters[idx], df_out.at[idx, "Cluster"]))

        st.session_state["cr_rerun_report"] = {
            "n_switched": len(switches),
            "n_outliers_before": n_outliers_before,
            "n_outliers_after": n_outliers_after,
            "pulled_in": max(0, n_outliers_before - n_outliers_after),
            "before": before_counts,
            "after": after_counts,
            "switches": switches,
        }

        st.session_state["cr_name_edits"] = {}
        st.session_state["cr_core_companies"] = {}
        return df_out

    return None
