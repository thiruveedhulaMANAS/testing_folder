FROM node:20-alpine

# python3 + pip are required at runtime by src/services/marketingRunner.js,
# which spawns scripts/marketing/workflow_backend.py as an isolated
# subprocess for the admin Marketing Automation panel.
RUN apk add --no-cache python3 py3-pip

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY scripts/marketing/requirements.txt ./scripts/marketing/requirements.txt
RUN pip install --no-cache-dir --break-system-packages -r scripts/marketing/requirements.txt

COPY src ./src
COPY public ./public
COPY scripts ./scripts

# The marketing subprocess runs as the non-root Node user and must be able
# to create/update its database export and run-state files at runtime.
RUN mkdir -p /tmp/marketing-runs /app/scripts/marketing/database_export \
    && chown -R node:node /tmp/marketing-runs /app/scripts/marketing

ENV NODE_ENV=production
EXPOSE 3000

USER node
CMD ["node", "src/server.js"]
