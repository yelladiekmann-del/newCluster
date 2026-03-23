"""Analytics page — cluster analytics table with rankings."""

import datetime

import numpy as np
import pandas as pd
import plotly.express as px
import streamlit as st

from styles import inject_global_css, page_header

inject_global_css()

# ── Constants ─────────────────────────────────────────────────────────────────

CLUSTER_COLORS = [
    "#26B4D2", "#F76664", "#7A6ECC", "#F7D864",
    "#4AC596", "#e8845c", "#516e81", "#7496b2",
    "#a78bfa", "#34d399", "#fb923c", "#60a5fa",
]

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

GRAD_OWNERSHIP = {"acquired/merged", "publicly held"}
GRAD_FINANCING_SUBSTRINGS = ("formerly", "private equity-backed")

# "higher" = higher value is better for ranking/highlighting
# "lower"  = lower value is better
METRIC_DIRECTION: dict[str, str] = {
    "# Companies":           "higher",
    "⌀ Angestellte":         "higher",
    "% Recently Founded":    "higher",
    "# Deals":               "higher",
    "Deal Momentum":         "higher",
    "⌀ Total Raised (m€)":  "higher",
    "Σ Total Raised (m€)":  "higher",
    "Σ Invested (4 J.)":    "higher",
    "Funding Momentum":      "higher",
    "Capital Invested Mean":   "higher",
    "Capital Invested Median": "higher",
    "Abweichung M/M":        "lower",
    "VC Graduation Rate":    "higher",
    "Mortality Rate":        "lower",
    "Marktanteil (HHI)":    "lower",
    "Marktreife":            "higher",
    "⌀ Patentierte Erf.":   "higher",
}

# Excluded from overall ranking score (neutral / size-only)
RANKING_EXCLUDE = {"Gesamt", "⌀ Year Founded"}

COLUMN_DESCRIPTIONS: dict[str, str] = {
    "Gesamt":               "Total rows for this cluster in the companies file.",
    "# Companies":          "Count of unique Company IDs in the cluster.",
    "⌀ Angestellte":        "Average number of employees across companies.",
    "⌀ Year Founded":       "Average founding year. Earlier = more established; later = more innovative.",
    "% Recently Founded":   "% of companies founded within the last 5 years (≥ Y−5). Higher = younger, more innovative cohort.",
    "# Deals":              "Total deal records linked to this cluster's companies.",
    "Deal Momentum":        "Deal activity trend: Count(Y & Y−1) / Count(Y−2 & Y−3) − 1. Positive = accelerating deal flow.",
    "⌀ Total Raised (m€)": "Average total funding raised per company (from companies file).",
    "Σ Total Raised (m€)": "Total funding raised across all companies in the cluster.",
    "Σ Invested (4 J.)":   "Sum of all deal sizes in years Y, Y−1, Y−2, Y−3.",
    "Funding Momentum":     "Funding trend: (Sum deal size Y & Y−1) / (Sum deal size Y−2 & Y−3) − 1. Positive = growing investment volume.",
    "Capital Invested Mean":   "Average deal size across all deals in the cluster.",
    "Capital Invested Median": "Median deal size. Less sensitive to outliers than the mean.",
    "Abweichung M/M":       "Mean ÷ Median of deal sizes. Close to 1.0 = symmetric distribution. Higher = a few very large deals skew the mean upward.",
    "VC Graduation Rate":   "% of companies that 'graduated': acquired, publicly held, or PE-backed — excluding bankrupt/out-of-business ones.",
    "Mortality Rate":       "% of companies with Business Status = 'Out of Business' or starting with 'Bankruptcy'. Lower is better.",
    "Marktanteil (HHI)":   "Herfindahl-Hirschman Index based on Total Raised within the cluster (0–10 000). >2 500 = highly concentrated. Lower = more competitive market.",
    "Marktreife":           "Average deal-stage score (Seed=1, A=2, B=3, C=4, D=5, E+=6). Higher = later-stage cluster.",
    "⌀ Patentierte Erf.":  "Average number of patent families per company. Proxy for innovation intensity.",
}

GROUPS: dict[str, list[str]] = {
    "Größe":            ["Gesamt", "# Companies", "⌀ Angestellte"],
    "Neuheit":          ["⌀ Year Founded", "% Recently Founded"],
    "Deals":            ["# Deals", "Deal Momentum"],
    "Funding":          ["⌀ Total Raised (m€)", "Σ Total Raised (m€)", "Σ Invested (4 J.)", "Funding Momentum"],
    "Risikoverteilung": ["Capital Invested Mean", "Capital Invested Median", "Abweichung M/M"],
    "Absolutes Risiko": ["VC Graduation Rate", "Mortality Rate"],
    "Markt":            ["Marktanteil (HHI)", "Marktreife"],
    "Technologie":      ["⌀ Patentierte Erf."],
}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _to_year(series: pd.Series) -> pd.Series:
    """Convert a column of dates or plain years to float years (NaN for missing)."""
    dt = pd.to_datetime(series, errors="coerce", dayfirst=True)
    years = dt.dt.year.astype(float)
    failed = years.isna()
    if failed.any():
        numeric = pd.to_numeric(series[failed], errors="coerce").astype(float)
        years = years.copy()
        years[failed] = numeric
    return years


def _get_reference_year(df_de, dd_col: str | None) -> int:
    """Return max deal year from Deals CSV; fallback to current year."""
    fallback = datetime.date.today().year
    if df_de is None or not dd_col or dd_col not in df_de.columns:
        return fallback
    years = _to_year(df_de[dd_col])
    max_yr = years.dropna().max()
    return int(max_yr) if (not pd.isna(max_yr) and max_yr > 0) else fallback


