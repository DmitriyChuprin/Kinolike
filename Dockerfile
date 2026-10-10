# Build the React/Vite client inside the image so docker compose is the only
# command needed to prepare and run the application.
FROM node:20-alpine AS frontend-build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime image contains only production dependencies and the built client.
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=frontend-build /app/server ./server
COPY --from=frontend-build /app/dist ./dist
COPY --from=frontend-build /app/docs ./docs
EXPOSE 3000
CMD ["node", "server/index.js"]
