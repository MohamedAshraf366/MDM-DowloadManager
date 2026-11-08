import { useEffect, useRef, useState } from 'react';
import type { AppSettings, FileCategory, ProxySettings, SpeedUnit, ThemeMode } from '../../shared/types';
import { useApp } from '../app/store';
import { downloadTextFile, readTextFile } from '../lib/files';
import {
  Button,
  Card,
  ConfirmDialog,
  Field,
  InlineNote,
  PageHeader,
  Segmented,
  Select,
  Tabs,
  TextInput,
  Toggle
} from '../components/Ui';
import { Icon, type IconName } from '../components/Icons';

type SettingsTab = 'general' | 'transfers' | 'network' | 'behavior' | 'advanced';

const CATEGORY_FIELDS: Array<{ key: FileCategory; label: string; icon: IconName }> = [
  { key: 'video', label: 'Video', icon: 'video' },
  { key: 'audio', label: 'Music', icon: 'audio' },
  { key: 'documents', label: 'Documents', icon: 'document' },
  { key: 'archives', label: 'Archives', icon: 'archive' },
  { key: 'images', label: 'Images', icon: 'image' },
  { key: 'programs', label: 'Programs', icon: 'program' },
  { key: 'other', label: 'Other', icon: 'file' }
];

export function SettingsPage() {
  const { snapshot, appInfo, call, notify } = useApp();
  const settings = snapshot?.settings;
  const [draft, setDraft] = useState<AppSettings | null>(settings ? structuredClone(settings) : null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<SettingsTab>('general');
  const [saving, setSaving] = useState(false);
  const [proxyPassword, setProxyPassword] = useState('');
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const dirtyRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (settings && !dirtyRef.current) {
      setDraft(structuredClone(settings));
    }
  }, [settings]);

  if (!draft) return null;

  const markDirty = () => {
    dirtyRef.current = true;
    setDirty(true);
  };

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    markDirty();
  };

  const updateProxy = (patch: Partial<ProxySettings>) => {
    setDraft((current) => (current ? { ...current, proxy: { ...current.proxy, ...patch } } : current));
    markDirty();
  };

  const updateCategoryFolder = (category: FileCategory, value: string) => {
    setDraft((current) =>
      current ? { ...current, categoryFolders: { ...current.categoryFolders, [category]: value } } : current
    );
    markDirty();
  };

  const chooseDefaultFolder = async () => {
    const result = await window.mdm.chooseFolder(draft.defaultDownloadDir);
    if (result.ok && result.data) update('defaultDownloadDir', result.data);
  };

  const save = async () => {
    setSaving(true);
    const result = await call(
      window.mdm.updateSettings({
        patch: draft,
        proxyPassword: passwordTouched ? proxyPassword : undefined
      }),
      'Settings saved'
    );
    setSaving(false);
    if (result) {
      setDraft(structuredClone(result));
      dirtyRef.current = false;
      setDirty(false);
      setPasswordTouched(false);
      setProxyPassword('');
    }
  };

  const discard = () => {
    if (!settings) return;
    setDraft(structuredClone(settings));
    dirtyRef.current = false;
    setDirty(false);
    setPasswordTouched(false);
    setProxyPassword('');
  };

  const resetAll = async () => {
    setResetOpen(false);
    const result = await call(window.mdm.resetSettings(), 'Settings reset to defaults');
    if (result) {
      setDraft(structuredClone(result));
      dirtyRef.current = false;
      setDirty(false);
      setPasswordTouched(false);
      setProxyPassword('');
    }
  };

  const exportSettings = async () => {
    const result = await window.mdm.exportSettings();
    if (!result.ok || !result.data) {
      notify('error', 'Could not export settings', result.error);
      return;
    }
    downloadTextFile(`mdm-settings-${new Date().toISOString().slice(0, 10)}.json`, result.data);
    notify('success', 'Settings exported');
  };

  const importSettings = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    try {
      const text = await readTextFile(file);
      const result = await call(window.mdm.importSettings(text), 'Settings imported');
      if (result) {
        setDraft(structuredClone(result));
        dirtyRef.current = false;
        setDirty(false);
      }
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const testProxy = async () => {
    if (dirty) {
      notify('info', 'Save first', 'Save your proxy settings before testing the connection.');
      return;
    }
    const result = await window.mdm.testProxy();
    if (result.ok && result.data?.ok) {
      notify('success', 'Proxy reachable', result.data.message);
    } else {
      notify('error', 'Proxy test failed', result.data?.message ?? result.error ?? 'No response from the proxy.');
    }
  };

  return (
    <div className="page settings-page">
      <PageHeader
        eyebrow="Preferences"
        title="Settings"
        description="Tune transfers, storage, networking, and how MDM behaves on this computer."
        actions={
          <Button variant="primary" icon="check" disabled={!dirty} loading={saving} onClick={() => void save()}>
            Save changes
          </Button>
        }
      />

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'general', label: 'General' },
          { value: 'transfers', label: 'Transfers' },
          { value: 'network', label: 'Network' },
          { value: 'behavior', label: 'Behavior' },
          { value: 'advanced', label: 'Advanced' }
        ]}
      />

      {tab === 'general' ? (
        <div className="settings-stack">
          <Card title="Appearance" subtitle="MDM respects your system theme by default.">
            <div className="setting-row">
              <div>
                <strong>Theme</strong>
                <p>Choose a light or dark workspace, or follow Windows.</p>
              </div>
              <Segmented<ThemeMode>
                value={draft.theme}
                onChange={(value) => update('theme', value)}
                options={[
                  { value: 'light', label: 'Light', icon: 'sun' },
                  { value: 'dark', label: 'Dark', icon: 'moon' },
                  { value: 'system', label: 'System', icon: 'monitor' }
                ]}
              />
            </div>
            <div className="setting-row">
              <div>
                <strong>Show speeds in</strong>
                <p>Mbit/s matches what a speed test or your internet plan quotes. MB/s is the file-size style (1 MB/s is 8 Mbit/s).</p>
              </div>
              <Segmented<SpeedUnit>
                value={draft.speedUnit}
                onChange={(value) => update('speedUnit', value)}
                options={[
                  { value: 'bytes', label: 'MB/s' },
                  { value: 'bits', label: 'Mbit/s' }
                ]}
              />
            </div>
            <div className="setting-row is-last">
              <div>
                <strong>Taskbar progress</strong>
                <p>Show total download progress on the Windows taskbar button.</p>
              </div>
              <Toggle
                checked={draft.showProgressInTaskbar}
                onChange={(value) => update('showProgressInTaskbar', value)}
                label="Show taskbar progress"
              />
            </div>
          </Card>

          <Card title="Storage" subtitle="New downloads are sorted into category folders.">
            <div className="setting-row">
              <div>
                <strong>Download folder</strong>
                <p className="path-value">{draft.defaultDownloadDir}</p>
              </div>
              <Button icon="folder" onClick={() => void chooseDefaultFolder()}>
                Change
              </Button>
            </div>
            <div className="setting-row">
              <div>
                <strong>Sort by file type</strong>
                <p>Create category subfolders automatically inside the download folder.</p>
              </div>
              <Toggle
                checked={draft.categorizeByType}
                onChange={(value) => update('categorizeByType', value)}
                label="Categorize downloads"
              />
            </div>
            {draft.categorizeByType ? (
              <div className="category-folder-grid">
                {CATEGORY_FIELDS.map((field) => (
                  <label key={field.key} className="category-folder">
                    <span className="category-folder-icon">
                      <Icon name={field.icon} size={15} />
                    </span>
                    <span>
                      <small>{field.label}</small>
                      <TextInput
                        value={draft.categoryFolders[field.key]}
                        onChange={(event) => updateCategoryFolder(field.key, event.target.value)}
                        aria-label={`${field.label} folder name`}
                      />
                    </span>
                  </label>
                ))}
              </div>
            ) : null}
            <InlineNote tone="info">
              Folder names are relative to the download folder. Category rules can override these locations for
              individual file types or sites.
            </InlineNote>
          </Card>

          <Card title="Browser bridge" subtitle="Connect the MDM browser extension.">
            <div className="setting-row">
              <div>
                <strong>Browser integration</strong>
                <p>{draft.browserIntegrationEnabled ? 'Listening for extension requests.' : 'Disabled.'}</p>
              </div>
              <Toggle
                checked={draft.browserIntegrationEnabled}
                onChange={(value) => update('browserIntegrationEnabled', value)}
                label="Enable browser integration"
              />
            </div>
            <div className="setting-row is-last">
              <div>
                <strong>Local bridge port</strong>
                <p>Change this only if another local service already uses the port.</p>
              </div>
              <TextInput
                className="compact-input"
                type="number"
                min={1024}
                max={65535}
                value={draft.bridgePort}
                onChange={(event) => update('bridgePort', Number(event.target.value))}
              />
            </div>
            <InlineNote tone="info">
              The extension pairs automatically while integration is enabled; no token copy is needed.
            </InlineNote>
          </Card>
        </div>
      ) : null}

      {tab === 'transfers' ? (
        <div className="settings-stack">
          <Card title="Performance" subtitle="More connections can improve speed, but use more bandwidth.">
            <div className="settings-number-grid">
              <Field label="Connections for every download" hint="1–64, including browser captures">
                <TextInput
                  type="number"
                  min={1}
                  max={64}
                  value={draft.defaultConnections}
                  onChange={(event) => update('defaultConnections', Number(event.target.value))}
                />
              </Field>
              <Field label="Concurrent downloads" hint="1–20">
                <TextInput
                  type="number"
                  min={1}
                  max={20}
                  value={draft.maxConcurrentDownloads}
                  onChange={(event) => update('maxConcurrentDownloads', Number(event.target.value))}
                />
              </Field>
              <Field label="Connections per host" hint="1–64">
                <TextInput
                  type="number"
                  min={1}
                  max={64}
                  value={draft.maxConnectionsPerHost}
                  onChange={(event) => update('maxConnectionsPerHost', Number(event.target.value))}
                />
              </Field>
              <ByteLimitField
                label="Global speed limit"
                value={draft.globalSpeedLimitBps}
                onChange={(value) => update('globalSpeedLimitBps', value)}
              />
              <ByteLimitField
                label="Default per-download limit"
                value={draft.defaultSpeedLimitBps}
                onChange={(value) => update('defaultSpeedLimitBps', value)}
              />
            </div>
            <ToggleRow
              title="Turbo mode"
              description="While a download runs, keep adding connections until the speed stops rising, so it uses all the bandwidth available. Extra connections are released when the download ends. Ignored when a speed limit is set."
              checked={draft.turboMode}
              onChange={(value) => update('turboMode', value)}
              last={!draft.turboMode}
            />
            {draft.turboMode ? (
              <div className="settings-number-grid">
                <Field label="Turbo: most connections per download" hint="2–64. Some servers block high counts.">
                  <TextInput
                    type="number"
                    min={2}
                    max={64}
                    value={draft.turboMaxConnections}
                    onChange={(event) => update('turboMaxConnections', Number(event.target.value))}
                  />
                </Field>
                <Field
                  label="Starting point: speed test result (Mbit/s)"
                  hint="Optional, leave 0. MDM learns what each network delivers by itself. A number here only helps Turbo start faster; it is never a limit, and a faster network is still found."
                >
                  <TextInput
                    type="number"
                    min={0}
                    max={100000}
                    value={draft.lineSpeedMbps}
                    onChange={(event) => update('lineSpeedMbps', Number(event.target.value))}
                  />
                </Field>
              </div>
            ) : null}
            <InlineNote tone="info">Set a speed limit to 0 for unlimited. Limits apply to the total session, not each connection.</InlineNote>
          </Card>

          <Card title="Reliability">
            <div className="settings-number-grid">
              <Field label="Maximum retries" hint="0–20">
                <TextInput
                  type="number"
                  min={0}
                  max={20}
                  value={draft.maxRetries}
                  onChange={(event) => update('maxRetries', Number(event.target.value))}
                />
              </Field>
              <Field label="Retry delay" hint="Seconds">
                <TextInput
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={round(draft.retryBaseDelayMs / 1000, 1)}
                  onChange={(event) => update('retryBaseDelayMs', Number(event.target.value) * 1000)}
                />
              </Field>
              <Field label="Connect timeout" hint="Seconds">
                <TextInput
                  type="number"
                  min={1}
                  max={300}
                  value={round(draft.connectTimeoutMs / 1000, 0)}
                  onChange={(event) => update('connectTimeoutMs', Number(event.target.value) * 1000)}
                />
              </Field>
              <Field label="Idle timeout" hint="Seconds">
                <TextInput
                  type="number"
                  min={1}
                  max={300}
                  value={round(draft.idleTimeoutMs / 1000, 0)}
                  onChange={(event) => update('idleTimeoutMs', Number(event.target.value) * 1000)}
                />
              </Field>
              <Field label="Maximum redirects" hint="0–30">
                <TextInput
                  type="number"
                  min={0}
                  max={30}
                  value={draft.maxRedirects}
                  onChange={(event) => update('maxRedirects', Number(event.target.value))}
                />
              </Field>
              <Field label="Checksum by default" hint="Can be overridden per download.">
                <Select
                  value={draft.checksumAlgorithm}
                  onChange={(event) => update('checksumAlgorithm', event.target.value as AppSettings['checksumAlgorithm'])}
                >
                  <option value="">None</option>
                  <option value="sha256">SHA-256</option>
                  <option value="sha1">SHA-1</option>
                  <option value="md5">MD5</option>
                </Select>
              </Field>
            </div>
          </Card>

          <Card title="File conflicts">
            <div className="setting-row is-last">
              <div>
                <strong>When a file already exists</strong>
                <p>Choose the default behavior for new downloads in the same location.</p>
              </div>
              <Select
                className="compact-select"
                value={draft.duplicatePolicy}
                onChange={(event) => update('duplicatePolicy', event.target.value as AppSettings['duplicatePolicy'])}
              >
                <option value="rename">Rename the new file</option>
                <option value="overwrite">Overwrite the existing file</option>
                <option value="skip">Skip the download</option>
              </Select>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === 'network' ? (
        <div className="settings-stack">
          <Card title="Proxy" subtitle="Use a direct connection, the Windows proxy, or a manual proxy.">
            <div className="setting-row">
              <div>
                <strong>Proxy mode</strong>
                <p>System mode follows the proxy configured in Windows Internet options.</p>
              </div>
              <Segmented
                value={draft.proxy.mode}
                onChange={(value) => updateProxy({ mode: value })}
                options={[
                  { value: 'none', label: 'Direct' },
                  { value: 'system', label: 'System' },
                  { value: 'manual', label: 'Manual' }
                ]}
              />
            </div>
            {draft.proxy.mode === 'manual' ? (
              <div className="settings-number-grid proxy-grid">
                <Field label="Protocol">
                  <Select
                    value={draft.proxy.protocol}
                    onChange={(event) => updateProxy({ protocol: event.target.value as ProxySettings['protocol'] })}
                  >
                    <option value="http">HTTP</option>
                    <option value="https">HTTPS</option>
                  </Select>
                </Field>
                <Field label="Host">
                  <TextInput
                    value={draft.proxy.host}
                    onChange={(event) => updateProxy({ host: event.target.value })}
                    placeholder="proxy.example.com"
                  />
                </Field>
                <Field label="Port">
                  <TextInput
                    type="number"
                    min={1}
                    max={65535}
                    value={draft.proxy.port}
                    onChange={(event) => updateProxy({ port: Number(event.target.value) })}
                  />
                </Field>
                <Field label="Username" hint="Optional">
                  <TextInput value={draft.proxy.username} onChange={(event) => updateProxy({ username: event.target.value })} />
                </Field>
                <Field label="Password" hint={draft.proxy.passwordSet && !passwordTouched ? 'A password is stored.' : 'Optional'}>
                  <TextInput
                    type="password"
                    value={proxyPassword}
                    onChange={(event) => {
                      setProxyPassword(event.target.value);
                      setPasswordTouched(true);
                    }}
                    placeholder={draft.proxy.passwordSet ? 'Stored securely' : 'No password'}
                  />
                </Field>
                <div className="field proxy-password-action">
                  <span className="field-label">Stored credential</span>
                  <Button
                    size="sm"
                    icon="trash"
                    disabled={!draft.proxy.passwordSet && !passwordTouched}
                    onClick={() => {
                      setProxyPassword('');
                      setPasswordTouched(true);
                    }}
                  >
                    Clear password
                  </Button>
                </div>
                <Field label="Bypass list" className="span-2" hint="Comma-separated hosts that connect directly.">
                  <TextInput value={draft.proxy.bypass} onChange={(event) => updateProxy({ bypass: event.target.value })} />
                </Field>
              </div>
            ) : null}
            <div className="setting-row is-last">
              <div>
                <strong>Test the proxy</strong>
                <p>Save changes first, then verify that the configured proxy responds.</p>
              </div>
              <Button icon="activity" onClick={() => void testProxy()}>
                Test connection
              </Button>
            </div>
          </Card>

          <Card title="Connection details">
            <div className="setting-row">
              <div>
                <strong>IP version</strong>
                <p>Restrict connections to IPv4 or IPv6 when a site behaves differently.</p>
              </div>
              <Segmented
                value={draft.ipVersion}
                onChange={(value) => update('ipVersion', value)}
                options={[
                  { value: 'any', label: 'Automatic' },
                  { value: 'ipv4', label: 'IPv4' },
                  { value: 'ipv6', label: 'IPv6' }
                ]}
              />
            </div>
            <div className="setting-row">
              <div>
                <strong>User agent</strong>
                <p>Identify as MDM or provide a custom string for picky servers.</p>
              </div>
              <Segmented
                value={draft.userAgentMode}
                onChange={(value) => update('userAgentMode', value)}
                options={[
                  { value: 'default', label: 'Default' },
                  { value: 'custom', label: 'Custom' }
                ]}
              />
            </div>
            {draft.userAgentMode === 'custom' ? (
              <Field label="Custom user agent" hint="Keep this under 500 characters.">
                <TextInput value={draft.userAgent} onChange={(event) => update('userAgent', event.target.value)} />
              </Field>
            ) : null}
          </Card>
        </div>
      ) : null}

      {tab === 'behavior' ? (
        <div className="settings-stack">
          <Card title="After a download completes">
            <ToggleRow
              title="Open completed files"
              description="Safe file types open in their default app after verification."
              checked={draft.autoOpenCompleted}
              onChange={(value) => update('autoOpenCompleted', value)}
            />
            <ToggleRow
              title="Resume unfinished downloads at startup"
              description="Continue paused or interrupted transfers when MDM launches."
              checked={draft.autoResumeOnStartup}
              onChange={(value) => update('autoResumeOnStartup', value)}
            />
            <ToggleRow
              title="Show extension setup at startup"
              description="Display browser-extension installation steps each time MDM opens."
              checked={draft.showExtensionSetupOnStartup}
              onChange={(value) => update('showExtensionSetupOnStartup', value)}
            />
            <ToggleRow
              title="Confirm destructive actions"
              description="Ask before deleting files or clearing history."
              checked={draft.confirmDestructiveActions}
              onChange={(value) => update('confirmDestructiveActions', value)}
            />
            <ToggleRow
              title="Shut down after queue completion"
              description="Queues must individually opt in to shutdown; this enables the feature."
              checked={draft.autoShutdownAfterQueue}
              onChange={(value) => update('autoShutdownAfterQueue', value)}
              last
            />
          </Card>

          <Card title="Notifications">
            <ToggleRow
              title="Enable notifications"
              description="Show Windows notifications for download events."
              checked={draft.notificationsEnabled}
              onChange={(value) => update('notificationsEnabled', value)}
            />
            <ToggleRow
              title="Notify when downloads start"
              description="Show a native notification when a transfer begins in the background."
              checked={draft.notifyOnStart}
              onChange={(value) => update('notifyOnStart', value)}
            />
            <ToggleRow
              title="Notify when downloads complete"
              description="Show a notification after a file finishes."
              checked={draft.notifyOnComplete}
              onChange={(value) => update('notifyOnComplete', value)}
            />
            <ToggleRow
              title="Notify when downloads fail"
              description="Show a notification when a transfer needs attention."
              checked={draft.notifyOnFailure}
              onChange={(value) => update('notifyOnFailure', value)}
            />
            <ToggleRow
              title="Also notify while the window is active"
              description="Show native notifications even when the MDM window is focused; otherwise in-app toasts are used."
              checked={draft.nativeNotificationsWhenActive}
              onChange={(value) => update('nativeNotificationsWhenActive', value)}
              last
            />
          </Card>

          <Card title="Windows integration">
            <ToggleRow
              title="Launch at startup"
              description="Start MDM when you sign in to Windows."
              checked={draft.launchAtStartup}
              onChange={(value) => update('launchAtStartup', value)}
            />
            <ToggleRow
              title="Close to tray"
              description="Keep downloads running when the main window is closed."
              checked={draft.closeToTray}
              onChange={(value) => update('closeToTray', value)}
            />
            <ToggleRow
              title="Minimize to tray"
              description="Hide the window instead of minimizing it to the taskbar."
              checked={draft.minimizeToTray}
              onChange={(value) => update('minimizeToTray', value)}
              last
            />
          </Card>
        </div>
      ) : null}

      {tab === 'advanced' ? (
        <div className="settings-stack">
          <Card title="Activity log">
            <div className="setting-row is-last">
              <div>
                <strong>Log level</strong>
                <p>Debug logging is verbose and meant for troubleshooting.</p>
              </div>
              <Select
                className="compact-select"
                value={draft.loggingLevel}
                onChange={(event) => update('loggingLevel', event.target.value as AppSettings['loggingLevel'])}
              >
                <option value="error">Errors only</option>
                <option value="warn">Warnings and errors</option>
                <option value="info">Normal</option>
                <option value="debug">Debug</option>
              </Select>
            </div>
          </Card>

          <Card title="Configuration" subtitle="Back up queues, schedules, rules, and settings.">
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(event) => void importSettings(event.target.files?.[0])}
            />
            <div className="settings-action-row">
              <Button icon="download" onClick={() => void exportSettings()}>
                Export settings
              </Button>
              <Button icon="upload" loading={importing} onClick={() => fileRef.current?.click()}>
                Import settings
              </Button>
              <Button variant="danger" icon="refresh" onClick={() => setResetOpen(true)}>
                Reset to defaults
              </Button>
            </div>
            <InlineNote tone="warning">
              Settings exports do not include the bridge token, proxy password, or download history. Queue exports are
              available on the Queues page.
            </InlineNote>
          </Card>

          <Card title="About MDM">
            <div className="about-grid">
              <div>
                <span>Version</span>
                <strong>{appInfo?.version ?? '2.6'}</strong>
              </div>
              <div>
                <span>Platform</span>
                <strong>{appInfo?.platform ?? 'Windows'}</strong>
              </div>
              <div>
                <span>Media tools</span>
                <strong>
                  {appInfo?.ffmpegAvailable ? 'ffmpeg' : 'ffmpeg missing'}
                  {appInfo?.ytDlpAvailable ? ' + yt-dlp' : ' + yt-dlp missing'}
                </strong>
              </div>
              <div>
                <span>Downloads</span>
                <strong>{appInfo?.downloadsPath ?? '—'}</strong>
              </div>
            </div>
            <div className="settings-action-row">
              <Button
                icon="folder"
                onClick={() => {
                  if (appInfo) {
                    void call(window.mdm.showItemInFolder(appInfo.userDataPath), 'Showing data folder');
                  }
                }}
              >
                Show data folder
              </Button>
              <Button icon="puzzle" onClick={() => void window.mdm.openExtensionFolder().then((result) => {
                if (!result.ok) notify('error', 'Could not open extension folder', result.error);
              })}>
                Extension folder
              </Button>
            </div>
            <p className="about-note">
              MDM is an original download manager. It stores settings locally in a SQLite database and never
              uploads browsing or download data.
            </p>
          </Card>
        </div>
      ) : null}

      {dirty ? (
        <div className="settings-savebar">
          <div>
            <span className="unsaved-dot" />
            <strong>Unsaved changes</strong>
            <p>Review your settings before applying them.</p>
          </div>
          <div>
            <Button onClick={discard}>Discard</Button>
            <Button variant="primary" icon="check" loading={saving} onClick={() => void save()}>
              Save changes
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={resetOpen}
        title="Reset all settings?"
        message="Theme, folder preferences, transfer limits, proxy, and behavior will return to their defaults. Downloads, queues, schedules, and rules are kept."
        confirmLabel="Reset settings"
        danger
        onCancel={() => setResetOpen(false)}
        onConfirm={() => void resetAll()}
      />
    </div>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  onChange,
  last = false
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  last?: boolean;
}) {
  return (
    <div className={`setting-row ${last ? 'is-last' : ''}`.trim()}>
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} label={title} />
    </div>
  );
}

function ByteLimitField({
  label,
  value,
  onChange
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label} hint="MB/s · 0 = unlimited">
      <TextInput
        type="number"
        min={0}
        step={0.1}
        value={round(value / (1024 * 1024), 1)}
        onChange={(event) => onChange(Math.max(0, Number(event.target.value)) * 1024 * 1024)}
      />
    </Field>
  );
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
