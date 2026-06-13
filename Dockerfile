# Stage 1: slim runtime base (Node + pnpm only)
FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PATH:$PNPM_HOME
RUN npm install pnpm@9.6.0 --global

# Stage 2: build toolchain + dependency cache
FROM base AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates python3 make g++ && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

ENV PATH=$PATH:/root/.foundry/bin
RUN curl -L https://foundry.paradigm.xyz/ | bash && \
    /root/.foundry/bin/foundryup

# Copy dependency metadata first (cached unless deps change)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages/abi-ts/package.json packages/abi-ts/
COPY packages/block-logs-stream/package.json packages/block-logs-stream/
COPY packages/cli/package.json packages/cli/
COPY packages/common/package.json packages/common/
COPY packages/config/package.json packages/config/
COPY packages/create-mud/package.json packages/create-mud/
COPY packages/dev-tools/package.json packages/dev-tools/
COPY packages/entrykit/package.json packages/entrykit/
COPY packages/explorer/package.json packages/explorer/
COPY packages/faucet/package.json packages/faucet/
COPY packages/gas-report/package.json packages/gas-report/
COPY packages/id.place/package.json packages/id.place/
COPY packages/paymaster/package.json packages/paymaster/
COPY packages/protocol-parser/package.json packages/protocol-parser/
COPY packages/react/package.json packages/react/
COPY packages/recs/package.json packages/recs/
COPY packages/schema-type/package.json packages/schema-type/
COPY packages/solhint-config-mud/package.json packages/solhint-config-mud/
COPY packages/solhint-plugin-mud/package.json packages/solhint-plugin-mud/
COPY packages/stash/package.json packages/stash/
COPY packages/store/package.json packages/store/
COPY packages/store-indexer/package.json packages/store-indexer/
COPY packages/store-sync/package.json packages/store-sync/
COPY packages/utils/package.json packages/utils/
COPY packages/vite-plugin-mud/package.json packages/vite-plugin-mud/
COPY packages/world/package.json packages/world/
COPY packages/world-consumer/package.json packages/world-consumer/
COPY packages/world-module-callwithsignature/package.json packages/world-module-callwithsignature/
COPY packages/world-module-erc20/package.json packages/world-module-erc20/
COPY packages/world-module-metadata/package.json packages/world-module-metadata/
COPY packages/world-modules/package.json packages/world-modules/
COPY apps/id.place/package.json apps/id.place/
COPY test/with-anvil/package.json test/with-anvil/
COPY test/mock-game-contracts/package.json test/mock-game-contracts/
COPY test/puppet-modules/package.json test/puppet-modules/
COPY test/system-libraries/package.json test/system-libraries/
COPY test/ts-benchmarks/package.json test/ts-benchmarks/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Copy source, re-link workspace bins, then build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm turbo run build --filter=@latticexyz/store-indexer...

# Stage 3: slim store-indexer image (no Foundry, no build tools)
FROM base AS store-indexer
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}
WORKDIR /app
COPY --from=builder /app .
WORKDIR /app/packages/store-indexer
EXPOSE 3001

# Stage 4: slim faucet image
FROM base AS faucet
WORKDIR /app
COPY --from=builder /app .
WORKDIR /app/packages/faucet
EXPOSE 3002
