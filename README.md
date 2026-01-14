# 🚀 NFe Proxy Server

Servidor proxy para comunicação com SEFAZs brasileiras, desenvolvido para o ConfirmaPay.

Este servidor resolve as limitações de SSL do Supabase Edge Functions com certificados ICP-Brasil.

## 📋 Requisitos

- Node.js 18+
- npm ou yarn
- VPS com Ubuntu/Debian (recomendado)

## 🛠️ Instalação no VPS

### 1. Conectar ao VPS via SSH

```bash
ssh usuario@seu-vps-ip
```

### 2. Instalar Node.js (se não tiver)

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verificar instalação
node --version
npm --version
```

### 3. Clonar/Upload do projeto

```bash
# Criar diretório
mkdir -p /var/www/nfe-proxy
cd /var/www/nfe-proxy

# Upload dos arquivos (via SCP, SFTP ou git)
# Exemplo com scp (execute no seu PC local):
# scp -r ./nfe-proxy-server/* usuario@seu-vps-ip:/var/www/nfe-proxy/
```

### 4. Instalar dependências

```bash
cd /var/www/nfe-proxy
npm install
```

### 5. Configurar variáveis de ambiente

```bash
# Copiar arquivo de exemplo
cp .env.example .env

# Editar configurações
nano .env
```

Conteúdo do `.env`:
```
PORT=3100
API_KEY=gere_uma_chave_segura_aqui
NODE_ENV=production
LOG_LEVEL=info
SEFAZ_TIMEOUT=30000
```

Para gerar uma chave API segura:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 6. Criar pasta de logs

```bash
mkdir -p logs
```

### 7. Iniciar com PM2 (recomendado para produção)

```bash
# Instalar PM2 globalmente
sudo npm install -g pm2

# Iniciar o servidor
pm2 start src/server.js --name nfe-proxy

# Configurar para iniciar automaticamente após reboot
pm2 startup
pm2 save

# Ver logs
pm2 logs nfe-proxy
```

### 8. Configurar Nginx como proxy reverso (opcional, mas recomendado)

```bash
sudo apt install nginx

# Criar configuração
sudo nano /etc/nginx/sites-available/nfe-proxy
```

Conteúdo:
```nginx
server {
    listen 80;
    server_name nfe.seudominio.com;

    location / {
        proxy_pass http://localhost:3100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Habilitar e reiniciar:
```bash
sudo ln -s /etc/nginx/sites-available/nfe-proxy /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### 9. Configurar SSL com Let's Encrypt (recomendado)

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d nfe.seudominio.com
```

## 🔧 Uso

### Health Check

```bash
curl http://seu-vps-ip:3100/health
```

### Consultar Status SEFAZ

```bash
curl -X POST http://seu-vps-ip:3100/api/sefaz/status-servico \
  -H "Content-Type: application/json" \
  -H "X-API-Key: sua_chave_api" \
  -d '{"uf": "MS", "ambiente": 2}'
```

## 📡 Endpoints

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/health` | Health check |
| POST | `/api/sefaz/status-servico` | Consulta status do serviço SEFAZ |
| POST | `/api/sefaz/autorizar` | Autoriza NF-e |
| POST | `/api/sefaz/consultar` | Consulta NF-e |

## 🔐 Segurança

- Todas as rotas `/api/*` requerem `X-API-Key` no header
- Rate limiting: 100 requisições por minuto
- Helmet para headers de segurança
- Logs de todas as requisições

## 📝 Comandos PM2

```bash
pm2 start nfe-proxy      # Iniciar
pm2 stop nfe-proxy       # Parar
pm2 restart nfe-proxy    # Reiniciar
pm2 logs nfe-proxy       # Ver logs
pm2 monit               # Monitor em tempo real
pm2 status              # Ver status
```

## 🐛 Troubleshooting

### Erro de certificado SSL

O servidor está configurado para aceitar certificados ICP-Brasil. Se houver problemas:

```bash
# Verificar logs
pm2 logs nfe-proxy --lines 100
```

### Servidor não inicia

```bash
# Verificar se a porta está em uso
sudo lsof -i :3100

# Verificar erros
node src/server.js
```

### Firewall

```bash
# Ubuntu com UFW
sudo ufw allow 3100/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

## 📄 Licença

Proprietário - ConfirmaPay