def _vc_grad_flag(row: pd.Series, bs_col, os_col, cfs_col) -> int:
    bs  = str(row[bs_col]).strip().lower()  if bs_col  else ""
    os  = str(row[os_col]).strip().lower()  if os_col  else ""
    cfs = str(row[cfs_col]).strip().lower() if cfs_col else ""
    if bs == "out of business" or bs == "bankruptcy":
        return 0
    if os in GRAD_OWNERSHIP:
        return 1
    if any(sub in cfs for sub in GRAD_FINANCING_SUBSTRINGS):
        return 1
    return 0


def _mortality_flag(row: pd.Series, bs_col) -> int:
    if not bs_col:
        return 0
    bs = str(row[bs_col]).strip().lower()
    return 1 if (bs == "out of business" or bs.startswith("bankruptcy")) else 0


# ── Core computation ──────────────────────────────────────────────────────────

def _compute(
    df_co: pd.DataFrame,
    df_de: pd.DataFrame | None,
    cluster_col: str,
    cmap: dict,
) -> tuple[pd.DataFrame, int]:
    """Compute per-cluster analytics. Returns (DataFrame, reference_year Y)."""
    co_id    = cmap.get("co_id")
    de_co_id = cmap.get("de_co_id")

    Y = _get_reference_year(df_de, cmap.get("deal_date"))
    clusters = sorted([c for c in df_co[cluster_col].unique() if c != "Outliers"])

    rows = []
    for cname in clusters:
        co = df_co[df_co[cluster_col] == cname]

        if df_de is not None and co_id and de_co_id \
                and co_id in co.columns and de_co_id in df_de.columns:
            ids = co[co_id].dropna().unique()
            de = df_de[df_de[de_co_id].isin(ids)].copy()
        else:
            de = pd.DataFrame()

        r: dict = {"Cluster": cname}

        # ── Größe ─────────────────────────────────────────────────────────────
        r["Gesamt"] = len(co)
        r["# Companies"] = int(co[co_id].nunique()) if (co_id and co_id in co.columns) else len(co)

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
            r["⌀ Year Founded"]     = int(round(vals.mean())) if len(vals) else None
            r["% Recently Founded"] = round((vals >= (Y - 5)).sum() / len(vals) * 100, 1) if len(vals) else None
        else:
            r["⌀ Year Founded"]     = None
            r["% Recently Founded"] = None

        # ── Deals ─────────────────────────────────────────────────────────────
        if not de.empty:
            did = cmap.get("deal_id")
            r["# Deals"] = int(de[did].nunique()) if (did and did in de.columns) else len(de)

            dd = cmap.get("deal_date")
            if dd and dd in de.columns:
                yrs = _to_year(de[dd])
                recent_n = int(((yrs >= Y - 1) & (yrs <= Y)).sum())
                prev_n   = int(((yrs >= Y - 3) & (yrs <= Y - 2)).sum())
                r["Deal Momentum"] = round((recent_n / prev_n - 1) * 100, 0) if prev_n > 0 else None
            else:
                r["Deal Momentum"] = None
        else:
            r["# Deals"]       = None
            r["Deal Momentum"] = None

        # ── Funding ───────────────────────────────────────────────────────────
        tr = cmap.get("total_raised")
        if tr and tr in co.columns:
            vals = pd.to_numeric(co[tr], errors="coerce").dropna()
            r["⌀ Total Raised (m€)"] = round(float(vals.mean()), 1) if len(vals) else None
            r["Σ Total Raised (m€)"] = round(float(vals.sum()),  1) if len(vals) else None
        else:
            r["⌀ Total Raised (m€)"] = None
            r["Σ Total Raised (m€)"] = None

        if not de.empty:
            ds = cmap.get("deal_size")
            dd = cmap.get("deal_date")
            if ds and ds in de.columns:
                deal_vals = pd.to_numeric(de[ds], errors="coerce")
                valid_size = deal_vals.notna()

                if dd and dd in de.columns:
                    yrs = _to_year(de[dd])
                    mask_4yr  = (yrs >= Y - 3) & (yrs <= Y) & valid_size
                    mask_rec  = (yrs >= Y - 1) & (yrs <= Y) & valid_size
                    mask_prev = (yrs >= Y - 3) & (yrs <= Y - 2) & valid_size
                    r["Σ Invested (4 J.)"] = round(float(deal_vals[mask_4yr].sum()), 1)
                    rec_sum  = deal_vals[mask_rec].sum()
                    prev_sum = deal_vals[mask_prev].sum()
                    r["Funding Momentum"] = round((rec_sum / prev_sum - 1) * 100, 1) if prev_sum > 0 else None
                else:
                    r["Σ Invested (4 J.)"] = None
                    r["Funding Momentum"]   = None

                mean_v   = float(deal_vals.mean())   if deal_vals.notna().any() else None
                median_v = float(deal_vals.median()) if deal_vals.notna().any() else None
                r["Capital Invested Mean"]   = round(mean_v,   2) if mean_v   is not None else None
                r["Capital Invested Median"] = round(median_v, 2) if median_v is not None else None
                r["Abweichung M/M"] = round(mean_v / median_v, 2) \
                    if (mean_v is not None and median_v and median_v > 0) else None
            else:
                for k in ["Σ Invested (4 J.)", "Funding Momentum",
                          "Capital Invested Mean", "Capital Invested Median", "Abweichung M/M"]:
                    r[k] = None

            sc = cmap.get("series")
            if sc and sc in de.columns:
                s_lower = de[sc].astype(str).str.lower().str.strip()
                scores  = s_lower.map(lambda v: SERIES_SCORE.get(v, np.nan))
                r["Marktreife"] = round(float(scores.mean()), 1) if scores.notna().any() else None
            else:
                r["Marktreife"] = None
        else:
            for k in ["Σ Invested (4 J.)", "Funding Momentum",
                      "Capital Invested Mean", "Capital Invested Median", "Abweichung M/M",
                      "Marktreife"]:
                r[k] = None

        # ── VC Graduation Rate ────────────────────────────────────────────────
        bs_col  = cmap.get("business_status")
        os_col  = cmap.get("ownership_status")
        cfs_col = cmap.get("company_financing_status")
        has_any = any(c and c in co.columns for c in [bs_col, os_col, cfs_col])
        if has_any:
            _bs  = bs_col  if (bs_col  and bs_col  in co.columns) else None
            _os  = os_col  if (os_col  and os_col  in co.columns) else None
            _cfs = cfs_col if (cfs_col and cfs_col in co.columns) else None
            flags = co.apply(_vc_grad_flag, axis=1, bs_col=_bs, os_col=_os, cfs_col=_cfs)
            r["VC Graduation Rate"] = round(float(flags.mean()) * 100, 1)
        else:
            r["VC Graduation Rate"] = None

        # ── Mortality Rate ────────────────────────────────────────────────────
        if bs_col and bs_col in co.columns:
            flags = co.apply(_mortality_flag, axis=1, bs_col=bs_col)
            r["Mortality Rate"] = round(float(flags.mean()) * 100, 1)
        else:
            r["Mortality Rate"] = None

        # ── HHI ───────────────────────────────────────────────────────────────
        if tr and tr in co.columns:
            vals  = pd.to_numeric(co[tr], errors="coerce").fillna(0)
            total = vals.sum()
            if total > 0:
                r["Marktanteil (HHI)"] = int(round(((vals / total) ** 2).sum() * 10000))
            else:
                r["Marktanteil (HHI)"] = None
        else:
            r["Marktanteil (HHI)"] = None

        # ── Patents ───────────────────────────────────────────────────────────
        pat = cmap.get("total_patent_families")
        if pat and pat in co.columns:
            vals = pd.to_numeric(co[pat], errors="coerce").dropna()
            r["⌀ Patentierte Erf."] = round(float(vals.mean()), 1) if len(vals) else None
        else:
            r["⌀ Patentierte Erf."] = None

        rows.append(r)

    return pd.DataFrame(rows), Y


