"""Analytics page — cluster analytics table."""

import datetime

import numpy as np
import pandas as pd
import streamlit as st

CURRENT_YEAR = datetime.date.today().year

# Series stage → numeric score
SERIES_SCORE: dict[str, float] = {
    "pre-seed": 0, "pre seed": 0, "preseed": 0,
    "seed": 1,
    "series a": 2, "a": 2,
    "series b": 3, "b": 3,
    "series c": 4, "c": 4,
    "series d": 5, "d": 5,
    "series e": 6, "e": 6, "e+": 6,
    "series f": 6, "f": 6, "g": 6,
    "growth": 6, "late stage": 6, "ipo": 7,
}

# Stages that count as "graduated" (reached Series B or later)
GRAD_STAGES = {
    "b", "series b", "c", "series c", "d", "series d",
    "e", "series e", "e+", "f", "series f", "g", "growth", "ipo",
}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _find_col(df: pd.DataFrame, candidates: list[str]) -> str | None:
    """Return the first column whose name (case-insensitive) matches any candidate."""
    lower_map = {c.lower().strip(): c for c in df.columns}
    for c in candidates:
        hit = lower_map.get(c.lower().strip())
        if hit:
            return hit
    return None


def _to_year(series: pd.Series) -> pd.Series:
    """Convert a column of dates or plain years to integer years."""
    dt = pd.to_datetime(series, errors="coerce", dayfirst=True)
    years = dt.dt.year.astype("Int64")
    # Rows that failed datetime parse → try as plain numeric year
    failed = years.isna()
    if failed.any():
        numeric = pd.to_numeric(series[failed], errors="coerce").astype("Int64")
        years = years.copy()
        years[failed] = numeric
    return years


def _pct_fmt(val) -> str | None:
    if val is None or (isinstance(val, float) and np.isnan(val)):
        return None
    return f"{val:+.0f} %"


# ── Core computation ──────────────────────────────────────────────────────────

