/**
 * Utilitário para Assinatura Digital de XML NFe
 * Padrão: XML Signature (XMLDSig) - Enveloped
 */

const { SignedXml } = require('xml-crypto');
const { DOMParser, XMLSerializer } = require('xmldom');
const forge = require('node-forge');
const crypto = require('crypto');
const logger = require('./logger');

/**
 * Carrega o certificado das variáveis de ambiente
 */
function loadCertificate() {
    const certBase64 = process.env.CERT_PFX_BASE64;
    const certPassword = process.env.CERT_PASSWORD;

    if (!certBase64 || !certPassword) {
        throw new Error('Certificado não configurado (CERT_PFX_BASE64 / CERT_PASSWORD)');
    }

    return loadCertificateFromBase64(certBase64, certPassword);
}

/**
 * Carrega certificado a partir de base64 e senha
 */
function loadCertificateFromBase64(certBase64, certPassword) {
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

    return { certificate, privateKey, certInfo: certBag.cert };
}

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
 * Classe para criar a assinatura NFe conforme padrão da SEFAZ
 */
class NFeSignature {
    constructor(privateKey) {
        this.privateKey = privateKey;
    }

    getSignatureAlgorithm() {
        return 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
    }

    getKeyInfo() {
        return '';  // Será adicionado manualmente
    }

    sign(content, callback) {
        const signer = crypto.createSign('RSA-SHA1');
        signer.update(content);
        const signature = signer.sign(this.privateKey, 'base64');
        callback(null, signature);
    }
}

/**
 * Assina o XML da NFe
 * @param {string} xml - XML da NFe (elemento NFe ou infNFe)
 * @param {object} certificadoOpts - Opcional: { certBase64, certPassword } para usar certificado específico
 * @returns {string} - XML assinado
 */
