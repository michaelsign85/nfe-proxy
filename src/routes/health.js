/**
 * Rotas de health check
 */

const express = require('express');
const router = express.Router();

// Health check simples
router.get('/', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
    });
});

// Health check detalhado
router.get('/detailed', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        node: process.version,
        platform: process.platform,
        env: process.env.NODE_ENV || 'development',
    });
});

module.exports = router;
