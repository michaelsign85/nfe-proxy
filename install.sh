#!/bin/bash

#############################################
# Script de Instalação - NFe Proxy Server
# Para VPS Ubuntu/Debian na Hostinger
#############################################

echo "🚀 Instalando NFe Proxy Server..."

# Verificar se está rodando como root
if [ "$EUID" -ne 0 ]; then 
  echo "Por favor, execute como root (sudo ./install.sh)"
  exit 1
fi

# Atualizar sistema
echo "📦 Atualizando sistema..."
apt update && apt upgrade -y

# Instalar Node.js 20 LTS
echo "📦 Instalando Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Verificar instalação
echo "✅ Node.js: $(node --version)"
echo "✅ npm: $(npm --version)"

# Criar diretório
echo "📁 Criando diretório..."
mkdir -p /var/www/nfe-proxy
cd /var/www/nfe-proxy

# Copiar arquivos (assumindo que já foram enviados)
if [ ! -f "package.json" ]; then
  echo "❌ Erro: Faça upload dos arquivos do projeto primeiro!"
  echo "   Use: scp -r ./nfe-proxy-server/* usuario@vps:/var/www/nfe-proxy/"
  exit 1
fi

# Instalar dependências
echo "📦 Instalando dependências..."
npm install --production

# Gerar API Key se não existir
if [ ! -f ".env" ]; then
  echo "🔑 Gerando arquivo .env..."
  API_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  
  cat > .env << EOF
PORT=3100
API_KEY=${API_KEY}
NODE_ENV=production
LOG_LEVEL=info
SEFAZ_TIMEOUT=30000
EOF
  
  echo "✅ API Key gerada: ${API_KEY}"
  echo "⚠️  IMPORTANTE: Guarde esta chave para configurar no Supabase!"
fi

# Criar pasta de logs
mkdir -p logs

# Instalar PM2
echo "📦 Instalando PM2..."
npm install -g pm2

# Iniciar servidor
echo "🚀 Iniciando servidor..."
pm2 start src/server.js --name nfe-proxy

# Configurar para iniciar no boot
pm2 startup systemd -u root --hp /root
pm2 save

# Instalar Nginx
echo "📦 Instalando Nginx..."
apt install -y nginx

# Configurar firewall
echo "🔥 Configurando firewall..."
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3100/tcp
ufw --force enable

echo ""
echo "=============================================="
echo "✅ Instalação concluída!"
echo "=============================================="
echo ""
echo "📡 O servidor está rodando em: http://$(curl -s ifconfig.me):3100"
echo ""
echo "Próximos passos:"
echo "1. Configure o DNS apontando para este IP"
echo "2. Execute: sudo certbot --nginx -d nfe.seudominio.com"
echo "3. Configure no Supabase:"
echo "   - NFE_PROXY_URL: https://nfe.seudominio.com"
echo "   - NFE_PROXY_API_KEY: (veja em /var/www/nfe-proxy/.env)"
echo ""
echo "Comandos úteis:"
echo "  pm2 logs nfe-proxy    # Ver logs"
echo "  pm2 restart nfe-proxy # Reiniciar"
echo "  pm2 status            # Status"
echo ""