function signNFeXml(xml, certificadoOpts = null) {
    let certificate, privateKey, certInfo;
    
    if (certificadoOpts && certificadoOpts.certBase64 && certificadoOpts.certPassword) {
        // Usar certificado fornecido na requisição
        const certData = loadCertificateFromBase64(certificadoOpts.certBase64, certificadoOpts.certPassword);
        certificate = certData.certificate;
        privateKey = certData.privateKey;
        certInfo = certData.certInfo;
        logger.info('Usando certificado fornecido na requisição');
    } else {
        // Usar certificado das variáveis de ambiente
        const certData = loadCertificate();
        certificate = certData.certificate;
        privateKey = certData.privateKey;
        certInfo = certData.certInfo;
    }

    logger.info('Assinando XML NFe...');
    logger.info(`  Certificado: ${certInfo.subject.getField('CN')?.value || 'N/A'}`);

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
    sig.signingKey = privateKey;

    // KeyInfo com X509Certificate
    const certContent = extractCertContent(certificate);
    sig.keyInfoProvider = {
        getKeyInfo: () => {
            return `<X509Data><X509Certificate>${certContent}</X509Certificate></X509Data>`;
        }
    };

    // Encontrar o elemento NFe para inserir a assinatura
    const nfe = doc.getElementsByTagName('NFe')[0];
    if (!nfe) {
        throw new Error('Elemento NFe não encontrado no XML');
    }

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
 * Assina o XML de Evento (Cancelamento, CC-e, etc)
 * @param {string} xml - XML do evento
 * @returns {string} - XML assinado
 */
function signEventoXml(xml) {
    const { certificate, privateKey, certInfo } = loadCertificate();

    logger.info('Assinando XML Evento...');

    // Limpar o XML de caracteres indesejados
    let cleanXml = xml
        .replace(/\r\n/g, '')
        .replace(/\n/g, '')
        .replace(/\t/g, '')
        .replace(/>\s+</g, '><')
        .trim();

    const doc = new DOMParser().parseFromString(cleanXml, 'text/xml');

    // Encontrar o elemento infEvento e seu Id
    const infEvento = doc.getElementsByTagName('infEvento')[0];
    if (!infEvento) {
        throw new Error('Elemento infEvento não encontrado no XML');
    }

    const infEventoId = infEvento.getAttribute('Id');
    if (!infEventoId) {
        throw new Error('Atributo Id não encontrado em infEvento');
    }

    // Configurar SignedXml
    const sig = new SignedXml();
    sig.signatureAlgorithm = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
    sig.canonicalizationAlgorithm = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';

    sig.addReference(
        `//*[@Id='${infEventoId}']`,
        [
            'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
            'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
        ],
        'http://www.w3.org/2000/09/xmldsig#sha1'
    );

    sig.signingKey = privateKey;

    const certContent = extractCertContent(certificate);
    sig.keyInfoProvider = {
        getKeyInfo: () => {
            return `<X509Data><X509Certificate>${certContent}</X509Certificate></X509Data>`;
        }
    };

    sig.computeSignature(cleanXml, {
        location: { reference: `//*[local-name(.)='infEvento']`, action: 'after' }
    });

    let signedXml = sig.getSignedXml();

    signedXml = signedXml
        .replace(/\r\n/g, '')
        .replace(/\n/g, '')
        .replace(/\t/g, '')
        .replace(/>\s+</g, '><')
        .trim();

    logger.info('XML Evento assinado com sucesso!');

    return signedXml;
}

/**
 * Assina o XML de Inutilização
 * @param {string} xml - XML da inutilização
 * @returns {string} - XML assinado
 */
function signInutXml(xml) {
    const { certificate, privateKey, certInfo } = loadCertificate();

    logger.info('Assinando XML Inutilização...');

    // Limpar o XML de caracteres indesejados
    let cleanXml = xml
        .replace(/\r\n/g, '')
        .replace(/\n/g, '')
        .replace(/\t/g, '')
        .replace(/>\s+</g, '><')
        .trim();

    const doc = new DOMParser().parseFromString(cleanXml, 'text/xml');

    // Encontrar o elemento infInut e seu Id
    const infInut = doc.getElementsByTagName('infInut')[0];
    if (!infInut) {
        throw new Error('Elemento infInut não encontrado no XML');
    }

    const infInutId = infInut.getAttribute('Id');
    if (!infInutId) {
        throw new Error('Atributo Id não encontrado em infInut');
    }

    // Configurar SignedXml
    const sig = new SignedXml();
    sig.signatureAlgorithm = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
    sig.canonicalizationAlgorithm = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';

    sig.addReference(
        `//*[@Id='${infInutId}']`,
        [
            'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
            'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
        ],
        'http://www.w3.org/2000/09/xmldsig#sha1'
    );

    sig.signingKey = privateKey;

    const certContent = extractCertContent(certificate);
    sig.keyInfoProvider = {
        getKeyInfo: () => {
            return `<X509Data><X509Certificate>${certContent}</X509Certificate></X509Data>`;
        }
    };

    sig.computeSignature(cleanXml, {
        location: { reference: `//*[local-name(.)='infInut']`, action: 'after' }
    });

    let signedXml = sig.getSignedXml();

    signedXml = signedXml
        .replace(/\r\n/g, '')
        .replace(/\n/g, '')
        .replace(/\t/g, '')
        .replace(/>\s+</g, '><')
        .trim();

    logger.info('XML Inutilização assinado com sucesso!');

    return signedXml;
}

/**
 * Valida se um XML está assinado
 */
function validateSignature(signedXml) {
    try {
        const doc = new DOMParser().parseFromString(signedXml, 'text/xml');
        const signature = doc.getElementsByTagName('Signature')[0];

        if (!signature) {
            return { valid: false, error: 'Assinatura não encontrada' };
        }

        const { certificate } = loadCertificate();

        const sig = new SignedXml();
        sig.keyInfoProvider = {
            getKey: () => certificate
        };

        sig.loadSignature(signature);
        const isValid = sig.checkSignature(signedXml);

        return { valid: isValid, errors: sig.validationErrors };
    } catch (error) {
        return { valid: false, error: error.message };
    }
}

module.exports = {
    signNFeXml,
    signEventoXml,
    signInutXml,
    validateSignature,
    loadCertificate
};
