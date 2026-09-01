#!/usr/bin/env python3
"""Marketing automation pipeline entrypoint.

Node.js owns the durable workflow state and administrator approval lifecycle.
This Python process performs either the complete pipeline or one AAVA-only
regeneration attempt, emits the AAVA result, and exits. It never waits for a
browser/admin decision and has no run-id environment dependency.
"""

import argparse
import json
import logging
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("workflow_backend")

CAMPAIGN_TXT = "campaign_details.txt"
STATE_PREFIX = "__MARKETING_STATE__"


class PipelineStageError(Exception):
    pass


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--campaign-name", default="")
    parser.add_argument("--campaign-details", default="")
    parser.add_argument("--aava-only", action="store_true")
    return parser.parse_args()


def emit_state(status, response=None, execution_id=None, error=None):
    print(
        f"{STATE_PREFIX}{json.dumps({'status': status, 'response': response, 'execution_id': execution_id, 'error': error}, ensure_ascii=False, separators=(',', ':'))}",
        flush=True,
    )


def write_campaign_txt(campaign_name: str, campaign_details: str) -> Path:
    output_dir = PROJECT_ROOT / "database_export"
    output_dir.mkdir(parents=True, exist_ok=True)
    content = (
        "CAMPAIGN NAME\n"
        "==============\n"
        f"{campaign_name}\n\n"
        "CAMPAIGN DETAILS\n"
        "================\n"
        f"{campaign_details}\n"
    )
    github_path = output_dir / CAMPAIGN_TXT
    github_path.write_text(content, encoding="utf-8")
    logger.info("Campaign metadata written before fetch_data: %s", github_path)
    return github_path


def run_fetch_stage() -> None:
    logger.info("STAGE 1/4 — fetch_data: exporting database tables")
    import fetch_data
    try:
        fetch_data.export_all_tables_to_csv()
    except Exception as exc:
        raise PipelineStageError(f"fetch_data stage raised an exception: {exc}") from exc
    logger.info("STAGE 1/4 complete")


def run_validation_stage() -> None:
    logger.info("STAGE 2/4 — file_checker: validating exported files")
    from utils import file_checker
    try:
        ok = file_checker.main()
    except Exception as exc:
        raise PipelineStageError(f"file_checker raised an exception: {exc}") from exc
    if not ok:
        raise PipelineStageError("file_checker validation FAILED — refusing to push to GitHub or trigger the Marketing Agent.")
    logger.info("STAGE 2/4 complete")


def run_github_stage() -> None:
    logger.info("STAGE 3/4 — github_writer: syncing latest CSV exports and campaign TXT to GitHub")
    import github_writer
    try:
        github_writer.sync_campaign_file(github_writer.repo)
    except Exception as exc:
        raise PipelineStageError(f"github_writer sync failed: {exc}") from exc
    logger.info("STAGE 3/4 complete")


def run_marketing_stage(aava_only: bool = False) -> dict:
    logger.info(
        "STAGE 4/4 — marketing agent: triggering downstream workflow%s",
        " (AAVA regeneration only)" if aava_only else "",
    )
    from backend.api_client import call_marketing_agent, AgentAPIError

    # AAVA receives no uploaded files and no file-based userInputs. AAVA and
    # GitHub are independent systems: after AAVA SUCCESS, content_reader.py
    # independently waits for and reads the newest GitHub Content.txt.
    import github_writer
    from content_reader import read_latest_content_after_success

    logger.info("[AAVA] Submitting workflow with no uploaded files and no file inputs")
    try:
        result = call_marketing_agent(
            log_sink=lambda msg: logger.info(msg),
        )
    except AgentAPIError as exc:
        raise PipelineStageError(f"Marketing Agent call failed: {exc}") from exc

    try:
        logger.info("[AAVA] AAVA completed successfully; independently reading GitHub Content/Content.txt.")
        github_content = read_latest_content_after_success(
            github_writer.repo,
            log=lambda msg: logger.info(msg),
        )
    except Exception as exc:
        raise PipelineStageError(f"AAVA Content.txt GitHub read/verification failed: {exc}") from exc

    logger.info("[AAVA] Latest Content.txt verified; sending GitHub content to admin approval UI.")
    emit_state("awaiting_approval", response=github_content, execution_id=result.get("execution_id"))
    logger.info("[APPROVAL] AAVA response is ready; Python worker exiting. Node.js owns approval.")
    return github_content


def main() -> int:
    args = parse_args()
    try:
        if args.aava_only:
            run_marketing_stage(aava_only=True)
        else:
            logger.info("Creating campaign metadata TXT before fetch_data")
            write_campaign_txt(args.campaign_name.strip(), args.campaign_details.strip())
            run_fetch_stage()
            run_validation_stage()
            run_github_stage()
            run_marketing_stage()
    except PipelineStageError as exc:
        logger.error("Pipeline HALTED: %s", exc)
        emit_state("failed", error=str(exc))
        return 1
    except Exception as exc:
        logger.exception("Unexpected pipeline error: %s", exc)
        emit_state("failed", error=str(exc))
        return 1

    logger.info("Marketing worker completed its assigned work.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
