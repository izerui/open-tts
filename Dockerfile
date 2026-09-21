FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node package.json index.js server.mjs ./

USER node

ENV HOST=0.0.0.0 \
    PORT=8787 \
    NODE_ENV=production \
    API_KEY=sk-tts-default-key \
    SILICONFLOW_API_KEY=

EXPOSE 8787

CMD ["node", "server.mjs"]
