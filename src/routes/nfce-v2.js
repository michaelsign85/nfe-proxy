/**
 * 🧾 NFC-e v2 - Implementação ISOLADA da NF-e
 * 
 * Modelo 65 - Nota Fiscal de Consumidor Eletrônica
 * 
 * DIFERENÇAS CRÍTICAS DA NF-e:
 * - Endpoint DIFERENTE: nfce.sefaz.ms.gov.br (não nfe.sefaz.ms.gov.br)
 * - mod = 65 (não 55)
 * - tpImp = 4 (DANFE NFC-e)
 * - indFinal = 1 (SEMPRE consumidor final)
 * - indPres = 1 (SEMPRE presencial)
 * - dest é OPCIONAL (obrigatório apenas >R$10.000)
 * - NÃO incluir enderDest
 * - NÃO incluir infRespTec
 * - infNFeSupl OBRIGATÓRIO (QR Code) - ANTES da assinatura
 * 
 * @author ConfirmaPay
 * @version 2.0.0
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const axios = require('axios');
const forge = require('node-forge');
const logger = require('../utils/logger');
const { UF_CODIGOS, SEFAZ_URLS } = require('../utils/sefaz-config');

const SEFAZ_TIMEOUT = parseInt(process.env.SEFAZ_TIMEOUT) || 30000;

// Arquivo para controle de numeração NFC-e
const NUMERACAO_FILE = path.join(__dirname, '../../data/numeracao_nfce_v2.json');

// ========================================
// FUNÇÕES UTILITÁRIAS
// ========================================

/**
 * Carrega o controle de numeração NFC-e
 */
function carregarNumeracao() {
    try {
        if (fs.existsSync(NUMERACAO_FILE)) {
            return JSON.parse(fs.readFileSync(NUMERACAO_FILE, 'utf8'));
        }
    } catch (e) {
        logger.warn('Erro ao carregar numeração NFC-e v2:', e.message);
    }
    return {};
}

/**
 * Salva o controle de numeração NFC-e
 */