def _compute(
    df_co: pd.DataFrame,
    df_de: pd.DataFrame | None,
    cluster_col: str,
    cmap: dict,
) -> pd.DataFrame:
    """Compute per-cluster analytics.

    cmap keys (all optional):
        co_id, de_co_id, employees, year_founded, total_raised,
        total_patent_families, last_deal_date, profitable,
        deal_id, deal_size, deal_date, series
    """
    co_id    = cmap.get("co_id")
    de_co_id = cmap.get("de_co_id")

    clusters = sorted(
        [c for c in df_co[cluster_col].unique() if c != "Outliers"],
    )

    rows = []
    for cname in clusters:
        co = df_co[df_co[cluster_col] == cname]

        # Linked deals
        if df_de is not None and co_id and de_co_id and co_id in co.columns and de_co_id in df_de.columns:
            ids = co[co_id].dropna().unique()
            de = df_de[df_de[de_co_id].isin(ids)].copy()
        else:
            de = pd.DataFrame()

        r: dict = {"Cluster": cname}

        # ── Größe ─────────────────────────────────────────────────────────────
        r["Gesamt"] = len(co)
        if co_id and co_id in co.columns:
            r["# Companies"] = int(co[co_id].nunique())
        else:
            r["# Companies"] = len(co)

        emp = cmap.get("employees")
        if emp and emp in co.columns:
            vals = pd.to_numeric(co[emp], errors="coerce").dropna()
            r["⌀ Angestellte"] = round(float(vals.mean()), 1) if len(vals) else None
        else:
            r["⌀ Angestellte"] = None

        # ── Neuheit ───────────────────────────────────────────────────────────
        yf = cmap.get("year_founded")
        if yf and yf in co.columns:
            vals = pd.to_numeric(co[yf], errors="coerce").dropna()
            r["⌀ Year Founded"] = int(round(vals.mean())) if len(vals) else None
            r["% Recently Founded"] = round((vals >= 2020).sum() / len(vals) * 100, 1) if len(vals) else None
        else:
            r["⌀ Year Founded"] = None
            r["% Recently Founded"] = None

        # ── Deals ─────────────────────────────────────────────────────────────
        if not de.empty:
            did = cmap.get("deal_id")
            r["# Deals"] = int(de[did].nunique()) if did and did in de.columns else len(de)

            dd = cmap.get("deal_date")
            if dd and dd in de.columns:
                yrs = _to_year(de[dd])
                recent = int(((yrs >= CURRENT_YEAR - 2) & (yrs <= CURRENT_YEAR - 1)).sum())
                prev    = int(((yrs >= CURRENT_YEAR - 4) & (yrs <= CURRENT_YEAR - 3)).sum())
                r["Deal Momentum"] = round((recent / prev - 1) * 100, 0) if prev > 0 else None
            else:
                r["Deal Momentum"] = None
        else:
            r["# Deals"] = None
            r["Deal Momentum"] = None

        # ── Funding ───────────────────────────────────────────────────────────
        tr = cmap.get("total_raised")
        if tr and tr in co.columns:
            vals = pd.to_numeric(co[tr], errors="coerce").dropna()
            r["⌀ Total Raised (m€)"] = round(float(vals.mean()), 1) if len(vals) else None
            r["Σ Total Raised (m€)"]  = round(float(vals.sum()),  1) if len(vals) else None
        else:
            r["⌀ Total Raised (m€)"] = None
            r["Σ Total Raised (m€)"]  = None

        if not de.empty:
            ds = cmap.get("deal_size")
            dd = cmap.get("deal_date")
            if ds and ds in de.columns:
                deal_vals = pd.to_numeric(de[ds], errors="coerce")

                if dd and dd in de.columns:
                    yrs = _to_year(de[dd])
                    mask_4yr   = (yrs >= CURRENT_YEAR - 4) & (yrs <= CURRENT_YEAR - 1)
                    mask_rec   = (yrs >= CURRENT_YEAR - 2) & (yrs <= CURRENT_YEAR - 1)
                    mask_prev  = (yrs >= CURRENT_YEAR - 4) & (yrs <= CURRENT_YEAR - 3)
                    r["Σ Invested (4 J.)"] = round(float(deal_vals[mask_4yr].sum()), 1)
                    rec_sum  = deal_vals[mask_rec].sum()
                    prev_sum = deal_vals[mask_prev].sum()
                    r["Funding Momentum"] = round((rec_sum / prev_sum - 1) * 100, 0) if prev_sum > 0 else None
                else:
                    r["Σ Invested (4 J.)"] = None
                    r["Funding Momentum"]   = None

                mean_v   = float(deal_vals.mean()) if deal_vals.notna().any() else None
                median_v = float(deal_vals.median()) if deal_vals.notna().any() else None
                r["Capital Invested Mean"]   = round(mean_v,   2) if mean_v   is not None else None
                r["Capital Invested Median"] = round(median_v, 2) if median_v is not None else None
                r["Abweichung M/M"] = round(mean_v / median_v, 2) if (mean_v and median_v and median_v > 0) else None
            else:
                for k in ["Σ Invested (4 J.)", "Funding Momentum",
                          "Capital Invested Mean", "Capital Invested Median", "Abweichung M/M"]:
                    r[k] = None

            sc = cmap.get("series")
            if sc and sc in de.columns and de_co_id and de_co_id in de.columns:
                s_lower = de[sc].astype(str).str.lower().str.strip()

                # VC Graduation Rate
                de2 = de.copy()
                de2["_grad"] = s_lower.isin(GRAD_STAGES)
                grad_by_co = de2.groupby(de_co_id)["_grad"].any()
                r["VC Graduation Rate"] = round(float(grad_by_co.mean()) * 100, 1) if len(grad_by_co) else None

                # Marktreife
                scores = s_lower.map(lambda v: SERIES_SCORE.get(v, np.nan))
                r["Marktreife"] = round(float(scores.mean()), 1) if scores.notna().any() else None
            else:
                r["VC Graduation Rate"] = None
                r["Marktreife"]          = None
        else:
            for k in ["Σ Invested (4 J.)", "Funding Momentum",
                      "Capital Invested Mean", "Capital Invested Median", "Abweichung M/M",
                      "VC Graduation Rate", "Marktreife"]:
                r[k] = None

        # ── Mortality Rate ────────────────────────────────────────────────────
        ld = cmap.get("last_deal_date")
        pr = cmap.get("profitable")
        if ld and ld in co.columns:
            cutoff = CURRENT_YEAR - 4
            last_yrs = _to_year(co[ld])
            old_mask = last_yrs < cutoff
            if pr and pr in co.columns:
                not_prof = ~co[pr].fillna(False).astype(bool)
                dead = old_mask & not_prof
            else:
                dead = old_mask
            r["Mortality Rate"] = round(float(dead.mean()) * 100, 1)
        else:
            r["Mortality Rate"] = None

        # ── Marktanteil (HHI) ─────────────────────────────────────────────────
        if tr and tr in co.columns:
            vals = pd.to_numeric(co[tr], errors="coerce").fillna(0)
            total = vals.sum()
            if total > 0:
                shares = vals / total
                r["Marktanteil (HHI)"] = int(round((shares ** 2).sum() * 10000))
            else:
                r["Marktanteil (HHI)"] = None
        else:
            r["Marktanteil (HHI)"] = None

        # ── Patente ───────────────────────────────────────────────────────────
        pat = cmap.get("total_patent_families")
        if pat and pat in co.columns:
            vals = pd.to_numeric(co[pat], errors="coerce").dropna()
            r["⌀ Patentierte Erf."] = round(float(vals.mean()), 1) if len(vals) else None
        else:
            r["⌀ Patentierte Erf."] = None

        rows.append(r)

    return pd.DataFrame(rows)


