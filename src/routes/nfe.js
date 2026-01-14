/**
 * 🚀 Rotas de emissão de NF-e (alto nível)
 * 
 * Endpoint que recebe dados JSON, monta XML, assina e envia para SEFAZ
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const https = require('https');
const forge = require('node-forge');
const crypto = require('crypto');
const { SignedXml } = require('xml-crypto');
const { DOMParser } = require('xmldom');
const logger = require('../utils/logger');
const { getSefazUrls, UF_CODIGOS } = require('../utils/sefaz-config');

const SEFAZ_TIMEOUT = parseInt(process.env.SEFAZ_TIMEOUT) || 30000;

/**
 * Extrai apenas o conteúdo do certificado (sem headers PEM)
 */
function extractCertContent(certPem) {
    return certPem
        .replace('-----BEGIN CERTIFICATE-----', '')
        .replace('-----END CERTIFICATE-----', '')
        .replace(/\r?\n|\r/g, '');
}

/**
 * Assina o XML da NFe com certificado fornecido
 * @param {string} xml - XML da NFe
 * @param {string} certPem - Certificado em formato PEM
 * @param {string} keyPem - Chave privada em formato PEM
 * @returns {string} - XML assinado
 */
function signNFeXmlWithCert(xml, certPem, keyPem) {
    logger.info('Assinando XML NFe...');

    // Limpar o XML de caracteres indesejados
    let cleanXml = xml
        .replace(/\r\n/g, '')
        .replace(/\n/g, '')
        .replace(/\t/g, '')
        .replace(/>\s+</g, '><')
        .trim();

    const doc = new DOMParser().parseFromString(cleanXml, 'text/xml');

    // Encontrar o elemento infNFe e seu Id
    const infNFe = doc.getElementsByTagName('infNFe')[0];
    if (!infNFe) {
        throw new Error('Elemento infNFe não encontrado no XML');
    }

    const infNFeId = infNFe.getAttribute('Id');
    if (!infNFeId) {
        throw new Error('Atributo Id não encontrado em infNFe');
    }

    // Configurar SignedXml
    const sig = new SignedXml();

    // Algoritmo de assinatura
    sig.signatureAlgorithm = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
    sig.canonicalizationAlgorithm = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';

    // Referência ao elemento infNFe
    sig.addReference(
        `//*[@Id='${infNFeId}']`,
        [
            'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
            'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
        ],
        'http://www.w3.org/2000/09/xmldsig#sha1'
    );

    // Chave privada
    sig.signingKey = keyPem;

    // KeyInfo com X509Certificate
    const certContent = extractCertContent(certPem);
    sig.keyInfoProvider = {
        getKeyInfo: () => {
            return `<X509Data><X509Certificate>${certContent}</X509Certificate></X509Data>`;
        }
    };

    // Calcular a assinatura
    sig.computeSignature(cleanXml, {
        location: { reference: `//*[local-name(.)='infNFe']`, action: 'after' }
    });

    let signedXml = sig.getSignedXml();

    // Limpar novamente após assinatura
    signedXml = signedXml
        .replace(/\r\n/g, '')
        .replace(/\n/g, '')
        .replace(/\t/g, '')
        .replace(/>\s+</g, '><')
        .trim();

    logger.info('XML NFe assinado com sucesso!');

    return signedXml;
}

/**
 * Calcula dígito verificador da chave de acesso (módulo 11)
 */
function calcularDV(chave43) {
    const pesos = [2, 3, 4, 5, 6, 7, 8, 9];
    let soma = 0;
    let pesoIndex = 0;
    
    for (let i = chave43.length - 1; i >= 0; i--) {
        soma += parseInt(chave43[i]) * pesos[pesoIndex];
        pesoIndex = (pesoIndex + 1) % 8;
    }
    
    const resto = soma % 11;
    return resto < 2 ? '0' : String(11 - resto);
}

/**
 * Gera código numérico aleatório para NF-e
 */
function gerarCodigoNumerico() {
    return String(Math.floor(Math.random() * 100000000)).padStart(8, '0');
}

/**
 * Formata número para 2 casas decimais
 */
function formatarValor(valor) {
    return Number(valor || 0).toFixed(2);
}

/**
 * Monta XML da NF-e a partir dos dados JSON
 */
