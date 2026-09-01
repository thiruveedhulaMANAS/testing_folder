require('dotenv').config();
const path = require('path');

const required = ['DATABASE_URL', 'JWT_SECRET'];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

// Env vars consumed by scripts/marketing/*.py (the Marketing Agent pipeline
// spawned by src/services/marketingRunner.js). These are deliberately NOT
// part of the app's own DATABASE_URL/JWT_SECRET/REDIS_URL -- the pipeline
// gets its own, explicitly-listed set of vars passed through to the Python
// subprocess's environment, and nothing else. Unset vars are simply
// omitted (not passed as empty strings) so the Python side's own
// "is this set?" checks behave correctly.
const marketingScriptEnv = {};
const passthroughVars = [
  'MARKETING_DATABASE_URI',
  'GITHUB_PAT',
  'GITHUB_REPO_OWNER',
  'GITHUB_REPO_NAME',
  'AAVA_API_BASE',
  'AAVA_REALM_ID',
  'AAVA_BEARER_TOKEN',
  'AAVA_USER',
  'MARKETING_PIPELINE_ID',
  'APP_PASSWORD',
  'SENDER_EMAIL',
  'EMAIL_EXCLUDE_LIST'
];
for (const key of passthroughVars) {
  if (process.env[key]) marketingScriptEnv[key] = process.env[key];
}

module.exports = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  taxRate: 0.08,
  // Marketing automation script runner (src/services/marketingRunner.js)
  pythonBin: process.env.PYTHON_BIN || 'python3',
  marketingScriptsDir: process.env.MARKETING_SCRIPTS_DIR || path.join(__dirname, '..', '..', 'scripts', 'marketing'),
  marketingRunStateDir: process.env.MARKETING_RUN_STATE_DIR || '/tmp/marketing-runs',
  marketingScriptEnv
};
