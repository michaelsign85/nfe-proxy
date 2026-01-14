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
const { signNFeXml, signEventoXml, signInutXml } = require('../utils/nfe-signer');

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
 * Autoriza NF-e na SEFAZ (usa certificado da requisição ou configurado no servidor)
 */
router.post('/autorizar', async (req, res) => {
    const startTime = Date.now();

    try {
        const {
            uf = 'SP',
            ambiente = 2,
            xmlNfe,
            certificado,
            senhaCertificado,
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

        // Preparar opções de certificado (se fornecido na requisição)
        const certificadoOpts = (certificado && senhaCertificado) 
            ? { certBase64: certificado, certPassword: senhaCertificado }
            : null;

        // === ASSINATURA DIGITAL DO XML ===
        let xmlNfeAssinado;
        try {
            // Verificar se o XML já está assinado
            if (xmlNfe.includes('<Signature')) {
                logger.info('XML já está assinado, usando como está');
                xmlNfeAssinado = xmlNfe;
            } else {
                logger.info('Assinando XML da NF-e...');
                xmlNfeAssinado = signNFeXml(xmlNfe, certificadoOpts);
                logger.info('XML assinado com sucesso!');
            }
        } catch (signError) {
            logger.error('Erro ao assinar XML:', signError.message);
            return res.status(400).json({
                error: 'Erro ao assinar XML da NF-e',
                detalhe: signError.message
            });
        }

        // Preparar httpsAgent - usa certificado da requisição ou do servidor
        let httpsAgent;
        if (certificado && senhaCertificado) {
            logger.info('Usando certificado fornecido na requisição para conexão HTTPS');
            const pfxBuffer = Buffer.from(certificado, 'base64');
            const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuffer));
            const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, senhaCertificado);

            const bags = p12.getBags({ bagType: forge.pki.oids.certBag });
            const cert = bags[forge.pki.oids.certBag][0].cert;

            const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
            const privateKey = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag][0].key;

            const certPem = forge.pki.certificateToPem(cert);
            const keyPem = forge.pki.privateKeyToPem(privateKey);

            httpsAgent = new https.Agent({
                cert: certPem,
                key: keyPem,
                rejectUnauthorized: false,
                minVersion: 'TLSv1.2',
            });
        } else {
            httpsAgent = getHttpsAgent();
        }

        // Gerar envelope SOAP com XML assinado (sem espaços/quebras entre tags)
        const envelope = `<?xml version="1.0" encoding="UTF-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope" xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4"><soap12:Header/><soap12:Body><nfe:nfeDadosMsg><enviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><idLote>1</idLote><indSinc>1</indSinc>${xmlNfeAssinado}</enviNFe></nfe:nfeDadosMsg></soap12:Body></soap12:Envelope>`;

        // Requisição à SEFAZ com certificado
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
            httpsAgent: httpsAgent,
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

/**
 * POST /api/sefaz/debug-cancelar
 * Retorna o XML de cancelamento sem enviar para SEFAZ (debug)
 */
