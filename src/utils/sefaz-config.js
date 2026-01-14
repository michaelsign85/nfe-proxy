/**
 * Configuração de URLs das SEFAZs por estado
 */

// Códigos UF IBGE
const UF_CODIGOS = {
    'AC': '12', 'AL': '27', 'AP': '16', 'AM': '13', 'BA': '29',
    'CE': '23', 'DF': '53', 'ES': '32', 'GO': '52', 'MA': '21',
    'MT': '51', 'MS': '50', 'MG': '31', 'PA': '15', 'PB': '25',
    'PR': '41', 'PE': '26', 'PI': '22', 'RJ': '33', 'RN': '24',
    'RS': '43', 'RO': '11', 'RR': '14', 'SC': '42', 'SP': '35',
    'SE': '28', 'TO': '17'
};

// Estados que usam SEFAZ própria
const SEFAZ_PROPRIA = ['AM', 'BA', 'GO', 'MG', 'MS', 'MT', 'PE', 'PR', 'RS', 'SP'];

// Estados que usam SVAN (SEFAZ Virtual Ambiente Nacional)
const SVAN_ESTADOS = ['MA', 'PA', 'PI'];

// Estados que usam SVRS (SEFAZ Virtual RS)
const SVRS_ESTADOS = ['AC', 'AL', 'AP', 'CE', 'DF', 'ES', 'PB', 'RJ', 'RN', 'RO', 'RR', 'SC', 'SE', 'TO'];

