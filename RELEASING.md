# Current release 

The build process is currently manual.

### Releasing `services/actions`

```bash
git add "<your changes>"
git commit -m "a good commit message"
docker build --platform linux/amd64 -t quicklookup/synmetrix-actions:$(git rev-parse --short HEAD) actions/services --push
```

This build and pushes a docker image, tagged to the current git (short) SHA.

### Deploying

Deploying the image to kubernetes involves updating `images` in the **synmetrix overlays in the cxs repo**:
- [staging](https://github.com/smartdataHQ/cxs/blob/main/data/synmetrix/overlays/staging/kustomization.yaml)
- [prod](https://github.com/smartdataHQ/cxs/blob/main/data/synmetrix/overlays/production/kustomization.yaml)

Modify the `newTag` of the appropriate image to match the git short sha you tagged your image with:
```yaml
[...]
images:
  - name: quicklookup/synmetrix-actions
    newTag: <new-sha>
[...]
```

