FROM node:22-bookworm-slim
# ffmpeg: miniaturas, prévia, cortes, vídeo HLS, limpeza de dados escondidos
# yt-dlp + gallery-dl: motores para baixar de qualquer site (atualizados sozinhos 1x por dia)
# chromium: navegador invisível, último recurso para players que só aparecem com a página rodando
# (Debian em vez de Alpine: o modelo de visão das legendas automáticas precisa da glibc)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates chromium fonts-liberation \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp gallery-dl \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_SKIP_DOWNLOAD=true BROWSER_BIN=/usr/bin/chromium
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