router.post('/debug-cancelar', async (req, res) => {
    try {
        const {
            uf = 'MS',
            ambiente = 2,
            chNFe,
            nProt,
            xJust
        } = req.body;

        if (!chNFe || !nProt || !xJust) {
            return res.status(400).json({
                error: 'Parâmetros obrigatórios: chNFe, nProt, xJust'
            });
        }

        const ufUpper = uf.toUpperCase();
        const cUF = UF_CODIGOS[ufUpper] || '50';
        const tpAmb = ambiente === 1 ? '1' : '2';
        const CNPJ = chNFe.substring(6, 20);
        // Formato dhEvento: AAAA-MM-DDThh:mm:ssTZD (timezone -04:00 para MS)
        // Subtrair 4 horas do UTC para obter hora local de MS
        const now = new Date();
        now.setHours(now.getHours() - 4);
        const dhEvento = now.toISOString().slice(0, 19) + '-04:00';
        const nSeqEvento = '1';
        const idEvento = `ID110111${chNFe}${nSeqEvento.padStart(2, '0')}`;
        const idLote = Date.now().toString().padStart(15, '0');

        // XML do Evento de Cancelamento
        const xmlEvento = `<evento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><infEvento Id="${idEvento}"><cOrgao>${cUF}</cOrgao><tpAmb>${tpAmb}</tpAmb><CNPJ>${CNPJ}</CNPJ><chNFe>${chNFe}</chNFe><dhEvento>${dhEvento}</dhEvento><tpEvento>110111</tpEvento><nSeqEvento>${nSeqEvento}</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>Cancelamento</descEvento><nProt>${nProt}</nProt><xJust>${xJust}</xJust></detEvento></infEvento></evento>`;

        // Assinar o evento
        let xmlEventoAssinado = signEventoXml(xmlEvento);

        // Envelope SOAP
        const envelope = `<?xml version="1.0" encoding="UTF-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4"><envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><idLote>${idLote}</idLote>${xmlEventoAssinado}</envEvento></nfeDadosMsg></soap12:Body></soap12:Envelope>`;

        res.json({
            xmlEvento,
            xmlEventoAssinado,
            envelope,
            idEvento,
            idLote
        });

    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * POST /api/sefaz/cancelar
 * Cancela NF-e na SEFAZ (Evento 110111)
 */
router.post('/cancelar', async (req, res) => {
    const startTime = Date.now();

    try {
        const {
            uf = 'MS',
            ambiente = 2,
            chNFe,
            nProt,
            xJust
        } = req.body;

        if (!chNFe || !nProt || !xJust) {
            return res.status(400).json({
                error: 'Parâmetros obrigatórios: chNFe, nProt, xJust'
            });
        }

        if (xJust.length < 15) {
            return res.status(400).json({
                error: 'Justificativa deve ter no mínimo 15 caracteres'
            });
        }

        const ufUpper = uf.toUpperCase();
        const cUF = UF_CODIGOS[ufUpper] || '50';
        const tpAmb = ambiente === 1 ? '1' : '2';
        const CNPJ = chNFe.substring(6, 20);
        // Formato dhEvento: AAAA-MM-DDThh:mm:ssTZD (timezone -04:00 para MS)
        // Subtrair 4 horas do UTC para obter hora local de MS
        const now = new Date();
        now.setHours(now.getHours() - 4);
        const dhEvento = now.toISOString().slice(0, 19) + '-04:00';
        const nSeqEvento = '1';
        const idEvento = `ID110111${chNFe}${nSeqEvento.padStart(2, '0')}`;
        // idLote deve ser numérico com até 15 dígitos
        const idLote = Date.now().toString().padStart(15, '0');

        const urls = getSefazUrls(ufUpper, 'RecepcaoEvento');
        const sefazUrl = ambiente === 1 ? urls.producao : urls.homologacao;

        logger.info(`Cancelando NF-e ${chNFe} na SEFAZ-${ufUpper}`);

        // XML do Evento de Cancelamento - layout correto conforme NT 2020.006
        const xmlEvento = `<evento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><infEvento Id="${idEvento}"><cOrgao>${cUF}</cOrgao><tpAmb>${tpAmb}</tpAmb><CNPJ>${CNPJ}</CNPJ><chNFe>${chNFe}</chNFe><dhEvento>${dhEvento}</dhEvento><tpEvento>110111</tpEvento><nSeqEvento>${nSeqEvento}</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>Cancelamento</descEvento><nProt>${nProt}</nProt><xJust>${xJust}</xJust></detEvento></infEvento></evento>`;

        // Assinar o evento
        let xmlEventoAssinado;
        try {
            xmlEventoAssinado = signEventoXml(xmlEvento);
            logger.info('Evento de cancelamento assinado com sucesso');
        } catch (signError) {
            logger.error('Erro ao assinar evento:', signError.message);
            return res.status(400).json({
                error: 'Erro ao assinar evento de cancelamento',
                detalhe: signError.message
            });
        }

        // Envelope SOAP - envEvento contém o evento assinado
        const envelope = `<?xml version="1.0" encoding="UTF-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4"><envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><idLote>${idLote}</idLote>${xmlEventoAssinado}</envEvento></nfeDadosMsg></soap12:Body></soap12:Envelope>`;

        // Log para debug
        logger.info('Envelope SOAP Cancelamento (primeiros 2000 chars):', envelope.substring(0, 2000));

        const response = await axios({
            method: 'POST',
            url: sefazUrl,
            data: envelope,
            headers: {
                'Content-Type': 'application/soap+xml; charset=utf-8',
                'SOAPAction': 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4/nfeRecepcaoEvento',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NFe/4.0',
            },
            timeout: SEFAZ_TIMEOUT,
            httpsAgent: getHttpsAgent(),
        });

        const tempoResposta = Date.now() - startTime;
        const xmlResponse = response.data;

        // Parse da resposta
        const eventoData = parseEventoResponse(xmlResponse);

        logger.info(`Cancelamento NF-e: ${eventoData.cStat} - ${eventoData.xMotivo}`, {
            tempo: tempoResposta,
        });

        res.json({
            ...eventoData,
            tempoResposta,
        });

    } catch (error) {
        const tempoResposta = Date.now() - startTime;
        logger.error('Erro ao cancelar NF-e:', error.message);

        res.status(500).json({
            cStat: 0,
            xMotivo: `Erro: ${error.message}`,
            erro: true,
            tempoResposta,
        });
    }
});

/**
 * POST /api/sefaz/inutilizar
 * Inutiliza faixa de numeração na SEFAZ
 */
router.post('/inutilizar', async (req, res) => {
    const startTime = Date.now();

    try {
        const {
            uf = 'MS',
            ambiente = 2,
            ano,
            CNPJ,
            mod = '55',
            serie,
            nNFIni,
            nNFFin,
            xJust
        } = req.body;

        if (!ano || !CNPJ || !serie || !nNFIni || !nNFFin || !xJust) {
            return res.status(400).json({
                error: 'Parâmetros obrigatórios: ano, CNPJ, serie, nNFIni, nNFFin, xJust'
            });
        }

        if (xJust.length < 15) {
            return res.status(400).json({
                error: 'Justificativa deve ter no mínimo 15 caracteres'
            });
        }

        const ufUpper = uf.toUpperCase();
        const cUF = UF_CODIGOS[ufUpper] || '50';
        const tpAmb = ambiente === 1 ? '1' : '2';
        const anoStr = ano.toString().slice(-2);
        const idInut = `ID${cUF}${anoStr}${CNPJ}${mod}${serie.toString().padStart(3, '0')}${nNFIni.toString().padStart(9, '0')}${nNFFin.toString().padStart(9, '0')}`;

        const urls = getSefazUrls(ufUpper, 'NfeInutilizacao');
        const sefazUrl = ambiente === 1 ? urls.producao : urls.homologacao;

        logger.info(`Inutilizando NF-e ${nNFIni}-${nNFFin} série ${serie} na SEFAZ-${ufUpper}`);

        // XML da Inutilização
        const xmlInut = `<inutNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><infInut Id="${idInut}"><tpAmb>${tpAmb}</tpAmb><xServ>INUTILIZAR</xServ><cUF>${cUF}</cUF><ano>${anoStr}</ano><CNPJ>${CNPJ}</CNPJ><mod>${mod}</mod><serie>${serie}</serie><nNFIni>${nNFIni}</nNFIni><nNFFin>${nNFFin}</nNFFin><xJust>${xJust}</xJust></infInut></inutNFe>`;

        // Assinar a inutilização
        let xmlInutAssinado;
        try {
            xmlInutAssinado = signInutXml(xmlInut);
            logger.info('Inutilização assinada com sucesso');
        } catch (signError) {
            logger.error('Erro ao assinar inutilização:', signError.message);
            return res.status(400).json({
                error: 'Erro ao assinar inutilização',
                detalhe: signError.message
            });
        }

        // Envelope SOAP
        const envelope = `<?xml version="1.0" encoding="UTF-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeInutilizacao4">${xmlInutAssinado}</nfeDadosMsg></soap12:Body></soap12:Envelope>`;

        const response = await axios({
            method: 'POST',
            url: sefazUrl,
            data: envelope,
            headers: {
                'Content-Type': 'application/soap+xml; charset=utf-8',
                'SOAPAction': 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeInutilizacao4/nfeInutilizacaoNF',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NFe/4.0',
            },
            timeout: SEFAZ_TIMEOUT,
            httpsAgent: getHttpsAgent(),
        });

        const tempoResposta = Date.now() - startTime;
        const xmlResponse = response.data;

        // Parse da resposta
        const inutData = parseInutilizacaoResponse(xmlResponse);

        logger.info(`Inutilização: ${inutData.cStat} - ${inutData.xMotivo}`, {
            tempo: tempoResposta,
        });

        res.json({
            ...inutData,
            tempoResposta,
        });

    } catch (error) {
        const tempoResposta = Date.now() - startTime;
        logger.error('Erro ao inutilizar:', error.message);

        res.status(500).json({
            cStat: 0,
            xMotivo: `Erro: ${error.message}`,
            erro: true,
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

function parseEventoResponse(xmlResponse) {
    const cStatMatch = xmlResponse.match(/<cStat>(\d+)<\/cStat>/g);
    const xMotivoMatch = xmlResponse.match(/<xMotivo>([^<]+)<\/xMotivo>/g);
    const nProtMatch = xmlResponse.match(/<nProt>(\d+)<\/nProt>/);
    const chNFeMatch = xmlResponse.match(/<chNFe>(\d+)<\/chNFe>/);
    const tpEventoMatch = xmlResponse.match(/<tpEvento>(\d+)<\/tpEvento>/);
    const dhRegEventoMatch = xmlResponse.match(/<dhRegEvento>([^<]+)<\/dhRegEvento>/);

    // Pegar o último cStat e xMotivo (do retEvento)
    const cStat = cStatMatch && cStatMatch.length > 1
        ? parseInt(cStatMatch[cStatMatch.length - 1].match(/\d+/)[0])
        : (cStatMatch ? parseInt(cStatMatch[0].match(/\d+/)[0]) : 0);

    const xMotivo = xMotivoMatch && xMotivoMatch.length > 1
        ? xMotivoMatch[xMotivoMatch.length - 1].replace(/<\/?xMotivo>/g, '')
        : (xMotivoMatch ? xMotivoMatch[0].replace(/<\/?xMotivo>/g, '') : 'Resposta inválida');

    return {
        cStat,
        xMotivo,
        nProt: nProtMatch ? nProtMatch[1] : null,
        chNFe: chNFeMatch ? chNFeMatch[1] : null,
        tpEvento: tpEventoMatch ? tpEventoMatch[1] : null,
        dhRegEvento: dhRegEventoMatch ? dhRegEventoMatch[1] : null,
        xmlResponse,
    };
}

function parseInutilizacaoResponse(xmlResponse) {
    const cStatMatch = xmlResponse.match(/<cStat>(\d+)<\/cStat>/);
    const xMotivoMatch = xmlResponse.match(/<xMotivo>([^<]+)<\/xMotivo>/);
    const nProtMatch = xmlResponse.match(/<nProt>(\d+)<\/nProt>/);
    const dhRecbtoMatch = xmlResponse.match(/<dhRecbto>([^<]+)<\/dhRecbto>/);

    return {
        cStat: cStatMatch ? parseInt(cStatMatch[1]) : 0,
        xMotivo: xMotivoMatch ? xMotivoMatch[1] : 'Resposta inválida',
        nProt: nProtMatch ? nProtMatch[1] : null,
        dhRecbto: dhRecbtoMatch ? dhRecbtoMatch[1] : null,
        xmlResponse,
    };
}

module.exports = router;