# ── Styling ───────────────────────────────────────────────────────────────────

def _highlight_top2(col: pd.Series) -> list[str]:
    """Cyan = rank 1, soft green = rank 2, per METRIC_DIRECTION."""
    direction = METRIC_DIRECTION.get(col.name, "higher")
    vals = pd.to_numeric(col, errors="coerce")
    ranks = vals.rank(ascending=(direction == "lower"), method="min", na_option="bottom")
    out = []
    for r in ranks:
        if r == 1:
            out.append("background-color: #e8f7fb; color: #0a7c96; font-weight: 700")
        elif r == 2:
            out.append("background-color: #dff0e8; color: #15803d")
        else:
            out.append("")
    return out


# ProgressColumn columns handle their own visual — skip Styler highlights for them
_PROGRESS_COLS = {"% Recently Founded", "VC Graduation Rate", "Mortality Rate"}


def _style(df: pd.DataFrame):
    s = df.style
    for col in df.columns:
        if col in METRIC_DIRECTION and col not in _PROGRESS_COLS:
            s = s.apply(_highlight_top2, subset=[col])
    return s


# ── Ranking ───────────────────────────────────────────────────────────────────

def _compute_ranking(df: pd.DataFrame) -> pd.DataFrame:
    """Normalise each metric 0–1, average, return sorted ranking table."""
    rank_cols = [
        c for c in METRIC_DIRECTION
        if c in df.columns and c not in RANKING_EXCLUDE
    ]
    norm_scores: dict[str, pd.Series] = {}
    for col in rank_cols:
        vals = pd.to_numeric(df[col], errors="coerce")
        vmin, vmax = vals.min(), vals.max()
        if pd.isna(vmin) or vmax == vmin:
            continue
        if METRIC_DIRECTION[col] == "higher":
            norm_scores[col] = (vals - vmin) / (vmax - vmin)
        else:
            norm_scores[col] = (vmax - vals) / (vmax - vmin)

    if not norm_scores:
        return pd.DataFrame()

    score_df = pd.DataFrame(norm_scores, index=df.index)
    avg = score_df.mean(axis=1)

    result = df[["Cluster"]].copy().reset_index(drop=True)
    result["Score"] = (avg.values * 100).round(1)
    result = result.sort_values("Score", ascending=False).reset_index(drop=True)
    result.insert(0, "Rank", range(1, len(result) + 1))
    return result


# ── Page ──────────────────────────────────────────────────────────────────────

_hdr_col, _export_col = st.columns([4, 1])
with _hdr_col:
    page_header("Analytics", "Cluster performance, rankings, and export.")

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
        "Upload one on the **Setup** page to unlock deal-based metrics. "
        "Company-level metrics are still available."
    )
    col_go, _ = st.columns([1, 3])
    with col_go:
        if st.button("Go to Setup →", width="stretch"):
            st.switch_page("pages/setup.py")

