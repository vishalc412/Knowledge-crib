import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  freshnessServiceSpec,
  installFreshnessService,
  queryFreshnessService,
  uninstallFreshnessService,
} from './freshness-service.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'crib-freshness-service-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const base = {
  userHome: '',
  nodePath: '/opt/node/bin/node',
  cliPath: '/opt/crib/dist/bin.js',
  registryDir: '/state/crib',
  uid: 501,
};

describe('freshness supervised service definitions', () => {
  it('renders a launchd agent with restart, startup and the exact worker command', () => {
    const spec = freshnessServiceSpec({ ...base, userHome: home, platform: 'darwin' });
    expect(spec.manager).toBe('launchd');
    expect(spec.content).toContain('<key>KeepAlive</key>');
    expect(spec.content).toContain('<key>RunAtLoad</key>');
    expect(spec.content).toContain('/opt/node/bin/node');
    expect(spec.content).toContain('/opt/crib/dist/bin.js');
    expect(spec.content).toContain('<string>worker</string>');
    expect(spec.content).toContain('KCRIB_REGISTRY_DIR');
  });

  it('renders a systemd user unit with restart-on-failure', () => {
    const spec = freshnessServiceSpec({ ...base, userHome: home, platform: 'linux' });
    expect(spec.manager).toBe('systemd-user');
    expect(spec.content).toContain(
      'ExecStart=/opt/node/bin/node /opt/crib/dist/bin.js freshness worker',
    );
    expect(spec.content).toContain('Restart=on-failure');
    expect(spec.content).toContain('WantedBy=default.target');
  });

  it('renders a Windows task with a restart policy and logon trigger', () => {
    const spec = freshnessServiceSpec({
      ...base,
      userHome: home,
      platform: 'win32',
      nodePath: 'C:\\node\\node.exe',
      cliPath: 'C:\\crib\\dist\\bin.js',
    });
    expect(spec.manager).toBe('task-scheduler');
    expect(spec.content).toContain('<LogonTrigger>');
    expect(spec.content).toContain('<RestartOnFailure>');
    expect(spec.content).toContain('C:\\node\\node.exe');
  });

  it('installs, queries and uninstalls through the selected manager', () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return calls.length === 2 ? 'active' : '';
    };
    const opts = {
      ...base,
      userHome: home,
      registryDir: join(home, 'state'),
      platform: 'linux' as const,
      run,
    };
    const installed = installFreshnessService(opts);
    expect(installed.installed).toBe(true);
    expect(existsSync(installed.path)).toBe(true);
    expect(readFileSync(installed.path, 'utf8')).toContain('freshness worker');
    expect(calls[0]).toEqual({ cmd: 'systemctl', args: ['--user', 'daemon-reload'] });
    expect(calls[1]).toEqual({
      cmd: 'systemctl',
      args: ['--user', 'enable', '--now', 'knowledge-crib-freshness.service'],
    });

    expect(queryFreshnessService(opts).active).toBe(true);
    expect(uninstallFreshnessService(opts).installed).toBe(false);
    expect(existsSync(installed.path)).toBe(false);
    expect(calls.some((c) => c.args.includes('disable'))).toBe(true);
  });
});