function salvarNumeracao(numeracao) {
    try {
        const dir = path.dirname(NUMERACAO_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(NUMERACAO_FILE, JSON.stringify(numeracao, null, 2));
    } catch (e) {
        logger.error('Erro ao salvar numeração NFC-e v2:', e.message);
    }
}

/**
 * Obtém o próximo número de NFC-e para um CNPJ/série
 */
function obterProximoNumero(cnpj, serie = 1) {
    const numeracao = carregarNumeracao();
    const chave = `nfce_v2_${cnpj}_${serie}`;

    if (!numeracao[chave]) {
        numeracao[chave] = { ultimo: 0 };
    }

    const proximo = numeracao[chave].ultimo + 1;
    numeracao[chave].ultimo = proximo;
    numeracao[chave].ultimaAtualizacao = new Date().toISOString();

    salvarNumeracao(numeracao);
    return proximo;
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
 * Gera código numérico aleatório de 8 dígitos
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
 * Formata valor unitário com até 10 casas decimais (padrão SEFAZ)
 */
function formatarValorUnitario(valor) {
    return Number(valor || 0).toFixed(4);
}

/**
 * Escapa caracteres especiais para XML
 */
function escapeXml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// ========================================
// QR CODE - Versão 2.00
// ========================================

/**
 * Gera o QR Code para NFC-e conforme Manual versão 7.0
 * 
 * Formato ONLINE (tpEmis=1):
 * URL?p=chNFe|nVersao|tpAmb|cIdToken|cHashQRCode
 * 
 * @param {string} chaveAcesso - Chave de acesso 44 dígitos
 * @param {string} tpAmb - Tipo ambiente (1=prod, 2=hom)
 * @param {string} cscId - ID do CSC (será formatado com 6 dígitos)
 * @param {string} csc - Token CSC secreto
 * @param {string} uf - UF do emitente
 */
function gerarQRCode(chaveAcesso, tpAmb, cscId, csc, uf) {
    const ufUpper = (uf || 'MS').toUpperCase();
    const urls = SEFAZ_URLS[ufUpper];
    
    // URL base do QR Code
    const urlBase = urls?.NfceQRCode?.[tpAmb === '1' ? 'producao' : 'homologacao']
        || 'https://hom.nfce.sefaz.ms.gov.br/nfce/qrcode';
    
    // URL de consulta pública
    const urlChave = urls?.NfceConsultaPublica?.[tpAmb === '1' ? 'producao' : 'homologacao']
        || 'http://www.dfe.ms.gov.br/nfce/consulta';

    // Formatar cIdToken com 6 dígitos
    const cIdToken = String(cscId).padStart(6, '0');
    
    // Versão do QR Code = 2
    const nVersao = '2';
    
    // Montar string para hash: chNFe|nVersao|tpAmb|cIdToken + CSC (sem separador antes do CSC!)
    const dadosParaHash = `${chaveAcesso}|${nVersao}|${tpAmb}|${cIdToken}${csc}`;
    
    // Hash SHA1 em hexadecimal maiúsculo
    const cHashQRCode = crypto.createHash('sha1').update(dadosParaHash).digest('hex').toUpperCase();
    
    // URL final do QR Code
    const qrCodeUrl = `${urlBase}?p=${chaveAcesso}|${nVersao}|${tpAmb}|${cIdToken}|${cHashQRCode}`;
    
    logger.debug(`QR Code gerado: ${qrCodeUrl.substring(0, 80)}...`);
    
    return { qrCodeUrl, urlChave, cHashQRCode };
}

// ========================================
// ASSINATURA XML
// ========================================

/**
 * Assina o XML da NFC-e usando o certificado digital
 */
function assinarXML(xml, certificadoBase64, certificadoSenha) {
    try {
        // Decodificar PFX
        const pfxBuffer = Buffer.from(certificadoBase64, 'base64');
        const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuffer));
        const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, certificadoSenha);

        // Extrair certificado e chave privada
        const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
        const cert = certBags[forge.pki.oids.certBag][0].cert;
        const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
        const privateKey = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag][0].key;

        // Extrair infNFe do XML
        const infNFeMatch = xml.match(/<infNFe[^>]*>[\s\S]*?<\/infNFe>/);
        if (!infNFeMatch) {
            throw new Error('Tag infNFe não encontrada no XML');
        }
        const infNFe = infNFeMatch[0];

        // Extrair Id da infNFe
        const idMatch = infNFe.match(/Id="([^"]+)"/);
        if (!idMatch) {
            throw new Error('Atributo Id não encontrado na infNFe');
        }
        const referenceUri = idMatch[1];

        // Canonicalização C14N (simplificada - remover espaços entre tags)
        const infNFeCanonical = infNFe
            .replace(/>\s+</g, '><')
            .replace(/\s+/g, ' ')
            .trim();

        // Calcular DigestValue (SHA1 do conteúdo canonicalizado)
        const digestValue = crypto
            .createHash('sha1')
            .update(infNFeCanonical, 'utf8')
            .digest('base64');

        // Montar SignedInfo
        const signedInfo = `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/><Reference URI="#${referenceUri}"><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/><Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/></Transforms><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/><DigestValue>${digestValue}</DigestValue></Reference></SignedInfo>`;

        // Assinar o SignedInfo
        const md = forge.md.sha1.create();
        md.update(signedInfo, 'utf8');
        const signature = forge.util.encode64(privateKey.sign(md));

        // Converter certificado para DER e depois Base64
        const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
        const x509Certificate = forge.util.encode64(certDer);

        // Montar bloco Signature
        const signatureBlock = `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">${signedInfo}<SignatureValue>${signature}</SignatureValue><KeyInfo><X509Data><X509Certificate>${x509Certificate}</X509Certificate></X509Data></KeyInfo></Signature>`;

        // Inserir assinatura após </infNFe> e antes de </NFe>
        // IMPORTANTE: infNFeSupl já está no XML, então inserir antes de </NFe>
        const xmlAssinado = xml.replace('</NFe>', `${signatureBlock}</NFe>`);

        return xmlAssinado;
    } catch (error) {
        logger.error('Erro ao assinar XML NFC-e:', error.message);
        throw error;
    }
}

// ========================================
// MONTAGEM DO XML NFC-e
// ========================================

