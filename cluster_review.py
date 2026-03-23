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

# All dialog session state keys — cleared whenever an external rerun (toggle, sort) fires
_DIALOG_STATE_KEYS = (
    "cr_company_editor_cluster", "cr_move_company", "cr_company_detail",
    "cr_add_companies_cluster", "cr_merge_pending", "cr_delete_pending",
    "cr_add_cluster_pending", "cr_delete_company_pending",
)

_EDITOR_PAGE_SIZE = 25


def _clear_dialog_state() -> None:
    """Clear all dialog session state keys. Called as on_change for widgets that trigger
    full-page reruns but should not re-open any previously open dialog."""
    for k in _DIALOG_STATE_KEYS:
        st.session_state[k] = None


def _open_company_editor_cb(cluster_name: str) -> None:
    """on_click callback — runs BEFORE the script body so the dialog-skip check fires."""
    st.session_state["cr_company_editor_cluster"] = cluster_name


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
    return f"{cluster_name}  ·  {n} {'company' if n == 1 else 'companies'}"


_URL_COLS = ["website", "url", "URL", "Website", "web", "Website URL", "homepage", "Homepage"]


def _render_named_cluster(
    cluster_name: str,
    df_cluster: pd.DataFrame,
    company_col: str,
    dimensions: list[str],
) -> None:
    df_full = st.session_state.get("df_clean", pd.DataFrame())

    # ── Name field ────────────────────────────────────────────────────────────
    st.markdown('<div class="hy-field-label">Cluster name</div>', unsafe_allow_html=True)
    new_name = st.text_input(
        "Cluster name",
        value=cluster_name,
        key=f"cr_name_{cluster_name}",
        placeholder="Cluster name…",
        label_visibility="collapsed",
    )

    # ── Description ───────────────────────────────────────────────────────────
    current_desc = st.session_state.get("cr_cluster_descriptions", {}).get(cluster_name, "")
    _desc_height = max(80, min(360, (len(current_desc) // 55 + 1 + current_desc.count("\n")) * 22))
    st.markdown('<div class="hy-field-label" style="margin-top:10px">Description</div>', unsafe_allow_html=True)
    new_desc = st.text_area(
        "Description",
        value=current_desc,
        key=f"cr_desc_{cluster_name}",
        placeholder="Describe what this cluster represents and what sets it apart…",
        height=_desc_height,
        label_visibility="collapsed",
    )

    # ── Action row ────────────────────────────────────────────────────────────
    n = len(df_cluster)
    _noun = "company" if n == 1 else "companies"
    name_changed = new_name.strip() != cluster_name
    desc_changed = new_desc != current_desc

    st.markdown('<div style="margin-top:12px"></div>', unsafe_allow_html=True)
    _browse_col, _confirm_col = st.columns(2)
    with _browse_col:
        st.button(
            f"Browse {n} {_noun} →", key=f"cr_open_editor_{cluster_name}",
            use_container_width=True, type="secondary",
            on_click=_open_company_editor_cb, args=(cluster_name,),
        )
    with _confirm_col:
        if st.button("Confirm edits", key=f"cr_confirm_{cluster_name}", type="primary",
                     disabled=not (name_changed or desc_changed), use_container_width=True):
            new_name_clean = new_name.strip()
            existing = set(df_full["Cluster"].unique()) - {cluster_name}
            if not new_name_clean:
                st.error("Name cannot be empty.")
            elif name_changed and new_name_clean in existing:
                st.error(f'"{new_name_clean}" already exists.')
            else:
                df_out = df_full.copy()
                descs = st.session_state.get("cr_cluster_descriptions") or {}
                descs[cluster_name] = new_desc
                if name_changed:
                    df_out.loc[df_out["Cluster"] == cluster_name, "Cluster"] = new_name_clean
                    if cluster_name in descs:
                        descs[new_name_clean] = descs.pop(cluster_name)
                st.session_state["cr_cluster_descriptions"] = descs
                st.session_state.df_clean = df_out
                st.rerun()


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

    try:
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
    finally:
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
            descs = st.session_state.get("cr_cluster_descriptions", {})
            descs.pop(delete_pending, None)
            st.session_state["cr_cluster_descriptions"] = descs
            st.session_state.df_clean = df_clean
            st.session_state["cr_delete_pending"] = None
            st.rerun()
    with col_no:
        if st.button("Cancel", width="stretch", key="delete_cancel"):
            st.session_state["cr_delete_pending"] = None
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
    _clusters_for = df_clean.set_index(company_col)["Cluster"].to_dict() if company_col in df_clean.columns else {}
    new_companies = st.multiselect(
        "Assign companies", options=all_companies,
        format_func=lambda x: f"{x}  ·  {_clusters_for.get(x, '')}",
        placeholder="Pick companies…",
    )

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
                st.session_state["cr_add_cluster_pending"] = False
                st.rerun()
    with col_no:
        if st.button("Cancel", width="stretch", key="add_cancel"):
            st.session_state["cr_add_cluster_pending"] = False
            st.rerun()


@st.dialog("Companies", width="large")
def show_companies_dialog(cname: str, df_cluster: pd.DataFrame, cluster_company_col: str, color: str) -> None:
    n = len(df_cluster)
    df_cluster = df_cluster.reset_index(drop=True)

    st.markdown(
        f'<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">'
        f'<div style="width:12px;height:12px;border-radius:50%;background:{color}"></div>'
        f'<span style="font-size:15px;font-weight:700;color:#0d1f2d">{cname}</span>'
        f'<span style="font-size:11px;color:#7496b2;background:#f7f9fc;border:1px solid #e4eaf2;'
        f'border-radius:20px;padding:2px 10px">{n} companies</span>'
        f'</div>',
        unsafe_allow_html=True,
    )

    _desc_col = "Description" if "Description" in df_cluster.columns else None
    _url_cols = ["website", "url", "URL", "Website", "web", "Website URL", "homepage", "Homepage"]
    _url_col  = next((c for c in _url_cols if c in df_cluster.columns), None)

    search = st.text_input("", placeholder="Search companies…", key="co_dlg_search", label_visibility="collapsed")

    df_show = df_cluster
    if search:
        mask = df_cluster[cluster_company_col].astype(str).str.contains(search, case=False, na=False)
        df_show = df_cluster[mask]

    rows_html = []
    for _, row in df_show.iterrows():
        name = str(row[cluster_company_col])
        desc = ""
        if _desc_col:
            raw = str(row.get(_desc_col, "") or "").strip()
            if raw and raw.lower() not in ("nan", "none"):
                desc = raw
        url_raw = ""
        if _url_col:
            raw_url = str(row.get(_url_col, "") or "").strip()
            if raw_url and raw_url.lower() not in ("nan", "none", ""):
                url_raw = raw_url if raw_url.startswith(("http://", "https://")) else f"https://{raw_url}"
        row_html = f'<div class="hy-co-item"><span class="hy-co-item-name">{name}</span>'
        if desc:
            row_html += f'<span class="hy-co-item-desc">{desc}</span>'
        if url_raw:
            display_url = url_raw.replace("https://", "").replace("http://", "").rstrip("/")[:30]
            row_html += f'<a class="hy-co-item-url" href="{url_raw}" target="_blank">↗ {display_url}</a>'
        row_html += '</div>'
        rows_html.append(row_html)

    if rows_html:
        st.markdown('<div class="hy-co-list">' + "".join(rows_html) + '</div>', unsafe_allow_html=True)
    else:
        st.markdown('<div class="hy-co-list"><div class="hy-co-empty">No companies match your search.</div></div>', unsafe_allow_html=True)


@st.dialog("Company details", width="large")
def _company_detail_dialog(info: dict, dimensions: list[str]) -> None:
    name = info.get("company", "")
    desc = info.get("desc", "")
    url_raw = info.get("url", "")
    row_data = info.get("row", {})

    st.markdown(
        f'<div style="font-size:16px;font-weight:700;color:#0d1f2d;margin-bottom:6px">{name}</div>',
        unsafe_allow_html=True,
    )
    if url_raw:
        display_url = url_raw.replace("https://", "").replace("http://", "").rstrip("/")[:60]
        st.markdown(
            f'<a class="hy-co-item-url" style="font-size:12px" href="{url_raw}" target="_blank">↗ {display_url}</a>',
            unsafe_allow_html=True,
        )
    if desc:
        st.markdown(
            f'<div style="font-size:13px;color:#516e81;line-height:1.6;margin-top:10px">{desc}</div>',
            unsafe_allow_html=True,
        )
    dim_items = [(d, str(row_data.get(d, "") or "")) for d in dimensions
                 if row_data.get(d) and str(row_data.get(d, "")).lower() not in ("nan", "none", "")]
    if dim_items:
        st.markdown('<div style="margin-top:12px">', unsafe_allow_html=True)
        for d, v in dim_items:
            st.markdown(
                f'<div style="font-size:11.5px;padding:2px 0">'
                f'<span style="font-weight:600;color:#0d1f2d">{d}:</span> '
                f'<span style="color:#516e81">{v}</span></div>',
                unsafe_allow_html=True,
            )
        st.markdown('</div>', unsafe_allow_html=True)
    if st.button("Close", key="co_detail_close"):
        st.session_state["cr_company_detail"] = None
        st.rerun()


@st.dialog("Add companies", width="large")
def _add_companies_dialog(cluster_name: str, df_clean: pd.DataFrame, company_col: str):
    other = df_clean[df_clean["Cluster"] != cluster_name].copy()
    search = st.text_input("Search", placeholder="Filter by name…", label_visibility="collapsed")
    if search:
        mask = other[company_col].astype(str).str.contains(search, case=False, na=False)
        other = other[mask]
    options = other[company_col].dropna().astype(str).tolist()
    clusters_for = other.set_index(company_col)["Cluster"].to_dict() if company_col in other.columns else {}
    selected = st.multiselect(
        "Select companies to add",
        options=options,
        format_func=lambda x: f"{x}  ·  {clusters_for.get(x, '')}",
        placeholder=f"Pick companies to move into {cluster_name}…",
        label_visibility="collapsed",
    )
    col_ok, col_no = st.columns(2)
    with col_ok:
        if st.button("Add to cluster", type="primary", width="stretch", disabled=not selected):
            df_out = df_clean.copy()
            df_out.loc[df_out[company_col].isin(selected), "Cluster"] = cluster_name
            st.session_state.df_clean = df_out
            st.session_state["cr_add_companies_cluster"] = None
            st.rerun()
    with col_no:
        if st.button("Cancel", width="stretch", key="add_co_cancel"):
            st.session_state["cr_add_companies_cluster"] = None
            st.rerun()


@st.dialog("Move company", width="large")
def _move_company_dialog(
    cluster_name: str,
    company_name: str,
    named_clusters: list[str],
    df_clean: pd.DataFrame,
    company_col: str,
):
    destinations = [c for c in ([_OUTLIER_LABEL] + named_clusters) if c != cluster_name]
    st.markdown(f"Move **{company_name}** to:")
    target = st.selectbox("Destination", options=destinations, label_visibility="collapsed")
    col_ok, col_no = st.columns(2)
    with col_ok:
        if st.button("Confirm", type="primary", width="stretch"):
            df_out = df_clean.copy()
            _mv_info = st.session_state.get("cr_move_company") or {}
            _mv_idx = _mv_info.get("index")
            if _mv_idx is not None and _mv_idx in df_out.index:
                df_out.at[_mv_idx, "Cluster"] = target
            else:
                df_out.loc[df_out[company_col] == company_name, "Cluster"] = target
            st.session_state.df_clean = df_out
            st.session_state["cr_move_company"] = None
            st.rerun()
    with col_no:
        if st.button("Cancel", width="stretch", key="move_co_cancel"):
            st.session_state["cr_move_company"] = None
            st.rerun()


@st.dialog("Remove company", width="small")
def _confirm_delete_company_dialog(cluster_name: str, company_name: str, company_col: str) -> None:
    st.markdown(f"Remove **{company_name}** from **{cluster_name}**?")
    st.caption("The company will be moved to Outliers.")
    col_ok, col_no = st.columns(2)
    with col_ok:
        if st.button("Remove", type="primary", width="stretch"):
            df_out = st.session_state["df_clean"].copy()
            _del_info = st.session_state.get("cr_delete_company_pending") or {}
            _del_idx = _del_info.get("index")
            if _del_idx is not None and _del_idx in df_out.index:
                df_out.at[_del_idx, "Cluster"] = _OUTLIER_LABEL
            else:
                df_out.loc[df_out[company_col] == company_name, "Cluster"] = _OUTLIER_LABEL
            st.session_state.df_clean = df_out
            st.session_state["cr_delete_company_pending"] = None
            st.rerun()
    with col_no:
        if st.button("Cancel", width="stretch", key="del_co_cancel"):
            st.session_state["cr_delete_company_pending"] = None
            st.rerun()


@st.dialog("Manage companies", width="large")
def _company_editor_dialog(
    cluster_name: str,
    df_cluster: pd.DataFrame,
    company_col: str,
    df_clean: pd.DataFrame,
    named_clusters: list[str],
) -> None:
    n = len(df_cluster)

    # ── Cluster identity header (matches show_companies_dialog style) ─────────
    _color = (st.session_state.get("cr_color_map") or {}).get(cluster_name, "#26B4D2")
    st.markdown(
        f'<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">'
        f'<div style="width:12px;height:12px;border-radius:50%;background:{_color}"></div>'
        f'<span style="font-size:15px;font-weight:700;color:#0d1f2d">{cluster_name}</span>'
        f'<span style="font-size:11px;color:#7496b2;background:#f7f9fc;border:1px solid #e4eaf2;'
        f'border-radius:20px;padding:2px 10px">{n} companies</span>'
        f'</div>',
        unsafe_allow_html=True,
    )

    # ── Search + add button row ───────────────────────────────────────────────
    with st.container():
        st.markdown('<span class="hy-cr-add-row-marker"></span>', unsafe_allow_html=True)
        _scol, _acol = st.columns([9, 0.5])
        with _scol:
            search = st.text_input(
                "Filter", key=f"ced_search_{cluster_name}",
                placeholder="Search companies…", label_visibility="collapsed",
            )
        with _acol:
            if st.button(" ", icon=":material/add:", key="ced_add",
                         use_container_width=True, type="secondary", help="Add companies"):
                st.session_state["cr_add_companies_cluster"] = cluster_name
                st.rerun()

    df_show = df_cluster
    if search:
        mask = df_cluster[company_col].astype(str).str.contains(search, case=False, na=False)
        df_show = df_cluster[mask]

    # ── Company list with alternating rows ────────────────────────────────────
    total = len(df_show)

    with st.container():
        st.markdown('<span class="hy-cr-co-list-marker"></span>', unsafe_allow_html=True)
        if total == 0:
            st.markdown('<div class="hy-co-empty">No companies match.</div>', unsafe_allow_html=True)
        else:
            for i, (row_idx, row) in enumerate(df_show.iterrows()):
                name = str(row.get(company_col, "") or "")
                _row_bg = "background:#f7f9fc;" if i % 2 != 0 else ""
                _nc, _mc, _dc = st.columns([10, 0.5, 0.5])
                with _nc:
                    st.markdown(
                        f'<span class="hy-co-item-name" style="{_row_bg}display:block;padding:2px 0">{name}</span>',
                        unsafe_allow_html=True,
                    )
                with _mc:
                    if st.button(" ", icon=":material/arrow_forward:", key=f"ced_mv_{i}",
                                 type="secondary", help=f"Move {name}"):
                        st.session_state["cr_move_company"] = {"cluster": cluster_name, "company": name, "index": int(row_idx)}
                        st.rerun()
                with _dc:
                    if st.button(" ", icon=":material/delete_outline:", key=f"ced_rm_{i}",
                                 type="secondary", help=f"Remove {name} from cluster"):
                        st.session_state["cr_delete_company_pending"] = {"cluster": cluster_name, "company": name, "index": int(row_idx)}
                        st.rerun()

    st.divider()
    if st.button("Close", key="ced_close", use_container_width=True):
        st.session_state["cr_company_editor_cluster"] = None
        st.rerun()


# ============================================================
# PUBLIC ENTRY POINT
# ============================================================

def render_cluster_review(
    df_clean: pd.DataFrame,
    company_col: str,
    dimensions: list[str],
    api_key: str,
    color_map: dict | None = None,
) -> None:
    st.session_state.setdefault("cr_rerun_report", None)
    st.session_state.setdefault("cr_delete_pending", None)
    st.session_state.setdefault("cr_delete_target", _OUTLIER_LABEL)
    st.session_state.setdefault("cr_merge_pending", None)
    st.session_state.setdefault("cr_cluster_descriptions", {})
    st.session_state.setdefault("cr_add_companies_cluster", None)
    st.session_state.setdefault("cr_move_company", None)
    st.session_state.setdefault("cr_company_detail", None)
    st.session_state.setdefault("cr_company_editor_cluster", None)
    st.session_state.setdefault("cr_add_cluster_pending", False)
    st.session_state.setdefault("cr_delete_company_pending", None)
    st.session_state.setdefault("cr_sorting", False)
    st.session_state["cr_color_map"] = color_map or {}

    all_clusters   = df_clean["Cluster"].unique().tolist()
    named_clusters = sorted(
        [c for c in all_clusters if c != _OUTLIER_LABEL],
        key=lambda c: -(df_clean["Cluster"] == c).sum(),
    )
    df_outliers = df_clean[df_clean["Cluster"] == _OUTLIER_LABEL]

    # ── Open dialogs if pending ───────────────────────────────────────────────
    merge_pending  = st.session_state.get("cr_merge_pending")
    delete_pending = st.session_state.get("cr_delete_pending")

    if merge_pending and merge_pending in named_clusters:
        _merge_dialog(merge_pending, named_clusters, df_clean)
    elif delete_pending and delete_pending in named_clusters:
        _delete_dialog(delete_pending, named_clusters, df_clean)
    elif st.session_state.get("cr_delete_company_pending"):
        _dpend = st.session_state["cr_delete_company_pending"]
        _confirm_delete_company_dialog(_dpend["cluster"], _dpend["company"], company_col)
    elif st.session_state.get("cr_add_companies_cluster"):
        _add_companies_dialog(st.session_state["cr_add_companies_cluster"], df_clean, company_col)
    elif st.session_state.get("cr_move_company"):
        _info = st.session_state["cr_move_company"]
        _move_company_dialog(_info["cluster"], _info["company"], named_clusters, df_clean, company_col)
    elif st.session_state.get("cr_company_detail"):
        _company_detail_dialog(st.session_state["cr_company_detail"], dimensions)
    elif st.session_state.get("cr_add_cluster_pending"):
        _add_cluster_dialog(df_clean, company_col)
    elif st.session_state.get("cr_company_editor_cluster"):
        _cec = st.session_state["cr_company_editor_cluster"]
        _df_cec = df_clean[df_clean["Cluster"] == _cec].reset_index(drop=True)
        _company_editor_dialog(_cec, _df_cec, company_col, df_clean, named_clusters)

    # ── Cluster list ──────────────────────────────────────────────────────────
    for cluster_name in named_clusters:
        color = (color_map or {}).get(cluster_name, "#26B4D2")
        df_cluster = df_clean[df_clean["Cluster"] == cluster_name].reset_index(drop=True)
        n = len(df_cluster)
        _noun = "company" if n == 1 else "companies"
        with st.container(border=True):
            # Title + icon buttons on the same row
            with st.container():
                st.markdown('<span class="hy-cr-icon-row-marker"></span>', unsafe_allow_html=True)
                _title_col, _b1, _b2 = st.columns([10, 0.5, 0.5])
                with _title_col:
                    st.markdown(
                        f'<div style="display:flex;align-items:center;gap:10px;padding:2px 0 6px">'
                        f'<div style="width:11px;height:11px;border-radius:50%;background:{color};flex-shrink:0"></div>'
                        f'<span style="font-size:14px;font-weight:700;color:#0d1f2d;letter-spacing:-0.01em">{cluster_name}</span>'
                        f'<span style="font-size:11px;color:#7496b2;background:#f7f9fc;border:1px solid #e4eaf2;'
                        f'border-radius:20px;padding:1px 8px;white-space:nowrap">{n} {_noun}</span>'
                        f'</div>',
                        unsafe_allow_html=True,
                    )
                with _b1:
                    if st.button(" ", icon=":material/call_merge:", key=f"cr_merge_{cluster_name}",
                                 use_container_width=True, type="secondary", help="Merge cluster"):
                        st.session_state["cr_merge_pending"] = cluster_name
                        st.rerun()
                with _b2:
                    if st.button(" ", icon=":material/delete_outline:", key=f"cr_del_{cluster_name}",
                                 use_container_width=True, type="secondary", help="Delete cluster"):
                        st.session_state["cr_delete_pending"] = cluster_name
                        st.session_state["cr_delete_target"] = _OUTLIER_LABEL
                        st.rerun()
            with st.expander("Edit cluster", expanded=False):
                _render_named_cluster(cluster_name, df_cluster, company_col, dimensions)

    # ── Outliers (styled list with move option) ───────────────────────────────
    if len(df_outliers) > 0:
        n_out = len(df_outliers)
        with st.container(border=True):
            with st.container():
                st.markdown('<span class="hy-cr-icon-row-marker"></span>', unsafe_allow_html=True)
                st.markdown(
                    f'<div style="display:flex;align-items:center;gap:8px;padding:2px 0 6px">'
                    f'<span style="font-size:14px;font-weight:700;color:#0d1f2d;letter-spacing:-0.01em">Outliers</span>'
                    f'<span style="font-size:11px;color:#7496b2;background:#f7f9fc;border:1px solid #e4eaf2;'
                    f'border-radius:20px;padding:1px 8px;white-space:nowrap">'
                    f'{n_out} {"company" if n_out == 1 else "companies"}</span>'
                    f'<span style="font-size:10px;color:#aac0d1;margin-left:2px">→ move to assign to a cluster</span>'
                    f'</div>',
                    unsafe_allow_html=True,
                )
            _out_search = st.text_input(
                "Filter outliers", key="cr_out_search",
                placeholder="Search outliers…", label_visibility="collapsed",
            )
            df_out_show = df_outliers.reset_index(drop=True)
            if _out_search:
                _omask = df_out_show[company_col].astype(str).str.contains(
                    _out_search, case=False, na=False, regex=False
                )
                df_out_show = df_out_show[_omask]

            with st.container():
                st.markdown('<span class="hy-cr-co-list-marker"></span>', unsafe_allow_html=True)
                if df_out_show.empty:
                    st.markdown('<div class="hy-co-empty">No outliers match.</div>', unsafe_allow_html=True)
                else:
                    for _oi, (_oidx, _orow) in enumerate(df_out_show.iterrows()):
                        _oname = str(_orow.get(company_col, "") or "")
                        _oscore = _orow.get("Outlier score")
                        _oscore_str = (
                            f"{float(_oscore):.2f}"
                            if _oscore is not None and not (isinstance(_oscore, float) and pd.isna(_oscore))
                            else None
                        )
                        _onc, _omc = st.columns([10, 0.5])
                        with _onc:
                            _score_badge = (
                                f'<span style="font-size:10px;color:#aac0d1;'
                                f'font-family:IBM Plex Mono,monospace;margin-left:6px">·  {_oscore_str}</span>'
                                if _oscore_str else ""
                            )
                            st.markdown(
                                f'<span class="hy-co-item-name">{_oname}</span>{_score_badge}',
                                unsafe_allow_html=True,
                            )
                        with _omc:
                            if st.button(" ", icon=":material/arrow_forward:", key=f"out_mv_{_oi}",
                                         type="secondary", help=f"Move {_oname} to a cluster"):
                                st.session_state["cr_move_company"] = {"cluster": _OUTLIER_LABEL, "company": _oname, "index": int(_oidx)}
                                st.rerun()

    # ── Add cluster ───────────────────────────────────────────────────────────
    if st.button("➕ Add cluster", key="cr_add_btn", width="stretch"):
        st.session_state["cr_add_cluster_pending"] = True
        st.rerun()

    # ── Sort via Gemini ───────────────────────────────────────────────────────
    with st.container(border=True):
        st.markdown(
            '<div style="font-size:13px;font-weight:600;color:#0d1f2d;margin-bottom:2px">'
            'Re-sort via Gemini</div>',
            unsafe_allow_html=True,
        )
        st.caption(
            "After renaming or restructuring clusters, have Gemini re-read each company's "
            "description and re-assign it to the best-fitting cluster."
        )
        col_toggle, col_rerun = st.columns([3, 1])
        with col_toggle:
            st.toggle(
                "Include outliers",
                key="cr_include_outliers",
                on_change=_clear_dialog_state,
                help="When ON, outlier companies are also sent to Gemini and may be sorted into a cluster.",
            )
        with col_rerun:
            _is_sorting = st.session_state.get("cr_sorting", False)
            if st.button(
                "⏳ Sorting…" if _is_sorting else "▶ Sort now",
                key="cr_rerun",
                type="primary",
                width="stretch",
                help="Gemini reads each company's description and reassigns it to the best cluster.",
                disabled=not api_key or _is_sorting,
            ):
                # Clear all dialog state immediately so no stale dialogs reopen
                _clear_dialog_state()
                st.session_state["cr_sorting"] = True

                try:
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
                    _clear_dialog_state()
                    st.rerun()
                except Exception as _exc:
                    st.error(f"Sort failed unexpectedly: {_exc}")
                finally:
                    st.session_state["cr_sorting"] = False

    if not api_key:
        st.caption("Add a Gemini API key on the Setup page to enable sorting.")

    # ── Sort report ───────────────────────────────────────────────────────────
    report = st.session_state.get("cr_rerun_report")
    if report:
        n_sw   = report["n_switched"]
        n_out  = report["n_outliers_after"]
        n_pull = report["pulled_in"]

        # Stat chips
        chips_html = (
            f'<div class="hy-sr-chip"><b>{n_sw}</b> '
            f'{"company" if n_sw == 1 else "companies"} moved</div>'
            f'<div class="hy-sr-chip"><b>{n_out}</b> outliers remaining</div>'
        )
        if n_pull > 0:
            chips_html += (
                f'<div class="hy-sr-chip green"><b>{n_pull}</b> '
                f'outlier{"s" if n_pull != 1 else ""} pulled in</div>'
            )

        st.markdown(
            f'<div class="hy-sr-banner">'
            f'<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">'
            f'<span style="font-size:11px;font-weight:700;text-transform:uppercase;'
            f'letter-spacing:0.06em;color:#7496b2;white-space:nowrap">Sort Report</span>'
            f'<div class="hy-sr-chips">{chips_html}</div>'
            f'</div>'
            f'</div>',
            unsafe_allow_html=True,
        )

        _dismiss_col, _ = st.columns([1, 5])
        with _dismiss_col:
            if st.button("✕ Dismiss", key="cr_dismiss_report", type="secondary", use_container_width=True):
                st.session_state["cr_rerun_report"] = None
                st.rerun()

        with st.expander("Sort report details"):
            # Cluster size changes table
            all_cluster_names = sorted(set(list(report["before"].keys()) + list(report["after"].keys())))
            size_rows_html = ""
            for i, name in enumerate(all_cluster_names):
                before = report["before"].get(name, 0)
                after  = report["after"].get(name, 0)
                diff   = after - before
                if diff > 0:
                    change_html = f'<span class="hy-sr-pos">+{diff}</span>'
                elif diff < 0:
                    change_html = f'<span class="hy-sr-neg">{diff}</span>'
                else:
                    change_html = f'<span class="hy-sr-neu">—</span>'
                _bg = "background:#f7f9fc;" if i % 2 != 0 else ""
                size_rows_html += (
                    f'<tr style="{_bg}">'
                    f'<td style="text-align:left;padding:6px 12px;border-bottom:1px solid #f0f4f8">{name}</td>'
                    f'<td style="padding:6px 12px;border-bottom:1px solid #f0f4f8">{before}</td>'
                    f'<td style="padding:6px 12px;border-bottom:1px solid #f0f4f8">{after}</td>'
                    f'<td style="padding:6px 12px;border-bottom:1px solid #f0f4f8">{change_html}</td>'
                    f'</tr>'
                )
            st.markdown(
                f'<div class="hy-sr-section" style="margin-bottom:6px">Cluster sizes</div>'
                f'<div class="hy-sr-wrap" style="margin-bottom:14px">'
                f'<table class="hy-sr-tbl">'
                f'<thead><tr>'
                f'<th style="text-align:left">Cluster</th>'
                f'<th>Before</th><th>After</th><th>Change</th>'
                f'</tr></thead>'
                f'<tbody>{size_rows_html}</tbody>'
                f'</table></div>',
                unsafe_allow_html=True,
            )

            if report["switches"]:
                switch_df = pd.DataFrame(report["switches"], columns=["Company", "From", "To", "Reason"])
                has_reason = not switch_df["Reason"].str.strip().eq("").all()
                sw_rows_html = ""
                for i, row in switch_df.iterrows():
                    _bg = "background:#f7f9fc;" if i % 2 != 0 else ""
                    reason_td = f'<td style="text-align:left;padding:6px 12px;border-bottom:1px solid #f0f4f8;color:#516e81;font-style:italic">{row["Reason"]}</td>' if has_reason else ""
                    sw_rows_html += (
                        f'<tr style="{_bg}">'
                        f'<td style="text-align:left;padding:6px 12px;border-bottom:1px solid #f0f4f8;font-weight:500">{row["Company"]}</td>'
                        f'<td style="text-align:left;padding:6px 12px;border-bottom:1px solid #f0f4f8;color:#516e81">{row["From"]}</td>'
                        f'<td style="text-align:left;padding:6px 12px;border-bottom:1px solid #f0f4f8">'
                        f'<span class="hy-sr-pos">{row["To"]}</span></td>'
                        f'{reason_td}'
                        f'</tr>'
                    )
                reason_th = '<th style="text-align:left">Reason</th>' if has_reason else ""
                st.markdown(
                    f'<div class="hy-sr-section" style="margin-bottom:6px">Companies moved ({len(report["switches"])})</div>'
                    f'<div class="hy-sr-wrap">'
                    f'<table class="hy-sr-tbl">'
                    f'<thead><tr>'
                    f'<th style="text-align:left">Company</th>'
                    f'<th style="text-align:left">From</th>'
                    f'<th style="text-align:left">To</th>'
                    f'{reason_th}'
                    f'</tr></thead>'
                    f'<tbody>{sw_rows_html}</tbody>'
                    f'</table></div>',
                    unsafe_allow_html=True,
                )
