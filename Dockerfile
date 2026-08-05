FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build:frontend
RUN npm run build:backend

FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
# Install only production dependencies to keep the image slim
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist
# We need ts-node and typescript on final image if we run seed script via ts-node, 
# but it's simpler if we compile seed.ts too or run it before startup in compiled form.
# Let's compile seed.ts into dist/backend/seed.js as well.
# Intsconfig.backend.json, we included "src/backend/**/*" so it will compile seed.ts automatically!
# Therefore, on startup we can run: node dist/backend/seed.js to initialize the DB.

EXPOSE 3001

ENV PORT=3001
ENV NODE_ENV=production

# Start application (database will auto-seed on first run)
CMD ["node", "dist/backend/index.js"]
