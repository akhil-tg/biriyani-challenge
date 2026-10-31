FROM node:22-slim
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV PORT=7860
EXPOSE 7860
CMD ["node", "server.js"]
