#!/usr/bin/env bash
set -euo pipefail

# PairPrep Automated Production Deployment & Rollback Script
# Usage: ./infra/deploy.sh <NEW_IMAGE_TAG>

NEW_IMAGE="${1:-ghcr.io/shubhx8/pairprep-server:latest}"
PREV_IMAGE_FILE="/tmp/pairprep_prev_image.txt"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$PROJECT_DIR"

echo "=================================================="
echo "Starting PairPrep Deployment"
echo "Target Image: $NEW_IMAGE"
echo "=================================================="

# 1. Capture current running image for rollback
CURRENT_IMAGE=$(docker inspect --format='{{.Config.Image}}' infra-server-1 2>/dev/null || echo "")
if [ -n "$CURRENT_IMAGE" ]; then
    echo "$CURRENT_IMAGE" > "$PREV_IMAGE_FILE"
    echo "Saved current image for rollback: $CURRENT_IMAGE"
fi

# 2. Pull the new image
echo "Pulling new image: $NEW_IMAGE..."
if ! docker pull "$NEW_IMAGE"; then
    echo "ERROR: Failed to pull image $NEW_IMAGE"
    exit 1
fi

# 3. Update stack with new image
echo "Deploying container..."
export SERVER_IMAGE="$NEW_IMAGE"
docker compose -f infra/docker-compose.prod.yml up -d server

# 4. Perform health check with retries
echo "Running health checks on /healthz..."
HEALTHY=false
for i in {1..6}; do
    sleep 3
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/healthz || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        HEALTHY=true
        echo "Health check passed on attempt $i (HTTP 200 OK)."
        break
    else
        echo "Attempt $i: /healthz returned HTTP $HTTP_CODE, retrying..."
    fi
done

# 5. Handle rollback on failure
if [ "$HEALTHY" = false ]; then
    echo "CRITICAL: Health check failed! Initiating rollback..."
    if [ -f "$PREV_IMAGE_FILE" ]; then
        ROLLBACK_IMAGE=$(cat "$PREV_IMAGE_FILE")
        if [ -n "$ROLLBACK_IMAGE" ]; then
            echo "Rolling back to previous stable image: $ROLLBACK_IMAGE..."
            export SERVER_IMAGE="$ROLLBACK_IMAGE"
            docker compose -f infra/docker-compose.prod.yml up -d server
            echo "Rollback completed."
        fi
    fi
    echo "Container logs:"
    docker compose -f infra/docker-compose.prod.yml logs --tail=30 server
    exit 1
fi

echo "=================================================="
echo "Deployment Succeeded: $NEW_IMAGE is live."
echo "=================================================="
