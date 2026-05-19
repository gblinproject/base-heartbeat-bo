FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache curl
# Force layer cache invalidation
ARG CACHEBUST=20260519T1
COPY dist/ ./dist/
COPY public/ ./public/
COPY start.sh ./start.sh
RUN chmod +x /app/start.sh
RUN echo '{"trades":[],"totalTrades":0,"totalBuys":0,"totalSells":0}' > /trades.json
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
  CMD wget -qO- http://localhost:${PORT}/api/healthz || exit 1
CMD ["node", "/app/dist/index.mjs"]