# ── Column mapping ────────────────────────────────────────────────────────────

_saved_map: dict = st.session_state.get("analytics_col_map", {})
NONE_OPT = "(not available)"
co_cols  = [NONE_OPT] + df_co.columns.tolist()
de_cols  = [NONE_OPT] + (df_de.columns.tolist() if df_de is not None else [])


def _sel(label, options, key, candidates=None):
    saved = _saved_map.get(key)
    if saved and saved in options:
        idx = options.index(saved)
    elif candidates:
        found = next(
            (o for o in options if o.lower().strip() in [c.lower().strip() for c in candidates]),
            None,
        )
        idx = options.index(found) if found else 0
    else:
        idx = 0
    return st.selectbox(label, options, index=idx, key=f"cmap_{key}")


_map_status_col_r, _ = st.columns([1, 3])
with _map_status_col_r:
    if _saved_map:
        st.markdown(
            '<span class="hy-chip hy-chip-green">✓ Mapping applied</span>',
            unsafe_allow_html=True,
        )

with st.expander("Column Mapping", expanded=not bool(_saved_map)):
    st.caption("Map CSV columns to analytics fields. Unmapped fields show as N/A.")

    st.markdown("**Companies CSV**")
    c1, c2, c3 = st.columns(3)
    with c1:
        v_co_id = _sel("Company ID",           co_cols, "co_id",
                       ["Company ID", "company_id", "id", "CompanyID"])
        v_emp   = _sel("Employees",             co_cols, "employees",
                       ["Employees", "Headcount", "# Employees", "employees"])
        v_yf    = _sel("Year Founded",          co_cols, "year_founded",
                       ["Year Founded", "founded", "founding_year", "year_founded"])
    with c2:
        v_tr    = _sel("Total Raised",          co_cols, "total_raised",
                       ["Total Raised", "total_raised", "Total Funding", "funding_total"])
        v_pat   = _sel("Total Patent Families", co_cols, "total_patent_families",
                       ["Total Patent Families", "patents", "patent_families"])
        v_bs    = _sel("Business Status",       co_cols, "business_status",
                       ["Business Status", "business_status", "status"])
    with c3:
        v_os    = _sel("Ownership Status",      co_cols, "ownership_status",
                       ["Ownership Status", "ownership_status", "ownership"])
        v_cfs   = _sel("Company Financing Status", co_cols, "company_financing_status",
                       ["Company Financing Status", "company_financing_status",
                        "financing_status", "Financing Status"])

    if df_de is not None:
        st.markdown("**Deals CSV**")
        d1, d2, d3 = st.columns(3)
        with d1:
            v_de_co_id = _sel("Company ID (Deals)", de_cols, "de_co_id",
                              ["Company ID", "company_id", "id", "CompanyID"])
            v_did      = _sel("Deal ID",             de_cols, "deal_id",
                              ["Deal ID", "deal_id", "id"])
        with d2:
            v_ds       = _sel("Deal Size (m€)",      de_cols, "deal_size",
                              ["Deal Size", "deal_size", "amount", "funding_amount"])
            v_dd       = _sel("Deal Date / Year",    de_cols, "deal_date",
                              ["Deal Date", "deal_date", "date", "year", "Year"])
        with d3:
            v_series   = _sel("Series / Stage",      de_cols, "series",
                              ["Series", "series", "stage", "round"])
    else:
        v_de_co_id = v_did = v_ds = v_dd = v_series = NONE_OPT

    if st.button("Apply mapping", type="primary"):
        def _v(val):
            return None if val == NONE_OPT else val
        st.session_state["analytics_col_map"] = {
            "co_id":                    _v(v_co_id),
            "employees":                _v(v_emp),
            "year_founded":             _v(v_yf),
            "total_raised":             _v(v_tr),
            "total_patent_families":    _v(v_pat),
            "business_status":          _v(v_bs),
            "ownership_status":         _v(v_os),
            "company_financing_status": _v(v_cfs),
            "de_co_id":                 _v(v_de_co_id),
            "deal_id":                  _v(v_did),
            "deal_size":                _v(v_ds),
            "deal_date":                _v(v_dd),
            "series":                   _v(v_series),
        }
        st.rerun()

_cmap = st.session_state.get("analytics_col_map", {})

if not _cmap:
    st.info("Set up the column mapping above and click **Apply mapping** to generate the analytics.")
    st.stop()

# ── Compute ───────────────────────────────────────────────────────────────────

with st.spinner("Computing cluster analytics…"):
    df_analytics, _ref_year = _compute(df_co, df_de, "Cluster", _cmap)

if df_analytics.empty:
    st.warning("No clusters found (Outliers excluded).")
    st.stop()

df_rank = _compute_ranking(df_analytics)

# ── Color map (shared across all charts) ─────────────────────────────────────
_named_sorted    = sorted(df_analytics["Cluster"].tolist())
_chart_color_map = {
    cname: CLUSTER_COLORS[i % len(CLUSTER_COLORS)]
    for i, cname in enumerate(_named_sorted)
}

# ── KPI values (all aggregate — whole market, not per-cluster peaks) ──────────

_n_companies_total = int(df_co["Cluster"].notna().sum()) if "Cluster" in df_co.columns else len(df_co)
_n_clusters        = len(df_analytics)

# Total Capital Raised — sum across all companies
_tr_col = _cmap.get("total_raised")
_total_capital = (
    pd.to_numeric(df_co[_tr_col], errors="coerce").sum()
    if _tr_col and _tr_col in df_co.columns
    else None
)

