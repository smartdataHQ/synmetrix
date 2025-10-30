# Release Process

## Automated Builds (GitHub Actions)

The build process now uses GitHub Actions for automated container builds and pushes to Docker Hub.

### Supported Services

The following services are automatically built:
- **actions** (`quicklookup/synmetrix-actions`)
- **cubejs** (`quicklookup/synmetrix-cube`) 
- **client** (`quicklookup/synmetrix-client`)
- **hasura-cli** (`quicklookup/synmetrix-hasura`)
- **hasura-backend-plus** (`quicklookup/hasura-backend-plus`)

### Triggering Builds

**Automatic builds** are triggered on push/PR when files change in:
- `services/actions/`, `services/cubejs/`, `services/client/`
- `scripts/containers/hasura-cli/`, `scripts/containers/hasura-backend-plus/`
- `services/hasura/` (triggers hasura-cli build)

**Manual builds** can be triggered via GitHub Actions UI:
1. Go to Actions → Build and Push Containers
2. Click "Run workflow" 
3. Select services (comma-separated or "all")
4. Images are automatically pushed to Docker Hub

### Image Tagging

All images are tagged with:
- `{branch}-{short-sha}` (e.g., `main-abc1234`)
- `{short-sha}` (e.g., `abc1234`)
- `{branch}` (branch name)
- `latest` (for main/master branch only)

### Manual Build (Legacy)

For individual service builds:

```bash
git add "<your changes>"
git commit -m "a good commit message"
docker build --platform linux/amd64 -t quicklookup/synmetrix-actions:$(git rev-parse --short HEAD) services/actions --push
```

## Deploying

Deploying images to Kubernetes involves updating `images` in the **synmetrix overlays in the cxs repo**:
- [staging](https://github.com/smartdataHQ/cxs/blob/main/data/synmetrix/overlays/staging/kustomization.yaml)
- [prod](https://github.com/smartdataHQ/cxs/blob/main/data/synmetrix/overlays/production/kustomization.yaml)

Update the `newTag` to match the short SHA from your build:
```yaml
images:
  - name: quicklookup/synmetrix-actions
    newTag: abc1234  # Use short SHA from build
  - name: quicklookup/synmetrix-cube  
    newTag: abc1234
  - name: quicklookup/synmetrix-client
    newTag: abc1234
  - name: quicklookup/synmetrix-hasura
    newTag: abc1234
  - name: quicklookup/hasura-backend-plus
    newTag: abc1234
```