function montarXMLNFe(dados, config) {
    const {
        emitente,
        destinatario,
        itens,
        pagamento,
        ambiente,
        serie,
        numero,
        natureza_operacao,
        uf,
    } = dados;

    const cUF = UF_CODIGOS[uf?.toUpperCase()] || '50';
    const dataAtual = new Date();
    // Ajustar para timezone -04:00 (MS)
    const dataMS = new Date(dataAtual.getTime() - (4 * 60 * 60 * 1000));
    const AAMM = `${String(dataMS.getFullYear()).slice(-2)}${String(dataMS.getMonth() + 1).padStart(2, '0')}`;
    const dhEmi = dataMS.toISOString().slice(0, 19) + '-04:00';
    const dhSaiEnt = dhEmi;
    
    const cnpj = emitente.cnpj.replace(/\D/g, '');
    const mod = '55';
    const serieStr = String(serie || 1).padStart(3, '0');
    const nNF = String(numero).padStart(9, '0');
    const tpEmis = '1'; // Normal
    const cNF = gerarCodigoNumerico();
    const tpAmb = ambiente === 1 ? '1' : '2';

    // Chave de acesso (43 dígitos + DV)
    const chave43 = `${cUF}${AAMM}${cnpj}${mod}${serieStr}${nNF}${tpEmis}${cNF}`;
    const cDV = calcularDV(chave43);
    const chaveAcesso = chave43 + cDV;

    // Calcular totais
    let vProd = 0;
    let vNF = 0;
    itens.forEach(item => {
        vProd += parseFloat(item.valor_total || 0);
    });
    vNF = vProd;

    // Regime tributário: 1=Simples Nacional
    const CRT = emitente.regime_tributario || 1;
    const usaCSOSN = CRT === 1 || CRT === 2;

    // Montar itens
    let itensXml = '';
    itens.forEach((item, index) => {
        const nItem = index + 1;
        const vItem = formatarValor(item.valor_total);
        const vUnit = formatarValor(item.valor_unitario);
        const qCom = formatarValor(item.quantidade);

        // ICMS para Simples Nacional (CSOSN)
        let icmsXml;
        if (usaCSOSN) {
            const csosn = item.csosn || '102';
            icmsXml = `<ICMSSN102><orig>${item.origem || '0'}</orig><CSOSN>${csosn}</CSOSN></ICMSSN102>`;
        } else {
            const cst = item.cst_icms || '00';
            icmsXml = `<ICMS00><orig>${item.origem || '0'}</orig><CST>${cst}</CST><modBC>0</modBC><vBC>0.00</vBC><pICMS>0.00</pICMS><vICMS>0.00</vICMS></ICMS00>`;
        }

        itensXml += `<det nItem="${nItem}"><prod><cProd>${item.codigo}</cProd><cEAN>SEM GTIN</cEAN><xProd>${item.descricao}</xProd><NCM>${item.ncm || '00000000'}</NCM><CFOP>${item.cfop || '5102'}</CFOP><uCom>${item.unidade || 'UN'}</uCom><qCom>${qCom}</qCom><vUnCom>${vUnit}</vUnCom><vProd>${vItem}</vProd><cEANTrib>SEM GTIN</cEANTrib><uTrib>${item.unidade || 'UN'}</uTrib><qTrib>${qCom}</qTrib><vUnTrib>${vUnit}</vUnTrib><indTot>1</indTot></prod><imposto><ICMS>${icmsXml}</ICMS><PIS><PISOutr><CST>${item.cst_pis || '49'}</CST><vBC>0.00</vBC><pPIS>0.00</pPIS><vPIS>0.00</vPIS></PISOutr></PIS><COFINS><COFINSOutr><CST>${item.cst_cofins || '49'}</CST><vBC>0.00</vBC><pCOFINS>0.00</pCOFINS><vCOFINS>0.00</vCOFINS></COFINSOutr></COFINS></imposto></det>`;
    });

    // Destinatário
    let destXml = '';
    if (destinatario) {
        const cpfCnpj = (destinatario.cpf || destinatario.cnpj || '').replace(/\D/g, '');
        const idTag = cpfCnpj.length === 11 ? 'CPF' : 'CNPJ';
        // Em homologação, nome é fixo
        const xNome = tpAmb === '2' ? 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL' : (destinatario.nome || 'CONSUMIDOR');
        const indIEDest = destinatario.contribuinte ? '1' : '9';

        destXml = `<dest><${idTag}>${cpfCnpj}</${idTag}><xNome>${xNome}</xNome><indIEDest>${indIEDest}</indIEDest></dest>`;
    } else {
        // Consumidor final
        destXml = `<dest><xNome>CONSUMIDOR FINAL</xNome><indIEDest>9</indIEDest></dest>`;
    }

    // Pagamento
    const vPag = formatarValor(pagamento?.valor || vNF);
    const tPag = pagamento?.forma || '01'; // 01=Dinheiro
    const pagXml = `<pag><detPag><tPag>${tPag}</tPag><vPag>${vPag}</vPag></detPag></pag>`;

    // Responsável técnico
    const respTecXml = `<infRespTec><CNPJ>52972631000105</CNPJ><xContato>ConfirmaPay</xContato><email>suporte@confirmapay.com</email><fone>67999999999</fone></infRespTec>`;

    // XML completo da NF-e
    const xml = `<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe versao="4.00" Id="NFe${chaveAcesso}"><ide><cUF>${cUF}</cUF><cNF>${cNF}</cNF><natOp>${natureza_operacao || 'VENDA DE MERCADORIA'}</natOp><mod>55</mod><serie>${serie || 1}</serie><nNF>${numero}</nNF><dhEmi>${dhEmi}</dhEmi><dhSaiEnt>${dhSaiEnt}</dhSaiEnt><tpNF>1</tpNF><idDest>1</idDest><cMunFG>${emitente.endereco?.codigo_municipio || '5002704'}</cMunFG><tpImp>1</tpImp><tpEmis>1</tpEmis><cDV>${cDV}</cDV><tpAmb>${tpAmb}</tpAmb><finNFe>1</finNFe><indFinal>1</indFinal><indPres>1</indPres><procEmi>0</procEmi><verProc>ConfirmaPay-1.0</verProc></ide><emit><CNPJ>${cnpj}</CNPJ><xNome>${emitente.razao_social}</xNome><xFant>${emitente.nome_fantasia || emitente.razao_social}</xFant><enderEmit><xLgr>${emitente.endereco?.logradouro || 'RUA'}</xLgr><nro>${emitente.endereco?.numero || 'SN'}</nro><xBairro>${emitente.endereco?.bairro || 'CENTRO'}</xBairro><cMun>${emitente.endereco?.codigo_municipio || '5002704'}</cMun><xMun>${emitente.endereco?.cidade || 'CAMPO GRANDE'}</xMun><UF>${uf?.toUpperCase() || 'MS'}</UF><CEP>${(emitente.endereco?.cep || '79000000').replace(/\D/g, '')}</CEP><cPais>1058</cPais><xPais>BRASIL</xPais></enderEmit><IE>${(emitente.inscricao_estadual || '').replace(/\D/g, '')}</IE><CRT>${CRT}</CRT></emit>${destXml}${itensXml}<total><ICMSTot><vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet><vProd>${formatarValor(vProd)}</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro><vNF>${formatarValor(vNF)}</vNF></ICMSTot></total><transp><modFrete>9</modFrete></transp>${pagXml}<infAdic><infCpl>VENDA REALIZADA VIA CONFIRMPAY PDV</infCpl></infAdic>${respTecXml}</infNFe></NFe>`;

    return { xml, chaveAcesso };
}

