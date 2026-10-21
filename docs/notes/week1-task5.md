# Task 5: Production Deployment Pipeline & Automated CD

## What Changed

- Authored a production-grade **CI/CD Workflow** in `.github/workflows/ci.yml`:
  - **`verify` Job**: Runs on all PRs and pushes to `master`, enforcing Prettier formatting, ESLint static analysis, strict TypeScript typechecking, Vitest test suites, and production builds.
  - **`deploy` Job**: Automatically triggers only when `verify` passes on `master`.
    - Authenticates to **GitHub Container Registry (`ghcr.io`)** via native `GITHUB_TOKEN`.
    - Builds the server image with Buildx and tags it with both the commit SHA (`:${{ github.sha }}`) and `:latest`.
    - Deploys to the Azure VM over SSH using GitHub Secrets.
    - Runs a healthcheck against `http://localhost:3000/healthz`.
- Created `infra/deploy.sh` with automated rollback:
  - Records the previous running container tag before deploying.
  - If the health check fails across 6 retries (18 seconds), it automatically rolls back to the previous tag and logs diagnostic output.
- Created `infra/docker-compose.prod.yml` parameterizing container images with `${SERVER_IMAGE}`.

## Why

- **GitHub Container Registry (GHCR):** Zero cost for public repositories, no rate-limiting issues compared to Docker Hub, and co-located on GitHub's network for fast image pulls.
- **Commit SHA Tagging:** Tagging containers with the git commit SHA creates immutable build artifacts that map 1-to-1 with git history, enabling instant single-command rollbacks.
- **Automated Health Check & Rollback:** Deploys are never considered complete until `/healthz` responds with HTTP 200 OK. If a crash or regression occurs, the script restores the previous container without requiring human intervention.

## Required GitHub Secrets Setup

To activate the automated deployment from GitHub Actions to your Azure VM:

1. Navigate to: **`https://github.com/Shubhx8/pairprep/settings/secrets/actions`**
2. Click **New repository secret** and add the following 3 variables:

| Secret Name   | Value                                 | Description                             |
| :------------ | :------------------------------------ | :-------------------------------------- |
| `VM_HOST`     | `52.175.53.13`                        | Public IP or Azure domain of your VM    |
| `VM_USERNAME` | `azureuser`                           | SSH user on the Azure VM                |
| `VM_SSH_KEY`  | _(Contents of `pairprep-vm_key.pem`)_ | Private key used for SSH authentication |

> **How to create a dedicated restricted deploy key (optional best practice):**
>
> ```bash
> ssh-keygen -t ed25519 -C "github-actions-deploy" -f deploy_key
> # Add deploy_key.pub to ~/.ssh/authorized_keys on the Azure VM
> # Add private deploy_key contents to GitHub Secret VM_SSH_KEY
> ```

## How to Explain in an Interview

> _"We implemented a fully automated CI/CD pipeline using GitHub Actions and GitHub Container Registry. Every merge to master triggers automated quality gates (lint, typecheck, tests, and build) before building a production Docker container tagged with the commit SHA. The pipeline securely deploys to our Azure host over SSH, verifies the deployment against /healthz, and automatically rolls back to the previous image tag if the health check fails, ensuring zero downtime."_
