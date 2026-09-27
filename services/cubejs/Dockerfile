FROM node:22.14.0-bullseye@sha256:1a956cf7ae435192dcdd18b8aba7349d649f0947795eac8b0b247b7024c60299

ARG DATABRICKS_JDBC_URL=https://databricks-bi-artifacts.s3.us-east-2.amazonaws.com/simbaspark-drivers/jdbc/2.6.32/DatabricksJDBC42-2.6.32.1054.zip

# Debian 11 (bullseye) LTS ended 2026-08-31. deb.debian.org has since purged
# the bullseye-security pool but still serves its index, so any install that
# resolves to a security update (libssl1.1 1.1.1w-0+deb11u8, ...) 404s. Read
# that suite from snapshot.debian.org's frozen copy of its final state (index
# dated 2026-08-31 21:13 UTC); its Valid-Until has passed, hence the flag.
# ponytail: stop-gap on an EOL base with no further security updates; move to
# a bookworm base (OpenSSL 3) to get updates again.
RUN sed -i 's#^deb http://deb.debian.org/debian-security bullseye-security main$#deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20260903T000000Z bullseye-security main#' /etc/apt/sources.list \
    && grep -q '^deb \[check-valid-until=no\] http://snapshot.debian.org/archive/debian-security/' /etc/apt/sources.list

RUN DEBIAN_FRONTEND=noninteractive \
    && apt-get update \
    && apt-get install -y --no-install-recommends rxvt-unicode libssl1.1 \
    && rm -rf /var/lib/apt/lists/*

ENV TERM=rxvt-unicode
ENV NODE_ENV=production

# Required for node-oracledb to buld on ARM64
RUN apt-get update \
    && apt-get install -y python3 gcc g++ make cmake libc-bin libc6 \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update && \
    apt-get install -y wget apt-transport-https ca-certificates gnupg && \
    wget -qO - https://apt.corretto.aws/corretto.key | apt-key add - && \
    echo "deb https://apt.corretto.aws stable main" | tee /etc/apt/sources.list.d/corretto.list

RUN apt-get update && apt-get install -y java-1.8.0-amazon-corretto-jdk

WORKDIR /app
ENV PATH=/app/node_modules/.bin:$PATH

COPY yarn.lock /app/yarn.lock
COPY package.json /app/package.json
COPY scripts/ /app/scripts/

RUN yarn --frozen-lockfile --network-timeout 100000

COPY index.js /app/
COPY src/ /app/src/

RUN apt-get update && apt-get install -y wget unzip && \
    wget -qO /tmp/DatabricksJDBC.zip "${DATABRICKS_JDBC_URL}" && \
    unzip /tmp/DatabricksJDBC.zip -d /app && \
    rm /tmp/DatabricksJDBC.zip

CMD ["yarn", "start"]

# registry.fraios.dev mirror enabled — rebuild trigger
