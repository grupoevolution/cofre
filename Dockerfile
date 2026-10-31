FROM node:22-alpine
# ffmpeg: miniaturas, vídeo HLS, limpeza de dados escondidos
# yt-dlp + gallery-dl: motores para baixar de qualquer site (atualizados sozinhos 1x por dia)
# chromium: navegador invisível, último recurso para players que só aparecem com a página rodando
RUN apk add --no-cache ffmpeg python3 py3-pip ca-certificates chromium nss freetype harfbuzz ttf-freefont \
 && pip install --no-cache-dir --break-system-packages yt-dlp gallery-dl
ENV PUPPETEER_SKIP_DOWNLOAD=true BROWSER_BIN=/usr/bin/chromium-browser
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
