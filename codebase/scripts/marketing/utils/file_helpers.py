"""
utils/file_helpers.py
---------------------
Utility functions for file reading, parsing, and display.
"""

import io
import json
import logging
from typing import Any

import pandas as pd

logger = logging.getLogger(__name__)


def read_file_content(uploaded_file) -> str:
    """Read and return raw text content from an uploaded Streamlit file object."""
    try:
        uploaded_file.seek(0)
        raw = uploaded_file.read()
        return raw.decode("utf-8", errors="replace")
    except Exception as e:
        logger.error(f"Error reading file {getattr(uploaded_file, 'name', '?')}: {e}")
        return f"[Error reading file: {e}]"


def get_file_bytes(uploaded_file) -> bytes:
    """Return raw bytes for a Streamlit uploaded file."""
    uploaded_file.seek(0)
    return uploaded_file.read()


def read_csv_preview(uploaded_file, max_rows: int = 200) -> dict[str, Any]:
    """
    Parse an uploaded CSV file into a pandas DataFrame for preview purposes.

    Returns
    -------
    dict
        {
          "ok":        bool,
          "error":     str | None,
          "dataframe": pd.DataFrame | None   # full parsed data
          "preview_df": pd.DataFrame | None  # truncated to max_rows for display
          "n_rows":    int,
          "n_cols":    int,
          "columns":   list[str],
        }
    """
    try:
        uploaded_file.seek(0)
        raw_bytes = uploaded_file.read()
        df = pd.read_csv(io.BytesIO(raw_bytes))
        return {
            "ok":         True,
            "error":      None,
            "dataframe":  df,
            "preview_df": df.head(max_rows),
            "n_rows":     len(df),
            "n_cols":     len(df.columns),
            "columns":    list(df.columns),
        }
    except Exception as e:
        logger.error(f"Error parsing CSV {getattr(uploaded_file, 'name', '?')}: {e}")
        return {
            "ok":         False,
            "error":      str(e),
            "dataframe":  None,
            "preview_df": None,
            "n_rows":     0,
            "n_cols":     0,
            "columns":    [],
        }


def parse_display_content(uploaded_file) -> dict[str, Any]:
    """
    Parse an uploaded file for display purposes.
    Returns a dict with:
      - 'type': 'json' | 'csv' | 'text'
      - 'content': parsed data or raw string
      - 'preview': human-readable preview string
    """
    name = getattr(uploaded_file, "name", "").lower()
    raw = read_file_content(uploaded_file)

    if name.endswith(".json"):
        try:
            parsed = json.loads(raw)
            return {
                "type": "json",
                "content": parsed,
                "preview": json.dumps(parsed, indent=2)[:4000],
            }
        except json.JSONDecodeError:
            pass

    if name.endswith(".csv"):
        csv_result = read_csv_preview(uploaded_file)
        if csv_result["ok"]:
            return {
                "type": "csv",
                "content": csv_result["dataframe"],
                "preview": raw[:4000],
            }

    return {
        "type": "text",
        "content": raw,
        "preview": raw[:4000],
    }


def extract_summary_from_result(result_content: str, filename: str) -> dict[str, Any]:
    """
    Attempt to extract a summary dict from a result file.
    Handles JSON results with known summary keys. Falls back to basic metadata.
    """
    summary = {"file": filename, "status": "unknown", "score": "N/A", "details": ""}

    try:
        data = json.loads(result_content)
        if isinstance(data, dict):
            summary["status"] = data.get("status", data.get("result", "completed"))
            summary["score"] = data.get("score", data.get("total_score", "N/A"))
            summary["details"] = data.get(
                "summary", data.get("details", data.get("message", ""))
            )
            for k, v in data.items():
                if k not in ("status", "result", "score", "total_score", "summary", "details", "message"):
                    if isinstance(v, (str, int, float, bool)):
                        summary[k] = v
    except (json.JSONDecodeError, TypeError):
        summary["status"] = "completed"
        snippet = result_content[:200].replace("\n", " ")
        summary["details"] = snippet

    return summary
