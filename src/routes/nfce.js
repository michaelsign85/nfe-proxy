/**
 * 🧾 Rotas de emissão de NFC-e (Modelo 65 - Cupom Fiscal)
 * 
 * Endpoint que recebe dados JSON, monta XML modelo 65 e envia para SEFAZ
 * Inclui geração de QR Code obrigatório
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
const { UF_CODIGOS, SEFAZ_URLS, getSefazUrls } = require('../utils/sefaz-config');
const { signNFeXml } = require('../utils/nfe-signer');

const SEFAZ_TIMEOUT = parseInt(process.env.SEFAZ_TIMEOUT) || 30000;

// Arquivo para controle de numeração NFC-e por CNPJ/série
const NUMERACAO_FILE = path.join(__dirname, '../../data/numeracao_nfce.json');

/**
 * Carrega o controle de numeração NFC-e
 */
function carregarNumeracao() {
    try {
        if (fs.existsSync(NUMERACAO_FILE)) {
            return JSON.parse(fs.readFileSync(NUMERACAO_FILE, 'utf8'));
        }
    } catch (e) {
        logger.warn('Erro ao carregar numeração NFC-e:', e.message);
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
        logger.error('Erro ao salvar numeração NFC-e:', e.message);
    }
}

/**
 * Obtém o próximo número de NFC-e para um CNPJ/série
 */
function obterProximoNumero(cnpj, serie = 1) {
    const numeracao = carregarNumeracao();
    const chave = `nfce_${cnpj}_${serie}`;

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
 * Gera código numérico aleatório para NFC-e
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
 * Formata valor unitário com até 4 casas decimais
 * Mantém formato consistente para o XSD
 */
function formatarValorUnitario(valor) {
    return Number(valor || 0).toFixed(4);
}

/**
 * Gera o hash do QR Code NFC-e usando SHA1
 * Conforme Manual de Orientação ao Contribuinte v7.0
 */
function gerarHashQRCode(dadosQR, csc) {
    const concat = dadosQR + csc;
    return crypto.createHash('sha1').update(concat).digest('hex').toUpperCase();
}

/**
 * Monta a URL do QR Code para NFC-e
 * Layout versão 2: chNFe|nVersao|tpAmb|cDest|dhEmi|vNF|vICMS|digVal|cIdToken|cHashQRCode
 * Quando não há destinatário, usa formato simplificado
 */
function montarQRCode(chaveAcesso, tpAmb, vNF, digVal, cscId, csc, uf, destinatarioCPF, dhEmi) {
    // URL base conforme UF
    const urls = SEFAZ_URLS[uf.toUpperCase()];
    const urlBase = urls?.NfceQRCode?.[tpAmb === '1' ? 'producao' : 'homologacao']
        || 'https://hom.nfce.sefaz.ms.gov.br/nfce/qrcode';

    // Formatar cIdToken com 6 dígitos
    const cIdToken = String(cscId).padStart(6, '0');

    // SEMPRE usar formato simplificado (Layout 2 - consulta por chave)
    // Conforme NT 2019.001 - o formato completo só é usado em contingência offline
    // Parâmetros: chNFe|nVersao|tpAmb|cIdToken|cHashQRCode
    const params = `chNFe=${chaveAcesso}&nVersao=2&tpAmb=${tpAmb}&cIdToken=${cIdToken}`;

    // Gerar hash SHA1 (params + CSC sem separador)
    const hash = gerarHashQRCode(params, csc);

    // URL final
    const qrCodeUrl = `${urlBase}?${params}&cHashQRCode=${hash}`;

    return { qrCodeUrl, hash };
}

/**
 * Envia XML para SEFAZ via HTTPS com certificado
 */
async function enviarParaSEFAZNFCe(urlSefaz, soapEnvelope, certificadoBase64, certificadoSenha) {
    // Carregar certificado PFX
    const pfxBuffer = Buffer.from(certificadoBase64, 'base64');
    const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuffer));
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, certificadoSenha);

    // Extrair certificado e chave privada
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
    const cert = certBags[forge.pki.oids.certBag][0].cert;
    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
    const privateKey = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag][0].key;

    const certPem = forge.pki.certificateToPem(cert);
    const keyPem = forge.pki.privateKeyToPem(privateKey);

    // Criar agente HTTPS com certificado
    const httpsAgent = new https.Agent({
        cert: certPem,
        key: keyPem,
        rejectUnauthorized: false,
    });

    // Enviar requisição SOAP
    const response = await axios.post(urlSefaz, soapEnvelope, {
        httpsAgent,
        headers: {
            'Content-Type': 'application/soap+xml; charset=utf-8',
            'SOAPAction': 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote',
        },
        timeout: SEFAZ_TIMEOUT,
    });

    return response;
}

