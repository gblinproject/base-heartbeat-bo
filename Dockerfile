FROM node:20-alpine
WORKDIR /app

COPY dist/ ./dist/
COPY public/ ./public/

RUN echo '{"trades":[],"totalTrades":0,"totalBuys":0,"totalSells":0}' > /trades.json

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/api/healthz || exit 1

CMD ["node", "/app/dist/index.mjs"]