/**
 * Monta o XML da NFC-e (modelo 65)
 * 
 * DIFERENÇAS DA NF-e:
 * - mod = 65
 * - tpImp = 4 (DANFE NFC-e)
 * - indFinal = 1 (sempre consumidor final)
 * - indPres = 1 (sempre presencial)
 * - Sem enderDest
 * - Sem infRespTec
 * - infNFeSupl com QR Code (incluído ANTES de assinar!)
 */
function montarXMLNFCe(dados) {
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
        csc_id,
        csc_token,
    } = dados;

    const ufUpper = (uf || 'MS').toUpperCase();
    const cUF = UF_CODIGOS[ufUpper] || '50';

    // Data/hora no timezone de MS (-04:00)
    const now = new Date();
    const ano = now.getFullYear();
    const mes = String(now.getMonth() + 1).padStart(2, '0');
    const dia = String(now.getDate()).padStart(2, '0');
    const hora = String(now.getHours()).padStart(2, '0');
    const minuto = String(now.getMinutes()).padStart(2, '0');
    const segundo = String(now.getSeconds()).padStart(2, '0');

    const AAMM = `${String(ano).slice(-2)}${mes}`;
    const dhEmi = `${ano}-${mes}-${dia}T${hora}:${minuto}:${segundo}-04:00`;

    const cnpj = emitente.cnpj.replace(/\D/g, '');
    const mod = '65'; // NFC-e!
    const serieStr = String(serie || 1).padStart(3, '0');
    const nNF = String(numero).padStart(9, '0');
    const tpEmis = '1'; // Normal (online)
    const cNF = gerarCodigoNumerico();
    const tpAmb = ambiente === 1 ? '1' : '2';

    // Gerar chave de acesso (43 dígitos + DV)
    const chave43 = `${cUF}${AAMM}${cnpj}${mod}${serieStr}${nNF}${tpEmis}${cNF}`;
    const cDV = calcularDV(chave43);
    const chaveAcesso = chave43 + cDV;

    // Calcular totais
    let vProd = 0;
    itens.forEach(item => {
        vProd += parseFloat(item.valor_total || 0);
    });
    const vNF = vProd;

    // Regime tributário
    const CRT = emitente.regime_tributario || 1;
    const usaCSOSN = CRT === 1 || CRT === 2;

    // Montar itens
    let itensXml = '';
    itens.forEach((item, index) => {
        const nItem = index + 1;
        const vItem = formatarValor(item.valor_total);
        const vUnit = formatarValorUnitario(item.valor_unitario);
        const qCom = Number(item.quantidade || 1).toFixed(4);

        const cProd = escapeXml((item.codigo || String(nItem)).substring(0, 60));
        const xProd = tpAmb === '2'
            ? 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'
            : escapeXml((item.descricao || 'PRODUTO').substring(0, 120));

        // ICMS
        let icmsXml;
        if (usaCSOSN) {
            const csosn = item.csosn || '102';
            icmsXml = `<ICMSSN102><orig>${item.origem || '0'}</orig><CSOSN>${csosn}</CSOSN></ICMSSN102>`;
        } else {
            icmsXml = `<ICMS00><orig>${item.origem || '0'}</orig><CST>00</CST><modBC>0</modBC><vBC>0.00</vBC><pICMS>0.00</pICMS><vICMS>0.00</vICMS></ICMS00>`;
        }

        itensXml += `<det nItem="${nItem}"><prod><cProd>${cProd}</cProd><cEAN>SEM GTIN</cEAN><xProd>${xProd}</xProd><NCM>${(item.ncm || '00000000').replace(/\D/g, '')}</NCM><CFOP>${item.cfop || '5102'}</CFOP><uCom>${escapeXml((item.unidade || 'UN').toUpperCase())}</uCom><qCom>${qCom}</qCom><vUnCom>${vUnit}</vUnCom><vProd>${vItem}</vProd><cEANTrib>SEM GTIN</cEANTrib><uTrib>${escapeXml((item.unidade || 'UN').toUpperCase())}</uTrib><qTrib>${qCom}</qTrib><vUnTrib>${vUnit}</vUnTrib><indTot>1</indTot></prod><imposto><ICMS>${icmsXml}</ICMS><PIS><PISNT><CST>07</CST></PISNT></PIS><COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS></imposto></det>`;
    });

    // Destinatário - OPCIONAL na NFC-e
    // IMPORTANTE: NÃO incluir enderDest na NFC-e!
    let destXml = '';
    const cpfDest = (destinatario?.documento || '').replace(/\D/g, '');
    if (cpfDest && cpfDest.length >= 11) {
        const idTag = cpfDest.length === 11 ? 'CPF' : 'CNPJ';
        const xNome = tpAmb === '2'
            ? 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'
            : escapeXml((destinatario?.nome || 'CONSUMIDOR').substring(0, 60));

        // NFC-e: apenas identificação, SEM endereço!
        destXml = `<dest><${idTag}>${cpfDest}</${idTag}><xNome>${xNome}</xNome><indIEDest>9</indIEDest></dest>`;
    }

    // Pagamento - vTroco é OBRIGATÓRIO na NFC-e!
    const vPag = formatarValor(pagamento?.valor || vNF);
    const tPag = String(pagamento?.forma || '01').padStart(2, '0');
    const vTroco = formatarValor(pagamento?.troco || 0);
    const pagXml = `<pag><detPag><tPag>${tPag}</tPag><vPag>${vPag}</vPag></detPag><vTroco>${vTroco}</vTroco></pag>`;

    // Gerar QR Code
    const { qrCodeUrl, urlChave } = gerarQRCode(chaveAcesso, tpAmb, csc_id, csc_token, ufUpper);

    // infNFeSupl - DEVE ser incluído no XML ANTES de assinar!
    // Posição: após </infNFe> e antes de </NFe>
    const infNFeSupl = `<infNFeSupl><qrCode><![CDATA[${qrCodeUrl}]]></qrCode><urlChave>${urlChave}</urlChave></infNFeSupl>`;

    // Endereço do emitente
    const enderEmit = `<enderEmit><xLgr>${escapeXml((emitente.endereco?.logradouro || 'RUA').substring(0, 60))}</xLgr><nro>${escapeXml((emitente.endereco?.numero || 'SN').substring(0, 60))}</nro><xBairro>${escapeXml((emitente.endereco?.bairro || 'CENTRO').substring(0, 60))}</xBairro><cMun>${emitente.endereco?.codigo_municipio || '5002704'}</cMun><xMun>${escapeXml((emitente.endereco?.cidade || 'CAMPO GRANDE').substring(0, 60))}</xMun><UF>${ufUpper}</UF><CEP>${(emitente.endereco?.cep || '79000000').replace(/\D/g, '')}</CEP><cPais>1058</cPais><xPais>BRASIL</xPais></enderEmit>`;

    // Montar XML completo da NFC-e
    // IMPORTANTE: Ordem correta dos elementos!
    const xml = `<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe${chaveAcesso}" versao="4.00"><ide><cUF>${cUF}</cUF><cNF>${cNF}</cNF><natOp>${escapeXml((natureza_operacao || 'VENDA').substring(0, 60))}</natOp><mod>65</mod><serie>${serie || 1}</serie><nNF>${numero}</nNF><dhEmi>${dhEmi}</dhEmi><tpNF>1</tpNF><idDest>1</idDest><cMunFG>${emitente.endereco?.codigo_municipio || '5002704'}</cMunFG><tpImp>4</tpImp><tpEmis>1</tpEmis><cDV>${cDV}</cDV><tpAmb>${tpAmb}</tpAmb><finNFe>1</finNFe><indFinal>1</indFinal><indPres>1</indPres><procEmi>0</procEmi><verProc>1.0</verProc></ide><emit><CNPJ>${cnpj}</CNPJ><xNome>${escapeXml((emitente.razao_social || 'EMPRESA').substring(0, 60))}</xNome>${enderEmit}<IE>${(emitente.inscricao_estadual || '').replace(/\D/g, '')}</IE><CRT>${CRT}</CRT></emit>${destXml}${itensXml}<total><ICMSTot><vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet><vProd>${formatarValor(vProd)}</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro><vNF>${formatarValor(vNF)}</vNF></ICMSTot></total><transp><modFrete>9</modFrete></transp>${pagXml}</infNFe>${infNFeSupl}</NFe>`;

    return {
        xml,
        chaveAcesso,
        qrCodeUrl,
        urlChave,
        vNF: formatarValor(vNF),
        dhEmi,
    };
}

