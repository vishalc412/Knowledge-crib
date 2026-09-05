/** Operating-system supervision for the one user-scoped freshness worker (audit F06). */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type ServicePlatform = 'darwin' | 'linux' | 'win32';
export type ServiceManager = 'launchd' | 'systemd-user' | 'task-scheduler';
export type ServiceRun = (cmd: string, args: string[]) => string;

export interface FreshnessServiceOptions {
  platform: ServicePlatform;
  userHome: string;
  nodePath: string;
  cliPath: string;
  registryDir: string;
  uid: number;
  run?: ServiceRun;
}

export interface FreshnessServiceSpec {
  manager: ServiceManager;
  id: string;
  path: string;
  content: string;
}

const LABEL = 'com.knowledge-crib.freshness';
const UNIT = 'knowledge-crib-freshness.service';
const TASK = 'Knowledge Crib Freshness';

const xml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const systemd = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');

export const defaultServiceRun: ServiceRun = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Pure service definition generation, which makes every platform contract testable on one host. */
export function freshnessServiceSpec(opts: FreshnessServiceOptions): FreshnessServiceSpec {
  const logs = join(opts.registryDir, 'freshness');
  if (opts.platform === 'darwin') {
    const path = join(opts.userHome, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const args = [opts.nodePath, opts.cliPath, 'freshness', 'worker'];
    const argXml = args.map((arg) => `      <string>${xml(arg)}</string>`).join('\n');
    return {
      manager: 'launchd',
      id: LABEL,
      path,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argXml}
    </array>
    <key>EnvironmentVariables</key>
    <dict><key>KCRIB_REGISTRY_DIR</key><string>${xml(opts.registryDir)}</string></dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ProcessType</key><string>Background</string>
    <key>StandardOutPath</key><string>${xml(join(logs, 'worker.stdout.log'))}</string>
    <key>StandardErrorPath</key><string>${xml(join(logs, 'worker.stderr.log'))}</string>
  </dict>
</plist>
`,
    };
  }
  if (opts.platform === 'linux') {
    const path = join(opts.userHome, '.config', 'systemd', 'user', UNIT);
    return {
      manager: 'systemd-user',
      id: UNIT,
      path,
      content: `[Unit]
Description=Knowledge Crib durable freshness worker
After=default.target

[Service]
Type=simple
Environment="KCRIB_REGISTRY_DIR=${systemd(opts.registryDir)}"
ExecStart=${systemd(opts.nodePath)} ${systemd(opts.cliPath)} freshness worker
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`,
    };
  }
  const path = join(opts.registryDir, 'freshness', 'knowledge-crib-freshness.xml');
  return {
    manager: 'task-scheduler',
    id: TASK,
    path,
    content: `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <RestartOnFailure><Interval>PT2S</Interval><Count>999</Count></RestartOnFailure>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <StartWhenAvailable>true</StartWhenAvailable>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(opts.nodePath)}</Command>
      <Arguments>"${xml(opts.cliPath)}" freshness worker</Arguments>
    </Exec>
  </Actions>
</Task>
`,
  };
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

function activate(
  spec: FreshnessServiceSpec,
  opts: FreshnessServiceOptions,
  run: ServiceRun,
): void {
  if (spec.manager === 'launchd') {
    const domain = `gui/${opts.uid}`;
    try {
      run('launchctl', ['bootout', domain, spec.path]);
    } catch {
      // A first install has nothing to unload.
    }
    run('launchctl', ['bootstrap', domain, spec.path]);
    run('launchctl', ['kickstart', '-k', `${domain}/${LABEL}`]);
  } else if (spec.manager === 'systemd-user') {
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', UNIT]);
  } else {
    run('schtasks.exe', ['/Create', '/TN', TASK, '/XML', spec.path, '/F']);
    run('schtasks.exe', ['/Run', '/TN', TASK]);
  }
}

export function installFreshnessService(opts: FreshnessServiceOptions) {
  const spec = freshnessServiceSpec(opts);
  writeAtomic(spec.path, spec.content);
  mkdirSync(join(opts.registryDir, 'freshness'), { recursive: true });
  activate(spec, opts, opts.run ?? defaultServiceRun);
  return { ...spec, installed: true, active: true };
}

export function queryFreshnessService(opts: FreshnessServiceOptions) {
  const spec = freshnessServiceSpec(opts);
  if (!existsSync(spec.path)) return { ...spec, installed: false, active: false };
  const run = opts.run ?? defaultServiceRun;
  try {
    if (spec.manager === 'launchd') run('launchctl', ['print', `gui/${opts.uid}/${LABEL}`]);
    else if (spec.manager === 'systemd-user') run('systemctl', ['--user', 'is-active', UNIT]);
    else run('schtasks.exe', ['/Query', '/TN', TASK]);
    return { ...spec, installed: true, active: true };
  } catch (error) {
    return {
      ...spec,
      installed: true,
      active: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function uninstallFreshnessService(opts: FreshnessServiceOptions) {
  const spec = freshnessServiceSpec(opts);
  const run = opts.run ?? defaultServiceRun;
  try {
    if (spec.manager === 'launchd') run('launchctl', ['bootout', `gui/${opts.uid}`, spec.path]);
    else if (spec.manager === 'systemd-user') {
      run('systemctl', ['--user', 'disable', '--now', UNIT]);
    } else run('schtasks.exe', ['/Delete', '/TN', TASK, '/F']);
  } catch {
    // Uninstall is idempotent: a missing/inactive manager entry is already the desired state.
  }
  rmSync(spec.path, { force: true });
  if (spec.manager === 'systemd-user') {
    try {
      run('systemctl', ['--user', 'daemon-reload']);
    } catch {
      // The unit file is gone even if the manager is unavailable.
    }
  }
  return { ...spec, installed: false, active: false };
}
