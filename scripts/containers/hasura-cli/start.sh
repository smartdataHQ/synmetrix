#!/bin/bash

cd /hasura || {
    echo "Hasura folder '/hasura' not found"
    exit 1
}

socat TCP-LISTEN:8080,fork TCP:hasura:8080 &

echo "Applying migrations..."
hasura-cli migrate apply --database-name default --endpoint http://hasura:8080 --admin-secret "$HASURA_GRAPHQL_ADMIN_SECRET" 2>&1
echo "Applying metadata..."
hasura-cli metadata apply --endpoint http://hasura:8080 --admin-secret "$HASURA_GRAPHQL_ADMIN_SECRET" 2>&1

hasura-cli console --log-level DEBUG --address 0.0.0.0 --no-browser || exit 1