// ========================================
// COMUNICAÇÃO COM SEFAZ
// ========================================

/**
 * Cria agente HTTPS com certificado digital
 */
function criarHttpsAgent(certificadoBase64, certificadoSenha) {
    const pfxBuffer = Buffer.from(certificadoBase64, 'base64');
    const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuffer));
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, certificadoSenha);

    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
    const cert = certBags[forge.pki.oids.certBag][0].cert;
    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
    const privateKey = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag][0].key;

    const certPem = forge.pki.certificateToPem(cert);
    const keyPem = forge.pki.privateKeyToPem(privateKey);

    return new https.Agent({
        cert: certPem,
        key: keyPem,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2',
    });
}

/**
 * Envia NFC-e para SEFAZ
 */
async function enviarParaSEFAZ(urlSefaz, xmlAssinado, httpsAgent) {
    // Envelope SOAP para NFC-e
    const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope" xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4"><soap12:Header/><soap12:Body><nfe:nfeDadosMsg><enviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><idLote>1</idLote><indSinc>1</indSinc>${xmlAssinado}</enviNFe></nfe:nfeDadosMsg></soap12:Body></soap12:Envelope>`;

    const response = await axios.post(urlSefaz, soapEnvelope, {
        httpsAgent,
        headers: {
            'Content-Type': 'application/soap+xml; charset=utf-8',
            'SOAPAction': 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote',
        },
        timeout: SEFAZ_TIMEOUT,
    });

    return response.data;
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
    };
}

// ========================================
// ROTAS
// ========================================

/**
 * POST /api/nfce/v2/status
 * Consulta status do serviço NFC-e
 */
router.post('/status', async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { uf = 'MS', ambiente = 2, certificado_base64, certificado_senha } = req.body;
        
        if (!certificado_base64 || !certificado_senha) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Certificado digital é obrigatório',
            });
        }

        const ufUpper = uf.toUpperCase();
        const tpAmb = ambiente === 1 ? '1' : '2';
        const cUF = UF_CODIGOS[ufUpper] || '50';

        // Usar endpoint NFC-e (DIFERENTE do NF-e!)
        const urls = SEFAZ_URLS[ufUpper];
        const urlSefaz = urls?.NfceStatusServico?.[ambiente === 1 ? 'producao' : 'homologacao'];
        
        if (!urlSefaz) {
            return res.status(400).json({
                sucesso: false,
                erro: `URL NFC-e não configurada para UF ${ufUpper}`,
            });
        }

        logger.info(`Consultando status NFC-e: ${urlSefaz}`);

        // Montar envelope SOAP
        const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope" xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4"><soap12:Header/><soap12:Body><nfe:nfeDadosMsg><consStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><tpAmb>${tpAmb}</tpAmb><cUF>${cUF}</cUF><xServ>STATUS</xServ></consStatServ></nfe:nfeDadosMsg></soap12:Body></soap12:Envelope>`;

        const httpsAgent = criarHttpsAgent(certificado_base64, certificado_senha);

        const response = await axios.post(urlSefaz, soapEnvelope, {
            httpsAgent,
            headers: {
                'Content-Type': 'application/soap+xml; charset=utf-8',
                'SOAPAction': 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4/nfeStatusServicoNF',
            },
            timeout: SEFAZ_TIMEOUT,
        });

        const elapsed = Date.now() - startTime;
        
        // Parse simples
        const cStatMatch = response.data.match(/<cStat>(\d+)<\/cStat>/);
        const xMotivoMatch = response.data.match(/<xMotivo>([^<]+)<\/xMotivo>/);

        const cStat = cStatMatch ? parseInt(cStatMatch[1]) : 0;
        const xMotivo = xMotivoMatch ? xMotivoMatch[1] : 'Resposta não parseada';

        return res.json({
            sucesso: cStat === 107,
            cStat,
            xMotivo,
            uf: ufUpper,
            ambiente: ambiente === 1 ? 'Produção' : 'Homologação',
            modelo: 65,
            tempoResposta: elapsed,
        });

    } catch (error) {
        logger.error('Erro ao consultar status NFC-e:', error.message);
        return res.status(500).json({
            sucesso: false,
            erro: error.message,
            tempoResposta: Date.now() - startTime,
        });
    }
});

