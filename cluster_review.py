import streamlit as st
import pandas as pd
import numpy as np
import requests
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

_OUTLIER_LABEL = "Outliers"
_GEN_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
_BATCH_SIZE = 20
_DESC_COL = "Description"
_MAX_WORKERS = 10


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


def _cluster_header_line(cluster_name: str, df_cluster: pd.DataFrame, dimensions: list[str]) -> str:
    n = len(df_cluster)
    top_parts = []
    for d in dimensions[:2]:
        if d not in df_cluster.columns:
            continue
        top = (
            df_cluster[d].dropna().str.strip().replace("", pd.NA).dropna()
            .value_counts().head(1).index.tolist()
        )
        if top:
            top_parts.append(top[0])
    suffix = "  ·  " + " / ".join(top_parts) if top_parts else ""
    return f"{cluster_name}  ·  {n}{suffix}"


def _render_named_cluster(
    cluster_name: str,
    df_cluster: pd.DataFrame,
    company_col: str,
    dimensions: list[str],
) -> None:
    # Rename / Merge / Delete buttons
    col_rename, col_merge, col_del, _ = st.columns([1, 1, 1, 7])
    with col_rename:
        if st.button("✏️ Rename", key=f"cr_rename_{cluster_name}", width="stretch"):
            st.session_state["cr_rename_pending"] = cluster_name
            st.rerun()
    with col_merge:
        if st.button("↔ Merge", key=f"cr_merge_{cluster_name}", width="stretch"):
            st.session_state["cr_merge_pending"] = cluster_name
            st.rerun()
    with col_del:
        if st.button("🗑 Delete", key=f"cr_del_{cluster_name}", width="stretch"):
            st.session_state["cr_delete_pending"] = cluster_name
            st.session_state["cr_delete_target"] = _OUTLIER_LABEL
            st.rerun()

    # LLM-generated (or user-edited) description — editable inline
    current_desc = st.session_state.get("cr_cluster_descriptions", {}).get(cluster_name, "")
    new_desc = st.text_area(
        "Description",
        value=current_desc,
        key=f"cr_desc_{cluster_name}",
        placeholder="Describe what this cluster represents and what sets it apart…",
        height=80,
    )
    if new_desc != current_desc:
        descs = st.session_state.get("cr_cluster_descriptions") or {}
        descs[cluster_name] = new_desc
        st.session_state["cr_cluster_descriptions"] = descs

    search = st.text_input(
        "Filter companies",
        key=f"cr_search_{cluster_name}",
        placeholder="Search by name…",
        label_visibility="collapsed",
    )
    show_cols = [c for c in [company_col, _DESC_COL, "Outlier score"] + dimensions if c in df_cluster.columns]
    df_show = df_cluster
    if search:
        mask = df_cluster[company_col].astype(str).str.contains(search, case=False, na=False)
        df_show = df_cluster[mask]
    st.dataframe(df_show[show_cols], use_container_width=True, hide_index=True, height=300)



# ============================================================
# HELPERS — LLM REASSIGNMENT
# ============================================================

def _build_cluster_block(cluster_names: list[str], df_clean: pd.DataFrame, dimensions: list[str]) -> str:
    lines = []
    for name in cluster_names:
        df_c = df_clean[df_clean["Cluster"] == name]
        desc = _build_auto_description(df_c, dimensions)
        desc_plain = desc.replace("**", "").replace("  \n", "; ")
        lines.append(f'"{name}": {desc_plain}')
    return "\n".join(lines)


