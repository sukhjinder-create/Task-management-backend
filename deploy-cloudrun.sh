#!/bin/bash
# One-command deploy to Google Cloud Run
# Run this from the Task-management-be folder

PROJECT_ID="asystence-backend"   # change this if you pick a different GCP project name
REGION="asia-south1"             # Mumbai — closest to India
SERVICE="asystence-api"
IMAGE="gcr.io/$PROJECT_ID/$SERVICE"

echo "🚀 Building and deploying to Google Cloud Run..."

# Build & push image
gcloud builds submit --tag $IMAGE

# Deploy to Cloud Run
gcloud run deploy $SERVICE \
  --image $IMAGE \
  --platform managed \
  --region $REGION \
  --allow-unauthenticated \
  --port 3000 \
  --memory 1Gi \
  --cpu 1 \
  --min-instances 1 \
  --max-instances 100 \
  --concurrency 1000 \
  --timeout 3600 \
  --set-env-vars "NODE_ENV=production"

echo "✅ Deployed! Copy the URL above and set it as VITE_BACKEND_URL in Vercel."
