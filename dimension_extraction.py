import streamlit as st
import pandas as pd
import requests
import json
import re
import time

_GEN_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
_BATCH_SIZE = 10

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

_PROMPT_TEMPLATE = """\
You are a market intelligence analyst. For each company below, extract 8 dimensions \
from its description.

Return ONLY a JSON array — one object per company, in the same order as the input. \
No explanation, no markdown, no extra text.

Companies:
{company_lines}

For each company return exactly this JSON structure (as one element of the array):
{{
  "Problem Solved": "the core problem solved, ≤8 words",
  "Customer Segment": "who specifically benefits — be concrete, e.g. 'mid-market logistics ops teams'",
  "Core Mechanism": "how it works technically or operationally, ≤10 words",
  "Tech Category": "pick the single best fit: AI/ML | SaaS | Marketplace | Fintech | Healthtech | \
Edtech | Hardware | API/Infrastructure | Logistics | Analytics | Other",
  "Business Model": "pick the single best fit: B2B SaaS | B2C | Marketplace | API/Usage-based | \
Hardware | Professional Services | Hybrid",
  "Value Shift": "what legacy approach or incumbent tool is displaced, ≤8 words",
  "Ecosystem Role": "pick one: Enabler | Optimizer | Disruptor | Infrastructure",
  "Scalability Lever": "pick the single primary lever: Network effects | Data flywheel | Platform | \
Distribution | Automation | Regulatory moat | Brand"
}}

Return ONLY the JSON array.\
"""


def _extract_batch(
    batch: list[tuple[int, str, str]],   # (row_index, company_name, description)
    api_key: str,
) -> dict[int, dict]:
    """Call Gemini for one batch. Returns {row_index: {dim: value}}."""
    company_lines = "\n".join(
        f"{i}. {name}: {desc[:800]}"
        for i, (_, name, desc) in enumerate(batch)
    )
    prompt = _PROMPT_TEMPLATE.format(company_lines=company_lines)

    try:
        resp = requests.post(
            f"{_GEN_URL}?key={api_key}",
            json={"contents": [{"parts": [{"text": prompt}]}]},
            timeout=60,
        )
        if resp.status_code != 200:
            st.warning(f"Dimension extraction batch error {resp.status_code}: {resp.text[:200]}")
            return {}

        raw = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
        raw = re.sub(r"```json|```", "", raw).strip()
        parsed = json.loads(raw)

        if not isinstance(parsed, list):
            st.warning("Unexpected response format from Gemini (expected JSON array).")
            return {}

        result = {}
        for i, dims in enumerate(parsed):
            if i < len(batch) and isinstance(dims, dict):
                result[batch[i][0]] = dims
        return result

    except json.JSONDecodeError as e:
        st.warning(f"Dimension extraction returned invalid JSON: {e}")
        return {}
    except Exception as e:
        st.warning(f"Dimension extraction batch failed: {e}")
        return {}


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

    results: dict[int, dict] = {}
    n_batches = max(1, (len(companies) + _BATCH_SIZE - 1) // _BATCH_SIZE)
    prog = st.progress(0, text="Extracting dimensions via Gemini…")

    for b in range(n_batches):
        batch = companies[b * _BATCH_SIZE: (b + 1) * _BATCH_SIZE]
        results.update(_extract_batch(batch, api_key))
        prog.progress(
            (b + 1) / n_batches,
            text=f"Batch {b + 1} / {n_batches} — {len(results)} / {len(companies)} companies done…",
        )
        time.sleep(0.1)

    prog.empty()

    df_out = df.copy()
    for dim in EXTRACTED_DIMENSIONS:
        df_out[dim] = pd.Series(
            {idx: results.get(idx, {}).get(dim, "") for idx in df_out.index}
        )

    return df_out
