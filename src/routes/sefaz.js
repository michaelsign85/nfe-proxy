/**
 * Rotas para comunicação com SEFAZs
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const https = require('https');
const forge = require('node-forge');
const logger = require('../utils/logger');
const { getSefazUrls, UF_CODIGOS } = require('../utils/sefaz-config');
const { signNFeXml } = require('../utils/nfe-signer');

// Timeout padrão para requisições SEFAZ
const SEFAZ_TIMEOUT = parseInt(process.env.SEFAZ_TIMEOUT) || 30000;

// Cache do httpsAgent com certificado
let cachedHttpsAgent = null;

/**
 * Cria um httpsAgent com o certificado digital configurado
 */
function getHttpsAgent() {
    if (cachedHttpsAgent) {
        return cachedHttpsAgent;
    }

    const certBase64 = process.env.CERT_PFX_BASE64;
    const certPassword = process.env.CERT_PASSWORD;

    if (!certBase64 || !certPassword) {
        logger.warn('Certificado não configurado - usando conexão sem certificado');
        return new https.Agent({
            rejectUnauthorized: false,
            minVersion: 'TLSv1.2',
        });
    }

    try {
        // Decodificar o PFX de Base64
        const pfxBuffer = Buffer.from(certBase64, 'base64');
        const pfxAsn1 = forge.asn1.fromDer(pfxBuffer.toString('binary'));
        const pfx = forge.pkcs12.pkcs12FromAsn1(pfxAsn1, certPassword);

        // Extrair certificado e chave privada
        const certBags = pfx.getBags({ bagType: forge.pki.oids.certBag });
        const keyBags = pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });

        const certBag = certBags[forge.pki.oids.certBag][0];
        const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag][0];

        const certificate = forge.pki.certificateToPem(certBag.cert);
        const privateKey = forge.pki.privateKeyToPem(keyBag.key);

        logger.info('✅ Certificado digital carregado com sucesso');
        logger.info(`   Titular: ${certBag.cert.subject.getField('CN')?.value || 'N/A'}`);
        logger.info(`   Válido até: ${certBag.cert.validity.notAfter}`);

        cachedHttpsAgent = new https.Agent({
            cert: certificate,
            key: privateKey,
            rejectUnauthorized: false,
            minVersion: 'TLSv1.2',
            maxVersion: 'TLSv1.3',
        });

        return cachedHttpsAgent;
    } catch (error) {
        logger.error('Erro ao carregar certificado:', error.message);
        return new https.Agent({
            rejectUnauthorized: false,
            minVersion: 'TLSv1.2',
        });
    }
}

/**
 * POST /api/sefaz/status-servico
 * Consulta status do serviço da SEFAZ
 */
router.post('/status-servico', async (req, res) => {
    const startTime = Date.now();

    try {
        const { uf = 'SP', ambiente: ambienteParam = 2 } = req.body;
        const ufUpper = uf.toUpperCase();
        const cUF = UF_CODIGOS[ufUpper] || '35';

        // Converter ambiente para número (aceita "producao", "homologacao", 1, 2)
        let ambiente;
        if (ambienteParam === 'producao' || ambienteParam === 1 || ambienteParam === '1') {
            ambiente = 1;
        } else {
            ambiente = 2;
        }

        const urls = getSefazUrls(ufUpper, 'NfeStatusServico');
        const sefazUrl = ambiente === 1 ? urls.producao : urls.homologacao;

        logger.info(`Consultando status SEFAZ-${ufUpper}`, { url: sefazUrl, ambiente });

        // Gerar envelope SOAP
        const envelope = gerarEnvelopeStatusServico(ambiente, cUF);

        // Requisição à SEFAZ com certificado
        const response = await axios({
            method: 'POST',
            url: sefazUrl,
            data: envelope,
            headers: {
                'Content-Type': 'application/soap+xml; charset=utf-8',
                'SOAPAction': 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4/nfeStatusServicoNF',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NFe/4.0',
            },
            timeout: SEFAZ_TIMEOUT,
            httpsAgent: getHttpsAgent(),
        });

        const tempoResposta = Date.now() - startTime;
        const xmlResponse = response.data;

        // Parse da resposta
        const statusData = parseStatusResponse(xmlResponse);
        const online = statusData.cStat === 107;

        logger.info(`Status SEFAZ-${ufUpper}: ${statusData.cStat} - ${statusData.xMotivo}`, {
            tempo: tempoResposta,
        });

        res.json({
            online,
            cStat: statusData.cStat,
            xMotivo: statusData.xMotivo,
            cUF: statusData.cUF,
            uf: ufUpper,
            dhRecbto: statusData.dhRecbto,
            tMed: statusData.tMed || tempoResposta,
            ambiente: ambiente === 1 ? 'Produção' : 'Homologação',
            tempoResposta,
        });

    } catch (error) {
        const tempoResposta = Date.now() - startTime;
        logger.error('Erro ao consultar status SEFAZ:', error.message);

        res.json({
            online: false,
            cStat: 0,
            xMotivo: `Erro: ${error.message}`,
            erro: true,
            tempoResposta,
        });
    }
});