/**
 * POST /api/nfce/v2/emitir
 * Emite NFC-e (modelo 65)
 */
router.post('/emitir', async (req, res) => {
    const startTime = Date.now();
    logger.info('=== Iniciando emissão NFC-e v2 ===');

    try {
        const {
            uf,
            ambiente,
            serie,
            emitente,
            destinatario,
            itens,
            pagamento,
            natureza_operacao,
            certificado_base64,
            certificado_senha,
            csc_id,
            csc_token,
        } = req.body;

        // Validações
        if (!emitente?.cnpj) {
            return res.status(400).json({ sucesso: false, erro: 'CNPJ do emitente é obrigatório' });
        }
        if (!itens || itens.length === 0) {
            return res.status(400).json({ sucesso: false, erro: 'Itens são obrigatórios' });
        }
        if (!certificado_base64 || !certificado_senha) {
            return res.status(400).json({ sucesso: false, erro: 'Certificado digital é obrigatório' });
        }
        if (!csc_id || !csc_token) {
            return res.status(400).json({ sucesso: false, erro: 'CSC (Código de Segurança do Contribuinte) é obrigatório para NFC-e' });
        }

        const ufUpper = (uf || 'MS').toUpperCase();
        const cnpj = emitente.cnpj.replace(/\D/g, '');
        const serieNfce = serie || 1;
        const tpAmb = ambiente === 1 ? '1' : '2';

        // Obter próximo número
        const numero = obterProximoNumero(cnpj, serieNfce);
        logger.info(`NFC-e número: ${numero}, série: ${serieNfce}`);

        // Montar XML (já inclui infNFeSupl com QR Code)
        const { xml, chaveAcesso, qrCodeUrl, urlChave, vNF, dhEmi } = montarXMLNFCe({
            emitente,
            destinatario,
            itens,
            pagamento,
            ambiente,
            serie: serieNfce,
            numero,
            natureza_operacao,
            uf: ufUpper,
            csc_id,
            csc_token,
        });

        logger.info(`Chave de acesso: ${chaveAcesso}`);

        // Assinar XML
        logger.info('Assinando XML NFC-e...');
        const xmlAssinado = assinarXML(xml, certificado_base64, certificado_senha);
        logger.info('XML assinado com sucesso');

        // Salvar XML para debug
        try {
            const logDir = path.join(__dirname, '../../logs');
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
            fs.writeFileSync(path.join(logDir, 'nfce_v2_ultimo.xml'), xmlAssinado);
            logger.info('XML salvo em logs/nfce_v2_ultimo.xml');
        } catch (e) {
            logger.warn('Não foi possível salvar XML de debug');
        }

        // Obter URL do webservice NFC-e (DIFERENTE do NF-e!)
        const urls = SEFAZ_URLS[ufUpper];
        const urlSefaz = urls?.NfceAutorizacao?.[tpAmb === '1' ? 'producao' : 'homologacao'];
        
        if (!urlSefaz) {
            throw new Error(`URL NFC-e não configurada para UF ${ufUpper}`);
        }

        logger.info(`Enviando para SEFAZ NFC-e: ${urlSefaz}`);

        // Criar agente HTTPS com certificado
        const httpsAgent = criarHttpsAgent(certificado_base64, certificado_senha);

        // Enviar para SEFAZ
        const xmlResposta = await enviarParaSEFAZ(urlSefaz, xmlAssinado, httpsAgent);

        // Parse da resposta
        const resposta = parseAutorizacaoResponse(xmlResposta);

        const elapsed = Date.now() - startTime;
        logger.info(`NFC-e processada em ${elapsed}ms - cStat: ${resposta.cStat}`);

        // Salvar resposta para debug
        try {
            fs.writeFileSync(path.join(__dirname, '../../logs/nfce_v2_resposta.xml'), xmlResposta);
        } catch (e) { /* ignore */ }

        // Resposta de sucesso
        if (resposta.cStat === 100) {
            return res.json({
                sucesso: true,
                cStat: resposta.cStat,
                xMotivo: resposta.xMotivo,
                chave_acesso: chaveAcesso,
                protocolo: resposta.nProt,
                numero,
                serie: serieNfce,
                xml: xmlAssinado,
                qrcode_url: qrCodeUrl,
                url_consulta: urlChave,
                valor_total: vNF,
                data_emissao: dhEmi,
                tempoResposta: elapsed,
            });
        }

        // Resposta com erro/rejeição
        return res.json({
            sucesso: false,
            cStat: resposta.cStat,
            xMotivo: resposta.xMotivo || 'Erro na autorização',
            chave_acesso: chaveAcesso,
            numero,
            serie: serieNfce,
            tempoResposta: elapsed,
        });

    } catch (error) {
        logger.error('Erro ao emitir NFC-e v2:', error);
        return res.status(500).json({
            sucesso: false,
            erro: error.message || 'Erro interno ao emitir NFC-e',
            tempoResposta: Date.now() - startTime,
        });
    }
});

