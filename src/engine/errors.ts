export type DownloadErrorCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_PROTOCOL'
  | 'HTTP_ERROR'
  | 'HTTP_403'
  | 'HTTP_404'
  | 'HTTP_410'
  | 'HTTP_416'
  | 'HTTP_429'
  | 'SERVER_ERROR'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'TLS'
  | 'TLS_CHAIN'
  | 'TLS_HANDSHAKE'
  | 'PROXY'
  | 'DNS'
  | 'DISK_FULL'
  | 'DISK_ERROR'
  | 'CHECKSUM_MISMATCH'
  | 'SIZE_MISMATCH'
  | 'RANGE_UNSUPPORTED'
  | 'CONTENT_CHANGED'
  | 'ENCRYPTED_MEDIA'
  | 'DRM_PROTECTED'
  | 'UNSUPPORTED_MEDIA'
  | 'YOUTUBE_UNAVAILABLE'
  | 'TOOL_MISSING'
  | 'FILE_EXISTS'
  | 'ABORTED'
  | 'INTERNAL';

export class DownloadError extends Error {
  readonly code: DownloadErrorCode;
  readonly retryable: boolean;
  readonly statusCode: number | null;
  readonly retryAfterMs: number | null;
  /** What was found out about the cause (for example who issued a rejected certificate). */
  readonly detail: string | null;

  constructor(
    message: string,
    code: DownloadErrorCode = 'INTERNAL',
    options: {
      retryable?: boolean;
      statusCode?: number | null;
      retryAfterMs?: number | null;
      cause?: unknown;
      detail?: string | null;
    } = {}
  ) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
    this.detail = options.detail ?? null;
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export class RangeUnsupportedError extends DownloadError {
  constructor(message = 'The server ignored a Range request') {
    super(message, 'RANGE_UNSUPPORTED', { retryable: false });
    this.name = 'RangeUnsupportedError';
  }
}

export class AbortDownloadError extends DownloadError {
  constructor(message = 'Download aborted') {
    super(message, 'ABORTED', { retryable: false });
    this.name = 'AbortDownloadError';
  }
}

export function friendlyErrorMessage(error: unknown): string {
  if (error instanceof DownloadError) {
    switch (error.code) {
      case 'HTTP_403':
        return 'Access denied (HTTP 403). The link may have expired or require a fresh sign-in.';
      case 'HTTP_404':
        return 'The file was not found (HTTP 404).';
      case 'HTTP_410':
        return 'The download link has expired (HTTP 410).';
      case 'HTTP_429':
        return 'The server is rate-limiting requests (HTTP 429). Retry later.';
      case 'SERVER_ERROR':
        return `The server returned an error (${error.statusCode ?? '5xx'}). It may be temporary.`;
      case 'TIMEOUT':
        return 'The connection timed out. Check your network or proxy settings.';
      case 'NETWORK':
        return 'The network connection was interrupted. Retry to resume.';
      case 'TLS':
        return 'The secure connection could not be verified (the server certificate is invalid, self-signed, or missing a certificate chain). For trusted but misconfigured servers, enable Allow invalid TLS certificates in the download settings.';
      case 'TLS_CHAIN': {
        const reason = error.message.replace(/^TLS certificate chain failed:\s*/i, '').trim();
        const found = error.detail
          ? `The server certificate chain could not be verified (${reason}). ${error.detail} If you trust this connection, enable Allow invalid TLS certificates for this download only.`
          : `The server certificate chain could not be verified${reason ? ` (${reason})` : ''}.`;
        if (error.detail) return found;
        return found + ' Common causes: antivirus, firewall or proxy software that re-signs HTTPS traffic (its root certificate must be installed in the operating system, then restart MDM), a server that sends an incomplete chain, or a wrong system clock. It can also be temporary on CDN edges, so retry once. If it persists, allow MDM in your security software, or enable Allow invalid TLS certificates for this download only if you trust the server.';
      }
      case 'TLS_HANDSHAKE':
        return 'The secure connection could not be established (TLS handshake failed). This is often temporary; retry the download.';
      case 'PROXY':
        return 'The configured proxy could not be reached or rejected the request.';
      case 'DNS':
        return 'The server address could not be resolved.';
      case 'DISK_FULL':
        return error.message && error.message !== 'The disk is full.'
          ? `${error.message} Choose another download folder or free up space, then retry.`
          : 'Not enough disk space. Choose another download folder or free up space, then retry.';
      case 'DISK_ERROR':
        return 'The file could not be written. Check permissions and disk health.';
      case 'CHECKSUM_MISMATCH':
        return 'Integrity verification failed: the downloaded checksum does not match.';
      case 'SIZE_MISMATCH':
        return 'The downloaded file size does not match the size reported by the server.';
      case 'RANGE_UNSUPPORTED':
        return 'The server does not support resumable downloads.';
      case 'CONTENT_CHANGED':
        return 'The file changed on the server. The download was restarted safely.';
      case 'ENCRYPTED_MEDIA':
        return 'This media stream is encrypted. MDM does not bypass encryption or DRM.';
      case 'DRM_PROTECTED':
        return 'This media is DRM-protected and cannot be downloaded.';
      case 'UNSUPPORTED_MEDIA':
        return 'This media manifest is not supported.';
      case 'YOUTUBE_UNAVAILABLE':
        return error.message || 'The site could not provide a downloadable format for this video.';
      case 'TOOL_MISSING':
        return error.message || 'A required media tool is missing. Reinstall MDM or add the tool to PATH.';
      case 'FILE_EXISTS':
        return 'A file with this name already exists.';
      case 'ABORTED':
        return 'The download was stopped.';
      default:
        return error.message;
    }
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof DownloadError) {
    if (error.code === 'ABORTED') return false;
    if (error.retryable) return true;
    return false;
  }
  const err = error as NodeJS.ErrnoException;
  const code = err?.code ?? '';
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET'].includes(
    code
  );
}