def _llm_reassign_batch(
    batch: list[tuple[int, str, str, str]],
    cluster_block: str,
    cluster_names: list[str],
    include_outliers: bool,
    api_key: str,
) -> tuple[dict[int, str], dict[int, str], str | None]:
    company_lines = "\n".join(
        f'  "{i}": {name} (currently: "{cur}") — {desc[:600]}'
        for i, (_, name, desc, cur) in enumerate(batch)
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
        'Additionally, if any assignment is non-obvious (e.g. moving away from the current segment), '
        'add an optional "reasons" key with brief explanations (≤8 words each):\n'
        '{"0": "Segment A", "1": "Segment B", "reasons": {"0": "KYC focus fits compliance cluster"}}\n'
        'Omit "reasons" entirely if all assignments are clear. No markdown, just the JSON.'
    )

    try:
        resp = requests.post(
            f"{_GEN_URL}?key={api_key}",
            json={"contents": [{"parts": [{"text": prompt}]}]},
            timeout=60,
        )
        if resp.status_code != 200:
            return {}, {}, f"LLM batch error {resp.status_code}: {resp.text[:200]}"
        raw = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
        raw = re.sub(r"```json|```", "", raw).strip()
        parsed = json.loads(raw)

        valid_set = set(valid)
        result = {}
        raw_reasons = parsed.get("reasons", {}) if isinstance(parsed, dict) else {}
        for pos_str, assigned in parsed.items():
            if pos_str == "reasons":
                continue
            try:
                pos = int(pos_str)
            except ValueError:
                continue
            if 0 <= pos < len(batch):
                row_idx = batch[pos][0]
                result[row_idx] = assigned if assigned in valid_set else (
                    _OUTLIER_LABEL if include_outliers else cluster_names[0]
                )
        row_reasons = {
            batch[int(k)][0]: str(v)
            for k, v in raw_reasons.items()
            if k.isdigit() and int(k) < len(batch)
        }
        return result, row_reasons, None

    except json.JSONDecodeError as e:
        return {}, {}, f"LLM returned invalid JSON: {e}"
    except Exception as e:
        return {}, {}, f"LLM reassignment batch failed: {e}"