# Total Deals — sum across all clusters
_total_deals = None
if "# Deals" in df_analytics.columns:
    _deal_vals = pd.to_numeric(df_analytics["# Deals"], errors="coerce").dropna()
    if len(_deal_vals):
        _total_deals = int(_deal_vals.sum())

# Market Momentum — deal-count-weighted average of per-cluster Deal Momentum
_market_momentum = None
if "Deal Momentum" in df_analytics.columns and "# Deals" in df_analytics.columns:
    _mom_vals    = pd.to_numeric(df_analytics["Deal Momentum"], errors="coerce")
    _deal_w      = pd.to_numeric(df_analytics["# Deals"],       errors="coerce").fillna(0)
    _valid       = _mom_vals.notna() & (_deal_w > 0)
    if _valid.any():
        _market_momentum = round(
            float((_mom_vals[_valid] * _deal_w[_valid]).sum() / _deal_w[_valid].sum()), 1
        )

# Market Maturity — deal-count-weighted average of Marktreife (avg deal stage)
_market_maturity = None
if "Marktreife" in df_analytics.columns and "# Deals" in df_analytics.columns:
    _mat_vals = pd.to_numeric(df_analytics["Marktreife"], errors="coerce")
    _deal_w   = pd.to_numeric(df_analytics["# Deals"],   errors="coerce").fillna(0)
    _valid    = _mat_vals.notna() & (_deal_w > 0)
    if _valid.any():
        _market_maturity = round(
            float((_mat_vals[_valid] * _deal_w[_valid]).sum() / _deal_w[_valid].sum()), 2
        )

# VC Graduation Rate — company-count-weighted average across clusters
_avg_grad = None
if "VC Graduation Rate" in df_analytics.columns:
    _grad_vals  = pd.to_numeric(df_analytics["VC Graduation Rate"], errors="coerce")
    _co_weights = pd.to_numeric(df_analytics["# Companies"],        errors="coerce").fillna(
                    df_analytics.get("Gesamt", pd.Series(dtype=float)))
    _valid = _grad_vals.notna() & (_co_weights > 0)
    if _valid.any():
        _avg_grad = round(
            float((_grad_vals[_valid] * _co_weights[_valid]).sum() / _co_weights[_valid].sum()), 1
        )


def _kpi_card(label: str, value: str, sub: str = "") -> str:
    sub_html = f'<div class="hy-kpi-sub">{sub}</div>' if sub else ""
    return (
        f'<div class="hy-kpi-card">'
        f'<div class="hy-kpi-label">{label}</div>'
        f'<div class="hy-kpi-value">{value}</div>'
        f'{sub_html}'
        f'</div>'
    )


# ── SECTION: KPI Overview ─────────────────────────────────────────────────────

st.markdown('<div class="hy-section-title" style="margin-top:20px">Overview</div>', unsafe_allow_html=True)

_capital_str = f"{_total_capital:,.0f} m€" if _total_capital is not None else "N/A"
_deals_str   = f"{_total_deals:,}" if _total_deals is not None else "N/A"

if _market_momentum is not None:
    _sign = "+" if _market_momentum >= 0 else ""
    _mom_str = f"{_sign}{_market_momentum:.1f}%"
    _mom_color = "#15803d" if _market_momentum >= 0 else "#dc2626"
    _mom_sub = f'<span style="color:{_mom_color}">deal-weighted avg</span>'
else:
    _mom_str = "N/A"
    _mom_sub = ""

# Maturity label: map numeric avg stage to a human-readable label
_STAGE_LABELS = {0: "Pre-Seed", 1: "Seed", 2: "Series A", 3: "Series B",
                 4: "Series C", 5: "Series D", 6: "Late Stage", 7: "IPO"}
if _market_maturity is not None:
    _mat_str = f"{_market_maturity:.1f}"
    _mat_stage = _STAGE_LABELS.get(round(_market_maturity), "")
    _mat_sub = _mat_stage if _mat_stage else "avg deal stage (0–7)"
else:
    _mat_str = "N/A"
    _mat_sub = "avg deal stage"

_grad_str = f"{_avg_grad:.1f}%" if _avg_grad is not None else "N/A"
_grad_sub  = "weighted by cluster size" if _avg_grad is not None else ""

_kpis_html = (
    f'<div style="display:flex;gap:12px;margin-bottom:16px">'
    + _kpi_card("Total Companies",    f"{_n_companies_total:,}", "across all clusters")
    + _kpi_card("Active Clusters",    str(_n_clusters),          "named clusters")
    + _kpi_card("Total Capital Raised", _capital_str,            "all clusters combined")
    + _kpi_card("Total Deals",        _deals_str,                "all clusters combined")
    + _kpi_card("Market Momentum",    _mom_str,                  _mom_sub)
    + _kpi_card("Market Maturity",    _mat_str,                  _mat_sub)
    + '</div>'
)
st.markdown(_kpis_html, unsafe_allow_html=True)

st.caption(
    f"Reference year **Y = {_ref_year}** · "
    f"Recent window: {_ref_year - 1}–{_ref_year} · "
    f"Previous window: {_ref_year - 3}–{_ref_year - 2} · "
    f"Recently Founded threshold: ≥ {_ref_year - 5}"
)

# ── SECTION: Spotlight (top performers) ───────────────────────────────────────

_spotlights = []