export function mapNetworkError(error: unknown, contextUrl?: string): DownloadError {
  if (error instanceof DownloadError) return error;
  const err = error as NodeJS.ErrnoException & { address?: string };
  const code = err?.code ?? '';
  const message = err?.message ?? String(error);
  const detail = (err as { mdmTlsDetail?: string } | null)?.mdmTlsDetail ?? null;
  const chainError =
    /SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_UNTRUSTED|CERT_REJECTED/i.test(
      `${code} ${message}`
    );
  if (chainError) {
    return new DownloadError(`TLS certificate chain failed: ${message}`, 'TLS_CHAIN', {
      retryable: true,
      cause: error,
      detail
    });
  }
  const certError =
    /certificate|CERT_|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO|altname|self[- ]signed|unable to verify/i.test(
      `${code} ${message}`
    );
  if (certError) {
    return new DownloadError(`TLS verification failed: ${message}`, 'TLS', { retryable: false, cause: error, detail });
  }
  const tlsHandshake = /TLS|SSL routines|EPROTO|handshake|tlsv1 alert/i.test(`${code} ${message}`);
  if (tlsHandshake) {
    return new DownloadError(`TLS handshake failed: ${message}`, 'TLS_HANDSHAKE', { retryable: true, cause: error });
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new DownloadError(`Host not found${contextUrl ? `: ${contextUrl}` : ''}`, 'DNS', { retryable: true, cause: error });
  }
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED') {
    return new DownloadError('The connection was reset by the server.', 'NETWORK', { retryable: true, cause: error });
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return new DownloadError('The connection timed out.', 'TIMEOUT', { retryable: true, cause: error });
  }
  if (code === 'ECONNREFUSED') {
    return new DownloadError('The connection was refused.', 'NETWORK', { retryable: true, cause: error });
  }
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return new DownloadError('The disk is full.', 'DISK_FULL', { retryable: false, cause: error });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new DownloadError('Permission denied while accessing the destination.', 'DISK_ERROR', { retryable: false, cause: error });
  }
  if (/proxy/i.test(message)) {
    return new DownloadError(`Proxy connection failed: ${message}`, 'PROXY', { retryable: false, cause: error });
  }
  return new DownloadError(message || 'A network error occurred.', 'NETWORK', { retryable: true, cause: error });
}