// URLs das SEFAZs
const SEFAZ_URLS = {
    // ============== SEFAZ com Webservice Próprio ==============
    'AM': {
        NfeStatusServico: {
            homologacao: 'https://homnfe.sefaz.am.gov.br/services2/services/NfeStatusServico4',
            producao: 'https://nfe.sefaz.am.gov.br/services2/services/NfeStatusServico4',
        },
        NfeAutorizacao: {
            homologacao: 'https://homnfe.sefaz.am.gov.br/services2/services/NfeAutorizacao4',
            producao: 'https://nfe.sefaz.am.gov.br/services2/services/NfeAutorizacao4',
        },
        NfeConsultaProtocolo: {
            homologacao: 'https://homnfe.sefaz.am.gov.br/services2/services/NfeConsulta4',
            producao: 'https://nfe.sefaz.am.gov.br/services2/services/NfeConsulta4',
        },
    },
    'BA': {
        NfeStatusServico: {
            homologacao: 'https://hnfe.sefaz.ba.gov.br/webservices/NFeStatusServico4/NFeStatusServico4.asmx',
            producao: 'https://nfe.sefaz.ba.gov.br/webservices/NFeStatusServico4/NFeStatusServico4.asmx',
        },
        NfeAutorizacao: {
            homologacao: 'https://hnfe.sefaz.ba.gov.br/webservices/NFeAutorizacao4/NFeAutorizacao4.asmx',
            producao: 'https://nfe.sefaz.ba.gov.br/webservices/NFeAutorizacao4/NFeAutorizacao4.asmx',
        },
        NfeConsultaProtocolo: {
            homologacao: 'https://hnfe.sefaz.ba.gov.br/webservices/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx',
            producao: 'https://nfe.sefaz.ba.gov.br/webservices/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx',
        },
    },
    'GO': {
        NfeStatusServico: {
            homologacao: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeStatusServico4',
            producao: 'https://nfe.sefaz.go.gov.br/nfe/services/NFeStatusServico4',
        },
        NfeAutorizacao: {
            homologacao: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeAutorizacao4',
            producao: 'https://nfe.sefaz.go.gov.br/nfe/services/NFeAutorizacao4',
        },
        NfeConsultaProtocolo: {
            homologacao: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeConsultaProtocolo4',
            producao: 'https://nfe.sefaz.go.gov.br/nfe/services/NFeConsultaProtocolo4',
        },
    },
    'MG': {
        NfeStatusServico: {
            homologacao: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeStatusServico4',
            producao: 'https://nfe.fazenda.mg.gov.br/nfe2/services/NFeStatusServico4',
        },
        NfeAutorizacao: {
            homologacao: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeAutorizacao4',
            producao: 'https://nfe.fazenda.mg.gov.br/nfe2/services/NFeAutorizacao4',
        },
        NfeConsultaProtocolo: {
            homologacao: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeConsultaProtocolo4',
            producao: 'https://nfe.fazenda.mg.gov.br/nfe2/services/NFeConsultaProtocolo4',
        },
    },
    'MS': {
        NfeStatusServico: {
            homologacao: 'https://hom.nfe.sefaz.ms.gov.br/ws/NFeStatusServico4',
            producao: 'https://nfe.sefaz.ms.gov.br/ws/NFeStatusServico4',
        },
        NfeAutorizacao: {
            homologacao: 'https://hom.nfe.sefaz.ms.gov.br/ws/NFeAutorizacao4',
            producao: 'https://nfe.sefaz.ms.gov.br/ws/NFeAutorizacao4',
        },
        NfeConsultaProtocolo: {
            homologacao: 'https://hom.nfe.sefaz.ms.gov.br/ws/NFeConsultaProtocolo4',
            producao: 'https://nfe.sefaz.ms.gov.br/ws/NFeConsultaProtocolo4',
        },
        RecepcaoEvento: {
            homologacao: 'https://hom.nfe.sefaz.ms.gov.br/ws/NFeRecepcaoEvento4',
            producao: 'https://nfe.sefaz.ms.gov.br/ws/NFeRecepcaoEvento4',
        },
        NfeInutilizacao: {
            homologacao: 'https://hom.nfe.sefaz.ms.gov.br/ws/NFeInutilizacao4',
            producao: 'https://nfe.sefaz.ms.gov.br/ws/NFeInutilizacao4',
        },
    },
    'MT': {
        NfeStatusServico: {
            homologacao: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeStatusServico4',
            producao: 'https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeStatusServico4',
        },
        NfeAutorizacao: {
            homologacao: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeAutorizacao4',
            producao: 'https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeAutorizacao4',
        },
        NfeConsultaProtocolo: {
            homologacao: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeConsulta4',
            producao: 'https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeConsulta4',
        },
    },
    'PE': {
        NfeStatusServico: {
            homologacao: 'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeStatusServico4',
            producao: 'https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeStatusServico4',
        },
        NfeAutorizacao: {
            homologacao: 'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeAutorizacao4',
            producao: 'https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeAutorizacao4',
        },
        NfeConsultaProtocolo: {
            homologacao: 'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeConsultaProtocolo4',
            producao: 'https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeConsultaProtocolo4',
        },
    },
    'PR': {
        NfeStatusServico: {
            homologacao: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeStatusServico4',
            producao: 'https://nfe.sefa.pr.gov.br/nfe/NFeStatusServico4',
        },
        NfeAutorizacao: {
            homologacao: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeAutorizacao4',
            producao: 'https://nfe.sefa.pr.gov.br/nfe/NFeAutorizacao4',
        },
        NfeConsultaProtocolo: {
            homologacao: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeConsultaProtocolo4',
            producao: 'https://nfe.sefa.pr.gov.br/nfe/NFeConsultaProtocolo4',
        },
    },
    'RS': {
        NfeStatusServico: {
            homologacao: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
            producao: 'https://nfe.sefazrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
        },
        NfeAutorizacao: {
            homologacao: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
            producao: 'https://nfe.sefazrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
        },
        NfeConsultaProtocolo: {
            homologacao: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
            producao: 'https://nfe.sefazrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
        },
    },
    'SP': {
        NfeStatusServico: {
            homologacao: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx',
            producao: 'https://nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx',
        },
        NfeAutorizacao: {
            homologacao: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx',
            producao: 'https://nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx',
        },
        NfeConsultaProtocolo: {
            homologacao: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx',
            producao: 'https://nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx',
        },
    },

    // ============== SVAN (SEFAZ Virtual Ambiente Nacional) ==============
    'SVAN': {
        NfeStatusServico: {
            homologacao: 'https://hom.sefazvirtual.fazenda.gov.br/NFeStatusServico4/NFeStatusServico4.asmx',
            producao: 'https://www.sefazvirtual.fazenda.gov.br/NFeStatusServico4/NFeStatusServico4.asmx',
        },
        NfeAutorizacao: {
            homologacao: 'https://hom.sefazvirtual.fazenda.gov.br/NFeAutorizacao4/NFeAutorizacao4.asmx',
            producao: 'https://www.sefazvirtual.fazenda.gov.br/NFeAutorizacao4/NFeAutorizacao4.asmx',
        },
        NfeConsultaProtocolo: {
            homologacao: 'https://hom.sefazvirtual.fazenda.gov.br/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx',
            producao: 'https://www.sefazvirtual.fazenda.gov.br/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx',
        },
    },

    // ============== SVRS (SEFAZ Virtual RS) ==============
    'SVRS': {
        NfeStatusServico: {
            homologacao: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
            producao: 'https://nfe.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
        },
        NfeAutorizacao: {
            homologacao: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
            producao: 'https://nfe.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
        },
        NfeConsultaProtocolo: {
            homologacao: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
            producao: 'https://nfe.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
        },
    },
};

/**
 * Obtém as URLs da SEFAZ para uma UF e serviço específico
 */
function getSefazUrls(uf, servico) {
    const ufUpper = uf.toUpperCase();

    // Verificar se tem SEFAZ própria
    if (SEFAZ_PROPRIA.includes(ufUpper) && SEFAZ_URLS[ufUpper]) {
        return SEFAZ_URLS[ufUpper][servico] || SEFAZ_URLS['SVRS'][servico];
    }

    // Verificar se usa SVAN
    if (SVAN_ESTADOS.includes(ufUpper)) {
        return SEFAZ_URLS['SVAN'][servico];
    }

    // Por padrão, usa SVRS
    return SEFAZ_URLS['SVRS'][servico];
}

module.exports = {
    UF_CODIGOS,
    SEFAZ_PROPRIA,
    SVAN_ESTADOS,
    SVRS_ESTADOS,
    SEFAZ_URLS,
    getSefazUrls,
};
