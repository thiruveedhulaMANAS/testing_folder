"""
backend/api_client.py
---------------------
AAVA Workflow API communication layer.

Real API contract (from workflow runner reference code):

  Submit:  POST /workflows/workflow-executions
           multipart fields: pipelineId, user, userInputs (JSON), files (ZIP)

  Poll:    GET  /workflows/workflow-executions?execution-id=<id>
           response: data.workflowExecutionResponseList[0].status
           values:   "SUCCESS" | "FAILED" | (anything else = still running)

  Result:  GET  /workflows/workflow-executions/<execution_id>/result
           response: data.result.response (JSON string)
                     └─ pipeLineAgents[].agent.name
                     └─ tasksOutputs[].raw | .description

Marketing Agent userInputs:
  {}

The current marketing workflow requires no uploaded files.

This module exposes a single public entry point, `call_marketing_agent`,
which submits the uploaded customer CSV to one pipeline and returns
segments, offers, personalized content, and a summary — everything the
"Personalized campaign generator" UI needs — from one workflow execution.
"""

import io
import json
import logging
import re
import time
import zipfile
from typing import Any

import requests
import urllib3

from utils.config import (
    API_BASE,
    AAVA_HEADERS,
    MARKETING_PIPELINE_ID,
    MARKETING_USER,
    VERIFY_SSL,
    WORKFLOW_EXECUTIONS_ENDPOINT,
    POLL_INTERVAL_SECONDS,
    WORKFLOW_TIMEOUT_SECONDS,
    REQUEST_TIMEOUT_SECONDS,
)

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Custom exception
# ---------------------------------------------------------------------------

class AgentAPIError(Exception):
    """Raised on any workflow API failure."""
    pass


# ---------------------------------------------------------------------------
# Internal helpers — generic AAVA workflow plumbing
# ---------------------------------------------------------------------------

