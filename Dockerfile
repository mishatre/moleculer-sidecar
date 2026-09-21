FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /usr/src/app

RUN apt-get update && apt-get install -y apt-transport-https ca-certificates curl gnupg && \
    apt-get update && \
    apt-get -y install git python3 build-essential && \
    ln -s /usr/bin/python3 /usr/bin/python && \
    rm -rf /var/lib/apt/lists/* && \
    # 
    npm install --global corepack@latest

COPY . .

RUN pnpm install --frozen-lockfile

RUN pnpm run build:ui

CMD [ "pnpm", "run", "start" ]