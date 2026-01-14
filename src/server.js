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

// Rota raiz
app.get('/', (req, res) => {
    res.json({
        name: 'NFe Proxy Server',
        version: '1.0.0',
        status: 'running',
        endpoints: {
            health: '/health',
            statusServico: '/api/sefaz/status-servico',
            autorizarNfe: '/api/sefaz/autorizar',
            consultarNfe: '/api/sefaz/consultar',
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
