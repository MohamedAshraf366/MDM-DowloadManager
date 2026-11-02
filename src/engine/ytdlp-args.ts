/**
 * Building yt-dlp command lines.
 *
 * yt-dlp treats everything after a bare `--` as a URL. An option placed after
 * it (for example `--ffmpeg-location C:\tools\ffmpeg.exe`) is therefore
 * "extracted" as if it were a page, and fails with errors such as
 * `'--ffmpeg-location' is not a valid URL` and `Unsupported url scheme: "c"`.
 * Keeping the separator and the URL last, in one place, makes that impossible.
 */
export function withUrlLast(options: string[], url: string | null): string[] {
  if (options.includes('--')) {
    throw new Error('yt-dlp options must not contain the "--" separator; it is added with the URL.');
  }
  return url === null ? [...options] : [...options, '--', url];
}

export interface YtDlpDownloadArgsInput {
  baseArgs: string[];
  selector: string;
  mergeFormat: 'mp4' | 'webm';
  /** yt-dlp output template, e.g. `<temp>/media.%(ext)s`. */
  output: string;
  /** Saved extraction data. When set, no URL is passed. */
  infoJsonPath: string | null;
  ffmpegPath?: string;
  requestArgs: string[];
  extra: string[];
  url: string;
}

export function buildYtDlpDownloadArgs(input: YtDlpDownloadArgsInput): string[] {
  const options = [
    ...input.baseArgs,
    '--newline',
    '--progress',
    '--progress-template',
    'download:MDM_PROGRESS %(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
    '--print',
    'after_move:MDM_FILE %(filepath)s',
    '--format',
    input.selector,
    '--merge-output-format',
    input.mergeFormat,
    '--concurrent-fragments',
    '4',
    '--buffer-size',
    '1M',
    '--continue',
    '--no-mtime',
    ...(input.ffmpegPath ? ['--ffmpeg-location', input.ffmpegPath] : []),
    ...input.extra,
    ...(input.infoJsonPath ? ['--load-info-json', input.infoJsonPath] : []),
    '--output',
    input.output,
    ...input.requestArgs
  ];
  return withUrlLast(options, input.infoJsonPath ? null : input.url);
}
