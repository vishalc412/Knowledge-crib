import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  freshnessServiceSpec,
  installFreshnessService,
  queryFreshnessService,
  restartFreshnessService,
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

  // ─── per-OS install receipts (WP5.6) ────────────────────────────────────────

  it('launchd install: bootout tolerated, then bootstrap + kickstart under gui/<uid>', () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === 'launchctl' && args[0] === 'bootout') throw new Error('not loaded');
      return '';
    };
    const opts = {
      ...base,
      userHome: home,
      registryDir: join(home, 'state'),
      platform: 'darwin' as const,
      run,
    };
    const installed = installFreshnessService(opts);
    expect(installed.installed && installed.active).toBe(true);
    expect(existsSync(installed.path)).toBe(true);
    expect(calls.map((c) => `${c.cmd} ${c.args.join(' ')}`)).toEqual([
      `launchctl bootout gui/501 ${installed.path}`,
      `launchctl bootstrap gui/501 ${installed.path}`,
      'launchctl kickstart -k gui/501/com.knowledge-crib.freshness',
    ]);
  });

  it('task-scheduler install: /Create with /F then /Run, abs path xml definition', () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return '';
    };
    const opts = {
      ...base,
      userHome: home,
      registryDir: join(home, 'state'),
      platform: 'win32' as const,
      nodePath: 'C:\\node\\node.exe',
      cliPath: 'C:\\crib\\dist\\bin.js',
      run,
    };
    const installed = installFreshnessService(opts);
    expect(existsSync(installed.path)).toBe(true);
    expect(calls).toEqual([
      {
        cmd: 'schtasks.exe',
        args: ['/Create', '/TN', 'Knowledge Crib Freshness', '/XML', installed.path, '/F'],
      },
      { cmd: 'schtasks.exe', args: ['/Run', '/TN', 'Knowledge Crib Freshness'] },
    ]);
  });

  // ─── receipt encoding hazards (WP5.6: "XML encoding, quoting, abs paths") ────

  it('launchd XML-escapes registry paths carrying &, < and spaces — no raw & survives', () => {
    const registryDir = `${home}/crib & crib<beta>dir`;
    const spec = freshnessServiceSpec({ ...base, userHome: home, platform: 'darwin', registryDir });
    expect(spec.content).toContain('KCRIB_REGISTRY_DIR');
    expect(spec.content).toContain('&amp; crib&lt;beta&gt;dir');
    // the ONLY ampersands in a well-formed plist are the entity starts
    expect(
      spec.content.replaceAll('&amp;', '').replaceAll('&lt;', '').replaceAll('&gt;', ''),
    ).not.toContain('&');
  });

  it('task-scheduler XML-escapes executable paths with &, < and >', () => {
    const spec = freshnessServiceSpec({
      ...base,
      platform: 'win32',
      nodePath: 'C:\\node & tools<bin>\\node.exe',
      cliPath: 'C:\\crib\\dist\\bin.js',
    });
    expect(spec.content).toContain('<Command>C:\\node &amp; tools&lt;bin&gt;\\node.exe</Command>');
  });

  it('systemd escapes backslashes and quotes inside the Environment directive', () => {
    const spec = freshnessServiceSpec({
      ...base,
      userHome: home,
      platform: 'linux',
      registryDir: '/state/crib\\user "shared"',
    });
    expect(spec.content).toContain(
      'Environment="KCRIB_REGISTRY_DIR=/state/crib\\\\user \\"shared\\""',
    );
  });

  it('restart: installed definition restarted in place; absent definition installed (start path)', () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return '';
    };
    const opts = {
      ...base,
      userHome: home,
      registryDir: join(home, 'state'),
      platform: 'linux' as const,
      run,
    };
    // absent → the start path installs
    const started = restartFreshnessService(opts);
    expect(started.restarted).toBe(false);
    expect(started.installed && started.active).toBe(true);
    expect(calls.map((c) => `${c.cmd} ${c.args.join(' ')}`)).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable --now knowledge-crib-freshness.service',
    ]);
    // installed → restart in place, definition untouched
    calls.length = 0;
    const bytes = readFileSync(started.path, 'utf8');
    const restarted = restartFreshnessService(opts);
    expect(restarted.restarted).toBe(true);
    expect(readFileSync(started.path, 'utf8')).toBe(bytes);
    expect(calls).toEqual([
      { cmd: 'systemctl', args: ['--user', 'restart', 'knowledge-crib-freshness.service'] },
    ]);
  });

  it('launchd restart kicks the running instance; task-scheduler restart ends then runs', () => {
    const darwinCalls: { cmd: string; args: string[] }[] = [];
    const darwinOpts = {
      ...base,
      userHome: home,
      registryDir: join(home, 'state'),
      platform: 'darwin' as const,
      run: (cmd: string, args: string[]) => {
        darwinCalls.push({ cmd, args });
        return '';
      },
    };
    restartFreshnessService(darwinOpts); // installs (absent definition)
    darwinCalls.length = 0;
    const darwin = restartFreshnessService(darwinOpts);
    expect(darwin.restarted).toBe(true);
    expect(darwinCalls).toEqual([
      { cmd: 'launchctl', args: ['kickstart', '-k', 'gui/501/com.knowledge-crib.freshness'] },
    ]);

    const winCalls: { cmd: string; args: string[] }[] = [];
    const winOpts = {
      ...base,
      userHome: home,
      registryDir: join(home, 'state'),
      platform: 'win32' as const,
      run: (cmd: string, args: string[]) => {
        winCalls.push({ cmd, args });
        return '';
      },
    };
    restartFreshnessService(winOpts); // installs (absent definition)
    winCalls.length = 0;
    const win = restartFreshnessService(winOpts);
    expect(win.restarted).toBe(true);
    expect(winCalls).toEqual([
      { cmd: 'schtasks.exe', args: ['/End', '/TN', 'Knowledge Crib Freshness'] },
      { cmd: 'schtasks.exe', args: ['/Run', '/TN', 'Knowledge Crib Freshness'] },
    ]);
  });
});