/**
 * Parse da resposta de autorização
 */
function parseAutorizacaoResponse(xmlResponse) {
    const getTag = (xml, tag) => {
        const regex = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`);
        const match = xml.match(regex);
        return match ? match[1] : null;
    };

    return {
        cStat: parseInt(getTag(xmlResponse, 'cStat')) || 0,
        xMotivo: getTag(xmlResponse, 'xMotivo') || '',
        nProt: getTag(xmlResponse, 'nProt') || '',
        chNFe: getTag(xmlResponse, 'chNFe') || '',
        dhRecbto: getTag(xmlResponse, 'dhRecbto') || '',
        digVal: getTag(xmlResponse, 'digVal') || '',
        xMsg: getTag(xmlResponse, 'xMsg') || '',
    };
}

/**
 * POST /api/nfe/emitir
 * Recebe dados JSON, monta XML, assina e envia para SEFAZ
 */
router.post('/emitir', async (req, res) => {
    const startTime = Date.now();

    try {
        const dados = req.body;

        // Validações básicas
        if (!dados.emitente || !dados.emitente.cnpj) {
            return res.status(400).json({ error: 'Dados do emitente não fornecidos' });
        }

        if (!dados.itens || dados.itens.length === 0) {
            return res.status(400).json({ error: 'Itens da NF-e não fornecidos' });
        }

        // Extrair certificado da requisição ou usar o do servidor
        let certPem, keyPem;
        
        if (dados.certificado_base64 && dados.certificado_senha) {
            // Usar certificado enviado na requisição
            try {
                const pfxBuffer = Buffer.from(dados.certificado_base64, 'base64');
                const pfxAsn1 = forge.asn1.fromDer(pfxBuffer.toString('binary'));
                const pfx = forge.pkcs12.pkcs12FromAsn1(pfxAsn1, dados.certificado_senha);

                const certBags = pfx.getBags({ bagType: forge.pki.oids.certBag });
                const keyBags = pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });

                certPem = forge.pki.certificateToPem(certBags[forge.pki.oids.certBag][0].cert);
                keyPem = forge.pki.privateKeyToPem(keyBags[forge.pki.oids.pkcs8ShroudedKeyBag][0].key);

                logger.info('Usando certificado enviado na requisição');
            } catch (certError) {
                logger.error('Erro ao processar certificado da requisição:', certError.message);
                return res.status(400).json({ error: 'Certificado inválido: ' + certError.message });
            }
        } else {
            // Usar certificado configurado no servidor
            const certBase64 = process.env.CERT_PFX_BASE64;
            const certPassword = process.env.CERT_PASSWORD;

            if (!certBase64 || !certPassword) {
                return res.status(400).json({ error: 'Certificado não configurado no servidor e não fornecido na requisição' });
            }

            try {
                const pfxBuffer = Buffer.from(certBase64, 'base64');
                const pfxAsn1 = forge.asn1.fromDer(pfxBuffer.toString('binary'));
                const pfx = forge.pkcs12.pkcs12FromAsn1(pfxAsn1, certPassword);

                const certBags = pfx.getBags({ bagType: forge.pki.oids.certBag });
                const keyBags = pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });

                certPem = forge.pki.certificateToPem(certBags[forge.pki.oids.certBag][0].cert);
                keyPem = forge.pki.privateKeyToPem(keyBags[forge.pki.oids.pkcs8ShroudedKeyBag][0].key);

                logger.info('Usando certificado do servidor');
            } catch (certError) {
                logger.error('Erro ao processar certificado do servidor:', certError.message);
                return res.status(500).json({ error: 'Erro ao carregar certificado do servidor' });
            }
        }

        const uf = dados.uf || dados.emitente.endereco?.uf || 'MS';
        const ambiente = dados.ambiente || 2;

        // Montar XML
        const { xml, chaveAcesso } = montarXMLNFe(dados, {});
        logger.info(`XML montado. Chave de acesso: ${chaveAcesso}`);

        // Assinar XML
        let xmlAssinado;
        try {
            xmlAssinado = signNFeXmlWithCert(xml, certPem, keyPem);
            logger.info('XML assinado com sucesso');
        } catch (signError) {
            logger.error('Erro ao assinar XML:', signError.message);
            return res.status(500).json({ error: 'Erro ao assinar XML: ' + signError.message });
        }

        // Enviar para SEFAZ
        const ufUpper = uf.toUpperCase();
        const urls = getSefazUrls(ufUpper, 'NfeAutorizacao');
        const sefazUrl = ambiente === 1 ? urls.producao : urls.homologacao;

        logger.info(`Enviando NF-e para SEFAZ-${ufUpper}`, { url: sefazUrl, ambiente });

        // Envelope SOAP
        const envelope = `<?xml version="1.0" encoding="UTF-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope" xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4"><soap12:Header/><soap12:Body><nfe:nfeDadosMsg><enviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><idLote>1</idLote><indSinc>1</indSinc>${xmlAssinado}</enviNFe></nfe:nfeDadosMsg></soap12:Body></soap12:Envelope>`;

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
        const sucesso = autorizacaoData.cStat === 100;

        logger.info(`Autorização NF-e: ${autorizacaoData.cStat} - ${autorizacaoData.xMotivo}`, {
            tempo: tempoResposta,
            sucesso,
        });

        res.json({
            sucesso,
            numero: dados.numero,
            serie: dados.serie || 1,
            chave_acesso: chaveAcesso,
            protocolo: autorizacaoData.nProt,
            cStat: autorizacaoData.cStat,
            xMotivo: autorizacaoData.xMotivo,
            dhRecbto: autorizacaoData.dhRecbto,
            ambiente: ambiente === 1 ? 'Produção' : 'Homologação',
            xml: sucesso ? xmlAssinado : null,
            tempoResposta,
        });

    } catch (error) {
        const tempoResposta = Date.now() - startTime;
        logger.error('Erro ao emitir NF-e:', error.message);

        res.status(500).json({
            sucesso: false,
            erro: error.message,
            tempoResposta,
        });
    }
});

module.exports = router;
