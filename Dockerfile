# syntax=docker/dockerfile:1
FROM node:24-alpine
WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
# data/ is a volume so SQLite persists across container restarts.
VOLUME ["/app/data"]
USER node
CMD ["node", "server.js"]