def _build_zip(files: dict) -> bytes:
    """
    Pack multiple in-memory files into a ZIP archive.

    Parameters
    ----------
    files : dict[str, bytes]
        Mapping of {filename: file_bytes} to include in the ZIP.

    Returns
    -------
    bytes
        Raw ZIP archive bytes.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for filename, data in files.items():
            zf.writestr(filename, data)
    return buf.getvalue()


def _submit_workflow(pipeline_id, user, user_inputs, zip_files, log_sink=None):
    """
    Submit a workflow execution to the AAVA API.

    Parameters
    ----------
    pipeline_id : str
    user : str
    user_inputs : dict[str, str]   placeholder -> filename
    zip_files : dict[str, bytes]   filename -> bytes
    log_sink : callable | None     if provided, called with each INFO message

    Returns
    -------
    str  execution_id
    """
    def _emit(msg):
        logger.info(msg)
        if log_sink:
            log_sink(msg)

    url = f"{API_BASE}{WORKFLOW_EXECUTIONS_ENDPOINT}"

    # ``files=None`` means the multipart request contains no file part at all.
    # This is required by the current fileless AAVA workflow contract.
    multipart = {
        "pipelineId": (None, pipeline_id),
        "user":       (None, user),
        "userInputs": (None, json.dumps(user_inputs)),
    }
    if zip_files:
        zip_bytes = _build_zip(zip_files)
        multipart["files"] = ("payload.zip", zip_bytes, "application/zip")

    _emit(
        f"[SUBMIT] pipeline={pipeline_id} user={user} "
        f"userInputs={user_inputs} files={list(zip_files.keys()) if zip_files else []}"
    )

    try:
        resp = requests.post(
            url,
            headers=AAVA_HEADERS,
            files=multipart,
            timeout=REQUEST_TIMEOUT_SECONDS,
            verify=VERIFY_SSL,
        )
        resp.raise_for_status()
    except requests.Timeout:
        raise AgentAPIError(
            f"Submit timed out after {REQUEST_TIMEOUT_SECONDS}s (pipeline={pipeline_id})"
        )
    except requests.HTTPError as e:
        raise AgentAPIError(
            f"Submit HTTP {e.response.status_code} (pipeline={pipeline_id}): {e.response.text}"
        )
    except requests.RequestException as e:
        raise AgentAPIError(f"Submit request failed (pipeline={pipeline_id}): {e}")

    try:
        execution_id = resp.json()["data"]["workflowExecutionId"]
    except (KeyError, TypeError, ValueError):
        raise AgentAPIError(f"Unexpected submit response: {resp.text[:500]}")

    _emit(f"[SUBMIT] Execution started: {execution_id}")
    return execution_id


def _poll_until_complete(execution_id, cancel_event=None, log_sink=None):
    """
    Poll workflow status until SUCCESS or FAILED.

    Raises AgentAPIError on failure, timeout, or cancellation.
    """
    def _emit(msg):
        logger.info(msg)
        if log_sink:
            log_sink(msg)

    url = f"{API_BASE}{WORKFLOW_EXECUTIONS_ENDPOINT}"
    elapsed = 0

    while True:
        if cancel_event and cancel_event.is_set():
            raise AgentAPIError(f"Cancelled while polling {execution_id}")

        if (
            WORKFLOW_TIMEOUT_SECONDS is not None
            and elapsed >= WORKFLOW_TIMEOUT_SECONDS
        ):
            raise AgentAPIError(
                f"Workflow {execution_id} timed out after {WORKFLOW_TIMEOUT_SECONDS}s"
            )

        try:
            resp = requests.get(
                url,
                headers=AAVA_HEADERS,
                params={"execution-id": execution_id},
                timeout=REQUEST_TIMEOUT_SECONDS,
                verify=VERIFY_SSL,
            )
            resp.raise_for_status()
            status = (
                resp.json()["data"]["workflowExecutionResponseList"][0]["status"]
            )
        except (KeyError, IndexError, TypeError, ValueError) as e:
            raise AgentAPIError(f"Unexpected poll response for {execution_id}: {e}")
        except requests.RequestException as e:
            raise AgentAPIError(f"Poll request failed for {execution_id}: {e}")

        _emit(f"[POLL] {execution_id} -> {status}")

        if status == "SUCCESS":
            return
        if status == "FAILED":
            raise AgentAPIError(f"Workflow {execution_id} reported FAILED status")

        time.sleep(POLL_INTERVAL_SECONDS)
        elapsed += POLL_INTERVAL_SECONDS


def _fetch_result(execution_id, log_sink=None):
    """
    Fetch and parse the result of a completed workflow.

    The AAVA API sometimes returns an empty/incomplete result immediately
    after reporting SUCCESS status — the result data is written asynchronously.
    This function retries up to RESULT_FETCH_MAX_RETRIES times with
    RESULT_FETCH_RETRY_INTERVAL_SECONDS between attempts until a valid
    non-null result with at least one of the expected keys is returned.

    Returns
    -------
    dict  parsed result with pipeLineAgents and tasksOutputs
    """
    RESULT_FETCH_MAX_RETRIES = 10
    RESULT_FETCH_RETRY_INTERVAL_SECONDS = 3

    def _emit(msg):
        logger.info(msg)
        if log_sink:
            log_sink(msg)

    url = f"{API_BASE}{WORKFLOW_EXECUTIONS_ENDPOINT}/{execution_id}/result"

    for attempt in range(1, RESULT_FETCH_MAX_RETRIES + 1):
        try:
            resp = requests.get(
                url,
                headers=AAVA_HEADERS,
                timeout=REQUEST_TIMEOUT_SECONDS,
                verify=VERIFY_SSL,
            )
            resp.raise_for_status()
        except requests.RequestException as e:
            raise AgentAPIError(f"Result fetch failed for {execution_id}: {e}")

        # The API may return the result payload as a nested JSON string,
        # or the result/data keys may simply be absent on the first few calls.
        try:
            body         = resp.json()
            data_block   = body.get("data") or {}
            result_block = data_block.get("result") or {}
            raw_response = result_block.get("response")
        except (AttributeError, ValueError):
            body         = {}
            result_block = {}
            raw_response = None

        # No response field yet — result not populated on the server side
        if not raw_response:
            _emit(
                f"[RESULT] {execution_id} — attempt {attempt}/{RESULT_FETCH_MAX_RETRIES}: "
                f"response field empty, retrying in {RESULT_FETCH_RETRY_INTERVAL_SECONDS}s…"
            )
            time.sleep(RESULT_FETCH_RETRY_INTERVAL_SECONDS)
            continue

        # Parse the nested JSON string
        try:
            result = json.loads(raw_response)
        except json.JSONDecodeError as e:
            raise AgentAPIError(
                f"Result response is not valid JSON for {execution_id}: {e}"
            )

        # Null payload — treat same as empty
        if result is None:
            _emit(
                f"[RESULT] {execution_id} — attempt {attempt}/{RESULT_FETCH_MAX_RETRIES}: "
                f"payload is null, retrying in {RESULT_FETCH_RETRY_INTERVAL_SECONDS}s…"
            )
            time.sleep(RESULT_FETCH_RETRY_INTERVAL_SECONDS)
            continue

        # Check that at least one of the expected keys is present and non-empty
        has_agents = bool(result.get("pipeLineAgents") or result.get("tasksOutputs"))
        if not has_agents:
            _emit(
                f"[RESULT] {execution_id} — attempt {attempt}/{RESULT_FETCH_MAX_RETRIES}: "
                f"pipeLineAgents/tasksOutputs missing or empty, retrying in {RESULT_FETCH_RETRY_INTERVAL_SECONDS}s…"
            )
            time.sleep(RESULT_FETCH_RETRY_INTERVAL_SECONDS)
            continue

        _emit(f"[RESULT] {execution_id} — result received on attempt {attempt}")

        return result

    raise AgentAPIError(
        f"Result for {execution_id} was not populated after "
        f"{RESULT_FETCH_MAX_RETRIES} attempts — the workflow may have completed "
        "without producing output."
    )


def _extract_agent_outputs(result):
    """
    Zip pipeLineAgents with tasksOutputs into a clean list.

    AAVA API behaviour observed:
      - pipeLineAgents is often [] (empty) even when tasksOutputs has content.
      - When pipeLineAgents is empty we fall back to tasksOutputs alone, using
        the workflow-level "name" field (or agents[].agent.name from the nested
        workflow definition) as the agent name.

    Returns
    -------
    list[dict]  [{"agent_name": str, "content": str}, ...]
    """
    if not result or not isinstance(result, dict):
        return []

    agents = result.get("pipeLineAgents") or []
    tasks  = result.get("tasksOutputs")   or []

    if not tasks:
        return []

    outputs = []

    if agents:
        # Normal path: pipeLineAgents and tasksOutputs are both populated
        for agent, task in zip(agents, tasks):
            if not isinstance(agent, dict):
                continue
            name = (
                agent.get("agent", {}).get("name", "Marketing Agent")
                if isinstance(agent.get("agent"), dict)
                else "Marketing Agent"
            )
            content = (task.get("raw") or task.get("description") or "") if isinstance(task, dict) else ""
            if not isinstance(content, str):
                content = json.dumps(content, ensure_ascii=False)
            outputs.append({"agent_name": name, "content": content})
    else:
        # Fallback path: pipeLineAgents is empty — use tasksOutputs directly.
        # Derive a name from the top-level workflow name in the result payload,
        # or from the nested agents list inside result["workflow"]["agents"].
        workflow_name = result.get("name", "Marketing Agent")

        # Try to pull agent names from the nested workflow definition if present
        agent_names = []
        try:
            wf_raw = result.get("workflow")
            if isinstance(wf_raw, str):
                wf_obj = json.loads(wf_raw)
            elif isinstance(wf_raw, dict):
                wf_obj = wf_raw
            else:
                wf_obj = {}
            for ag_entry in (wf_obj.get("workflow", {}).get("agents") or []):
                n = ag_entry.get("agent", {}).get("name")
                if n:
                    agent_names.append(n)
        except Exception:
            pass

        for idx, task in enumerate(tasks):
            if not isinstance(task, dict):
                continue
            content = task.get("raw") or task.get("description") or ""
            if not isinstance(content, str):
                content = json.dumps(content, ensure_ascii=False)
            name = agent_names[idx] if idx < len(agent_names) else workflow_name
            outputs.append({"agent_name": name, "content": content})

    return outputs


# ---------------------------------------------------------------------------
# Marketing Agent output parsing
# ---------------------------------------------------------------------------

_JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)


def _parse_marketing_output(agent_outputs: list) -> dict:
    """
    Parse the Marketing Agent's combined output into the structured shape
    the UI expects.

    The agent is expected to return a JSON object (see the schema documented
    in utils/config.py) somewhere in its task output text. This function is
    defensive: it tries a straight json.loads() first, then falls back to
    extracting the first {...} block from the text, and finally — if nothing
    parses — returns an "unstructured" result so the UI can still show the
    raw text instead of failing.

    Returns
    -------
    dict
        {
          "structured": bool,
          "segments":   list[dict],
          "customers":  list[dict],
          "offers":     list[dict],
          "content":    list[dict],
          "summary":    str,
          "raw_text":   str,   # full concatenated agent output, always present
        }
    """
    normalized_outputs = []
    for output in agent_outputs or []:
        if not isinstance(output, dict):
            continue
        content = output.get("content", "")
        if not isinstance(content, str):
            content = json.dumps(content, ensure_ascii=False)
        normalized_outputs.append({
            "agent_name": str(output.get("agent_name") or "Marketing Agent"),
            "content": content,
        })

    raw_text = "\n\n".join(
        f"=== {o['agent_name']} ===\n{o['content']}" for o in normalized_outputs
    )

    candidates = [o.get("content", "") for o in normalized_outputs if o.get("content")]
    # Also try the concatenation in case the JSON spans multiple task chunks
    candidates.append(raw_text)

    parsed = None
    for text in candidates:
        text = (text or "").strip()
        if not text:
            continue
        # Attempt 1: whole string is JSON
        try:
            candidate = json.loads(text)
            if isinstance(candidate, dict):
                parsed = candidate
                break
        except (json.JSONDecodeError, TypeError):
            pass
        # Attempt 2: extract the first {...} block (handles Markdown fences,
        # leading/trailing commentary from the LLM, etc.)
        match = _JSON_OBJECT_RE.search(text)
        if match:
            try:
                candidate = json.loads(match.group(0))
                if isinstance(candidate, dict):
                    parsed = candidate
                    break
            except (json.JSONDecodeError, TypeError):
                continue

    if not parsed:
        return {
            "structured": False,
            "segments":   [],
            "customers":  [],
            "offers":     [],
            "content":    [],
            "summary":    "",
            "raw_text":   raw_text,
        }

    segments  = parsed.get("segments")  or []
    customers = parsed.get("customers") or []
    offers    = parsed.get("offers")    or []
    content   = parsed.get("content")   or []
    summary   = parsed.get("summary")   or ""

    # If segment counts weren't provided directly, derive them from customers
    if not segments and customers:
        counts: dict = {}
        for c in customers:
            seg = c.get("segment", "Unknown")
            counts[seg] = counts.get(seg, 0) + 1
        segments = [{"name": k, "count": v} for k, v in counts.items()]

    return {
        "structured": True,
        "segments":   segments,
        "customers":  customers,
        "offers":     offers,
        "content":    content,
        "summary":    summary if isinstance(summary, str) else json.dumps(summary, indent=2),
        "raw_text":   raw_text,
    }


# ---------------------------------------------------------------------------
# Public API — called by workflow.py
# ---------------------------------------------------------------------------

def call_marketing_agent(
    cancel_event=None,
    log_sink=None,
    **legacy_kwargs,
):
    """Run the Marketing Agent workflow with no uploaded files.

    The active AAVA workflow is intentionally fileless: it receives an empty
    ``userInputs`` object and no multipart ``files`` part. Legacy file-based
    arguments are rejected so an old caller cannot silently reintroduce the
    obsolete file-upload contract.
    """
    if legacy_kwargs:
        unexpected = ", ".join(sorted(legacy_kwargs))
        raise TypeError(
            f"File-based AAVA inputs are no longer supported; unexpected arguments: {unexpected}"
        )

    if cancel_event and cancel_event.is_set():
        raise AgentAPIError("Cancelled before Marketing Agent submission.")

    def _emit(msg):
        logger.info(msg)
        if log_sink:
            log_sink(msg)

    _emit("[MARKETING] Submitting AAVA workflow with no uploaded files")

    execution_id = _submit_workflow(
        pipeline_id=MARKETING_PIPELINE_ID,
        user=MARKETING_USER,
        user_inputs={},
        zip_files=None,
        log_sink=log_sink,
    )

    _poll_until_complete(execution_id, cancel_event=cancel_event, log_sink=log_sink)

    # AAVA and GitHub are deliberately decoupled. Once AAVA reports SUCCESS,
    # do not fetch, parse, or validate the AAVA result payload here. The
    # authoritative response is produced asynchronously in GitHub and is
    # read by content_reader.py after this function returns. This prevents a
    # malformed/empty AAVA result payload from blocking a successful run.
    _emit(
        f"[MARKETING] Done. execution_id={execution_id}; "
        "AAVA SUCCESS received. Response will be read independently from "
        "latest GitHub Content/Content.txt"
    )

    return {"execution_id": execution_id}
