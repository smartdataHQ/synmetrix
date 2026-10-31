# Bookworm (glibc 2.36): Cube 1.7.36+ ships an x86_64 native module that needs
# glibc 2.34, which bullseye (2.31) lacks.
FROM node:22.14.0-bookworm@sha256:e5ddf893cc6aeab0e5126e4edae35aa43893e2836d1d246140167ccc2616f5d7

RUN DEBIAN_FRONTEND=noninteractive \
    && apt-get update \
    && apt-get install -y --no-install-recommends rxvt-unicode \
    && rm -rf /var/lib/apt/lists/*

ENV TERM=rxvt-unicode
ENV NODE_ENV=production

# Required for node-oracledb to buld on ARM64
RUN apt-get update \
    && apt-get install -y python3 gcc g++ make cmake libc-bin libc6 \
    && rm -rf /var/lib/apt/lists/*

# Java 11+ for the JDBC drivers: they start the JVM with --add-opens, which
# Java 8 rejects by crashing the process. Installed before `yarn` so node-java
# builds against it.
RUN apt-get update && \
    apt-get install -y wget apt-transport-https ca-certificates gnupg && \
    wget -qO - https://apt.corretto.aws/corretto.key | apt-key add - && \
    echo "deb https://apt.corretto.aws stable main" | tee /etc/apt/sources.list.d/corretto.list

RUN apt-get update && apt-get install -y java-21-amazon-corretto-jdk

WORKDIR /app
ENV PATH=/app/node_modules/.bin:$PATH

# CubeStore runs as its own service; skip downloading the bundled binary.
ENV CUBESTORE_SKIP_POST_INSTALL=true

COPY yarn.lock /app/yarn.lock
COPY package.json /app/package.json
COPY scripts/ /app/scripts/

RUN yarn --frozen-lockfile --network-timeout 100000

# sqlite3's prebuilt binary needs glibc 2.38 (bookworm has 2.36); build it here.
RUN cd node_modules/sqlite3 && node-gyp rebuild

# DuckDB datasources may load but never download extensions (sandbox in
# scripts/patchCubeYamlCompiler.mjs): ship the remote-data ones.
RUN node -e "require('@duckdb/node-api').DuckDBInstance.create(':memory:').then((i) => i.connect()).then(async (c) => { for (const e of ['httpfs', 'aws', 'motherduck', 'excel']) await c.run('INSTALL ' + e); }).catch((e) => { console.error(e); process.exit(1); })"

# Fail the build, not the first query, if a native module cannot load here.
RUN node -e "require('@cubejs-backend/native').loadNative(); require('sqlite3'); require('@duckdb/node-api')"

COPY index.js /app/
COPY src/ /app/src/

CMD ["yarn", "start"]
