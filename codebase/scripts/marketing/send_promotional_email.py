#!/usr/bin/env python3
"""
send_promotional_email.py
--------------------------
Template script for the admin "Marketing Automation" panel (scriptId:
"promo_email"). Spawned by src/services/marketingRunner.js as an isolated
subprocess with a minimal, explicit environment -- it does NOT receive
DATABASE_URL, JWT_SECRET, REDIS_URL, or any other app secret.

What this template does:
  - Resolves a demo audience size for the requested segment.
  - Prints a realistic-looking progress stream to stdout, which the API
    forwards live to the browser over Server-Sent Events.
  - Exits 0 on success.

What this template deliberately does NOT do:
  - It does not connect to any database.
  - It does not call any external API, email provider, or third party.
  - It does not read or embed any credentials.

Wiring up a real email send:
  1. Add your ESP's credentials (e.g. SENDGRID_API_KEY) as environment
     variables on the `api` service (docker-compose.yml / your deploy
     config) -- never hardcode them in this file.
  2. Explicitly pass through only what this script needs via
     `env.marketingScriptEnv` in src/config/env.js, which
     marketingRunner.js merges into the child process environment.
  3. Have a second reviewer sign off before pointing this at real
     customer email addresses.
"""

import argparse
import sys
import time

DEMO_AUDIENCE_SIZES = {
    "all": 4820,
    "inactive_30d": 1140,
    "high_value": 366,
    "cart_abandoners": 512,
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Send a promotional email blast (template).")
    parser.add_argument("--segment", required=True)
    parser.add_argument("--discount", required=True, type=int)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()

    audience = DEMO_AUDIENCE_SIZES.get(args.segment, 250)

    print(f"[promo_email] run_id={args.run_id} segment={args.segment} discount={args.discount}%")
    print(f"[promo_email] Resolved audience: {audience} users in segment '{args.segment}'")
    print("[promo_email] NOTE: this is a template run -- no email provider is configured, "
          "no messages are actually sent.")

    batch_size = max(audience // 5, 1)
    sent = 0
    while sent < audience:
        step = min(batch_size, audience - sent)
        sent += step
        pct = int(sent / audience * 100)
        print(f"[promo_email] ...{sent}/{audience} queued ({pct}%)")
        time.sleep(0.3)

    print(f"[promo_email] Done. {audience} users would receive a {args.discount}% off email.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
