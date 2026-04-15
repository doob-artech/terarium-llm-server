FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY data/workers.example.json ./data/workers.example.json

ENV NODE_ENV=production
ENV PORT=18200

EXPOSE 18200

CMD ["node", "src/server.js"]
