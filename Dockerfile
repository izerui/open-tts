FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node index.js server.mjs ./

USER node

ENV HOST=0.0.0.0 \
    PORT=8787 \
    NODE_ENV=production \
    API_KEY=sk-c96e08d2c3e20a3e244c51ee69888d0a96400b1a3883aa4e \
    API_KEYS= \
    WHISPER_URL=

EXPOSE 8787

CMD ["node", "server.mjs"]