# ── Styling ───────────────────────────────────────────────────────────────────

def _style(df: pd.DataFrame):
    def _momentum_color(val):
        if pd.isna(val) or val is None:
            return ""
        try:
            v = float(val)
        except (TypeError, ValueError):
            return ""
        if v > 0:
            return "background-color: #e6f4ea; color: #1a7f37"
        if v < 0:
            return "background-color: #fce8e8; color: #c41230"
        return ""

    def _risk_color(val):
        if pd.isna(val) or val is None:
            return ""
        try:
            v = float(val)
        except (TypeError, ValueError):
            return ""
        if v > 30:
            return "background-color: #fff3cd"
        return ""

    def _hhi_color(val):
        if pd.isna(val) or val is None:
            return ""
        try:
            v = int(val)
        except (TypeError, ValueError):
            return ""
        if v > 2500:
            return "background-color: #fff3cd"
        return ""

    s = df.style
    for col in df.columns:
        if "Momentum" in col:
            s = s.map(_momentum_color, subset=[col])
        if col == "Mortality Rate":
            s = s.map(_risk_color, subset=[col])
        if col == "Marktanteil (HHI)":
            s = s.map(_hhi_color, subset=[col])
    return s


# ── Page ──────────────────────────────────────────────────────────────────────

st.title("📊 Analytics")

# Gate: clusters must be confirmed
_confirmed = st.session_state.get("clusters_confirmed", False)
_clustered = (
    st.session_state.get("df_clean") is not None
    and "Cluster" in getattr(st.session_state.get("df_clean"), "columns", [])
)

if not _confirmed or not _clustered:
    st.info("Run and confirm clustering first — go to **Embed & Cluster**.")
    col_a, col_b = st.columns(2)
    with col_a:
        if st.button("Go to Setup →", width="stretch"):
            st.switch_page("pages/setup.py")
    with col_b:
        if st.button("Go to Embed & Cluster →", type="primary", width="stretch"):
            st.switch_page("pages/embed_cluster.py")
    st.stop()

df_co = st.session_state.df_clean
df_de = st.session_state.get("df_deals")

if df_de is None:
    st.info(
        "No Deals CSV loaded yet.  \n"
        "Upload one on the **Setup** page to unlock all analytics metrics. "
        "You can still view company-level metrics without it."
    )
    col_go, _ = st.columns([1, 3])
    with col_go:
        if st.button("Go to Setup →", width="stretch"):
            st.switch_page("pages/setup.py")

st.divider()

# ── Column mapping ────────────────────────────────────────────────────────────

_saved_map: dict = st.session_state.get("analytics_col_map", {})

NONE_OPT = "(not available)"
co_cols   = [NONE_OPT] + df_co.columns.tolist()
de_cols   = [NONE_OPT] + (df_de.columns.tolist() if df_de is not None else [])


def _sel(label, options, key, default_candidates=None):
    """Selectbox that tries to pre-select based on saved map or candidate names."""
    saved = _saved_map.get(key)
    if saved and saved in options:
        idx = options.index(saved)
    elif default_candidates:
        found = next(
            (o for o in options if o.lower().strip() in [c.lower().strip() for c in default_candidates]),
            None,
        )
        idx = options.index(found) if found else 0
    else:
        idx = 0
    return st.selectbox(label, options, index=idx, key=f"cmap_{key}")