/**
 * POST /api/sefaz/autorizar
 * Autoriza NF-e na SEFAZ (usa certificado configurado no servidor)
 */
router.post('/autorizar', async (req, res) => {
    const startTime = Date.now();

    try {
        const {
            uf = 'SP',
            ambiente = 2,
            xmlNfe,
        } = req.body;

        if (!xmlNfe) {
            return res.status(400).json({ error: 'XML da NF-e não fornecido' });
        }

        const ufUpper = uf.toUpperCase();
        const cUF = UF_CODIGOS[ufUpper] || '35';
        const tpAmb = ambiente === 1 ? '1' : '2';

        const urls = getSefazUrls(ufUpper, 'NfeAutorizacao');
        const sefazUrl = ambiente === 1 ? urls.producao : urls.homologacao;

        logger.info(`Autorizando NF-e na SEFAZ-${ufUpper}`, { url: sefazUrl, ambiente });

        // === ASSINATURA DIGITAL DO XML ===
        let xmlNfeAssinado;
        try {
            // Verificar se o XML já está assinado
            if (xmlNfe.includes('<Signature')) {
                logger.info('XML já está assinado, usando como está');
                xmlNfeAssinado = xmlNfe;
            } else {
                logger.info('Assinando XML da NF-e...');
                xmlNfeAssinado = signNFeXml(xmlNfe);
                logger.info('XML assinado com sucesso!');
            }
        } catch (signError) {
            logger.error('Erro ao assinar XML:', signError.message);
            return res.status(400).json({ 
                error: 'Erro ao assinar XML da NF-e',
                detalhe: signError.message 
            });
        }

        // Gerar envelope SOAP com XML assinado (sem espaços/quebras entre tags)
        const envelope = `<?xml version="1.0" encoding="UTF-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope" xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4"><soap12:Header/><soap12:Body><nfe:nfeDadosMsg><enviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><idLote>1</idLote><indSinc>1</indSinc>${xmlNfeAssinado}</enviNFe></nfe:nfeDadosMsg></soap12:Body></soap12:Envelope>`;

        // Requisição à SEFAZ com certificado configurado no servidor
        const response = await axios({
            method: 'POST',
            url: sefazUrl,
            data: envelope,
            headers: {
                'Content-Type': 'application/soap+xml; charset=utf-8',
                'SOAPAction': 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NFe/4.0',
            },
            timeout: SEFAZ_TIMEOUT,
            httpsAgent: getHttpsAgent(),
        });

        const tempoResposta = Date.now() - startTime;
        const xmlResponse = response.data;

        // Parse da resposta
        const autorizacaoData = parseAutorizacaoResponse(xmlResponse);

        logger.info(`Autorização NF-e: ${autorizacaoData.cStat} - ${autorizacaoData.xMotivo}`, {
            tempo: tempoResposta,
        });

        res.json({
            ...autorizacaoData,
            tempoResposta,
        });

    } catch (error) {
        const tempoResposta = Date.now() - startTime;
        logger.error('Erro ao autorizar NF-e:', error.message);

        res.status(500).json({
            cStat: 0,
            xMotivo: `Erro: ${error.message}`,
            erro: true,
            tempoResposta,
        });
    }
});

/**
 * POST /api/sefaz/consultar
 * Consulta NF-e na SEFAZ
 */
router.post('/consultar', async (req, res) => {
    const startTime = Date.now();

    try {
        const {
            uf = 'SP',
            ambiente = 2,
            chNFe,
            certificado,
            senhaCertificado
        } = req.body;

        if (!chNFe) {
            return res.status(400).json({ error: 'Chave da NF-e não fornecida' });
        }

        if (!certificado || !senhaCertificado) {
            return res.status(400).json({ error: 'Certificado digital não fornecido' });
        }

        const ufUpper = uf.toUpperCase();

        const urls = getSefazUrls(ufUpper, 'NfeConsultaProtocolo');
        const sefazUrl = ambiente === 1 ? urls.producao : urls.homologacao;

        logger.info(`Consultando NF-e ${chNFe} na SEFAZ-${ufUpper}`);

        // Carregar certificado
        const pfxBuffer = Buffer.from(certificado, 'base64');
        const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuffer));
        const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, senhaCertificado);

        const bags = p12.getBags({ bagType: forge.pki.oids.certBag });
        const cert = bags[forge.pki.oids.certBag][0].cert;

        const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
        const privateKey = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag][0].key;

        const certPem = forge.pki.certificateToPem(cert);
        const keyPem = forge.pki.privateKeyToPem(privateKey);

        // Gerar envelope SOAP
        const envelope = gerarEnvelopeConsulta(ambiente, chNFe);

        const response = await axios({
            method: 'POST',
            url: sefazUrl,
            data: envelope,
            headers: {
                'Content-Type': 'application/soap+xml; charset=utf-8',
                'SOAPAction': 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4/nfeConsultaNF',
            },
            timeout: SEFAZ_TIMEOUT,
            httpsAgent: new https.Agent({
                cert: certPem,
                key: keyPem,
                rejectUnauthorized: false,
                minVersion: 'TLSv1.2',
            }),
        });

        const tempoResposta = Date.now() - startTime;

        res.json({
            xmlResponse: response.data,
            tempoResposta,
        });

    } catch (error) {
        const tempoResposta = Date.now() - startTime;
        logger.error('Erro ao consultar NF-e:', error.message);

        res.status(500).json({
            erro: true,
            mensagem: error.message,
            tempoResposta,
        });
    }
});

