/**
 * Middleware de autenticação por API Key
 */

const logger = require('../utils/logger');

const authMiddleware = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    const expectedKey = process.env.API_KEY;

    if (!expectedKey) {
        logger.warn('API_KEY não configurada no servidor');
        return res.status(500).json({ error: 'Servidor não configurado corretamente' });
    }

    if (!apiKey) {
        logger.warn('Requisição sem API Key', { ip: req.ip, path: req.path });
        return res.status(401).json({ error: 'API Key não fornecida' });
    }

    if (apiKey !== expectedKey) {
        logger.warn('API Key inválida', { ip: req.ip, path: req.path });
        return res.status(403).json({ error: 'API Key inválida' });
    }

    // Verificar IPs permitidos (opcional)
    const allowedIps = process.env.ALLOWED_IPS?.split(',').map(ip => ip.trim()).filter(Boolean);
    if (allowedIps && allowedIps.length > 0) {
        const clientIp = req.ip || req.connection.remoteAddress;
        if (!allowedIps.includes(clientIp)) {
            logger.warn('IP não autorizado', { ip: clientIp, path: req.path });
            return res.status(403).json({ error: 'IP não autorizado' });
        }
    }

    next();
};

module.exports = authMiddleware;
