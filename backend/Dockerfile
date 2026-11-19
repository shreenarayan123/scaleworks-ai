FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
RUN npx prisma generate

COPY src ./src
RUN mkdir -p /app/uploads

ENV NODE_ENV=production
ENV UPLOAD_DIR=/app/uploads
EXPOSE 8080
CMD ["npm", "start"]