def _llm_reassign_all(
    df_clean: pd.DataFrame,
    company_col: str,
    dimensions: list[str],
    cluster_names: list[str],
    include_outliers: bool,
    api_key: str,
) -> tuple[dict[int, str], dict[int, str]]:
    cluster_block = _build_cluster_block(cluster_names, df_clean, dimensions)

    deleted_indices = st.session_state.get("chat_deleted_cluster_indices", set())

    if include_outliers:
        eligible = df_clean
    else:
        eligible = df_clean[
            (df_clean["Cluster"] != _OUTLIER_LABEL) |
            (df_clean.index.isin(deleted_indices))
        ]

    companies = []
    for idx, row in eligible.iterrows():
        name = str(row.get(company_col, f"Row {idx}"))
        desc = str(row.get(_DESC_COL, "")).strip()
        if not desc:
            desc = " | ".join(str(row.get(d, "")) for d in dimensions if d in row.index)
        current = str(row.get("Cluster", _OUTLIER_LABEL))
        companies.append((idx, name, desc, current))

    results: dict[int, str] = {}
    n_batches = max(1, (len(companies) + _BATCH_SIZE - 1) // _BATCH_SIZE)
    _rounds = max(1, (n_batches + _MAX_WORKERS - 1) // _MAX_WORKERS)
    _eta_secs = _rounds * 4
    _eta_str = f"~{_eta_secs}s" if _eta_secs < 60 else f"~{_eta_secs // 60}m {_eta_secs % 60}s"
    prog = st.progress(0, text=f"Reassigning companies via Gemini… (est. {_eta_str}, {_MAX_WORKERS} parallel calls)")
    _reassign_start = time.time()

    batches = [companies[b * _BATCH_SIZE: (b + 1) * _BATCH_SIZE] for b in range(n_batches)]
    error_msgs: list[str] = []
    all_reasons: dict[int, str] = {}
    completed = 0

    with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as ex:
        futures = {
            ex.submit(_llm_reassign_batch, batch, cluster_block, cluster_names, include_outliers, api_key): batch
            for batch in batches
        }
        for future in as_completed(futures):
            batch_result, batch_reasons, err = future.result()
            results.update(batch_result)
            all_reasons.update(batch_reasons)
            if err:
                error_msgs.append(err)
            completed += 1
            _elapsed = time.time() - _reassign_start
            if completed > 1 and completed < n_batches:
                _rate = _elapsed / completed
                _remaining = int(_rate * (n_batches - completed))
                _rem_str = f"~{_remaining}s" if _remaining < 60 else f"~{_remaining // 60}m {_remaining % 60}s"
                prog.progress(
                    completed / n_batches,
                    text=f"{completed}/{n_batches} batches — {_rem_str} remaining…",
                )
            else:
                prog.progress(completed / n_batches, text=f"{completed}/{n_batches} batches…")

    prog.empty()
    for msg in error_msgs:
        st.warning(msg)
    return results, all_reasons


# ============================================================
# DIALOGS
# ============================================================

@st.dialog("Merge cluster", width="large")
def _merge_dialog(merge_pending: str, named_clusters: list[str], df_clean: pd.DataFrame):
    n_merge = int((df_clean["Cluster"] == merge_pending).sum())
    other_clusters = [c for c in named_clusters if c != merge_pending]
    if not other_clusters:
        st.warning("No other clusters to merge into.")
        if st.button("Close"):
            st.session_state["cr_merge_pending"] = None
            st.rerun()
        return

    st.markdown(
        f"Move all **{n_merge} {'company' if n_merge == 1 else 'companies'}** "
        f"from **{merge_pending}** into:"
    )
    merge_target = st.selectbox("Target cluster", options=other_clusters, label_visibility="collapsed")
    col_ok, col_no = st.columns(2)
    with col_ok:
        if st.button("Confirm merge", type="primary", width="stretch"):
            df_clean.loc[df_clean["Cluster"] == merge_pending, "Cluster"] = merge_target
            descs = st.session_state.get("cr_cluster_descriptions", {})
            descs.pop(merge_pending, None)
            st.session_state["cr_cluster_descriptions"] = descs
            st.session_state.df_clean = df_clean
            st.session_state["cr_merge_pending"] = None
            st.rerun()
    with col_no:
        if st.button("Cancel", width="stretch", key="merge_cancel"):
            st.session_state["cr_merge_pending"] = None
            st.rerun()


@st.dialog("Delete cluster", width="large")
def _delete_dialog(delete_pending: str, named_clusters: list[str], df_clean: pd.DataFrame):
    n_del = int((df_clean["Cluster"] == delete_pending).sum())
    other_destinations = [_OUTLIER_LABEL] + [c for c in named_clusters if c != delete_pending]
    st.markdown(
        f"Move **{n_del} {'company' if n_del == 1 else 'companies'}** "
        f"from **{delete_pending}** to:"
    )
    target = st.selectbox("Destination", options=other_destinations, label_visibility="collapsed")
    col_ok, col_no = st.columns(2)
    with col_ok:
        if st.button("Confirm delete", type="primary", width="stretch"):
            df_clean.loc[df_clean["Cluster"] == delete_pending, "Cluster"] = target
            st.session_state.df_clean = df_clean
            st.session_state["cr_delete_pending"] = None            st.rerun()
    with col_no:
        if st.button("Cancel", width="stretch", key="delete_cancel"):
            st.session_state["cr_delete_pending"] = None
            st.rerun()


@st.dialog("Rename cluster", width="large")
def _rename_dialog(cluster_name: str, df_clean: pd.DataFrame):
    new_name = st.text_input("New name", value=cluster_name, placeholder="Cluster name…")
    col_ok, col_no = st.columns(2)
    with col_ok:
        if st.button("Rename", type="primary", width="stretch"):
            new_name_clean = (new_name or "").strip()
            existing = set(df_clean["Cluster"].unique()) - {cluster_name}
            if not new_name_clean:
                st.error("Please enter a name.")
            elif new_name_clean in existing:
                st.error(f'"{new_name_clean}" already exists.')
            else:
                df_out = df_clean.copy()
                df_out.loc[df_out["Cluster"] == cluster_name, "Cluster"] = new_name_clean
                descs = st.session_state.get("cr_cluster_descriptions") or {}
                if cluster_name in descs:
                    descs[new_name_clean] = descs.pop(cluster_name)
                    st.session_state["cr_cluster_descriptions"] = descs
                st.session_state.df_clean = df_out
                st.session_state["cr_rename_pending"] = None
                st.rerun()
    with col_no:
        if st.button("Cancel", width="stretch", key="rename_cancel"):
            st.session_state["cr_rename_pending"] = None
            st.rerun()


@st.dialog("Add new cluster", width="large")
def _add_cluster_dialog(df_clean: pd.DataFrame, company_col: str):
    new_name = st.text_input("Cluster name", placeholder="e.g. Enterprise SaaS")
    new_desc = st.text_area(
        "Description (optional)",
        placeholder="e.g. Infrastructure tools for payments and treasury automation",
        height=80,
    )
    all_companies = df_clean[company_col].dropna().tolist() if company_col in df_clean.columns else []
    new_companies = st.multiselect("Assign companies", options=all_companies, placeholder="Pick companies…")

    col_ok, col_no = st.columns(2)
    with col_ok:
        if st.button("Create cluster", type="primary", width="stretch"):
            new_name_clean = (new_name or "").strip()
            existing_names = set(df_clean["Cluster"].unique().tolist())
            if not new_name_clean:
                st.error("Please enter a cluster name.")
            elif new_name_clean in existing_names:
                st.error(f'"{new_name_clean}" already exists.')
            elif not new_companies:
                st.error("Select at least one company.")
            else:
                df_clean.loc[df_clean[company_col].isin(new_companies), "Cluster"] = new_name_clean
                if new_desc and new_desc.strip():
                    descs = st.session_state.get("cr_cluster_descriptions", {})
                    descs[new_name_clean] = new_desc.strip()
                    st.session_state["cr_cluster_descriptions"] = descs
                st.session_state.df_clean = df_clean
                st.session_state["cr_name_edits"] = {}
                st.rerun()
    with col_no:
        if st.button("Cancel", width="stretch", key="add_cancel"):
            st.rerun()


# ============================================================
# PUBLIC ENTRY POINT
# ============================================================

def render_cluster_review(
    df_clean: pd.DataFrame,
    company_col: str,
    dimensions: list[str],
    api_key: str,
) -> None:
    st.session_state.setdefault("cr_rerun_report", None)
    st.session_state.setdefault("cr_delete_pending", None)
    st.session_state.setdefault("cr_delete_target", _OUTLIER_LABEL)
    st.session_state.setdefault("cr_merge_pending", None)
    st.session_state.setdefault("cr_rename_pending", None)
    st.session_state.setdefault("cr_cluster_descriptions", {})

    all_clusters   = df_clean["Cluster"].unique().tolist()
    named_clusters = sorted(
        [c for c in all_clusters if c != _OUTLIER_LABEL],
        key=lambda c: -(df_clean["Cluster"] == c).sum(),
    )
    df_outliers = df_clean[df_clean["Cluster"] == _OUTLIER_LABEL]

    # ── Open dialogs if pending ───────────────────────────────────────────────
    merge_pending  = st.session_state.get("cr_merge_pending")
    delete_pending = st.session_state.get("cr_delete_pending")
    rename_pending = st.session_state.get("cr_rename_pending")

    if merge_pending and merge_pending in named_clusters:
        _merge_dialog(merge_pending, named_clusters, df_clean)

    if delete_pending and delete_pending in named_clusters:
        _delete_dialog(delete_pending, named_clusters, df_clean)

    if rename_pending and rename_pending in named_clusters:
        _rename_dialog(rename_pending, df_clean)

    # ── Cluster list (collapsed expanders) ────────────────────────────────────
    for cluster_name in named_clusters:
        df_cluster = df_clean[df_clean["Cluster"] == cluster_name].reset_index(drop=True)
        header_line = _cluster_header_line(cluster_name, df_cluster, dimensions)
        with st.expander(header_line, expanded=False):
            _render_named_cluster(cluster_name, df_cluster, company_col, dimensions)

    # ── Outliers (collapsed) ──────────────────────────────────────────────────
    if len(df_outliers) > 0:
        n_out = len(df_outliers)
        with st.expander(
            f"Outliers  ·  {n_out} {'company' if n_out == 1 else 'companies'}  (read-only)",
            expanded=False,
        ):
            show_cols = [c for c in [company_col, "Outlier score"] + dimensions if c in df_outliers.columns]
            st.dataframe(
                df_outliers.reset_index(drop=True)[show_cols],
                use_container_width=True, hide_index=True, height=300,
            )

    # ── Add cluster ───────────────────────────────────────────────────────────
    if st.button("➕ Add cluster", key="cr_add_btn", width="stretch"):
        _add_cluster_dialog(df_clean, company_col)

    # ── Sort via Gemini ───────────────────────────────────────────────────────
    st.divider()
    st.markdown("**🔄 Sort companies via Gemini**")
    st.caption(
        "After renaming or restructuring clusters, have Gemini re-read each company's "
        "description and re-assign it to the best-fitting cluster."
    )

    col_toggle, col_rerun = st.columns([3, 1])
    with col_toggle:
        st.toggle(
            "Include outliers",
            key="cr_include_outliers",
            help="When ON, outlier companies are also sent to Gemini and may be sorted into a cluster.",
        )
    with col_rerun:
        if st.button(
            "▶ Sort now",
            key="cr_rerun",
            type="primary",
            width="stretch",
            help="Gemini reads each company's description and reassigns it to the best cluster.",
            disabled=not api_key,
        ):
            named_now = sorted(
                [c for c in df_clean["Cluster"].unique() if c != _OUTLIER_LABEL],
                key=lambda c: -(df_clean["Cluster"] == c).sum(),
            )
            include_outliers = st.session_state.get("cr_include_outliers", False)
            old_clusters = df_clean["Cluster"].copy()

            assignments, all_reasons = _llm_reassign_all(
                df_clean, company_col, dimensions, named_now, include_outliers, api_key
            )

            if not assignments:
                st.error("Reassignment returned no results. Check your API key and try again.")
                return

            df_out = df_clean.copy()
            for row_idx, new_cluster in assignments.items():
                df_out.at[row_idx, "Cluster"] = new_cluster

            reassigned = set(assignments.keys()) & st.session_state.get("chat_deleted_cluster_indices", set())
            st.session_state["chat_deleted_cluster_indices"] = (
                st.session_state.get("chat_deleted_cluster_indices", set()) - reassigned
            )

            before_counts = old_clusters.value_counts().to_dict()
            after_counts  = df_out["Cluster"].value_counts().to_dict()
            n_outliers_before = before_counts.get(_OUTLIER_LABEL, 0)
            n_outliers_after  = after_counts.get(_OUTLIER_LABEL, 0)

            switch_mask = old_clusters != df_out["Cluster"]
            switches = []
            for idx in df_out.index[switch_mask]:
                company_name = str(df_out.at[idx, company_col]) if company_col in df_out.columns else str(idx)
                reason = all_reasons.get(idx, "")
                switches.append((company_name, old_clusters[idx], df_out.at[idx, "Cluster"], reason))

            st.session_state["cr_rerun_report"] = {
                "n_switched": len(switches),
                "n_outliers_before": n_outliers_before,
                "n_outliers_after": n_outliers_after,
                "pulled_in": max(0, n_outliers_before - n_outliers_after),
                "before": before_counts,
                "after": after_counts,
                "switches": switches,
            }
            st.session_state.df_clean = df_out
            st.rerun()

    if not api_key:
        st.caption("Add a Gemini API key on the Setup page to enable sorting.")

    # ── Sort report ───────────────────────────────────────────────────────────
    report = st.session_state.get("cr_rerun_report")
    if report:
        col_rep, col_dismiss = st.columns([5, 1])
        with col_rep:
            st.info(
                f"**{report['n_switched']}** {'company' if report['n_switched'] == 1 else 'companies'} "
                f"changed cluster. **{report['n_outliers_after']}** outliers remaining."
                + (f" **{report['pulled_in']}** outlier{'s' if report['pulled_in'] != 1 else ''} pulled in." if report["pulled_in"] > 0 else "")
            )
        with col_dismiss:
            st.write("")
            if st.button("Dismiss", key="cr_dismiss_report"):
                st.session_state["cr_rerun_report"] = None
                st.rerun()

        with st.expander("Sort report details"):
            all_cluster_names = sorted(set(list(report["before"].keys()) + list(report["after"].keys())))
            size_rows = []
            for name in all_cluster_names:
                before = report["before"].get(name, 0)
                after  = report["after"].get(name, 0)
                diff   = after - before
                size_rows.append({"Cluster": name, "Before": before, "After": after,
                                   "Change": f"+{diff}" if diff > 0 else str(diff)})
            st.dataframe(pd.DataFrame(size_rows), use_container_width=True, hide_index=True)

            if report["switches"]:
                st.markdown(f"**Companies that switched ({len(report['switches'])}):**")
                switch_df = pd.DataFrame(report["switches"], columns=["Company", "From", "To", "Reason"])
                if switch_df["Reason"].str.strip().eq("").all():
                    switch_df = switch_df.drop(columns=["Reason"])
                st.dataframe(switch_df, use_container_width=True, hide_index=True)
