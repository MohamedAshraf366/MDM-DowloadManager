import { useEffect, useMemo, useState } from 'react';
import type {
  AddDownloadRequest,
  ChecksumAlgorithm,
  DownloadPriority,
  MediaFormat,
  MediaProbeResult
} from '../../shared/types';
import { formatSpeed, parseByteSize } from '../../shared/format';
import { useApp } from '../app/store';
import { Button, Field, InlineNote, Modal, Segmented, Select, TextArea, TextInput, Toggle } from './Ui';
import { Icon } from './Icons';

type StartMode = 'now' | 'paused' | 'scheduled';

export function AddDownloadDialog() {
  const { snapshot, addDialogOpen, closeAddDialog, notify, focusDownload, appInfo } = useApp();
  const [url, setUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [destination, setDestination] = useState('');
  const [queueId, setQueueId] = useState('default');
  const [priority, setPriority] = useState<DownloadPriority>('normal');
  const [speedLimit, setSpeedLimit] = useState('');
  const [startMode, setStartMode] = useState<StartMode>('now');
  const [scheduledAt, setScheduledAt] = useState('');
  const [checksumAlgorithm, setChecksumAlgorithm] = useState<ChecksumAlgorithm | ''>('');
  const [checksum, setChecksum] = useState('');
  const [autoOpen, setAutoOpen] = useState(false);
  const [autoDelete, setAutoDelete] = useState(false);
  const [referrer, setReferrer] = useState('');
  const [sourcePageUrl, setSourcePageUrl] = useState('');
  const [headers, setHeaders] = useState('');
  const [cookies, setCookies] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [tlsAllowInsecure, setTlsAllowInsecure] = useState(false);
  const [turboMode, setTurboMode] = useState(true);
  const [connections, setConnections] = useState(32);
  const [repeatCount, setRepeatCount] = useState(1);
  const [probe, setProbe] = useState<MediaProbeResult | null>(null);
  const [selectedFormatId, setSelectedFormatId] = useState('');
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const settings = snapshot?.settings;
  const mediaSuggestion = /\.(m3u8|mpd)(?:$|[?#])/i.test(url.trim());
  const selectedFormat = useMemo(
    () => probe?.formats.find((format) => format.id === selectedFormatId) ?? null,
    [probe, selectedFormatId]
  );

  useEffect(() => {
    if (!addDialogOpen) return;
    setUrl('');
    setFileName('');
    setDestination('');
    setQueueId('default');
    setPriority('normal');
    setSpeedLimit(settings?.defaultSpeedLimitBps ? String(Math.round(settings.defaultSpeedLimitBps / 1024)) : '');
    setStartMode('now');
    setScheduledAt('');
    setChecksumAlgorithm(settings?.checksumAlgorithm ?? '');
    setChecksum('');
    setAutoOpen(false);
    setAutoDelete(false);
    setReferrer('');
    setSourcePageUrl('');
    setHeaders('');
    setCookies('');
    setAdvanced(false);
    setTlsAllowInsecure(false);
    setTurboMode(settings?.turboMode ?? true);
    setConnections(32);
    setRepeatCount(1);
    setProbe(null);
    setSelectedFormatId('');
    setProbing(false);
    setSaving(false);
    setError('');
  }, [addDialogOpen, settings?.defaultSpeedLimitBps, settings?.checksumAlgorithm, settings?.turboMode]);

  useEffect(() => {
    if (!addDialogOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === 'Enter') {
        event.preventDefault();
        void submit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const detectMedia = async () => {
    setError('');
    if (!isHttpUrl(url)) {
      setError('Enter a valid HTTP or HTTPS media URL first.');
      return;
    }
    setProbing(true);
    try {
      const result = await window.mdm.probeMedia(url.trim(), parseHeaders(headers), cookies);
      if (!result.ok || !result.data) throw new Error(result.error ?? 'No media streams were found.');
      const data = result.data;
      if (data.protected && data.formats.every((format) => format.protected)) {
        throw new Error('This stream is protected and cannot be downloaded.');
      }
      const available = data.formats.filter((format) => !format.protected);
      if (!available.length) throw new Error(data.error || 'No downloadable media formats were found.');
      const best = pickBestFormat(available);
      setProbe(data);
      setSelectedFormatId(best?.id ?? '');
      if (!fileName && data.suggestedFileName) setFileName(data.suggestedFileName);
      notify('success', 'Media stream detected', `${available.length} format${available.length === 1 ? '' : 's'} available.`);
    } catch (probeError) {
      setProbe(null);
      setSelectedFormatId('');
      setError((probeError as Error).message);
    } finally {
      setProbing(false);
    }
  };

  const chooseFolder = async () => {
    const result = await window.mdm.chooseFolder(destination || appInfo?.downloadsPath);
    if (result.ok && result.data) setDestination(result.data);
    else if (!result.ok) notify('error', 'Could not choose folder', result.error);
  };

  const submit = async () => {
    if (saving) return;
    setError('');
    const trimmedUrl = url.trim();
    if (!isHttpUrl(trimmedUrl)) {
      setError('Enter a complete HTTP, HTTPS, or FTP link.');
      return;
    }
    let scheduledIso: string | null = null;
    if (startMode === 'scheduled') {
      if (!scheduledAt) {
        setError('Choose a date and time for the scheduled download.');
        return;
      }
      const date = new Date(scheduledAt);
      if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
        setError('Choose a time in the future.');
        return;
      }
      scheduledIso = date.toISOString();
    }
    setSaving(true);
    try {
      const parsedHeaders = parseHeaders(headers);
      const request: AddDownloadRequest = {
        url: trimmedUrl,
        queueId,
        priority,
        speedLimitBps: speedLimit.trim() ? Math.max(0, parseByteSize(`${speedLimit} KB`) ?? 0) : 0,
        startNow: startMode !== 'paused',
        scheduledAt: scheduledIso,
        autoOpen,
        autoDelete,
        turboMode,
        connections,
        repeatCount,
        referrer: referrer.trim(),
        sourcePageUrl: sourcePageUrl.trim(),
        cookies,
        headers: Object.keys(parsedHeaders).length ? parsedHeaders : undefined,
        checksumAlgorithm,
        checksum: checksumAlgorithm ? checksum.trim() : '',
        tlsAllowInsecure
      };
      if (fileName.trim()) request.fileName = fileName.trim();
      if (destination.trim()) request.destinationDir = destination.trim();
      if (selectedFormat) request.mediaFormatId = selectedFormat.id;

      const response = await window.mdm.addDownload(request);
      if (!response.ok) throw new Error(response.error ?? 'The download could not be started.');
      const result = response.data ?? null;
      if (result?.duplicateOf) {
        notify('info', 'Already in your queue', 'MDM found an active download for this link.');
      } else if (result && startMode !== 'now') {
        notify(
          'success',
          startMode === 'paused' ? 'Download added' : 'Download scheduled',
          fileName.trim() || selectedFormat?.label || 'The transfer was added to the queue.'
        );
      }
      if (result) {
        closeAddDialog();
        focusDownload(result.duplicateOf ?? result.id);
      }
    } catch (submitError) {
      const reason = (submitError as Error).message;
      setError(reason);
      notify('error', 'Download failed to start', reason, {
        dedupeKey: `download-start-failed:${reason}`,
        actions: [{ kind: 'open-logs', label: 'View logs' }]
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={addDialogOpen}
      onClose={closeAddDialog}
      title="New download"
      subtitle="Paste a direct link or inspect an HLS/DASH stream before downloading."
      width={760}
      className="add-download-modal"
      footer={
        <>
          <span className="modal-shortcut">
            <kbd>Ctrl</kbd> + <kbd>Enter</kbd>
          </span>
          <Button onClick={closeAddDialog}>Cancel</Button>
          <Button variant="primary" icon="download" loading={saving} onClick={() => void submit()}>
            {startMode === 'paused' ? 'Add paused' : startMode === 'scheduled' ? 'Schedule download' : 'Start download'}
          </Button>
        </>
      }
    >
      <div className="add-form">
        <Field
          label="Download address"
          hint={mediaSuggestion && !probe ? 'A media manifest was detected. Select Detect media to choose a quality.' : undefined}
        >
          <div className="url-row">
            <div className="url-input-wrap">
              <Icon name="link" size={17} />
              <TextInput
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setProbe(null);
                  setSelectedFormatId('');
                }}
                placeholder="https://example.com/file.zip"
                autoFocus
                spellCheck={false}
              />
            </div>
            <Button icon="search" loading={probing} onClick={() => void detectMedia()}>
              Detect media
            </Button>
          </div>
        </Field>

        {probe && selectedFormat ? (
          <div className="media-panel">
            <div className="media-panel-head">
              <div>
                <strong>{probe.title || 'Authorized media stream'}</strong>
                <span>
                  {probe.kind.toUpperCase()} · {probe.formats.filter((format) => !format.protected).length} formats
                  {probe.durationSeconds ? ` · ${formatDuration(probe.durationSeconds)}` : ''}
                </span>
              </div>
              <span className="media-badge">VOD</span>
            </div>
            <div className="media-formats">
              {probe.formats.map((format) => (
                <label
                  key={format.id}
                  className={`media-format ${selectedFormatId === format.id ? 'is-selected' : ''} ${format.protected ? 'is-disabled' : ''}`.trim()}
                >
                  <input
                    type="radio"
                    name="media-format"
                    value={format.id}
                    checked={selectedFormatId === format.id}
                    disabled={format.protected}
                    onChange={() => setSelectedFormatId(format.id)}
                  />
                  <span className="radio-mark" />
                  <span className="media-format-copy">
                    <strong>{format.label}</strong>
                    <span>
                      {[format.resolution, format.codecs, format.language].filter(Boolean).join(' · ') || 'Media stream'}
                    </span>
                  </span>
                  <span className="media-format-meta">
                    {format.protected ? 'Protected' : format.bandwidth ? formatSpeed(format.bandwidth / 8) : format.type.toUpperCase()}
                  </span>
                </label>
              ))}
            </div>
            <InlineNote tone="info">
              Download only media you own or have permission to save. DRM-protected streams are never bypassed.
            </InlineNote>
          </div>
        ) : null}

        <div className="form-grid">
          <Field label="File name" hint="Leave blank to use the server-provided name.">
            <TextInput
              value={fileName}
              onChange={(event) => setFileName(event.target.value)}
              placeholder={selectedFormat ? 'video.mp4' : 'Automatic'}
            />
          </Field>
          <Field label="Save to" hint="Leave blank to sort into category folders.">
            <div className="input-row">
              <TextInput
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
                placeholder={appInfo?.downloadsPath ?? settings?.defaultDownloadDir ?? 'Downloads'}
              />
              <Button icon="folder" onClick={() => void chooseFolder()}>
                Browse
              </Button>
            </div>
          </Field>
          <Field label="Queue">
            <Select value={queueId} onChange={(event) => setQueueId(event.target.value)}>
              {snapshot?.queues.map((queue) => (
                <option key={queue.id} value={queue.id}>
                  {queue.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={priority} onChange={(event) => setPriority(event.target.value as DownloadPriority)}>
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </Select>
          </Field>
          <Field label="Speed limit" hint="KB/s. Leave blank for unlimited.">
            <TextInput
              type="number"
              min={0}
              placeholder="Unlimited"
              value={speedLimit}
              onChange={(event) => setSpeedLimit(event.target.value)}
            />
          </Field>
        </div>

        <div className="start-row">
          <span className="field-label">When to start</span>
          <Segmented
            value={startMode}
            onChange={setStartMode}
            options={[
              { value: 'now', label: 'Now', icon: 'zap' },
              { value: 'paused', label: 'Paused', icon: 'pause' },
              { value: 'scheduled', label: 'Schedule', icon: 'calendar' }
            ]}
          />
          {startMode === 'scheduled' ? (
            <TextInput
              type="datetime-local"
              className="schedule-input"
              value={scheduledAt}
              onChange={(event) => setScheduledAt(event.target.value)}
            />
          ) : null}
        </div>

        <div className="advanced-toggle">
          <button type="button" className="text-button" onClick={() => setAdvanced((value) => !value)}>
            {advanced ? 'Hide advanced options' : 'Advanced options'}
            <Icon name={advanced ? 'chevron-down' : 'chevron-right'} size={13} />
          </button>
        </div>

        {advanced ? (
          <div className="advanced-panel">
            <div className="form-grid">
              <Field label="Checksum algorithm">
                <Select
                  value={checksumAlgorithm}
                  onChange={(event) => setChecksumAlgorithm(event.target.value as ChecksumAlgorithm | '')}
                >
                  <option value="">None</option>
                  <option value="sha256">SHA-256</option>
                  <option value="sha1">SHA-1</option>
                  <option value="md5">MD5</option>
                </Select>
              </Field>
              <Field label="Expected checksum">
                <TextInput
                  value={checksum}
                  onChange={(event) => setChecksum(event.target.value)}
                  placeholder="Hex digest"
                  disabled={!checksumAlgorithm}
                />
              </Field>
              <Field label="Referrer">
                <TextInput value={referrer} onChange={(event) => setReferrer(event.target.value)} placeholder="https://…" />
              </Field>
              <Field label="Source page">
                <TextInput
                  value={sourcePageUrl}
                  onChange={(event) => setSourcePageUrl(event.target.value)}
                  placeholder="https://…"
                />
              </Field>
              <Field label="Cookies" className="span-2">
                <TextInput value={cookies} onChange={(event) => setCookies(event.target.value)} placeholder="name=value; …" />
              </Field>
              <Field
                label="Request headers"
                className="span-2"
                hint="One Name: value pair per line. Credentials are stored encrypted."
              >
                <TextArea
                  rows={3}
                  value={headers}
                  onChange={(event) => setHeaders(event.target.value)}
                  placeholder={'Authorization: Bearer …\nAccept-Language: en-US'}
                />
              </Field>
            </div>
            <div className="setting-row">
              <div>
                <strong>Open when complete</strong>
                <p>Executables and scripts are never opened automatically.</p>
              </div>
              <Toggle checked={autoOpen} onChange={setAutoOpen} label="Open when complete" />
            </div>
            <div className="setting-row">
              <div>
                <strong>Auto delete after download</strong>
                <p>Permanently deletes the downloaded file when it finishes (like Shift+Delete, bypassing the Recycle Bin).</p>
              </div>
              <Toggle checked={autoDelete} onChange={setAutoDelete} label="Auto delete after download" />
            </div>
            <div className="setting-row">
              <div>
                <strong>Allow invalid TLS certificates</strong>
                <p>
                  For servers with self-signed, expired, or incomplete certificate chains. Only enable this for sources
                  you trust — the connection is then not verified.
                </p>
              </div>
              <Toggle checked={tlsAllowInsecure} onChange={setTlsAllowInsecure} label="Allow invalid TLS certificates" />
            </div>
            <div className="setting-row">
              <div>
                <strong>Most connections</strong>
                <p>2–64. More connections can improve multi-part server speed.</p>
              </div>
              <div style={{ width: 80 }}>
                <TextInput
                  type="number"
                  min={2}
                  max={64}
                  value={String(connections)}
                  onChange={(event) => setConnections(Math.max(2, Math.min(64, Number(event.target.value) || 32)))}
                />
              </div>
            </div>
            <div className="setting-row">
              <div>
                <strong>Repeat count</strong>
                <p>Download the file N times in sequence. 1 = once.</p>
              </div>
              <div style={{ width: 80 }}>
                <TextInput
                  type="number"
                  min={1}
                  max={9999}
                  value={String(repeatCount)}
                  onChange={(event) => setRepeatCount(Math.max(1, Math.min(9999, Number(event.target.value) || 1)))}
                />
              </div>
            </div>
            <div className="setting-row">
              <div>
                <strong>Turbo mode</strong>
                <p>
                  Automatically increase connections during download until throughput stops rising. Default: ON.
                </p>
              </div>
              <Toggle checked={turboMode} onChange={setTurboMode} label="Turbo mode" />
            </div>
          </div>
        ) : null}

        {error ? <InlineNote tone="danger">{error}</InlineNote> : null}
      </div>
    </Modal>
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'ftp:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function parseHeaders(value: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of value.split('\n')) {
    if (!line.trim()) continue;
    const separator = line.indexOf(':');
    if (separator < 1) throw new Error(`Header "${line}" is missing a colon.`);
    const name = line.slice(0, separator).trim();
    const content = line.slice(separator + 1).trim();
    if (!name) continue;
    headers[name] = content;
  }
  return headers;
}

function pickBestFormat(formats: MediaFormat[]): MediaFormat | undefined {
  return formats
    .slice()
    .sort((a, b) => {
      const aVideo = a.mimeType.startsWith('video/') ? 1 : 0;
      const bVideo = b.mimeType.startsWith('video/') ? 1 : 0;
      return bVideo - aVideo || b.bandwidth - a.bandwidth;
    })[0];
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  return `${minutes}:${String(remaining).padStart(2, '0')}`;
}
