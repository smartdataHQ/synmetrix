ARG HASURA_VERSION=v2.48.0

FROM alpine:3.19

ARG HASURA_VERSION

# Install hasura-cli
RUN apk add --no-cache curl ca-certificates bash gcompat libstdc++ && \
    curl -L "https://github.com/hasura/graphql-engine/releases/download/${HASURA_VERSION}/cli-hasura-linux-amd64" -o /usr/local/bin/hasura-cli && \
    chmod +x /usr/local/bin/hasura-cli && \
    # Create .hasura directory and set HOME
    mkdir -p /root/.hasura && \
    hasura-cli version

WORKDIR /hasura-migrations

COPY ./migrations ./migrations
COPY ./metadata ./metadata
COPY ./seeds ./seeds
COPY ./config.yaml ./config.yaml

# Default command shows help; override with specific migration commands  
CMD ["hasura-cli", "--help"]
