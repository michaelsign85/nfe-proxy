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

// Timeout padrão para requisições SEFAZ
const SEFAZ_TIMEOUT = parseInt(process.env.SEFAZ_TIMEOUT) || 30000;

/**
 * POST /api/sefaz/status-servico
 * Consulta status do serviço da SEFAZ
 */
router.post('/status-servico', async (req, res) => {
    const startTime = Date.now();

    try {
        const { uf = 'SP', ambiente = 2 } = req.body;
        const ufUpper = uf.toUpperCase();
        const cUF = UF_CODIGOS[ufUpper] || '35';

        const urls = getSefazUrls(ufUpper, 'NfeStatusServico');
        const sefazUrl = ambiente === 1 ? urls.producao : urls.homologacao;

        logger.info(`Consultando status SEFAZ-${ufUpper}`, { url: sefazUrl, ambiente });

        // Gerar envelope SOAP
        const envelope = gerarEnvelopeStatusServico(ambiente, cUF);

        // Requisição à SEFAZ
        const response = await axios({
            method: 'POST',
            url: sefazUrl,
            data: envelope,
            headers: {
                'Content-Type': 'application/soap+xml; charset=utf-8',
                'SOAPAction': 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4/nfeStatusServicoNF',
            },
            timeout: SEFAZ_TIMEOUT,
            httpsAgent: new https.Agent({
                rejectUnauthorized: false, // Aceitar certificados ICP-Brasil
                minVersion: 'TLSv1.2',
            }),
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
 * Autoriza NF-e na SEFAZ (requer certificado digital)
 */
router.post('/autorizar', async (req, res) => {
    const startTime = Date.now();

    try {
        const {
            uf = 'SP',
            ambiente = 2,
            xmlNfe,
            certificado, // Base64 do certificado .pfx
            senhaCertificado
        } = req.body;

        if (!xmlNfe) {
            return res.status(400).json({ error: 'XML da NF-e não fornecido' });
        }

        if (!certificado || !senhaCertificado) {
            return res.status(400).json({ error: 'Certificado digital não fornecido' });
        }

        const ufUpper = uf.toUpperCase();

        const urls = getSefazUrls(ufUpper, 'NfeAutorizacao');
        const sefazUrl = ambiente === 1 ? urls.producao : urls.homologacao;

        logger.info(`Autorizando NF-e na SEFAZ-${ufUpper}`, { url: sefazUrl, ambiente });

        // Carregar certificado PFX
        const pfxBuffer = Buffer.from(certificado, 'base64');
        const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuffer));
        const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, senhaCertificado);

        // Extrair chave privada e certificado
        const bags = p12.getBags({ bagType: forge.pki.oids.certBag });
        const certBag = bags[forge.pki.oids.certBag][0];
        const cert = certBag.cert;

        const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
        const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag][0];
        const privateKey = keyBag.key;

        // Converter para PEM
        const certPem = forge.pki.certificateToPem(cert);
        const keyPem = forge.pki.privateKeyToPem(privateKey);

        // Gerar envelope SOAP
        const envelope = gerarEnvelopeAutorizacao(ambiente, xmlNfe);

        // Requisição à SEFAZ com certificado mTLS
        const response = await axios({
            method: 'POST',
            url: sefazUrl,
            data: envelope,
            headers: {
                'Content-Type': 'application/soap+xml; charset=utf-8',
                'SOAPAction': 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote',
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