with st.expander("⚙️ Column Mapping", expanded=not bool(_saved_map)):
    st.caption(
        "Map the columns from your CSVs to the expected analytics fields. "
        "Unmatched fields will be skipped."
    )
    st.markdown("**Companies CSV**")
    c1, c2, c3 = st.columns(3)
    with c1:
        v_co_id   = _sel("Company ID",        co_cols, "co_id",   ["Company ID", "company_id", "id", "CompanyID"])
        v_emp     = _sel("Employees",          co_cols, "employees", ["Employees", "Headcount", "# Employees", "employees"])
        v_yf      = _sel("Year Founded",       co_cols, "year_founded", ["Year Founded", "founded", "founding_year", "year_founded"])
    with c2:
        v_tr      = _sel("Total Raised",       co_cols, "total_raised", ["Total Raised", "total_raised", "Total Funding", "funding_total"])
        v_pat     = _sel("Total Patent Families", co_cols, "total_patent_families", ["Total Patent Families", "patents", "patent_families"])
        v_ld      = _sel("Last Deal Date",     co_cols, "last_deal_date", ["Last Deal Date", "last_funding_date", "last_deal_date"])
    with c3:
        v_prof    = _sel("Profitable (bool)",  co_cols, "profitable", ["Profitable", "profitable", "is_profitable"])

    if df_de is not None:
        st.markdown("**Deals CSV**")
        d1, d2, d3 = st.columns(3)
        with d1:
            v_de_co_id = _sel("Company ID (Deals)", de_cols, "de_co_id", ["Company ID", "company_id", "id", "CompanyID"])
            v_did      = _sel("Deal ID",             de_cols, "deal_id",  ["Deal ID", "deal_id", "id"])
        with d2:
            v_ds       = _sel("Deal Size (m€)",      de_cols, "deal_size", ["Deal Size", "deal_size", "amount", "funding_amount"])
            v_dd       = _sel("Deal Date / Year",    de_cols, "deal_date", ["Deal Date", "deal_date", "date", "year", "Year"])
        with d3:
            v_series   = _sel("Series / Stage",      de_cols, "series",    ["Series", "series", "stage", "round"])
    else:
        v_de_co_id = NONE_OPT
        v_did = v_ds = v_dd = v_series = NONE_OPT

    if st.button("Apply mapping", type="primary"):
        cmap = {
            "co_id":                  None if v_co_id   == NONE_OPT else v_co_id,
            "employees":              None if v_emp      == NONE_OPT else v_emp,
            "year_founded":           None if v_yf       == NONE_OPT else v_yf,
            "total_raised":           None if v_tr       == NONE_OPT else v_tr,
            "total_patent_families":  None if v_pat      == NONE_OPT else v_pat,
            "last_deal_date":         None if v_ld       == NONE_OPT else v_ld,
            "profitable":             None if v_prof     == NONE_OPT else v_prof,
            "de_co_id":               None if v_de_co_id == NONE_OPT else v_de_co_id,
            "deal_id":                None if v_did      == NONE_OPT else v_did,
            "deal_size":              None if v_ds       == NONE_OPT else v_ds,
            "deal_date":              None if v_dd       == NONE_OPT else v_dd,
            "series":                 None if v_series   == NONE_OPT else v_series,
        }
        st.session_state["analytics_col_map"] = cmap
        st.rerun()

# Build current cmap from widgets (even without pressing Apply, use last saved)
_cmap = st.session_state.get("analytics_col_map", {})

st.divider()

# ── Compute & display ─────────────────────────────────────────────────────────

if not _cmap:
    st.info("Set up the column mapping above and click **Apply mapping** to generate the table.")
    st.stop()

with st.spinner("Computing cluster analytics…"):
    df_analytics = _compute(df_co, df_de, "Cluster", _cmap)

if df_analytics.empty:
    st.warning("No clusters found (Outliers excluded).")
    st.stop()

# ── Format display columns ────────────────────────────────────────────────────

