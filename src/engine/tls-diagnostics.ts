import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import { getTrustedCAs } from './tls-trust';

/**
 * When a certificate check fails, Node reports only a short code. These
 * helpers find out what the server actually presented, so the message can say
 * who issued it and whether that issuer is trusted. That is what tells
 * antivirus HTTPS scanning, a missing intermediate and a wrong clock apart.
 *
 * The inspection performs a TLS handshake only. It sends no request, no
 * cookies and no headers, and it never trusts what it sees.
 */
export interface PresentedCertificate {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  fingerprint256: string;
}

export interface TlsInspection {
  /** Node's own verdict for the chain the server sent, e.g. UNABLE_TO_GET_ISSUER_CERT_LOCALLY. */
  authorizationError: string | null;
  chain: PresentedCertificate[];
  /** True if the chain leads to a certificate authority that MDM trusts. */
  anchored: boolean;
}

const INSPECT_TIMEOUT_MS = 5000;
const CACHE_MS = 2 * 60 * 1000;
const cache = new Map<string, { at: number; result: Promise<TlsInspection | null> }>();

/** Security and filtering products that re-sign HTTPS traffic with their own root. */
const SCANNING_PRODUCTS =
  /kaspersky|eset|avast|avg\b|bitdefender|norton|symantec|mcafee|sophos|fortinet|fortigate|zscaler|palo alto|bluecoat|forcepoint|websense|cisco|umbrella|check ?point|trend micro|cyberoam|sonicwall|netskope|barracuda|watchguard|fiddler|charles proxy|mitmproxy|burp|proxifier|squid|ssl inspection|ssl proxy|web ?shield|https scanning|dr\.?web|panda|f-secure|comodo|malwarebytes/i;

function nameOf(entry: { CN?: string | string[]; O?: string | string[]; OU?: string | string[] } | undefined): string {
  if (!entry) return '';
  const pick = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] ?? '' : value ?? '');
  return pick(entry.CN) || pick(entry.O) || pick(entry.OU);
}

let trustedCache: { byFingerprint: Set<string>; bySubject: Map<string, X509Certificate[]> } | null = null;

function trustedCertificates(): NonNullable<typeof trustedCache> {
  if (trustedCache) return trustedCache;
  const byFingerprint = new Set<string>();
  const bySubject = new Map<string, X509Certificate[]>();
  for (const pem of getTrustedCAs() ?? tls.rootCertificates) {
    try {
      const certificate = new X509Certificate(pem);
      byFingerprint.add(certificate.fingerprint256);
      const list = bySubject.get(certificate.subject) ?? [];
      list.push(certificate);
      bySubject.set(certificate.subject, list);
    } catch {
      // A certificate this runtime cannot parse is simply not used for the comparison.
    }
  }
  trustedCache = { byFingerprint, bySubject };
  return trustedCache;
}

function anchorsChain(presented: X509Certificate[]): boolean {
  const trusted = trustedCertificates();
  for (const certificate of presented) {
    if (trusted.byFingerprint.has(certificate.fingerprint256)) return true;
    for (const root of trusted.bySubject.get(certificate.issuer) ?? []) {
      try {
        if (certificate.verify(root.publicKey)) return true;
      } catch {
        // Not signed by this one.
      }
    }
  }
  return false;
}

function inspect(host: string, port: number): Promise<TlsInspection | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: TlsInspection | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const isIp = /^[\d.]+$|:/.test(host);
    const socket = tls.connect(
      { host, port, servername: isIp ? undefined : host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] },
      () => {
        try {
          const chain: PresentedCertificate[] = [];
          const parsed: X509Certificate[] = [];
          const seen = new Set<string>();
          let current = socket.getPeerCertificate(true);
          while (current && current.fingerprint256 && !seen.has(current.fingerprint256) && chain.length < 6) {
            seen.add(current.fingerprint256);
            chain.push({
              subject: nameOf(current.subject),
              issuer: nameOf(current.issuer),
              validFrom: current.valid_from,
              validTo: current.valid_to,
              fingerprint256: current.fingerprint256
            });
            if (current.raw) parsed.push(new X509Certificate(current.raw));
            current = current.issuerCertificate;
          }
          const authorizationError = socket.authorizationError ? String(socket.authorizationError) : null;
          socket.destroy();
          finish({ authorizationError, chain, anchored: anchorsChain(parsed) });
        } catch {
          socket.destroy();
          finish(null);
        }
      }
    );
    socket.setTimeout(INSPECT_TIMEOUT_MS, () => {
      socket.destroy();
      finish(null);
    });
    socket.on('error', () => finish(null));
  });
}

/** Looks at what the server presents. Cached briefly, so retries and parallel segments share one look. */
export function inspectCertificateChain(host: string, port: number): Promise<TlsInspection | null> {
  const key = `${host}:${port}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  const result = inspect(host, port);
  cache.set(key, { at: Date.now(), result });
  return result;
}

/** A short reason from Node's own wording, without the code prefix. */
export function tlsReason(error: unknown): string {
  const err = error as { code?: string; message?: string } | null;
  const message = (err?.message ?? '').trim();
  return message || err?.code || 'certificate check failed';
}

export function describeTlsFailure(host: string, inspection: TlsInspection | null, now = new Date()): string {
  if (!inspection || inspection.chain.length === 0) return '';
  const [leaf, ...rest] = inspection.chain;
  if (!leaf) return '';
  const parts: string[] = [];
  const top = inspection.chain.at(-1)!;
  const issuerNote = leaf.issuer ? ` issued by "${leaf.issuer}"` : '';
  parts.push(`${host} presented a certificate for "${leaf.subject}"${issuerNote}${rest.length ? ` (chain of ${inspection.chain.length})` : ''}.`);

  const from = Date.parse(leaf.validFrom);
  const to = Date.parse(leaf.validTo);
  if (Number.isFinite(from) && now.getTime() < from) {
    parts.push(`Your computer's date (${now.toDateString()}) is before the certificate becomes valid (${leaf.validFrom}); set the clock correctly.`);
  } else if (Number.isFinite(to) && now.getTime() > to) {
    parts.push(`The certificate expired on ${leaf.validTo}; if that date looks wrong, check your computer's clock (${now.toDateString()}).`);
  } else if (!inspection.anchored) {
    const scanner = [leaf.issuer, top.issuer, top.subject].find((name) => SCANNING_PRODUCTS.test(name));
    if (scanner) {
      parts.push(`This looks like HTTPS scanning by "${scanner}": it replaces the site's certificate with its own, and Windows or MDM does not trust that issuer. Turn off HTTPS/SSL scanning for MDM in that product, or install its root certificate in Windows ("Trusted Root Certification Authorities") and restart MDM.`);
    } else {
      parts.push(`The chain ends at "${top.issuer || top.subject}", which is not a certificate authority that Windows or MDM trusts. If you did not expect this, something between you and the site (antivirus, firewall, VPN, proxy or the network) is replacing the certificate.`);
    }
  } else {
    parts.push('The chain leads to a trusted authority, so the server probably sent an incomplete chain (a missing intermediate certificate).');
  }
  return parts.join(' ');
}