/**
 * Monta XML da NFC-e (modelo 65) a partir dos dados JSON
 */
function montarXMLNFCe(dados, config) {
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

    const cUF = UF_CODIGOS[uf?.toUpperCase()] || '50';

    // Gerar data/hora no timezone -04:00 (MS - não tem horário de verão desde 2019)
    const dataUTC = new Date();
    const offsetMS = -4 * 60; // -4 horas em minutos
    const dataMS = new Date(dataUTC.getTime() + (offsetMS * 60 * 1000));

    // Formatar data manualmente para evitar problemas com toISOString()
    const ano = dataMS.getUTCFullYear();
    const mes = String(dataMS.getUTCMonth() + 1).padStart(2, '0');
    const dia = String(dataMS.getUTCDate()).padStart(2, '0');
    const hora = String(dataMS.getUTCHours()).padStart(2, '0');
    const minuto = String(dataMS.getUTCMinutes()).padStart(2, '0');
    const segundo = String(dataMS.getUTCSeconds()).padStart(2, '0');

    const AAMM = `${String(ano).slice(-2)}${mes}`;
    const dhEmi = `${ano}-${mes}-${dia}T${hora}:${minuto}:${segundo}-04:00`;

    const cnpj = emitente.cnpj.replace(/\D/g, '');
    const mod = '65'; // NFC-e!
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
    itens.forEach(item => {
        vProd += parseFloat(item.valor_total || 0);
    });
    const vNF = vProd;

    // Regime tributário: 1=Simples Nacional
    const CRT = emitente.regime_tributario || 1;
    const usaCSOSN = CRT === 1 || CRT === 2;

    // Montar itens
    let itensXml = '';
    itens.forEach((item, index) => {
        const nItem = index + 1;
        const vItem = formatarValor(item.valor_total);
        const vUnit = formatarValorUnitario(item.valor_unitario);
        const qCom = Number(item.quantidade || 1).toFixed(4);

        // Código do produto - remover hífens e caracteres especiais, máximo 60 chars
        const cProd = (item.codigo || String(nItem)).replace(/[^a-zA-Z0-9]/g, '').substring(0, 60);
        // Descrição em homologação
        const xProd = tpAmb === '2'
            ? 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'
            : (item.descricao || 'PRODUTO').substring(0, 120);

        // ICMS para Simples Nacional (usar ICMSSN102 para CSOSN 102)
        let icmsXml;
        if (usaCSOSN) {
            const csosn = item.csosn || '102';
            // Tag correta: ICMSSN + CSOSN (ex: ICMSSN102 para CSOSN 102)
            icmsXml = `<ICMSSN102><orig>${item.origem || '0'}</orig><CSOSN>${csosn}</CSOSN></ICMSSN102>`;
        } else {
            icmsXml = `<ICMS00><orig>${item.origem || '0'}</orig><CST>00</CST><modBC>0</modBC><vBC>0.00</vBC><pICMS>0.00</pICMS><vICMS>0.00</vICMS></ICMS00>`;
        }

        itensXml += `<det nItem="${nItem}">` +
            `<prod>` +
            `<cProd>${cProd}</cProd>` +
            `<cEAN>SEM GTIN</cEAN>` +
            `<xProd>${xProd}</xProd>` +
            `<NCM>${(item.ncm || '00000000').replace(/\D/g, '')}</NCM>` +
            `<CFOP>${item.cfop || '5102'}</CFOP>` +
            `<uCom>${(item.unidade || 'UN').toUpperCase()}</uCom>` +
            `<qCom>${qCom}</qCom>` +
            `<vUnCom>${vUnit}</vUnCom>` +
            `<vProd>${vItem}</vProd>` +
            `<cEANTrib>SEM GTIN</cEANTrib>` +
            `<uTrib>${(item.unidade || 'UN').toUpperCase()}</uTrib>` +
            `<qTrib>${qCom}</qTrib>` +
            `<vUnTrib>${vUnit}</vUnTrib>` +
            `<indTot>1</indTot>` +
            `</prod>` +
            `<imposto>` +
            `<ICMS>${icmsXml}</ICMS>` +
            `<PIS><PISNT><CST>07</CST></PISNT></PIS>` +
            `<COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS>` +
            `</imposto>` +
            `</det>`;
    });

    // Destinatário - OPCIONAL na NFC-e (só obrigatório acima de R$ 10.000 ou se informado CPF/CNPJ)
    let destXml = '';
    const cpfDest = (destinatario?.documento || '').replace(/\D/g, '');

    if (cpfDest && cpfDest.length >= 11) {
        const idTag = cpfDest.length === 11 ? 'CPF' : 'CNPJ';
        const xNome = tpAmb === '2'
            ? 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'
            : (destinatario?.nome || 'CONSUMIDOR').substring(0, 60);

        destXml = `<dest>` +
            `<${idTag}>${cpfDest}</${idTag}>` +
            `<xNome>${xNome}</xNome>` +
            `<indIEDest>9</indIEDest>` +
            `</dest>`;
    }

    // Pagamento
    const vPag = formatarValor(pagamento?.valor || vNF);
    const tPag = String(pagamento?.forma || '01').padStart(2, '0');
    const pagXml = `<pag><detPag><tPag>${tPag}</tPag><vPag>${vPag}</vPag></detPag></pag>`;

    // XML completo - NFC-e modelo 65
    // Diferenças principais da NF-e:
    // - mod = 65
    // - tpImp = 4 (DANFE NFC-e)
    // - indFinal = 1 (consumidor final SEMPRE)
    // - indPres = 1 (presencial SEMPRE)
    // - Sem transportador
    // - infNFeSupl com qrCode
    const xml = `<NFe xmlns="http://www.portalfiscal.inf.br/nfe">` +
        `<infNFe Id="NFe${chaveAcesso}" versao="4.00">` +
        `<ide>` +
        `<cUF>${cUF}</cUF>` +
        `<cNF>${cNF}</cNF>` +
        `<natOp>${(natureza_operacao || 'VENDA').substring(0, 60)}</natOp>` +
        `<mod>65</mod>` +  // NFC-e!
        `<serie>${serie || 1}</serie>` +
        `<nNF>${numero}</nNF>` +
        `<dhEmi>${dhEmi}</dhEmi>` +
        `<tpNF>1</tpNF>` +
        `<idDest>1</idDest>` +
        `<cMunFG>${emitente.endereco?.codigo_municipio || '5002704'}</cMunFG>` +
        `<tpImp>4</tpImp>` +  // DANFE NFC-e (formato cupom)
        `<tpEmis>1</tpEmis>` +
        `<cDV>${cDV}</cDV>` +
        `<tpAmb>${tpAmb}</tpAmb>` +
        `<finNFe>1</finNFe>` +
        `<indFinal>1</indFinal>` +  // Sempre consumidor final
        `<indPres>1</indPres>` +    // Sempre presencial
        `<procEmi>0</procEmi>` +
        `<verProc>1.0</verProc>` +
        `</ide>` +
        `<emit>` +
        `<CNPJ>${cnpj}</CNPJ>` +
        `<xNome>${(emitente.razao_social || 'EMPRESA').substring(0, 60)}</xNome>` +
        `<enderEmit>` +
        `<xLgr>${(emitente.endereco?.logradouro || 'RUA').substring(0, 60)}</xLgr>` +
        `<nro>${(emitente.endereco?.numero || 'SN').substring(0, 60)}</nro>` +
        `<xBairro>${(emitente.endereco?.bairro || 'CENTRO').substring(0, 60)}</xBairro>` +
        `<cMun>${emitente.endereco?.codigo_municipio || '5002704'}</cMun>` +
        `<xMun>${(emitente.endereco?.cidade || 'CAMPO GRANDE').substring(0, 60)}</xMun>` +
        `<UF>${(uf || 'MS').toUpperCase()}</UF>` +
        `<CEP>${(emitente.endereco?.cep || '79000000').replace(/\D/g, '')}</CEP>` +
        `<cPais>1058</cPais>` +
        `<xPais>BRASIL</xPais>` +
        `</enderEmit>` +
        `<IE>${(emitente.inscricao_estadual || '').replace(/\D/g, '')}</IE>` +
        `<CRT>${CRT}</CRT>` +
        `</emit>` +
        destXml +
        itensXml +
        `<total>` +
        `<ICMSTot>` +
        `<vBC>0.00</vBC>` +
        `<vICMS>0.00</vICMS>` +
        `<vICMSDeson>0.00</vICMSDeson>` +
        `<vFCP>0.00</vFCP>` +
        `<vBCST>0.00</vBCST>` +
        `<vST>0.00</vST>` +
        `<vFCPST>0.00</vFCPST>` +
        `<vFCPSTRet>0.00</vFCPSTRet>` +
        `<vProd>${formatarValor(vProd)}</vProd>` +
        `<vFrete>0.00</vFrete>` +
        `<vSeg>0.00</vSeg>` +
        `<vDesc>0.00</vDesc>` +
        `<vII>0.00</vII>` +
        `<vIPI>0.00</vIPI>` +
        `<vIPIDevol>0.00</vIPIDevol>` +
        `<vPIS>0.00</vPIS>` +
        `<vCOFINS>0.00</vCOFINS>` +
        `<vOutro>0.00</vOutro>` +
        `<vNF>${formatarValor(vNF)}</vNF>` +
        `</ICMSTot>` +
        `</total>` +
        `<transp><modFrete>9</modFrete></transp>` +
        pagXml +
        `</infNFe>` +
        `</NFe>`;

    return { xml, chaveAcesso, cNF, dhEmi, vNF: formatarValor(vNF), cDV };
}