// ============== Funções Auxiliares ==============

function gerarEnvelopeStatusServico(ambiente, cUF) {
    const tpAmb = ambiente === 1 ? '1' : '2';

    return `<?xml version="1.0" encoding="UTF-8"?>
<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope" xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4">
  <soap12:Header/>
  <soap12:Body>
    <nfe:nfeDadosMsg>
      <consStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        <tpAmb>${tpAmb}</tpAmb>
        <cUF>${cUF}</cUF>
        <xServ>STATUS</xServ>
      </consStatServ>
    </nfe:nfeDadosMsg>
  </soap12:Body>
</soap12:Envelope>`;
}

function gerarEnvelopeAutorizacao(ambiente, xmlNfe) {
    const tpAmb = ambiente === 1 ? '1' : '2';

    return `<?xml version="1.0" encoding="UTF-8"?>
<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope" xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">
  <soap12:Header/>
  <soap12:Body>
    <nfe:nfeDadosMsg>
      <enviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        <idLote>1</idLote>
        <indSinc>1</indSinc>
        ${xmlNfe}
      </enviNFe>
    </nfe:nfeDadosMsg>
  </soap12:Body>
</soap12:Envelope>`;
}

function gerarEnvelopeConsulta(ambiente, chNFe) {
    const tpAmb = ambiente === 1 ? '1' : '2';

    return `<?xml version="1.0" encoding="UTF-8"?>
<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope" xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4">
  <soap12:Header/>
  <soap12:Body>
    <nfe:nfeDadosMsg>
      <consSitNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        <tpAmb>${tpAmb}</tpAmb>
        <xServ>CONSULTAR</xServ>
        <chNFe>${chNFe}</chNFe>
      </consSitNFe>
    </nfe:nfeDadosMsg>
  </soap12:Body>
</soap12:Envelope>`;
}

function parseStatusResponse(xmlResponse) {
    const cStatMatch = xmlResponse.match(/<cStat>(\d+)<\/cStat>/);
    const xMotivoMatch = xmlResponse.match(/<xMotivo>([^<]+)<\/xMotivo>/);
    const cUFMatch = xmlResponse.match(/<cUF>(\d+)<\/cUF>/);
    const dhRecbtoMatch = xmlResponse.match(/<dhRecbto>([^<]+)<\/dhRecbto>/);
    const tMedMatch = xmlResponse.match(/<tMed>(\d+)<\/tMed>/);

    return {
        cStat: cStatMatch ? parseInt(cStatMatch[1]) : 0,
        xMotivo: xMotivoMatch ? xMotivoMatch[1] : 'Resposta inválida',
        cUF: cUFMatch ? cUFMatch[1] : '35',
        dhRecbto: dhRecbtoMatch ? dhRecbtoMatch[1] : new Date().toISOString(),
        tMed: tMedMatch ? parseInt(tMedMatch[1]) : undefined,
    };
}

function parseAutorizacaoResponse(xmlResponse) {
    const cStatMatch = xmlResponse.match(/<cStat>(\d+)<\/cStat>/);
    const xMotivoMatch = xmlResponse.match(/<xMotivo>([^<]+)<\/xMotivo>/);
    const nRecMatch = xmlResponse.match(/<nRec>(\d+)<\/nRec>/);
    const protNFeMatch = xmlResponse.match(/<protNFe[^>]*>([\s\S]*?)<\/protNFe>/);
    const chNFeMatch = xmlResponse.match(/<chNFe>(\d+)<\/chNFe>/);
    const nProtMatch = xmlResponse.match(/<nProt>(\d+)<\/nProt>/);

    return {
        cStat: cStatMatch ? parseInt(cStatMatch[1]) : 0,
        xMotivo: xMotivoMatch ? xMotivoMatch[1] : 'Resposta inválida',
        nRec: nRecMatch ? nRecMatch[1] : null,
        chNFe: chNFeMatch ? chNFeMatch[1] : null,
        nProt: nProtMatch ? nProtMatch[1] : null,
        protNFe: protNFeMatch ? protNFeMatch[1] : null,
        xmlResponse,
    };
}

module.exports = router;
