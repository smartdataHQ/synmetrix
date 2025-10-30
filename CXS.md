# Images

During the deployment to dev, the following images are built from this codebase and pushed manually to the `quicklookup` org on Docker Hub:

### `quicklookup/synmetrix-actions:latest`
Source: [services/actions/Dockerfile](services/actions/Dockerfile)

### `quicklookup/synmetrix-cube:latest`
Source: [services/cubejs/Dockerfile](services/cubejs/Dockerfile)

### `quicklookup/hasura-backend-plus:latest`
Source: [scripts/containers/hasura-backend-plus/Dockerfile](scripts/containers/hasura-backend-plus/Dockerfile)

### `quicklookup/synmetrix-hasura-migrations:latest` ( _Migration Job_ )
Source: [services/hasura/Dockerfile](services/hasura/Dockerfile)
Built via: [services/hasura/build.sh](services/hasura/build.sh)