# Top Funded
_tr_metric = "Σ Total Raised (m€)" if "Σ Total Raised (m€)" in df_analytics.columns else "⌀ Total Raised (m€)"
if _tr_metric in df_analytics.columns:
    _tr_vals = pd.to_numeric(df_analytics[_tr_metric], errors="coerce")
    if _tr_vals.notna().any():
        _top_idx = _tr_vals.idxmax()
        _spotlights.append({
            "label": "Top Funded",
            "cluster": df_analytics.loc[_top_idx, "Cluster"],
            "metric": f"{_tr_vals[_top_idx]:,.1f} m€",
            "color": "#26B4D2",
        })

# Fastest Growing (Deal Momentum)
if "Deal Momentum" in df_analytics.columns:
    _dm_vals = pd.to_numeric(df_analytics["Deal Momentum"], errors="coerce")
    if _dm_vals.notna().any():
        _top_idx = _dm_vals.idxmax()
        _dm_v = _dm_vals[_top_idx]
        _sign = "+" if _dm_v >= 0 else ""
        _spotlights.append({
            "label": "Fastest Growing",
            "cluster": df_analytics.loc[_top_idx, "Cluster"],
            "metric": f"{_sign}{_dm_v:.0f}% deal momentum",
            "color": "#4AC596",
        })

# Most Active (# Deals)
if "# Deals" in df_analytics.columns:
    _deal_vals = pd.to_numeric(df_analytics["# Deals"], errors="coerce")
    if _deal_vals.notna().any():
        _top_idx = _deal_vals.idxmax()
        _spotlights.append({
            "label": "Most Active",
            "cluster": df_analytics.loc[_top_idx, "Cluster"],
            "metric": f"{int(_deal_vals[_top_idx]):,} deals",
            "color": "#7A6ECC",
        })

if _spotlights:
    st.markdown('<div class="hy-section-title" style="margin-top:4px;margin-bottom:10px">Spotlight</div>', unsafe_allow_html=True)
    _spot_cols = st.columns(len(_spotlights))
    for _col, _sp in zip(_spot_cols, _spotlights):
        with _col:
            with st.container(border=True):
                st.markdown(
                    f'<div style="font-size:9px;font-weight:700;text-transform:uppercase;'
                    f'letter-spacing:0.07em;color:{_sp["color"]};font-family:IBM Plex Mono,monospace;'
                    f'margin-bottom:6px">{_sp["label"]}</div>'
                    f'<div style="font-size:14px;font-weight:700;color:#0d1f2d;'
                    f'letter-spacing:-0.01em;margin-bottom:8px">{_sp["cluster"]}</div>'
                    f'<span class="hy-cl-chip">{_sp["metric"]}</span>',
                    unsafe_allow_html=True,
                )

# ── SECTION: Cluster Size + Funding charts (side by side) ─────────────────────

def _bar_layout(fig, xlab=""):
    fig.update_layout(
        showlegend=False,
        margin=dict(l=0, r=50, t=6, b=0),
        xaxis=dict(title=xlab, showgrid=True, gridcolor="#e4eaf2", gridwidth=1,
                   tickfont=dict(family="IBM Plex Mono", size=10)),
        yaxis=dict(title="", tickfont=dict(family="IBM Plex Sans", size=11)),
        plot_bgcolor="#ffffff", paper_bgcolor="#f7f9fc",
        font=dict(family="IBM Plex Sans", size=11, color="#0d1f2d"),
        height=max(180, 38 * len(df_analytics)),
    )
    fig.update_traces(marker_line_width=0, opacity=0.88,
                      textfont=dict(family="IBM Plex Mono", size=10, color="#0d1f2d"))
    return fig


_size_col_name = "# Companies" if "# Companies" in df_analytics.columns else "Gesamt"
_fund_col_name = "Σ Total Raised (m€)" if "Σ Total Raised (m€)" in df_analytics.columns else None

_show_size  = _size_col_name in df_analytics.columns
_show_fund  = _fund_col_name is not None and _fund_col_name in df_analytics.columns

if _show_size or _show_fund:
    _chart_cols = st.columns(2)

    if _show_size:
        with _chart_cols[0]:
            st.markdown('<div class="hy-section-title" style="margin-bottom:4px">Cluster Size</div>', unsafe_allow_html=True)
            _sz = df_analytics[["Cluster", _size_col_name]].sort_values(_size_col_name)
            _fig_sz = px.bar(_sz, x=_size_col_name, y="Cluster", orientation="h",
                             color="Cluster", color_discrete_map=_chart_color_map, text=_size_col_name)
            _fig_sz.update_traces(texttemplate="%{text:,}", textposition="outside")
            st.plotly_chart(_bar_layout(_fig_sz, "Companies"), use_container_width=True)

    if _show_fund:
        with _chart_cols[1]:
            st.markdown('<div class="hy-section-title" style="margin-bottom:4px">Total Capital Raised</div>', unsafe_allow_html=True)
            _fd = df_analytics[["Cluster", _fund_col_name]].dropna(subset=[_fund_col_name]).sort_values(_fund_col_name)
            _fig_fd = px.bar(_fd, x=_fund_col_name, y="Cluster", orientation="h",
                             color="Cluster", color_discrete_map=_chart_color_map, text=_fund_col_name)
            _fig_fd.update_traces(texttemplate="%{text:,.0f} m€", textposition="outside")
            st.plotly_chart(_bar_layout(_fig_fd, "m€"), use_container_width=True)

# ── SECTION: Momentum comparison chart ────────────────────────────────────────

