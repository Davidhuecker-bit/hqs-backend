FROM node:20-alpine

WORKDIR /app

# bash is not included in Alpine by default but start.sh requires it
RUN apk add --no-cache bash

# Install dependencies first (cached layer)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

CMD ["bash", "start.sh"]
