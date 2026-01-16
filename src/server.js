/**
 * 🚀 NFe Proxy Server
 * 
 * Servidor proxy para comunicação com SEFAZs brasileiras
 * Instalado em VPS para contornar limitações de SSL do Supabase Edge Functions
 * 
 * @author ConfirmaPay
 * @version 1.0.0
 */

// Tentar carregar .env (opcional - variáveis do Docker têm prioridade)
try { require('dotenv').config(); } catch (e) { /* ignore */ }

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const logger = require('./utils/logger');
const sefazRoutes = require('./routes/sefaz');
const healthRoutes = require('./routes/health');
const certificadoRoutes = require('./routes/certificado');
const nfeRoutes = require('./routes/nfe');
const nfceV2Routes = require('./routes/nfce-v2'); // NFC-e v2 - Implementação ISOLADA
const authMiddleware = require('./middleware/auth');

// DEBUG: Mostrar variáveis de ambiente no início
console.log('🔧 Variáveis de ambiente:');
console.log('  - API_KEY:', process.env.API_KEY ? '✓ Configurada' : '✗ NÃO configurada');
console.log('  - NODE_ENV:', process.env.NODE_ENV || 'não definido');
console.log('  - PORT:', process.env.PORT || '3100 (default)');

const app = express();
const PORT = process.env.PORT || 3100;

// Confiar no proxy reverso (EasyPanel/Traefik)
app.set('trust proxy', 1);

// Segurança
app.use(helmet());

// CORS - permitir chamadas do Supabase
app.use(cors({
    origin: '*', // Em produção, restrinja para seus domínios
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));

// Rate limiting - proteção contra abuso
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minuto
    max: 100, // 100 requisições por minuto
    message: { error: 'Muitas requisições. Tente novamente em 1 minuto.' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false }, // Desabilitar validação do X-Forwarded-For
});
app.use(limiter);

// Parse JSON
app.use(express.json({ limit: '10mb' }));

// Log de requisições
app.use((req, res, next) => {
    logger.info(`${req.method} ${req.path}`, {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
    });
    next();
});

// Rotas públicas
app.use('/health', healthRoutes);

// Rotas protegidas por API Key
app.use('/api/sefaz', authMiddleware, sefazRoutes);
app.use('/api/certificado', authMiddleware, certificadoRoutes);
app.use('/api/nfe', authMiddleware, nfeRoutes);
app.use('/api/nfce/v2', authMiddleware, nfceV2Routes); // NFC-e v2 - Isolado da NF-e

// Rota raiz
app.get('/', (req, res) => {
    res.json({
        name: 'NFe Proxy Server',
        version: '1.1.0',
        status: 'running',
        endpoints: {
            health: '/health',
            // NF-e (modelo 55)
            statusServico: '/api/sefaz/status-servico',
            autorizarNfe: '/api/sefaz/autorizar',
            consultarNfe: '/api/sefaz/consultar',
            emitirNfe: '/api/nfe/emitir',
            // NFC-e (modelo 65) - v2 ISOLADO
            nfceInfo: '/api/nfce/v2/info',
            nfceStatus: '/api/nfce/v2/status',
            nfceEmitir: '/api/nfce/v2/emitir',
            // Certificado
            validarCertificado: '/api/certificado/validar',
        },
    });
});

// Handler de erros
app.use((err, req, res, next) => {
    logger.error('Erro não tratado:', err);
    res.status(500).json({
        error: 'Erro interno do servidor',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
});

// 404
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint não encontrado' });
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
    logger.info(`🚀 NFe Proxy Server rodando na porta ${PORT}`);
    logger.info(`📡 Ambiente: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM recebido. Encerrando servidor...');
    process.exit(0);
});

process.on('SIGINT', () => {
    logger.info('SIGINT recebido. Encerrando servidor...');
    process.exit(0);
});