_has_deal_mom  = "Deal Momentum"    in df_analytics.columns
_has_fund_mom  = "Funding Momentum" in df_analytics.columns

if _has_deal_mom or _has_fund_mom:
    st.markdown('<div class="hy-section-title" style="margin-top:8px;margin-bottom:4px">Momentum Overview</div>', unsafe_allow_html=True)
    st.caption("How fast deal activity and investment volume are growing (or shrinking) per cluster.")

    _mom_cols = [c for c in ["Deal Momentum", "Funding Momentum"] if c in df_analytics.columns]
    _mom_df = df_analytics[["Cluster"] + _mom_cols].copy()
    # Sort by first momentum col
    _mom_df = _mom_df.sort_values(_mom_cols[0], na_position="last")

    _fig_mom = px.bar(
        _mom_df.melt(id_vars="Cluster", value_vars=_mom_cols, var_name="Type", value_name="Momentum %"),
        x="Momentum %", y="Cluster", color="Type", barmode="group", orientation="h",
        color_discrete_map={"Deal Momentum": "#26B4D2", "Funding Momentum": "#4AC596"},
        height=max(200, 44 * len(df_analytics)),
    )
    _fig_mom.update_layout(
        showlegend=True,
        legend=dict(orientation="h", yanchor="bottom", y=1.01, xanchor="left", x=0,
                    font=dict(size=11)),
        margin=dict(l=0, r=20, t=30, b=0),
        xaxis=dict(title="Change vs. prior period (%)", showgrid=True, gridcolor="#e4eaf2",
                   tickfont=dict(family="IBM Plex Mono", size=10),
                   zeroline=True, zerolinecolor="#c8d8e4", zerolinewidth=1.5),
        yaxis=dict(title="", tickfont=dict(family="IBM Plex Sans", size=11)),
        plot_bgcolor="#ffffff", paper_bgcolor="#f7f9fc",
        font=dict(family="IBM Plex Sans", size=11, color="#0d1f2d"),
    )
    _fig_mom.update_traces(marker_line_width=0, opacity=0.88)
    st.plotly_chart(_fig_mom, use_container_width=True)

st.divider()

# ── SECTION: Analytics Table ──────────────────────────────────────────────────

_tbl_hdr, _desc_toggle = st.columns([3, 1])
with _tbl_hdr:
    st.markdown('<div class="hy-section-title">Analytics Table</div>', unsafe_allow_html=True)
with _desc_toggle:
    st.markdown('<div style="padding-top:4px"></div>', unsafe_allow_html=True)

with st.expander("Column Descriptions", expanded=False):
    items = [(k, v) for k, v in COLUMN_DESCRIPTIONS.items() if k in df_analytics.columns]
    mid = (len(items) + 1) // 2
    left_col, right_col = st.columns(2)
    for i, (col_name, desc) in enumerate(items):
        dir_icon = {"higher": " ↑", "lower": " ↓"}.get(METRIC_DIRECTION.get(col_name, ""), "")
        target = left_col if i < mid else right_col
        target.markdown(
            f"**{col_name}**{dir_icon}  \n<small style='color:#555'>{desc}</small>",
            unsafe_allow_html=True,
        )
        target.markdown("")

# Drop the redundant "Gesamt" column (always == # Companies when no duplicates)
_tbl_df = df_analytics.drop(columns=["Gesamt"], errors="ignore").copy()

# Coerce all non-Cluster columns to numeric so NaN renders as empty (not "None")
for _c in _tbl_df.columns:
    if _c != "Cluster":
        _tbl_df[_c] = pd.to_numeric(_tbl_df[_c], errors="coerce")

col_cfg = {
    "Cluster":               st.column_config.TextColumn("Cluster", width="large"),
    "# Companies":           st.column_config.NumberColumn("Companies",        format="%d"),
    "⌀ Angestellte":         st.column_config.NumberColumn("Avg Employees",    format="%.0f"),
    "⌀ Year Founded":        st.column_config.NumberColumn("Founded",          format="%d"),
    "% Recently Founded":    st.column_config.ProgressColumn(
                                "Recently Founded", format="%.1f%%", min_value=0, max_value=100,
                                help=f"% companies founded ≥ {_ref_year - 5}"),
    "# Deals":               st.column_config.NumberColumn("Deals",            format="%d"),
    "Deal Momentum":         st.column_config.NumberColumn("Deal Momentum",    format="%+.0f%%",
                                help=f"Count({_ref_year-1}–{_ref_year}) / Count({_ref_year-3}–{_ref_year-2}) − 1"),
    "⌀ Total Raised (m€)":  st.column_config.NumberColumn("Avg Raised (m€)",  format="%.1f"),
    "Σ Total Raised (m€)":  st.column_config.NumberColumn("Total Raised (m€)", format="%.1f"),
    "Σ Invested (4 J.)":    st.column_config.NumberColumn("4Y Invested (m€)",  format="%.1f",
                                help=f"Sum of deal sizes {_ref_year-3}–{_ref_year}"),
    "Funding Momentum":      st.column_config.NumberColumn("Funding Momentum", format="%+.1f%%",
                                help=f"(Sum {_ref_year-1}–{_ref_year}) / (Sum {_ref_year-3}–{_ref_year-2}) − 1"),
    "Capital Invested Mean":   st.column_config.NumberColumn("Deal Mean (m€)",   format="%.2f"),
    "Capital Invested Median": st.column_config.NumberColumn("Deal Median (m€)", format="%.2f"),
    "Abweichung M/M":        st.column_config.NumberColumn("Mean / Median",    format="%.2f",
                                help="Invested Mean ÷ Invested Median"),
    "VC Graduation Rate":    st.column_config.ProgressColumn(
                                "Graduation Rate", format="%.1f%%", min_value=0, max_value=100,
                                help="Acquired / Publicly held / PE-backed (excl. bankrupt)"),
    "Mortality Rate":        st.column_config.ProgressColumn(
                                "Mortality Rate",  format="%.1f%%", min_value=0, max_value=100,
                                help="Business Status = Out of Business or Bankruptcy"),
    "Marktanteil (HHI)":    st.column_config.NumberColumn("HHI",               format="%d",
                                help="0–10 000. > 2 500 = highly concentrated."),
    "Marktreife":            st.column_config.NumberColumn("Maturity",          format="%.1f",
                                help="Avg. deal stage (Seed=1 … E+=6)"),
    "⌀ Patentierte Erf.":   st.column_config.NumberColumn("Avg Patents",       format="%.1f"),
}

