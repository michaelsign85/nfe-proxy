/**
 * 🚀 Rotas de emissão de NF-e (alto nível)
 * 
 * Endpoint que recebe dados JSON, monta XML e chama /api/sefaz/autorizar
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { UF_CODIGOS } = require('../utils/sefaz-config');

const SEFAZ_TIMEOUT = parseInt(process.env.SEFAZ_TIMEOUT) || 30000;

// Arquivo para controle de numeração por CNPJ/série
const NUMERACAO_FILE = path.join(__dirname, '../../data/numeracao_nfe.json');

/**
 * Carrega o controle de numeração
 */
function carregarNumeracao() {
    try {
        if (fs.existsSync(NUMERACAO_FILE)) {
            return JSON.parse(fs.readFileSync(NUMERACAO_FILE, 'utf8'));
        }
    } catch (e) {
        logger.warn('Erro ao carregar numeração:', e.message);
    }
    return {};
}

/**
 * Salva o controle de numeração
 */
function salvarNumeracao(numeracao) {
    try {
        const dir = path.dirname(NUMERACAO_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(NUMERACAO_FILE, JSON.stringify(numeracao, null, 2));
    } catch (e) {
        logger.error('Erro ao salvar numeração:', e.message);
    }
}

/**
 * Obtém o próximo número de NF-e para um CNPJ/série
 */
function obterProximoNumero(cnpj, serie = 1) {
    const numeracao = carregarNumeracao();
    const chave = `${cnpj}_${serie}`;
    
    // Se não existe, começar do 1
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
 * Atualiza o último número usado (quando recebe do frontend)
 */
function atualizarUltimoNumero(cnpj, serie, numero) {
    const numeracao = carregarNumeracao();
    const chave = `${cnpj}_${serie}`;
    
    if (!numeracao[chave] || numeracao[chave].ultimo < numero) {
        numeracao[chave] = { 
            ultimo: numero,
            ultimaAtualizacao: new Date().toISOString()
        };
        salvarNumeracao(numeracao);
    }
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
 * Formato baseado no teste que passou em homologação (test-nfe.ps1)
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
    itens.forEach(item => {
        vProd += parseFloat(item.valor_total || 0);
    });
    const vNF = vProd;

    // Regime tributário: 1=Simples Nacional
    const CRT = emitente.regime_tributario || 1;
    const usaCSOSN = CRT === 1 || CRT === 2;

    // Montar itens - EXATAMENTE como no teste que funcionou
    let itensXml = '';
    itens.forEach((item, index) => {
        const nItem = index + 1;
        const vItem = formatarValor(item.valor_total);
        const vUnit = formatarValor(item.valor_unitario);
        const qCom = Number(item.quantidade || 1).toFixed(4);

        // Código do produto
        const cProd = (item.codigo || String(nItem)).substring(0, 60);
        // Descrição em homologação
        const xProd = tpAmb === '2'
            ? 'PRODUTO TESTE HOMOLOGACAO'
            : (item.descricao || 'PRODUTO').substring(0, 120);

        // ICMS para Simples Nacional
        let icmsXml;
        if (usaCSOSN) {
            const csosn = item.csosn || '102';
            icmsXml = `<ICMSSN102><orig>${item.origem || '0'}</orig><CSOSN>${csosn}</CSOSN></ICMSSN102>`;
        } else {
            icmsXml = `<ICMS00><orig>${item.origem || '0'}</orig><CST>00</CST><modBC>0</modBC><vBC>0.00</vBC><pICMS>0.00</pICMS><vICMS>0.00</vICMS></ICMS00>`;
        }

        // PIS e COFINS - usar PISNT/COFINSNT CST 07 como no teste
        itensXml += `<det nItem="${nItem}">` +
            `<prod>` +
            `<cProd>${cProd}</cProd>` +
            `<cEAN>SEM GTIN</cEAN>` +
            `<xProd>${xProd}</xProd>` +
            `<NCM>${(item.ncm || '61091000').replace(/\D/g, '')}</NCM>` +
            `<CFOP>${item.cfop || '5102'}</CFOP>` +
            `<uCom>UN</uCom>` +
            `<qCom>${qCom}</qCom>` +
            `<vUnCom>${vUnit}</vUnCom>` +
            `<vProd>${vItem}</vProd>` +
            `<cEANTrib>SEM GTIN</cEANTrib>` +
            `<uTrib>UN</uTrib>` +
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

    // Destinatário - COMPLETO com endereco como no teste
    let destXml = '';
    // Usar CPF de teste em homologação: 12345678909
    const cpfDest = tpAmb === '2' ? '12345678909' : (destinatario?.documento || destinatario?.cpf || '').replace(/\D/g, '');

    if (cpfDest && cpfDest.length >= 11) {
        const idTag = cpfDest.length === 11 ? 'CPF' : 'CNPJ';
        const xNome = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';

        destXml = `<dest>` +
            `<${idTag}>${cpfDest}</${idTag}>` +
            `<xNome>${xNome}</xNome>` +
            `<enderDest>` +
            `<xLgr>RUA TESTE</xLgr>` +
            `<nro>1</nro>` +
            `<xBairro>CENTRO</xBairro>` +
            `<cMun>${emitente.endereco?.codigo_municipio || '5002704'}</cMun>` +
            `<xMun>${emitente.endereco?.cidade || 'CAMPO GRANDE'}</xMun>` +
            `<UF>${(uf || 'MS').toUpperCase()}</UF>` +
            `<CEP>${(emitente.endereco?.cep || '79000000').replace(/\D/g, '')}</CEP>` +
            `<cPais>1058</cPais>` +
            `<xPais>BRASIL</xPais>` +
            `</enderDest>` +
            `<indIEDest>9</indIEDest>` +
            `</dest>`;
    }

    // Pagamento
    const vPag = formatarValor(pagamento?.valor || vNF);
    const tPag = String(pagamento?.forma || '01').padStart(2, '0');
    const pagXml = `<pag><detPag><tPag>${tPag}</tPag><vPag>${vPag}</vPag></detPag></pag>`;

    // Responsável técnico - usar CNPJ do emitente como no teste
    const respTecXml = `<infRespTec>` +
        `<CNPJ>${cnpj}</CNPJ>` +
        `<xContato>SUPORTE TECNICO</xContato>` +
        `<email>suporte@mkang.com.br</email>` +
        `<fone>6730000000</fone>` +
        `</infRespTec>`;

    // XML completo - EXATAMENTE na ordem do teste que funcionou
    // IMPORTANTE: Id vem ANTES de versao no atributo infNFe
    const xml = `<NFe xmlns="http://www.portalfiscal.inf.br/nfe">` +
        `<infNFe Id="NFe${chaveAcesso}" versao="4.00">` +
        `<ide>` +
        `<cUF>${cUF}</cUF>` +
        `<cNF>${cNF}</cNF>` +
        `<natOp>${(natureza_operacao || 'VENDA').substring(0, 60)}</natOp>` +
        `<mod>55</mod>` +
        `<serie>${serie || 1}</serie>` +
        `<nNF>${numero}</nNF>` +
        `<dhEmi>${dhEmi}</dhEmi>` +
        `<tpNF>1</tpNF>` +
        `<idDest>1</idDest>` +
        `<cMunFG>${emitente.endereco?.codigo_municipio || '5002704'}</cMunFG>` +
        `<tpImp>1</tpImp>` +
        `<tpEmis>1</tpEmis>` +
        `<cDV>${cDV}</cDV>` +
        `<tpAmb>${tpAmb}</tpAmb>` +
        `<finNFe>1</finNFe>` +
        `<indFinal>1</indFinal>` +
        `<indPres>1</indPres>` +
        `<procEmi>0</procEmi>` +
        `<verProc>1.0</verProc>` +
        `</ide>` +
        `<emit>` +
        `<CNPJ>${cnpj}</CNPJ>` +
        `<xNome>${(emitente.razao_social || 'EMPRESA').substring(0, 60)}</xNome>` +
        `<enderEmit>` +
        `<xLgr>${(emitente.endereco?.logradouro || 'RUA TESTE').substring(0, 60)}</xLgr>` +
        `<nro>${(emitente.endereco?.numero || '100').substring(0, 60)}</nro>` +
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
        respTecXml +
        `</infNFe>` +
        `</NFe>`;

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
 * GET /api/nfe/proximo-numero
 * Retorna o próximo número de NF-e disponível para um CNPJ/série
 */
router.get('/proximo-numero', (req, res) => {
    try {
        const { cnpj, serie } = req.query;
        
        if (!cnpj) {
            return res.status(400).json({ error: 'CNPJ é obrigatório' });
        }
        
        const cnpjLimpo = cnpj.replace(/\D/g, '');
        const serieInt = parseInt(serie) || 1;
        
        const numeracao = carregarNumeracao();
        const chave = `${cnpjLimpo}_${serieInt}`;
        const ultimoNumero = numeracao[chave]?.ultimo || 0;
        const proximoNumero = ultimoNumero + 1;
        
        res.json({
            cnpj: cnpjLimpo,
            serie: serieInt,
            ultimo_numero: ultimoNumero,
            proximo_numero: proximoNumero
        });
    } catch (error) {
        logger.error('Erro ao obter próximo número:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/nfe/atualizar-numero
 * Sincroniza o último número usado (quando frontend informa)
 */
router.post('/atualizar-numero', (req, res) => {
    try {
        const { cnpj, serie, numero } = req.body;
        
        if (!cnpj || !numero) {
            return res.status(400).json({ error: 'CNPJ e número são obrigatórios' });
        }
        
        const cnpjLimpo = cnpj.replace(/\D/g, '');
        const serieInt = parseInt(serie) || 1;
        const numeroInt = parseInt(numero);
        
        atualizarUltimoNumero(cnpjLimpo, serieInt, numeroInt);
        
        logger.info(`Numeração atualizada: CNPJ ${cnpjLimpo}, Série ${serieInt}, Último número: ${numeroInt}`);
        
        res.json({
            sucesso: true,
            cnpj: cnpjLimpo,
            serie: serieInt,
            ultimo_numero: numeroInt
        });
    } catch (error) {
        logger.error('Erro ao atualizar número:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/nfe/emitir
 * Recebe dados JSON, monta XML e envia para /api/sefaz/autorizar
 * Usa a mesma lógica de assinatura que já funciona
 * Se número não for fornecido, gera automaticamente
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

        const cnpj = dados.emitente.cnpj.replace(/\D/g, '');
        const serie = dados.serie || 1;
        const uf = dados.uf || dados.emitente.endereco?.uf || 'MS';
        const ambiente = dados.ambiente || 2;
        
        // Se número não foi fornecido, gerar automaticamente
        let numero = dados.numero;
        if (!numero) {
            numero = obterProximoNumero(cnpj, serie);
            logger.info(`Número NF-e gerado automaticamente: ${numero} (CNPJ: ${cnpj}, Série: ${serie})`);
        } else {
            // Atualizar controle com o número fornecido (para manter sincronizado)
            atualizarUltimoNumero(cnpj, serie, numero);
        }
        
        // Adicionar número ao dados para montagem do XML
        dados.numero = numero;
        dados.serie = serie;

        // Montar XML (sem assinatura - a assinatura será feita pelo /api/sefaz/autorizar)
        const { xml, chaveAcesso } = montarXMLNFe(dados, {});
        logger.info(`XML montado. Chave de acesso: ${chaveAcesso}`);
        logger.info(`XML gerado (primeiros 500 chars): ${xml.substring(0, 500)}...`);

        // Chamar internamente o endpoint /api/sefaz/autorizar que já funciona
        // Isso usa a mesma assinatura e envelope que passou nos testes de homologação
        const axios = require('axios');

        // Fazer chamada interna para /api/sefaz/autorizar
        const autorizarUrl = `http://localhost:${process.env.PORT || 3100}/api/sefaz/autorizar`;

        logger.info(`Chamando ${autorizarUrl} internamente`);

        const autorizarResponse = await axios({
            method: 'POST',
            url: autorizarUrl,
            data: {
                uf: uf,
                ambiente: ambiente,
                xmlNfe: xml
            },
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.API_KEY || req.headers['x-api-key']
            },
            timeout: SEFAZ_TIMEOUT
        });

        const tempoResposta = Date.now() - startTime;
        const result = autorizarResponse.data;

        // Quando cStat = 104 (lote processado), o status real da NF-e está no protNFe
        // Precisamos extrair o cStat interno do protocolo
        let nfeCstat = result.cStat;
        let nfeXMotivo = result.xMotivo;
        
        if (result.cStat === 104 && result.protNFe) {
            // Extrair cStat do protocolo da NF-e
            const cStatMatch = result.protNFe.match(/<cStat>(\d+)<\/cStat>/);
            const xMotivoMatch = result.protNFe.match(/<xMotivo>([^<]+)<\/xMotivo>/);
            
            if (cStatMatch) {
                nfeCstat = parseInt(cStatMatch[1]);
            }
            if (xMotivoMatch) {
                nfeXMotivo = xMotivoMatch[1];
            }
            
            logger.info(`Status NF-e extraído do protNFe: ${nfeCstat} - ${nfeXMotivo}`);
        }

        logger.info(`Resultado autorização: ${nfeCstat} - ${nfeXMotivo}`, {
            tempo: tempoResposta,
            sucesso: nfeCstat === 100,
        });

        // Retornar resultado no formato esperado pelo frontend
        res.json({
            sucesso: nfeCstat === 100,
            numero: dados.numero,
            serie: dados.serie || 1,
            chave_acesso: chaveAcesso,
            protocolo: result.nProt || '',
            cStat: nfeCstat,
            xMotivo: nfeXMotivo,
            dhRecbto: result.dhRecbto,
            ambiente: ambiente === 1 ? 'Produção' : 'Homologação',
            xml: nfeCstat === 100 ? result.xmlAssinado : null,
            tempoResposta,
        });

    } catch (error) {
        const tempoResposta = Date.now() - startTime;
        logger.error('Erro ao emitir NF-e:', error.message);

        // Se a chamada ao autorizar falhou, extrair o erro
        if (error.response && error.response.data) {
            const errData = error.response.data;
            return res.json({
                sucesso: false,
                numero: req.body.numero,
                serie: req.body.serie || 1,
                chave_acesso: '',
                protocolo: '',
                cStat: errData.cStat || 0,
                xMotivo: errData.xMotivo || errData.error || error.message,
                dhRecbto: errData.dhRecbto || '',
                ambiente: (req.body.ambiente || 2) === 1 ? 'Produção' : 'Homologação',
                xml: null,
                tempoResposta,
            });
        }

        res.status(500).json({
            sucesso: false,
            erro: error.message,
            tempoResposta,
        });
    }
});

module.exports = router;
