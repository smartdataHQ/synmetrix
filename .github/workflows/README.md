# GitHub Actions Workflows

This directory contains GitHub Actions workflows for automated CI/CD operations.

## Active Workflows

### `build-containers.yml` - Selective Docker Container Builds

Automated Docker container building and pushing for all Synmetrix services.

**Supported Services:**
- `quicklookup/synmetrix-actions` (Node.js backend)
- `quicklookup/synmetrix-cube` (CubeJS analytics) 
- `quicklookup/synmetrix-client` (React frontend)
- `quicklookup/synmetrix-hasura` (GraphQL API)
- `quicklookup/hasura-backend-plus` (Auth backend)

**Triggers:**
- **Automatic**: Push/PR when files change in service directories
- **Manual**: GitHub Actions UI → "Build and Push Containers"

**Change Detection:**
The workflow automatically detects which services need rebuilding based on file changes:
- `services/actions/` → builds actions service
- `services/cubejs/` → builds cubejs service  
- `services/client/` → builds client service
- `scripts/containers/hasura-cli/` or `services/hasura/` → builds hasura-cli service
- `scripts/containers/hasura-backend-plus/` → builds hasura-backend-plus service

**Image Tagging:**
All built images are tagged with:
- `{short-sha}` (e.g., `abc1234`) - Primary deployment tag
- `{branch}-{short-sha}` (e.g., `main-abc1234`) - Full context tag
- `{branch}` (branch name) - Latest for branch
- `latest` (main/master branch only) - Production latest

**Push Logic:**
- ✅ **Pushes**: All branch pushes and manual triggers
- ❌ **Build only**: Pull requests (for testing)

**Manual Usage:**
1. Go to Actions → "Build and Push Containers"
2. Click "Run workflow"
3. Select services: `actions,cubejs,client,hasura-cli,hasura-backend-plus` or `all`
4. Images automatically pushed to Docker Hub

## Disabled Workflows

Legacy workflows in `./disabled/` directory have been deactivated by commenting out their triggers. These include:
- `aws-staging.yml` - AWS deployment workflow
- `commitlint.yml` - Commit message linting
- `drafts-release.yml` - Release draft management
- `lint-pr-title.yml` - PR title linting
- `notify-release.yml` - Slack release notifications
- `schedule-release.yml` - Scheduled releases

## Deployment

Built images are deployed to Kubernetes via the [cxs repository](https://github.com/smartdataHQ/cxs) using:
- **Staging**: `data/synmetrix/overlays/staging/`
- **Production**: `data/synmetrix/overlays/production/`

Update `newTag` in the appropriate overlay's `kustomization.yaml` to deploy new images.