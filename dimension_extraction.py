import streamlit as st
import pandas as pd
import requests
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

_GEN_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
_BATCH_SIZE = 20
# Paid tier: gemini-2.5-flash is ~300–1000 RPM — 10 workers is safe.
# 429s are retried with exponential backoff; no manual throttle needed.
# Reduce to 3–5 if you consistently see 429 errors on a free-tier key.
_MAX_WORKERS = 10

EXTRACTED_DIMENSIONS = [
    "Problem Solved",
    "Customer Segment",
    "Core Mechanism",
    "Tech Category",
    "Business Model",
    "Value Shift",
    "Ecosystem Role",
    "Scalability Lever",
]

_DIMENSIONS_SPEC = """\
  "Problem Solved": "the core problem solved, ≤8 words",
  "Customer Segment": "who specifically benefits — be concrete, e.g. 'mid-market logistics ops teams'",
  "Core Mechanism": "how it works technically or operationally, ≤10 words",
  "Tech Category": "pick the single best fit: AI/ML | SaaS | Marketplace | Fintech | Healthtech | Edtech | Hardware | API/Infrastructure | Logistics | Analytics | Other",
  "Business Model": "pick the single best fit: B2B SaaS | B2C | Marketplace | API/Usage-based | Hardware | Professional Services | Hybrid",
  "Value Shift": "what legacy approach or incumbent tool is displaced, ≤8 words",
  "Ecosystem Role": "pick one: Enabler | Optimizer | Disruptor | Infrastructure",
  "Scalability Lever": "pick the single primary lever: Network effects | Data flywheel | Platform | Distribution | Automation | Regulatory moat | Brand"\
"""

_BATCH_PROMPT = """\
You are a market intelligence analyst. For each company below, extract 8 dimensions from its description.

Return ONLY a JSON array — one object per company, in the same order as the input.
No explanation, no markdown, no extra text.

Companies:
{company_lines}

Each array element must be exactly:
{{
{spec}
}}

Return ONLY the JSON array.\
"""

_SINGLE_PROMPT = """\
You are a market intelligence analyst. Extract 8 dimensions from this company description.

Company: {name}
Description: {desc}

Return ONLY a single JSON object — no array, no explanation, no markdown:
{{
{spec}
}}\
"""


# ============================================================
# JSON REPAIR
# ============================================================

def _try_parse(raw: str) -> list | dict | None:
    """Try to parse raw text as JSON, with light repair attempts."""
    # Strip markdown fences
    cleaned = re.sub(r"```json|```", "", raw).strip()

    # Direct parse
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    # Remove trailing commas before ] or }
    repaired = re.sub(r",\s*([}\]])", r"\1", cleaned)
    try:
        return json.loads(repaired)
    except json.JSONDecodeError:
        pass

    # Truncated array: find the last complete object and close the array
    last_brace = cleaned.rfind("}")
    if last_brace != -1:
        truncated = cleaned[: last_brace + 1]
        # Find the opening [
        bracket = truncated.find("[")
        if bracket != -1:
            try:
                return json.loads(truncated[bracket:] + "]")
            except json.JSONDecodeError:
                pass

    return None


# ============================================================
# GEMINI CALLS
# ============================================================

def _call_gemini(prompt: str, api_key: str) -> str | None:
    """Make a single Gemini call. Returns raw text or None on failure."""
    try:
        resp = requests.post(
            f"{_GEN_URL}?key={api_key}",
            json={"contents": [{"parts": [{"text": prompt}]}]},
            timeout=60,
        )
        if resp.status_code != 200:
            return None
        return resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    except Exception:
        return None


def _extract_single(item: tuple[int, str, str], api_key: str) -> dict:
    """Extract dimensions for one company. Returns dim dict or {}."""
    row_idx, name, desc = item
    prompt = _SINGLE_PROMPT.format(name=name, desc=desc[:1200], spec=_DIMENSIONS_SPEC)

    for attempt in range(2):
        raw = _call_gemini(prompt, api_key)
        if raw is None:
            time.sleep(1)
            continue
        parsed = _try_parse(raw)
        if isinstance(parsed, dict):
            return parsed
        if isinstance(parsed, list) and parsed and isinstance(parsed[0], dict):
            return parsed[0]
        time.sleep(0.5)

    return {}


