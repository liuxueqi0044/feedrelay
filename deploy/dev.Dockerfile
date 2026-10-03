# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_HOME=/usr/local/share/corepack
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile && mkdir -p /app/apps/server/.data && chown node:node /app/apps/server/.data
USER node
CMD ["pnpm", "dev"]
