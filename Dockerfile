FROM node:22-alpine
# ffmpeg: miniaturas, vídeo HLS, limpeza de dados escondidos
# yt-dlp + gallery-dl: motores para baixar de qualquer site (atualizados sozinhos 1x por dia)
RUN apk add --no-cache ffmpeg python3 py3-pip ca-certificates \
 && pip install --no-cache-dir --break-system-packages yt-dlp gallery-dl
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
