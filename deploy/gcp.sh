#!/usr/bin/env bash
# Optional Google Cloud deployment for remit:
#   - Go ledger as a single-instance Cloud Run service
#   - TypeScript review desk as a Cloud Run service
#   - sweep as a Cloud Run job, hourly via Cloud Scheduler
#   - secrets in Secret Manager
#
# This script is provided for operators who already use GCP. It was not
# used for the free Neon/Render/GitHub deployment described in README.md.
# Google Cloud requires a billing account even when usage stays within
# free allowances. Do not run it unless you accept that.
#
# Required environment (export first; values are never printed):
#   GCP_PROJECT       Google Cloud project id
#   DATABASE_URL      Postgres URL reachable from Cloud Run (for example Neon)
#   LEDGER_TOKEN      bearer token for the ledger GraphQL API
#   REVIEW_PASSWORD   password for user "remit" on the human desk
# Optional:
#   GCP_REGION        default us-central1
#   WORLD_SEED        default 20261023
#   DRAFT_MODEL       default baseline:rules
#   REMIT_BUDGET_USD  default 1
#   XAI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY / GROQ_API_KEY
set -euo pipefail

PROJECT="${GCP_PROJECT:?set GCP_PROJECT}"
REGION="${GCP_REGION:-us-central1}"
: "${DATABASE_URL:?set DATABASE_URL}"
: "${LEDGER_TOKEN:?set LEDGER_TOKEN}"
: "${REVIEW_PASSWORD:?set REVIEW_PASSWORD}"

REPO="${REGION}-docker.pkg.dev/${PROJECT}/remit"
LEDGER_IMG="${REPO}/ledger:latest"
AGENT_IMG="${REPO}/agent:latest"
DRAFT_MODEL="${DRAFT_MODEL:-baseline:rules}"
REMIT_BUDGET_USD="${REMIT_BUDGET_USD:-1}"
WORLD_SEED="${WORLD_SEED:-20261023}"

echo "Enabling APIs..."
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com cloudscheduler.googleapis.com \
  --project "$PROJECT"

echo "Ensuring Artifact Registry repository..."
gcloud artifacts repositories describe remit --location "$REGION" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud artifacts repositories create remit \
    --repository-format=docker --location "$REGION" --project "$PROJECT"

echo "Building images..."
gcloud builds submit \
  --config deploy/cloudbuild.yaml \
  --substitutions="_LOCATION=${REGION}" \
  . --project "$PROJECT"

put_secret() {
  local name="$1" value="$2"
  if gcloud secrets describe "$name" --project "$PROJECT" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- --project "$PROJECT" >/dev/null
  else
    printf '%s' "$value" | gcloud secrets create "$name" \
      --data-file=- --replication-policy=automatic --project "$PROJECT" >/dev/null
  fi
  echo "secret $name stored"
}

put_secret remit-database-url "$DATABASE_URL"
put_secret remit-ledger-token "$LEDGER_TOKEN"
put_secret remit-review-password "$REVIEW_PASSWORD"
[ -n "${XAI_API_KEY:-}" ] && put_secret remit-xai-key "$XAI_API_KEY"
[ -n "${ANTHROPIC_API_KEY:-}" ] && put_secret remit-anthropic-key "$ANTHROPIC_API_KEY"
[ -n "${OPENAI_API_KEY:-}" ] && put_secret remit-openai-key "$OPENAI_API_KEY"
[ -n "${GROQ_API_KEY:-}" ] && put_secret remit-groq-key "$GROQ_API_KEY"

LEDGER_SECRETS="DATABASE_URL=remit-database-url:latest,LEDGER_TOKEN=remit-ledger-token:latest"
AGENT_SECRETS="${LEDGER_SECRETS},REVIEW_PASSWORD=remit-review-password:latest"
[ -n "${XAI_API_KEY:-}" ] && AGENT_SECRETS="${AGENT_SECRETS},XAI_API_KEY=remit-xai-key:latest"
[ -n "${ANTHROPIC_API_KEY:-}" ] && AGENT_SECRETS="${AGENT_SECRETS},ANTHROPIC_API_KEY=remit-anthropic-key:latest"
[ -n "${OPENAI_API_KEY:-}" ] && AGENT_SECRETS="${AGENT_SECRETS},OPENAI_API_KEY=remit-openai-key:latest"
[ -n "${GROQ_API_KEY:-}" ] && AGENT_SECRETS="${AGENT_SECRETS},GROQ_API_KEY=remit-groq-key:latest"