/**
 * POST /api/nfce/v2/atualizar-numero
 * Atualiza o último número de NFC-e
 */
router.post('/atualizar-numero', (req, res) => {
    try {
        const { cnpj, serie = 1, ultimo_numero } = req.body;

        if (!cnpj || !ultimo_numero) {
            return res.status(400).json({
                sucesso: false,
                erro: 'Informe cnpj e ultimo_numero',
            });
        }

        const cnpjLimpo = cnpj.replace(/\D/g, '');
        const numeracao = carregarNumeracao();
        const chave = `nfce_v2_${cnpjLimpo}_${serie}`;

        numeracao[chave] = {
            ultimo: parseInt(ultimo_numero),
            ultimaAtualizacao: new Date().toISOString(),
        };

        salvarNumeracao(numeracao);

        logger.info(`Numeração NFC-e v2 atualizada: ${chave} = ${ultimo_numero}`);

        return res.json({
            sucesso: true,
            cnpj: cnpjLimpo,
            serie,
            ultimo_numero: parseInt(ultimo_numero),
            proximo_numero: parseInt(ultimo_numero) + 1,
        });

    } catch (error) {
        logger.error('Erro ao atualizar numeração:', error);
        return res.status(500).json({
            sucesso: false,
            erro: error.message,
        });
    }
});