/**
 * Adiciona o grupo infNFeSupl com QR Code após assinatura
 */
function adicionarQRCode(xmlAssinado, qrCodeUrl, urlChave) {
    // O infNFeSupl deve vir DEPOIS de </Signature> e ANTES de </NFe>
    const infNFeSupl = `<infNFeSupl>` +
        `<qrCode><![CDATA[${qrCodeUrl}]]></qrCode>` +
        `<urlChave>${urlChave}</urlChave>` +
        `</infNFeSupl>`;

    // Inserir após </Signature> (se existir) ou após </infNFe>
    if (xmlAssinado.includes('</Signature>')) {
        return xmlAssinado.replace('</Signature></NFe>', `</Signature>${infNFeSupl}</NFe>`);
    }
    return xmlAssinado.replace('</infNFe></NFe>', `</infNFe>${infNFeSupl}</NFe>`);
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
 * POST /api/nfce/emitir - Emite NFC-e
 */
router.post('/emitir', async (req, res) => {
    const startTime = Date.now();
    logger.info('=== Iniciando emissão de NFC-e ===');

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

        const cnpj = emitente.cnpj.replace(/\D/g, '');
        const serieNfce = serie || 1;
        const tpAmb = ambiente === 1 ? '1' : '2';

        // Obter próximo número
        const numero = obterProximoNumero(cnpj, serieNfce);
        logger.info(`NFC-e número: ${numero}, série: ${serieNfce}`);

        // Montar XML base (sem QR Code ainda)
        const { xml, chaveAcesso, cNF, dhEmi, vNF } = montarXMLNFCe({
            emitente,
            destinatario,
            itens,
            pagamento,
            ambiente,
            serie: serieNfce,
            numero,
            natureza_operacao,
            uf: uf || 'MS',
            csc_id,
            csc_token,
        });

        logger.info(`Chave de acesso NFC-e: ${chaveAcesso}`);

        // Debug: Log do XML antes de assinar
        logger.debug(`XML NFC-e antes de assinar (primeiros 500 chars): ${xml.substring(0, 500)}...`);

        // Assinar XML usando a mesma função do NF-e
        logger.info('Assinando XML NFC-e...');
        const certificadoOpts = { certBase64: certificado_base64, certPassword: certificado_senha };
        const xmlAssinado = signNFeXml(xml, certificadoOpts);

        // Extrair digVal do XML assinado para o QR Code
        const digValMatch = xmlAssinado.match(/<DigestValue>([^<]+)<\/DigestValue>/);
        const digVal = digValMatch ? digValMatch[1] : '';

        // Gerar QR Code
        const cpfDest = (destinatario?.documento || '').replace(/\D/g, '');
        const { qrCodeUrl, hash } = montarQRCode(
            chaveAcesso,
            tpAmb,
            vNF,
            digVal,
            csc_id,
            csc_token,
            uf || 'MS',
            cpfDest,
            dhEmi  // Passar data/hora de emissão
        );

        // URL de consulta pública
        const urls = SEFAZ_URLS[(uf || 'MS').toUpperCase()];
        const urlChave = urls?.NfceConsultaPublica?.[tpAmb === '1' ? 'producao' : 'homologacao']
            || 'http://www.dfe.ms.gov.br/nfce/qrcode';

        // Adicionar QR Code ao XML assinado
        const xmlComQR = adicionarQRCode(xmlAssinado, qrCodeUrl, urlChave);

        logger.info(`QR Code URL: ${qrCodeUrl.substring(0, 100)}...`);

        // Obter URL do webservice NFC-e
        const urlSefaz = urls?.NfceAutorizacao?.[tpAmb === '1' ? 'producao' : 'homologacao'];
        if (!urlSefaz) {
            throw new Error(`URL NFC-e não encontrada para UF ${uf}`);
        }

        logger.info(`Enviando para SEFAZ: ${urlSefaz}`);

        // DEBUG: Salvar XML para análise
        try {
            const debugPath = path.join(__dirname, '../../logs/nfce_debug.xml');
            fs.writeFileSync(debugPath, xmlComQR, 'utf8');
            logger.info(`XML salvo em: ${debugPath}`);
        } catch (e) {
            logger.warn('Não foi possível salvar XML de debug:', e.message);
        }

        // Montar envelope SOAP - SEM espaços ou quebras de linha desnecessárias
        const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope" xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4"><soap12:Header/><soap12:Body><nfe:nfeDadosMsg><enviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><idLote>1</idLote><indSinc>1</indSinc>${xmlComQR}</enviNFe></nfe:nfeDadosMsg></soap12:Body></soap12:Envelope>`;

        // Enviar para SEFAZ
        const sefazResult = await enviarParaSEFAZNFCe(urlSefaz, soapEnvelope, certificado_base64, certificado_senha);

        // Parse da resposta
        const resposta = parseAutorizacaoResponse(sefazResult.data);

        const elapsed = Date.now() - startTime;
        logger.info(`NFC-e processada em ${elapsed}ms - cStat: ${resposta.cStat}, xMotivo: ${resposta.xMotivo}`);

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
                xml: xmlComQR,
                qrcode_url: qrCodeUrl,
                qrcode_hash: hash,
                url_consulta: urlChave,
                digVal,
            });
        }

        // Resposta com erro/rejeição
        return res.json({
            sucesso: false,
            cStat: resposta.cStat,
            xMotivo: resposta.xMotivo || resposta.xMsg || 'Erro na autorização',
            chave_acesso: chaveAcesso,
            numero,
            serie: serieNfce,
        });

    } catch (error) {
        logger.error('Erro ao emitir NFC-e:', error);
        return res.status(500).json({
            sucesso: false,
            erro: error.message || 'Erro interno ao emitir NFC-e',
        });
    }
});

/**
 * GET /api/nfce/status - Verifica status do serviço NFC-e
 */
router.get('/status', async (req, res) => {
    const uf = (req.query.uf || 'MS').toUpperCase();
    const ambiente = req.query.ambiente === '1' ? 'producao' : 'homologacao';

    try {
        const urls = SEFAZ_URLS[uf];
        const url = urls?.NfceStatusServico?.[ambiente];

        if (!url) {
            return res.status(400).json({
                sucesso: false,
                erro: `URL NFC-e não encontrada para UF ${uf}`,
            });
        }

        return res.json({
            sucesso: true,
            uf,
            ambiente,
            url,
            mensagem: 'Use POST /api/sefaz/status para consultar o status real',
        });

    } catch (error) {
        return res.status(500).json({
            sucesso: false,
            erro: error.message,
        });
    }
});

/**
 * POST /api/nfce/atualizar-numero
 * Atualiza o último número de NFC-e para um CNPJ/série
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
        const chave = `nfce_${cnpjLimpo}_${serie}`;

        numeracao[chave] = {
            ultimo: parseInt(ultimo_numero),
            ultimaAtualizacao: new Date().toISOString(),
            atualizadoManualmente: true,
        };

        salvarNumeracao(numeracao);

        logger.info(`Numeração NFC-e atualizada: ${chave} = ${ultimo_numero}`);

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

module.exports = router;
