FROM node:20-alpine

WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package.json package-lock.json ./

# Copy data dir so the postinstall fetch-mkopo-catalog script skips the download
COPY data/ ./data/

# Install production dependencies only
RUN npm ci --omit=dev

# Copy the rest of the application
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