/**
 * GET /api/nfce/v2/info
 * Informações sobre a implementação
 */
router.get('/info', (req, res) => {
    res.json({
        versao: '2.0.0',
        modelo: 65,
        descricao: 'NFC-e - Nota Fiscal de Consumidor Eletrônica',
        endpoints: {
            status: 'POST /api/nfce/v2/status',
            emitir: 'POST /api/nfce/v2/emitir',
            atualizarNumero: 'POST /api/nfce/v2/atualizar-numero',
            debugXml: 'GET /api/nfce/v2/debug-xml',
        },
        diferencasNFe: [
            'Endpoint DIFERENTE: nfce.sefaz.ms.gov.br',
            'mod = 65 (não 55)',
            'tpImp = 4 (DANFE NFC-e)',
            'Destinatário opcional',
            'Sem enderDest',
            'Sem infRespTec',
            'infNFeSupl obrigatório (QR Code)',
        ],
    });
});

/**
 * GET /api/nfce/v2/debug-xml
 * Retorna o último XML enviado e a resposta do SEFAZ (para debug)
 */
router.get('/debug-xml', (req, res) => {
    try {
        const logDir = path.join(__dirname, '../../logs');
        let xmlEnviado = '';
        let xmlResposta = '';

        const xmlEnviadoPath = path.join(logDir, 'nfce_v2_ultimo.xml');
        const xmlRespostaPath = path.join(logDir, 'nfce_v2_resposta.xml');

        if (fs.existsSync(xmlEnviadoPath)) {
            xmlEnviado = fs.readFileSync(xmlEnviadoPath, 'utf8');
        }
        if (fs.existsSync(xmlRespostaPath)) {
            xmlResposta = fs.readFileSync(xmlRespostaPath, 'utf8');
        }

        res.json({
            sucesso: true,
            xml_enviado: xmlEnviado,
            xml_resposta: xmlResposta,
            tamanho_enviado: xmlEnviado.length,
            tamanho_resposta: xmlResposta.length,
        });
    } catch (error) {
        res.status(500).json({
            sucesso: false,
            erro: error.message,
        });
    }
});

module.exports = router;
