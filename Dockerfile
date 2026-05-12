FROM node:20-alpine

WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package.json package-lock.json ./

# Copy data dir and scripts before npm ci (postinstall needs both)
COPY data/ ./data/
COPY scripts/ ./scripts/

# Install production dependencies only
RUN npm ci --omit=dev

# Copy the rest of the application
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