# Height: 38px header + 35px per data row, no cap — all clusters always visible
st.dataframe(
    _style(_tbl_df),
    column_config=col_cfg,
    use_container_width=True,
    hide_index=True,
    height=38 + 35 * len(_tbl_df),
)

st.caption("Cyan = #1 in category  ·  Green = #2  ·  ↑ higher is better  ·  ↓ lower is better")

# ── SECTION: Growth vs. Funding scatter ───────────────────────────────────────

_gf_x = "Deal Momentum"
_gf_y = "⌀ Total Raised (m€)" if "⌀ Total Raised (m€)" in df_analytics.columns else None
_gf_sz = "# Companies"        if "# Companies"         in df_analytics.columns else None

if _gf_x in df_analytics.columns and _gf_y:
    st.markdown('<div class="hy-section-title" style="margin-top:20px;margin-bottom:4px">Growth vs. Funding</div>', unsafe_allow_html=True)
    st.caption("Each bubble is a cluster. X = deal activity growth · Y = avg funding raised · Size = number of companies.")

    _gf_cols = ["Cluster", _gf_x, _gf_y] + ([_gf_sz] if _gf_sz else [])
    _gf_df   = df_analytics[_gf_cols].dropna(subset=[_gf_x, _gf_y]).copy()

    if not _gf_df.empty:
        _fig_gf = px.scatter(
            _gf_df,
            x=_gf_x, y=_gf_y,
            size=_gf_sz if _gf_sz else None,
            color="Cluster",
            color_discrete_map=_chart_color_map,
            text="Cluster",
            size_max=55,
            height=420,
        )
        _fig_gf.update_traces(
            textposition="top center",
            textfont=dict(family="IBM Plex Sans", size=10, color="#0d1f2d"),
            marker=dict(opacity=0.80, line=dict(width=1, color="#ffffff")),
        )
        _fig_gf.update_layout(
            showlegend=False,
            margin=dict(l=0, r=0, t=10, b=0),
            xaxis=dict(
                title="Deal Momentum (%)", showgrid=True, gridcolor="#e4eaf2",
                zeroline=True, zerolinecolor="#c8d8e4", zerolinewidth=1.5,
                tickfont=dict(family="IBM Plex Mono", size=10),
            ),
            yaxis=dict(
                title="Avg Total Raised (m€)", showgrid=True, gridcolor="#e4eaf2",
                tickfont=dict(family="IBM Plex Mono", size=10),
            ),
            plot_bgcolor="#ffffff", paper_bgcolor="#f7f9fc",
            font=dict(family="IBM Plex Sans", size=11, color="#0d1f2d"),
        )
        st.plotly_chart(_fig_gf, use_container_width=True)

st.divider()

# ── SECTION: Cluster Ranking ──────────────────────────────────────────────────

if not df_rank.empty:
    st.markdown('<div class="hy-section-title">Cluster Ranking</div>', unsafe_allow_html=True)
    st.caption(
        "Each metric normalised 0–1 (best = 1, worst = 0) and averaged. "
        "Excludes size/neutral columns."
    )

    _rank_cards_html = ""
    for _, row in df_rank.iterrows():
        _rank = int(row["Rank"])
        _name = row["Cluster"]
        _score = float(row["Score"])
        _badge_class = "hy-rank-badge hy-rank-badge-gold" if _rank == 1 else "hy-rank-badge"
        _bar_pct = _score  # score is already 0–100
        _rank_cards_html += (
            f'<div class="hy-rank-card">'
            f'<span class="{_badge_class}">#{_rank}</span>'
            f'<span class="hy-rank-name">{_name}</span>'
            f'<div class="hy-rank-bar-wrap"><div class="hy-rank-bar" style="width:{_bar_pct:.1f}%"></div></div>'
            f'<span class="hy-rank-score">{_score:.1f}</span>'
            f'</div>'
        )
    st.markdown(_rank_cards_html, unsafe_allow_html=True)

st.divider()

# ── Export ────────────────────────────────────────────────────────────────────

export_df = df_analytics.copy()
if not df_rank.empty:
    export_df = export_df.merge(
        df_rank[["Cluster", "Rank", "Score"]].rename(columns={"Score": "Overall Score (%)"}),
        on="Cluster", how="left",
    )

_exp_col1, _exp_col2 = st.columns([3, 1])
with _exp_col2:
    st.download_button(
        "Download analytics CSV",
        export_df.to_csv(index=False),
        "cluster_analytics.csv",
        "text/csv",
        type="primary",
        use_container_width=True,
    )
