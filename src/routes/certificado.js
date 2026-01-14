/**
 * 🔐 Rotas de Certificado Digital
 * 
 * Endpoints para validação de certificados A1 (PFX/P12)
 */

const express = require('express');
const forge = require('node-forge');
const router = express.Router();
const logger = require('../utils/logger');

/**
 * POST /api/certificado/validar
 * Valida um certificado digital A1 e retorna informações
 */
router.post('/validar', async (req, res) => {
    try {
        const { certificado_base64, senha } = req.body;

        if (!certificado_base64 || !senha) {
            return res.status(400).json({
                valido: false,
                error: 'Certificado e senha são obrigatórios'
            });
        }

        logger.info('📄 Validando certificado digital...');

        // Decodificar base64
        const pfxDer = forge.util.decode64(certificado_base64);

        // Parse do P12
        const p12Asn1 = forge.asn1.fromDer(pfxDer);
        const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, senha);

        // Extrair certificado
        const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
        const certBag = certBags[forge.pki.oids.certBag];

        if (!certBag || certBag.length === 0) {
            return res.status(400).json({
                valido: false,
                error: 'Certificado não encontrado no arquivo PFX'
            });
        }

        const cert = certBag[0].cert;
        if (!cert) {
            return res.status(400).json({
                valido: false,
                error: 'Certificado inválido'
            });
        }

        // Extrair informações do subject
        const subject = cert.subject;
        let titular = '';
        let cnpj = '';

        for (const attr of subject.attributes) {
            if (attr.shortName === 'CN') {
                titular = attr.value;
            }
            // CNPJ pode estar no CN
            const cnpjMatch = attr.value?.match(/\d{14}/);
            if (cnpjMatch) {
                cnpj = cnpjMatch[0];
            }
        }

        // Extrair CNPJ do campo OID específico se não encontrado
        if (!cnpj) {
            for (const ext of cert.extensions || []) {
                if (ext.id === '2.16.76.1.3.3' || ext.name === 'subjectAltName') {
                    const cnpjMatch = ext.value?.toString().match(/\d{14}/);
                    if (cnpjMatch) {
                        cnpj = cnpjMatch[0];
                        break;
                    }
                }
            }
        }

        // Tentar extrair do CN se ainda não encontrado
        if (!cnpj && titular) {
            const cnpjMatch = titular.match(/\d{14}/);
            if (cnpjMatch) {
                cnpj = cnpjMatch[0];
            }
        }

        // Verificar validade
        const validade = cert.validity.notAfter;
        const agora = new Date();
        const diasRestantes = Math.ceil((validade.getTime() - agora.getTime()) / (1000 * 60 * 60 * 24));

        if (diasRestantes < 0) {
            return res.status(400).json({
                valido: false,
                error: `Certificado expirado há ${Math.abs(diasRestantes)} dias`,
                titular,
                cnpj,
                validade: validade.toISOString(),
                dias_restantes: diasRestantes
            });
        }

        logger.info(`✅ Certificado válido: ${titular} (CNPJ: ${cnpj || 'não encontrado'})`);
        logger.info(`   Validade: ${validade.toISOString()} (${diasRestantes} dias restantes)`);

        return res.json({
            valido: true,
            titular,
            cnpj,
            validade: validade.toISOString(),
            dias_restantes: diasRestantes
        });

    } catch (error) {
        logger.error('❌ Erro ao validar certificado:', error.message);
        
        // Tratar erros específicos do forge
        if (error.message.includes('PKCS#12 MAC could not be verified')) {
            return res.status(400).json({
                valido: false,
                error: 'Senha do certificado incorreta'
            });
        }

        if (error.message.includes('Invalid PEM formatted message') || 
            error.message.includes('ASN.1 object')) {
            return res.status(400).json({
                valido: false,
                error: 'Arquivo de certificado inválido. Certifique-se de enviar um arquivo .pfx ou .p12 válido'
            });
        }

        return res.status(500).json({
            valido: false,
            error: error.message || 'Erro interno ao validar certificado'
        });
    }
});

/**
 * GET /api/certificado/info
 * Retorna informações de um certificado já armazenado
 */
router.get('/info', async (req, res) => {
    // TODO: Implementar busca de certificado do banco
    res.json({
        message: 'Endpoint não implementado. Use POST /api/certificado/validar para validar certificados.'
    });
});

module.exports = router;
