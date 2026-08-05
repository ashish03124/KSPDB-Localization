FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build:frontend
RUN npm run build:backend

FROM node:20-slim

WORKDIR /app

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 3001

ENV PORT=3001
ENV NODE_ENV=production

# Start application (database will auto-seed on first run)
CMD ["node", "dist/backend/index.js"]
