# Private RBI: Xvfb + headful Debian Chromium + ffmpeg capture + Node server.
# Multi-arch: builds natively on ARM64 (Oracle Ampere A1) and x86-64.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      xvfb xauth \
      ffmpeg \
      python3 python3-xlib \
      fonts-liberation fonts-dejavu-core fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
      ca-certificates tzdata dumb-init \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data
USER node

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    CHROMIUM_PATH=/usr/bin/chromium

EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
