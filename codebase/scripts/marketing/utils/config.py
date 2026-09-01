"""
utils/config.py
---------------
Centralised configuration for the Marketing Agent pipeline.

Everything here is read from the environment. These vars are explicitly
passed through to this subprocess by src/services/marketingRunner.js (see
config/env.js marketingScriptEnv) -- set them in your .env file, see
.env.example.
"""

import os


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set. Add it to your .env (see .env.example)."
        )
    return value


# ================= AAVA CONFIG =================
API_BASE = os.getenv("AAVA_API_BASE", "https://int-ai.aava.ai")
REALM_ID = os.getenv("AAVA_REALM_ID", "79")
AAVA_BEARER_TOKEN = _require_env("AAVA_BEARER_TOKEN")
AAVA_HEADERS = {
    "Authorization": f"Bearer {AAVA_BEARER_TOKEN}",
    "x-realm-id": REALM_ID,
    "platform": "plugin",
    "Accept": "application/json",
    "Connection": "close",
}

# ---------------------------------------------------------------------------
# Marketing Agent workflow
# ---------------------------------------------------------------------------
# Single agent that receives the uploaded customer CSV and returns
# segments, offers, personalized content, and a summary in one shot.
#
# Expected response contract (agent should honour this JSON shape inside
# its task output "raw"/"description" text -- see backend/api_client.py
# `_parse_marketing_output` for the defensive parser used if the agent
# deviates from this shape):
#
# {
#   "segments": [
#       {"name": "New customers", "count": 128},
#       {"name": "Loyal buyers",  "count": 64},
#       ...
#   ],
#   "customers": [
#       {"customer": "Arun R.", "segment": "Loyal buyer",
#        "recency_days": 5, "spend_tier": "Mid"},
#       ...
#   ],
#   "offers": [
#       {"segment": "Loyal buyers", "offer": "...", "channel": "Email"},
#       ...
#   ],
#   "content": [
#       {"segment": "New customers", "subject": "...", "body": "..."},
#       ...
#   ],
#   "summary": "Free-form executive summary text."
# }
MARKETING_PIPELINE_ID = os.getenv("MARKETING_PIPELINE_ID", "21423")
MARKETING_WORKFLOW_NAME = "Doomsday Hackathon"
MARKETING_USER = _require_env("AAVA_USER")

# ---------------------------------------------------------------------------
# API endpoints (relative to API_BASE)
# ---------------------------------------------------------------------------
WORKFLOW_EXECUTIONS_ENDPOINT = "/workflows/workflow-executions"

# ---------------------------------------------------------------------------
# Polling & timeout settings
# ---------------------------------------------------------------------------
POLL_INTERVAL_SECONDS = 2
WORKFLOW_TIMEOUT_SECONDS = None
REQUEST_TIMEOUT_SECONDS = 60

# ---------------------------------------------------------------------------
# SSL verification (set False only for dev/internal environments)
# ---------------------------------------------------------------------------
VERIFY_SSL = False
