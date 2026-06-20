# Integration test-runner image.
#
# Built from the MONOREPO ROOT context (see docker-compose.yml: the test-runner
# service sets `context: ../..`). Building from the root is what makes the
# dependency tree COMPLETE: the upload-service relies on packages hoisted at the
# workspace root (e.g. `bitcoinjs-lib`, a direct dependency of the root
# package.json), and a package-local `yarn install` silently drops them. Copying
# the root lockfile + .yarnrc.yml + .yarn/ and running `yarn install --immutable`
# reproduces the exact tree the app runs with.
#
# Codebase requires Node 22 (@ar.io/sdk v4 is ESM-only; root engines >=22.12).
# Compose passes the same default; keep in sync with .nvmrc (22.22.0).
ARG NODE_VERSION=22.22.0

FROM node:${NODE_VERSION}-bullseye-slim
WORKDIR /usr/src/app

# git: resolves a git-hosted transitive devDependency (avsc, via arlocal/turbo-sdk).
# corepack: activates the Yarn version pinned in the root package.json — the base
# image ships Yarn 1.x, which errors on the `packageManager: yarn@3.x` field.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# Install dependencies from the workspace manifests first, so the (slow) install
# layer is cached and only re-runs when a manifest or the lockfile changes — not
# on every source edit while iterating the suite.
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/ ./.yarn/
COPY packages/upload-service/package.json   ./packages/upload-service/
COPY packages/payment-service/package.json  ./packages/payment-service/
COPY packages/admin-service/package.json    ./packages/admin-service/
COPY packages/shared/package.json           ./packages/shared/

# --immutable: the copied lockfile must already satisfy the manifests; this both
# reproduces the committed tree and fails loudly if the lockfile has drifted.
RUN yarn install --immutable

# Now copy the full source tree (node_modules etc. excluded via the
# .dockerignore alongside this file).
COPY . .

WORKDIR /usr/src/app/packages/upload-service

# Pre-create the FileSystemObjectStore temp dirs: bundle prepare/post/verify jobs
# assemble bundles on disk under TEMP_DIR (default "temp"), but the dirs are only
# auto-created by FileSystemObjectStore's constructor, which these S3-backed tests
# don't instantiate — so without this the jobs hit ENOENT on temp/bundle/*.
# Then run migrations and the integration suite only (unit is CI-gated separately;
# e2e specs need a live/funded signer and are excluded from test:integration).
CMD mkdir -p temp/bundle temp/raw-data-item temp/header temp/bundle-payload temp/data temp/multipart-uploads \
  && yarn db:migrate:latest \
  && yarn test:integration
