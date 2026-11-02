import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildYtDlpDownloadArgs, withUrlLast } from '../src/engine/ytdlp-args';
import { ytDlpFailure } from '../src/engine/youtube';

const URL_UNDER_TEST = 'https://media.example/watch?v=1';
const FFMPEG = 'C:\\Program Files\\MDM\\resources\\tools\\ffmpeg.exe';

function input(overrides: Partial<Parameters<typeof buildYtDlpDownloadArgs>[0]> = {}) {
  return {
    baseArgs: ['--no-playlist', '--no-warnings'],
    selector: 'bv*+ba/b',
    mergeFormat: 'mp4' as const,
    output: 'C:\\temp\\media.%(ext)s',
    infoJsonPath: null,
    ffmpegPath: FFMPEG,
    requestArgs: ['--cookies', 'C:\\temp\\cookies.txt', '--user-agent', 'UA'],
    extra: ['--force-generic-extractor'],
    url: URL_UNDER_TEST,
    ...overrides
  };
}

describe('yt-dlp argument order', () => {
  it('puts every option before the separator and the URL last', () => {
    const args = buildYtDlpDownloadArgs(input());
    const separator = args.indexOf('--');
    expect(separator).toBe(args.length - 2);
    expect(args.at(-1)).toBe(URL_UNDER_TEST);
    // The bug: --ffmpeg-location and its path used to land after "--" and were read as URLs.
    expect(args.indexOf('--ffmpeg-location')).toBeLessThan(separator);
    expect(args[args.indexOf('--ffmpeg-location') + 1]).toBe(FFMPEG);
    expect(args.slice(separator + 1)).toEqual([URL_UNDER_TEST]);
  });

  it('passes no URL when saved extraction data is used, and still keeps ffmpeg', () => {
    const args = buildYtDlpDownloadArgs(input({ infoJsonPath: 'C:\\temp\\mdm-info.json' }));
    expect(args).not.toContain('--');
    expect(args).not.toContain(URL_UNDER_TEST);
    expect(args).toContain('--load-info-json');
    expect(args).toContain('--ffmpeg-location');
  });

  it('omits --ffmpeg-location when there is no ffmpeg path', () => {
    expect(buildYtDlpDownloadArgs(input({ ffmpegPath: undefined }))).not.toContain('--ffmpeg-location');
  });

  it('refuses to build a command line that already contains the separator', () => {
    expect(() => withUrlLast(['--no-playlist', '--', 'oops'], URL_UNDER_TEST)).toThrow(/separator/);
  });

  const ytDlp = spawnSync('yt-dlp', ['--version'], { encoding: 'utf8' });
  it.skipIf(ytDlp.status !== 0)('is accepted by the real yt-dlp, which never mistakes an option for a URL', () => {
    for (const infoJsonPath of [null]) {
      const args = buildYtDlpDownloadArgs(
        input({ infoJsonPath, requestArgs: [], extra: ['--simulate'], url: 'https://mdm-test.invalid/video' })
      );
      const run = spawnSync('yt-dlp', ['--ignore-config', ...args], { encoding: 'utf8', timeout: 60_000 });
      const output = `${run.stderr}${run.stdout}`;
      expect(output).not.toMatch(/is not a valid URL/);
      expect(output).not.toMatch(/Unsupported url scheme/);
      expect(output).not.toMatch(/Extracting URL: --/);
    }
  });
});

describe('yt-dlp failures are not blamed on ffmpeg unless ffmpeg is really the problem', () => {
  it('does not call a bad argument "FFmpeg is required"', () => {
    const failure = ytDlpFailure(
      "ERROR: [generic] '--ffmpeg-location' is not a valid URL\nERROR: Unable to handle request: Unsupported url scheme: \"c\""
    );
    expect(failure.code).not.toBe('TOOL_MISSING');
    expect(failure.message).not.toMatch(/FFmpeg is required/);
  });

  it.each([
    'ERROR: Postprocessing: ffprobe and ffmpeg not found. Please install or provide the path using --ffmpeg-location',
    'ERROR: You have requested merging of multiple formats but ffmpeg is not installed.',
    'ERROR: ffmpeg not found. Please install or provide the path using --ffmpeg-location',
    'WARNING: ffmpeg-location C:\\x\\ffmpeg.exe does not exist! Continuing without ffmpeg'
  ])('still reports a missing ffmpeg: %s', (stderr) => {
    const failure = ytDlpFailure(stderr);
    expect(failure.code).toBe('TOOL_MISSING');
    expect(failure.message).toMatch(/FFmpeg is required/);
  });
});