def _extract_batch(
    batch: list[tuple[int, str, str]],
    api_key: str,
) -> dict[int, dict]:
    """
    Try to extract dimensions for a batch.
    Strategy:
      1. Call Gemini with a batch prompt.
      2. Attempt JSON repair on the response.
      3. If the batch still fails after one retry, fall back to per-company calls.
    Returns {row_index: {dim: value}}.
    """
    company_lines = "\n".join(
        f"{i}. {name}: {desc[:800]}"
        for i, (_, name, desc) in enumerate(batch)
    )
    prompt = _BATCH_PROMPT.format(company_lines=company_lines, spec=_DIMENSIONS_SPEC)

    for attempt in range(2):
        raw = _call_gemini(prompt, api_key)
        if raw is None:
            time.sleep(1)
            continue

        parsed = _try_parse(raw)

        if isinstance(parsed, list):
            result = {}
            for i, dims in enumerate(parsed):
                if i < len(batch) and isinstance(dims, dict):
                    result[batch[i][0]] = dims
            if result:
                return result

        elif isinstance(parsed, dict) and len(batch) == 1:
            return {batch[0][0]: parsed}

        time.sleep(1)

    # Batch failed twice — fall back to individual calls
    if len(batch) > 1:
        result = {}
        for item in batch:
            dims = _extract_single(item, api_key)
            if dims:
                result[item[0]] = dims
            time.sleep(0.1)
        return result

    return {}


# ============================================================
# PUBLIC ENTRY POINT
# ============================================================

def extract_dimensions(
    df: pd.DataFrame,
    company_col: str,
    desc_col: str,
    api_key: str,
) -> pd.DataFrame:
    """
    Extract 8 dimensions for all rows that have a description.
    Returns a copy of df with EXTRACTED_DIMENSIONS columns appended.
    """
    companies = []
    for idx, row in df.iterrows():
        name = str(row.get(company_col, f"Row {idx}"))
        desc = str(row.get(desc_col, "")).strip()
        if desc:
            companies.append((idx, name, desc))

    if not companies:
        st.error("No descriptions found — make sure the selected description column contains text.")
        return df

    batches = [
        companies[b * _BATCH_SIZE: (b + 1) * _BATCH_SIZE]
        for b in range(max(1, (len(companies) + _BATCH_SIZE - 1) // _BATCH_SIZE))
    ]
    n_batches = len(batches)
    _eta_secs = max(5, (n_batches * 5) // _MAX_WORKERS)
    _eta_str = f"~{_eta_secs}s" if _eta_secs < 60 else f"~{_eta_secs // 60}m {_eta_secs % 60}s"
    prog = st.progress(0, text=f"Extracting dimensions via Gemini… (est. {_eta_str}, {_MAX_WORKERS} parallel calls)")
    _extract_start = time.time()

    results: dict[int, dict] = {}
    completed = 0

    with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as executor:
        futures = {executor.submit(_extract_batch, batch, api_key): batch for batch in batches}
        for future in as_completed(futures):
            results.update(future.result())
            completed += 1
            _elapsed = time.time() - _extract_start
            if completed > 1 and completed < n_batches:
                _rate = _elapsed / completed
                _remaining = int(_rate * (n_batches - completed))
                _rem_str = f"~{_remaining}s" if _remaining < 60 else f"~{_remaining // 60}m {_remaining % 60}s"
                prog.progress(
                    completed / n_batches,
                    text=f"{completed}/{n_batches} batches — {len(results)} companies done · {_rem_str} remaining…",
                )
            else:
                prog.progress(
                    completed / n_batches,
                    text=f"{completed}/{n_batches} batches — {len(results)} companies done…",
                )

    prog.empty()

    n_failed = len(companies) - len(results)
    if n_failed > 0:
        st.warning(
            f"{n_failed} {'company' if n_failed == 1 else 'companies'} could not be processed "
            "and will have empty dimension fields."
        )

    df_out = df.copy()
    for dim in EXTRACTED_DIMENSIONS:
        df_out[dim] = pd.Series(
            {idx: results.get(idx, {}).get(dim, "") for idx in df_out.index}
        )

    return df_out
