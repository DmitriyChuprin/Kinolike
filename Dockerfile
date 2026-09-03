FROM node:20-alpine
RUN apk add --no-cache python3 make g++ curl ffmpeg chromium \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp
ENV CHROMIUM_PATH=/usr/bin/chromium-browser
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server/ ./server/
COPY client/ ./client/
EXPOSE 3000
CMD ["node", "server/index.js"]
