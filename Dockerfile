FROM node:22-slim
# git fica instalado para o caso de uma versão futura da biblioteca do WhatsApp voltar a precisar dele
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production DATA_DIR=/app/data PORT=3000
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]
