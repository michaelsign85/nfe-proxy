/**
 * Script para testar geração de XML NFC-e localmente
 */
const { UF_CODIGOS, SEFAZ_URLS } = require('./src/utils/sefaz-config');
const crypto = require('crypto');

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

function gerarCodigoNumerico() {
    return String(Math.floor(Math.random() * 100000000)).padStart(8, '0');
}

function escapeXml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatarValor(valor) {
    return Number(valor || 0).toFixed(2);
}

// Gerar QR Code
function gerarQRCode(chaveAcesso, tpAmb, cscId, csc) {
    const urlBase = 'https://hom.nfce.sefaz.ms.gov.br/nfce/qrcode';
    const urlChave = 'http://www.dfe.ms.gov.br/nfce/consulta';
    const cIdToken = String(cscId).padStart(6, '0');
    const nVersao = '2';
    const dadosParaHash = `${chaveAcesso}|${nVersao}|${tpAmb}|${cIdToken}${csc}`;
    const cHashQRCode = crypto.createHash('sha1').update(dadosParaHash).digest('hex').toUpperCase();
    const qrCodeUrl = `${urlBase}?p=${chaveAcesso}|${nVersao}|${tpAmb}|${cIdToken}|${cHashQRCode}`;
    return { qrCodeUrl, urlChave };
}

// Dados teste
const emitente = {
    cnpj: '33599303000121',
    razao_social: 'M. KANG EIRELI',
    inscricao_estadual: '284408131',
    regime_tributario: 1,
    endereco: {
        logradouro: 'RUA TESTE',
        numero: '100',
        bairro: 'CENTRO',
        codigo_municipio: '5002704',
        cidade: 'CAMPO GRANDE',
        cep: '79002000'
    }
};

const cUF = '50';
const now = new Date();
const ano = now.getFullYear();
const mes = String(now.getMonth() + 1).padStart(2, '0');
const AAMM = `${String(ano).slice(-2)}${mes}`;
const dhEmi = `${ano}-${mes}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}-04:00`;

const cnpj = emitente.cnpj;
const mod = '65';
const serie = '001';
const numero = 3;
const nNF = String(numero).padStart(9, '0');
const tpEmis = '1';
const cNF = gerarCodigoNumerico();
const tpAmb = '2';

const chave43 = `${cUF}${AAMM}${cnpj}${mod}${serie}${nNF}${tpEmis}${cNF}`;
const cDV = calcularDV(chave43);
const chaveAcesso = chave43 + cDV;

console.log('Chave de acesso:', chaveAcesso);
console.log('Tamanho:', chaveAcesso.length);

// QR Code
const { qrCodeUrl, urlChave } = gerarQRCode(chaveAcesso, tpAmb, '000001', '364a18079b83e1e2a35799fa1403040fb98d');
console.log('QR Code URL:', qrCodeUrl.substring(0, 80) + '...');

// Montar item - EXATAMENTE como na NFC-e
const itemXml = `<det nItem="1"><prod><cProd>001</cProd><cEAN>SEM GTIN</cEAN><xProd>NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL</xProd><NCM>22021000</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>1.0000</qCom><vUnCom>10.0000</vUnCom><vProd>10.00</vProd><cEANTrib>SEM GTIN</cEANTrib><uTrib>UN</uTrib><qTrib>1.0000</qTrib><vUnTrib>10.0000</vUnTrib><indTot>1</indTot></prod><imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS><PIS><PISNT><CST>07</CST></PISNT></PIS><COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS></imposto></det>`;

// enderEmit
const enderEmit = `<enderEmit><xLgr>RUA TESTE</xLgr><nro>100</nro><xBairro>CENTRO</xBairro><cMun>5002704</cMun><xMun>CAMPO GRANDE</xMun><UF>MS</UF><CEP>79002000</CEP><cPais>1058</cPais><xPais>BRASIL</xPais></enderEmit>`;

// pagamento
const pagXml = `<pag><detPag><tPag>01</tPag><vPag>10.00</vPag></detPag></pag>`;

// infNFeSupl
const infNFeSupl = `<infNFeSupl><qrCode><![CDATA[${qrCodeUrl}]]></qrCode><urlChave>${urlChave}</urlChave></infNFeSupl>`;

// XML completo - Verificar ordem dos elementos!
const xml = `<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe${chaveAcesso}" versao="4.00"><ide><cUF>50</cUF><cNF>${cNF}</cNF><natOp>VENDA AO CONSUMIDOR</natOp><mod>65</mod><serie>1</serie><nNF>${numero}</nNF><dhEmi>${dhEmi}</dhEmi><tpNF>1</tpNF><idDest>1</idDest><cMunFG>5002704</cMunFG><tpImp>4</tpImp><tpEmis>1</tpEmis><cDV>${cDV}</cDV><tpAmb>2</tpAmb><finNFe>1</finNFe><indFinal>1</indFinal><indPres>1</indPres><procEmi>0</procEmi><verProc>1.0</verProc></ide><emit><CNPJ>${cnpj}</CNPJ><xNome>${emitente.razao_social}</xNome>${enderEmit}<IE>${emitente.inscricao_estadual}</IE><CRT>1</CRT></emit>${itemXml}<total><ICMSTot><vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet><vProd>10.00</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro><vNF>10.00</vNF></ICMSTot></total><transp><modFrete>9</modFrete></transp>${pagXml}</infNFe>${infNFeSupl}</NFe>`;

console.log('');
console.log('=== XML GERADO ===');
console.log(xml);
console.log('');
console.log('Tamanho XML:', xml.length);

// Verificar estrutura
console.log('');
console.log('=== VERIFICAÇÕES ===');
console.log('Tem <mod>65</mod>:', xml.includes('<mod>65</mod>'));
console.log('Tem <tpImp>4</tpImp>:', xml.includes('<tpImp>4</tpImp>'));
console.log('Tem <indFinal>1</indFinal>:', xml.includes('<indFinal>1</indFinal>'));
console.log('Tem <indPres>1</indPres>:', xml.includes('<indPres>1</indPres>'));
console.log('Tem infNFeSupl:', xml.includes('<infNFeSupl>'));
console.log('NÃO tem enderDest:', !xml.includes('<enderDest>'));
console.log('NÃO tem infRespTec:', !xml.includes('<infRespTec>'));