# The stand-in ledger persists a small world snapshot. Keep exactly one
# writer process. Cloud Run IAM is open at the network edge so the agent
# can call it, but every GraphQL request still needs LEDGER_TOKEN in the
# application. A production ERP integration replaces this service.
echo "Deploying ledger service..."
gcloud run deploy remit-ledger \
  --image "$LEDGER_IMG" --region "$REGION" --project "$PROJECT" \
  --allow-unauthenticated --port 8090 \
  --max-instances 1 --concurrency 1 \
  --set-env-vars "WORLD_SEED=${WORLD_SEED}" \
  --set-secrets "$LEDGER_SECRETS"

LEDGER_URL="$(gcloud run services describe remit-ledger \
  --region "$REGION" --project "$PROJECT" --format='value(status.url)')"

echo "Deploying human desk..."
gcloud run deploy remit-review \
  --image "$AGENT_IMG" --region "$REGION" --project "$PROJECT" \
  --allow-unauthenticated --port 3000 \
  --set-env-vars "NODE_ENV=production,LEDGER_URL=${LEDGER_URL},DRAFT_MODEL=${DRAFT_MODEL},REMIT_BUDGET_USD=${REMIT_BUDGET_USD}" \
  --set-secrets "$AGENT_SECRETS" \
  --command node --args dist/src/cli.js,serve,--port,3000

echo "Creating/updating sweep job..."
if gcloud run jobs describe remit-sweep --region "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud run jobs update remit-sweep \
    --image "$AGENT_IMG" --region "$REGION" --project "$PROJECT" \
    --set-env-vars "NODE_ENV=production,LEDGER_URL=${LEDGER_URL},DRAFT_MODEL=${DRAFT_MODEL}" \
    --set-secrets "$AGENT_SECRETS" \
    --command node --args "dist/src/cli.js,sweep,--budget,${REMIT_BUDGET_USD}" \
    --max-retries 1 --task-timeout 20m
else
  gcloud run jobs create remit-sweep \
    --image "$AGENT_IMG" --region "$REGION" --project "$PROJECT" \
    --set-env-vars "NODE_ENV=production,LEDGER_URL=${LEDGER_URL},DRAFT_MODEL=${DRAFT_MODEL}" \
    --set-secrets "$AGENT_SECRETS" \
    --command node --args "dist/src/cli.js,sweep,--budget,${REMIT_BUDGET_USD}" \
    --max-retries 1 --task-timeout 20m
fi

echo "Scheduling one sweep per hour..."
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
SCHEDULER_IDENTITY="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
JOB_URI="https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/remit-sweep:run"
if gcloud scheduler jobs describe remit-hourly --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud scheduler jobs update http remit-hourly \
    --location "$REGION" --project "$PROJECT" \
    --schedule "23 * * * *" --uri "$JOB_URI" --http-method POST \
    --oauth-service-account-email "$SCHEDULER_IDENTITY"
else
  gcloud scheduler jobs create http remit-hourly \
    --location "$REGION" --project "$PROJECT" \
    --schedule "23 * * * *" --uri "$JOB_URI" --http-method POST \
    --oauth-service-account-email "$SCHEDULER_IDENTITY"
fi

echo
echo "Done."
echo "Ledger: ${LEDGER_URL}"
echo "Desk:   $(gcloud run services describe remit-review --region "$REGION" --project "$PROJECT" --format='value(status.url)')"
echo "Sweep:  Cloud Run job remit-sweep, hourly at :23 via Cloud Scheduler remit-hourly"
echo "First run: gcloud run jobs execute remit-sweep --region ${REGION} --project ${PROJECT} --wait"
echo "If Scheduler reports permission denied, grant roles/run.invoker on the job to ${SCHEDULER_IDENTITY} in your project's IAM policy."
