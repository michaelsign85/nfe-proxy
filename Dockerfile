# NFe Proxy Server - Dockerfile
FROM node:20-alpine

# Forçar rebuild - mude este timestamp para rebuild
ARG CACHEBUST=2026011323

# Criar diretório da aplicação
WORKDIR /app

# Copiar package.json primeiro (para cache de dependências)
COPY package*.json ./

# Instalar dependências (sem cache para garantir)
RUN npm cache clean --force && npm install --production

# Copiar resto dos arquivos (sem cache)
COPY --chown=node:node . .

# Criar pasta de logs
RUN mkdir -p logs && chmod 777 logs

# Expor porta
EXPOSE 80

# Variáveis de ambiente padrão (podem ser sobrescritas pelo EasyPanel)
ENV NODE_ENV=production
ENV PORT=80

# Comando para iniciar
CMD ["node", "src/server.js"]
