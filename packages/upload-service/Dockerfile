# The codebase requires Node 22 (.nvmrc v22.22.0, root engines >=22.12,
# @ar.io/sdk v4 is ESM-only). Default to Node 22; CI passes the same value
# via build-args. NODE_VERSION_SHORT must match the major used by the
# distroless runtime image below.
ARG NODE_VERSION=22.14.0
ARG NODE_VERSION_SHORT=22

FROM node:${NODE_VERSION}-bookworm-slim AS builder

# This image is built with the package directory as the build context
# (see .github/workflows/docker.yml and docker-compose.yml). That context
# does NOT contain the monorepo-root .yarnrc.yml / yarn.lock / Yarn plugins,
# so we configure a self-contained, node-modules install here rather than
# relying on the workspace-tools plugin (`yarn workspaces focus`).
WORKDIR /usr/src/app

# git (+ CA certs) is required to resolve a git-hosted transitive
# devDependency (avsc -> https://github.com/Irys-xyz/avsc, pulled in by
# arlocal/turbo-sdk). ca-certificates lets git verify the GitHub TLS cert.
# This only affects the throwaway builder stage; the runtime image below
# does not carry it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Activate the Yarn version pinned in package.json via Corepack.
RUN corepack enable

COPY . .

# Use the node-modules linker (not PnP) so the distroless runtime, which
# expects a real node_modules tree, works. No lockfile is present in this
# context, so the install cannot be immutable.
RUN yarn config set nodeLinker node-modules \
  && yarn config set enableGlobalCache false \
  && yarn install --no-immutable \
  && yarn build

# Produce a production-only dependency tree. `npm prune` operates on the
# node-modules layout Yarn just created and removes devDependencies without
# needing the Yarn workspace-tools plugin.
RUN npm prune --omit=dev

FROM gcr.io/distroless/nodejs${NODE_VERSION_SHORT}-debian12
WORKDIR /usr/src/app

# Add shell
COPY --from=busybox:1.35.0-uclibc /bin/sh /bin/sh
COPY --from=busybox:1.35.0-uclibc /bin/addgroup /bin/addgroup
COPY --from=busybox:1.35.0-uclibc /bin/adduser /bin/adduser
COPY --from=busybox:1.35.0-uclibc /bin/chown /bin/chown

# Create user
RUN addgroup -g 1000 node \
  && adduser -u 1000 -G node -s /bin/sh -D node
RUN chown -R node ./
USER node

# Copy build files
COPY --from=builder --chown=node /usr/src/app/lib ./lib
COPY --from=builder --chown=node /usr/src/app/node_modules ./node_modules
COPY --from=builder --chown=node /usr/src/app/docs ./docs

EXPOSE 3000
CMD ["./lib/index.js"]
