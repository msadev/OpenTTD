FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY *.js ./

ENV LOG_LEVEL=error

EXPOSE 8080

CMD ["node", "websocket-proxy.js", "8080"]