GROUPS = {
    "Größe":           ["Gesamt", "# Companies", "⌀ Angestellte"],
    "Neuheit":         ["⌀ Year Founded", "% Recently Founded"],
    "Deals":           ["# Deals", "Deal Momentum"],
    "Funding":         ["⌀ Total Raised (m€)", "Σ Total Raised (m€)", "Σ Invested (4 J.)", "Funding Momentum"],
    "Risikoverteilung":["Capital Invested Mean", "Capital Invested Median", "Abweichung M/M"],
    "Absolutes Risiko":["VC Graduation Rate", "Mortality Rate"],
    "Markt":           ["Marktanteil (HHI)", "Marktreife"],
    "Technologie":     ["⌀ Patentierte Erf."],
}

# Group header bar
group_cols = st.columns([2] + [len(v) for v in GROUPS.values()])
group_cols[0].markdown("")  # cluster name spacer
for i, (gname, gcols) in enumerate(GROUPS.items()):
    present = [c for c in gcols if c in df_analytics.columns]
    if present:
        group_cols[i + 1].markdown(
            f"<div style='text-align:center;background:#e8f4f8;border-radius:4px;"
            f"padding:2px 4px;font-size:0.75em;font-weight:600;color:#1a6080'>{gname}</div>",
            unsafe_allow_html=True,
        )

# Column config
col_cfg = {
    "Cluster":               st.column_config.TextColumn("Cluster Name", width="large"),
    "Gesamt":                st.column_config.NumberColumn("Gesamt", format="%d"),
    "# Companies":           st.column_config.NumberColumn("# Companies", format="%d"),
    "⌀ Angestellte":         st.column_config.NumberColumn("⌀ Angestellte", format="%.1f"),
    "⌀ Year Founded":        st.column_config.NumberColumn("⌀ Year Founded", format="%d"),
    "% Recently Founded":    st.column_config.NumberColumn("% Recently Founded", format="%.1f %%"),
    "# Deals":               st.column_config.NumberColumn("# Deals", format="%d"),
    "Deal Momentum":         st.column_config.NumberColumn("Deal Momentum", format="%+.0f %%",
                                help="(2024–2025 deals) / (2022–2023 deals) − 1"),
    "⌀ Total Raised (m€)":  st.column_config.NumberColumn("⌀ Total Raised", format="%.1f m€"),
    "Σ Total Raised (m€)":  st.column_config.NumberColumn("Σ Total Raised", format="%.1f m€"),
    "Σ Invested (4 J.)":    st.column_config.NumberColumn("Σ Invested (4 J.)", format="%.1f m€",
                                help="Sum of deal sizes over the last 4 years"),
    "Funding Momentum":      st.column_config.NumberColumn("Funding Momentum", format="%+.0f %%",
                                help="(Deal size last 2 yrs) / (Deal size prev. 2 yrs) − 1"),
    "Capital Invested Mean":   st.column_config.NumberColumn("Invested Mean", format="%.2f m€"),
    "Capital Invested Median": st.column_config.NumberColumn("Invested Median", format="%.2f m€"),
    "Abweichung M/M":        st.column_config.NumberColumn("Abweichung M/M", format="%.2f",
                                help="Mean / Median of deal sizes"),
    "VC Graduation Rate":    st.column_config.NumberColumn("VC Graduation Rate", format="%.1f %%",
                                help="% of companies that reached Series B or later"),
    "Mortality Rate":        st.column_config.NumberColumn("Mortality Rate", format="%.1f %%",
                                help="% with last deal > 4 yrs ago and not profitable"),
    "Marktanteil (HHI)":    st.column_config.NumberColumn("Marktanteil (HHI)", format="%d",
                                help="Herfindahl-Hirschman Index (0–10 000). >2 500 = concentrated."),
    "Marktreife":            st.column_config.NumberColumn("Marktreife", format="%.1f",
                                help="Avg. series score (Seed=1 … E+=6)"),
    "⌀ Patentierte Erf.":   st.column_config.NumberColumn("⌀ Patentierte Erf.", format="%.1f"),
}

styled = _style(df_analytics)

st.dataframe(
    styled,
    column_config=col_cfg,
    use_container_width=True,
    hide_index=True,
    height=min(60 + 35 * (len(df_analytics) + 1), 700),
)

# ── Export ────────────────────────────────────────────────────────────────────
st.download_button(
    "⬇ Download analytics CSV",
    df_analytics.to_csv(index=False),
    "cluster_analytics.csv",
    "text/csv",
    type="primary",
    width="content",
)
