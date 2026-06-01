FROM node:22-alpine

WORKDIR /app

# Сначала зависимости — лучше кэшируется.
COPY package.json ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server/index.js"]
