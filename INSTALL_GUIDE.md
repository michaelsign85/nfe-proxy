# =====================================================
# GUIA DE INSTALAÇÃO - NFe Proxy no VPS Hostinger
# =====================================================

## Passo 1: Acessar o VPS

Conecte via SSH:
```powershell
ssh root@SEU_IP_DO_VPS
```

## Passo 2: Upload dos arquivos

Execute no seu PC (PowerShell):
```powershell
# Primeiro, comprima a pasta
Compress-Archive -Path "d:\confirmapay\nfe-proxy-server\*" -DestinationPath "d:\confirmapay\nfe-proxy.zip" -Force

# Use WinSCP, FileZilla ou scp para enviar
# Ou use o painel Hostinger para fazer upload
```

## Passo 3: No VPS - Extrair e instalar

```bash
# Criar pasta
mkdir -p /var/www/nfe-proxy
cd /var/www/nfe-proxy

# Se enviou via painel Hostinger, mova para /var/www/nfe-proxy

# Instalar Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Instalar PM2
sudo npm install -g pm2

# Instalar dependências
npm install --production

# Criar .env
cp .env.example .env

# Gerar API Key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Copie a chave gerada

# Editar .env
nano .env
# Cole a API Key no campo API_KEY

# Criar pasta de logs
mkdir -p logs

# Iniciar servidor
pm2 start src/server.js --name nfe-proxy
pm2 save
pm2 startup
```

## Passo 4: Configurar HTTPS (Recomendado)

```bash
# Instalar Nginx
sudo apt install nginx

# Criar config
sudo nano /etc/nginx/sites-available/nfe-proxy
```

Cole:
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
        proxy_cache_bypass $http_upgrade;
    }
}
```

Continue:
```bash
# Habilitar site
sudo ln -s /etc/nginx/sites-available/nfe-proxy /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx

# Certificado SSL
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d nfe.seudominio.com
```

## Passo 5: Configurar no Supabase

No terminal local, configure os secrets:

```powershell
cd d:\confirmapay

# URL do proxy (com HTTPS se configurou)
npx supabase secrets set NFE_PROXY_URL="https://nfe.seudominio.com"

# API Key (a que você gerou no .env do VPS)
npx supabase secrets set NFE_PROXY_API_KEY="sua_api_key_aqui"
```

Ou via dashboard Supabase:
1. Acesse https://supabase.com/dashboard
2. Selecione o projeto confirmapay-br
3. Settings > Edge Functions > Secrets
4. Adicione:
   - NFE_PROXY_URL: https://nfe.seudominio.com (ou http://IP:3100)
   - NFE_PROXY_API_KEY: (a chave do .env do VPS)

## Passo 6: Fazer redeploy da Edge Function

```powershell
cd d:\confirmapay
npx supabase functions deploy nfe-status-servico --project-ref zsvpjbcqsvqzmxzqrxxo
```

## Passo 7: Testar!

```powershell
$headers = @{
  "apikey" = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpzdnBqYmNxc3Zxem14enFyeHhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Mjg1OTk5NjEsImV4cCI6MjA0NDE3NTk2MX0.LAgsNqIOSTkMPNcE4x7P2_fKrLQvPY3kxo_1qHJYsEk"
  "Content-Type" = "application/json"
}

$body = '{"uf": "MS", "ambiente": 2}'

Invoke-RestMethod -Uri "https://zsvpjbcqsvqzmxzqrxxo.supabase.co/functions/v1/nfe-status-servico" -Method POST -Headers $headers -Body $body | ConvertTo-Json
```

Resposta esperada:
```json
{
  "online": true,
  "cStat": 107,
  "xMotivo": "Serviço em Operação",
  "uf": "MS",
  "via_proxy": true
}
```

## Troubleshooting

### Ver logs do proxy no VPS:
```bash
pm2 logs nfe-proxy
```

### Verificar se está rodando:
```bash
pm2 status
curl http://localhost:3100/health
```

### Firewall Hostinger:
No painel Hostinger, certifique-se de que as portas 80, 443 e 3100 estão abertas.
