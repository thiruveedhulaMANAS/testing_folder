"""
backend/workflow.py
-------------------
Pipeline orchestration layer for the Personalized Campaign Generator.

A single Marketing Agent call replaces the previous 3-step
Coverage → Scoring → Summary pipeline. "Run pipeline" triggers exactly
one workflow execution against the uploaded CSV.
"""

import logging
import threading
import time
from typing import Callable

from backend.api_client import call_marketing_agent, AgentAPIError

logger = logging.getLogger(__name__)

STATUS_PENDING   = "pending"
STATUS_RUNNING   = "running"
STATUS_DONE      = "done"
STATUS_ERROR     = "error"
STATUS_CANCELLED = "cancelled"


def _make_op(label: str) -> dict:
    return {"label": label, "status": STATUS_PENDING, "message": ""}


def run_marketing_pipeline(
    csv_bytes: bytes,
    csv_filename: str,
    status_dict: dict,
    cancel_event: threading.Event,
    result_callback: Callable,
) -> None:
    """
    Run the single-agent marketing pipeline.

    Steps
    -----
    1. upload        — prepare legacy CSV metadata (not sent to the active AAVA workflow)
    2. agent_call     — submit to the Marketing Agent pipeline
    3. agent_wait     — poll until the workflow completes
    4. collect        — parse and hand off segments/offers/content/summary
    """

    ops_order = ["upload", "agent_call", "agent_wait", "collect"]

    status_dict.update({
        "upload":      _make_op("Uploading CSV"),
        "agent_call":  _make_op("Calling Marketing Agent"),
        "agent_wait":  _make_op("Waiting for agent response"),
        "collect":     _make_op("Collecting results"),
        "_ops_order":  ops_order,
        "_error":      None,
        "_done":       False,
        "_result":     None,
        "_logs":       [],
    })

    def _log(message: str, level: str = "INFO"):
        import datetime
        ts = datetime.datetime.now().strftime("%H:%M:%S")
        status_dict["_logs"].append(f"[{ts}] [{level}] {message}")
        if level == "ERROR":
            logger.error(message)
        else:
            logger.info(message)

    def update(op_key: str, status: str, message: str = ""):
        status_dict[op_key]["status"]  = status
        status_dict[op_key]["message"] = message
        level = "ERROR" if status == STATUS_ERROR else "INFO"
        _log(f"[{op_key.upper()}] {status.upper()} — {message}", level)

    def abort_remaining(from_op: str = None):
        marking = from_op is None
        for key in ops_order:
            if from_op and key == from_op:
                marking = True
            if marking and status_dict[key]["status"] in (STATUS_PENDING, STATUS_RUNNING):
                status_dict[key]["status"]  = STATUS_CANCELLED
                status_dict[key]["message"] = "Cancelled"
        status_dict["_done"] = False

    try:
        # ── STEP 1: Upload ────────────────────────────────────────────────
        if cancel_event.is_set():
            abort_remaining()
            return

        update("upload", STATUS_RUNNING, "Preparing CSV…")
        time.sleep(0.2)
        update("upload", STATUS_DONE, f"{csv_filename} ready")

        # ── STEP 2: Marketing Agent call ─────────────────────────────────
        if cancel_event.is_set():
            abort_remaining("agent_call")
            return

        from utils.config import MARKETING_PIPELINE_ID
        update(
            "agent_call", STATUS_RUNNING,
            f"Submitting pipeline {MARKETING_PIPELINE_ID} → {csv_filename}…",
        )

        agent_result = call_marketing_agent(
            csv_bytes=csv_bytes,
            csv_filename=csv_filename,
            cancel_event=cancel_event,
            log_sink=_log,
        )

        update(
            "agent_call", STATUS_DONE,
            f"Execution {agent_result['execution_id']} → SUCCESS",
        )

        # ── STEP 3: Response received ────────────────────────────────────
        update("agent_wait", STATUS_RUNNING, "Extracting campaign output…")

        parsed = agent_result["parsed"]
        n_segments = len(parsed.get("segments") or [])
        n_offers   = len(parsed.get("offers") or [])
        n_content  = len(parsed.get("content") or [])

        status_dict["_result"] = agent_result

        update(
            "agent_wait", STATUS_DONE,
            f"Received — {n_segments} segment(s), {n_offers} offer(s), {n_content} content item(s)",
        )

        # ── STEP 4: Collect ──────────────────────────────────────────────
        update("collect", STATUS_RUNNING, "Aggregating results…")
        time.sleep(0.2)
        update("collect", STATUS_DONE, "Done ✓")

        status_dict["_logs"].clear()
        status_dict["_done"] = True
        result_callback(agent_result)

    except AgentAPIError as exc:
        _log(f"Pipeline AgentAPIError: {exc}", "ERROR")
        status_dict["_error"] = str(exc)
        for key in ops_order:
            if status_dict[key]["status"] in (STATUS_PENDING, STATUS_RUNNING):
                status_dict[key]["status"]  = STATUS_ERROR
                status_dict[key]["message"] = str(exc)

    except Exception as exc:
        _log(f"Unexpected pipeline error: {exc}", "ERROR")
        logger.exception(f"Unexpected pipeline error: {exc}")
        status_dict["_error"] = f"Unexpected error: {exc}"
        for key in ops_order:
            if status_dict[key]["status"] in (STATUS_PENDING, STATUS_RUNNING):
                status_dict[key]["status"]  = STATUS_ERROR
                status_dict[key]["message"] = str(exc)
