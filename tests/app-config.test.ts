import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultAppConfig, readAppConfig, saveAppPath, pickAppPath, launchApp } from '../apps/server/src/app-config.ts';

const dirs: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), 'qwen-config-')); dirs.push(root); const app = join(root, '千问 办公.app'); mkdirSync(join(app, 'Contents/MacOS'), { recursive: true }); writeFileSync(join(app, 'Contents/MacOS/QwenWorkCN'), ''); return { app, file: join(root, 'config.json') }; }
afterEach(() => dirs.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
describe('desktop application configuration', () => {
  it('normalizes a Finder bundle path and persists it independently of test runs', () => {
    const { app, file } = fixture(); expect(saveAppPath(file, app + '/', 'darwin').appPath).toBe(app); expect(readAppConfig(file, 'darwin').appPath).toBe(app);
    expect(defaultAppConfig('darwin').pickerLabel).toBe('在访达中选择 App'); expect(defaultAppConfig('win32').pickerLabel).toBe('浏览本地应用');
  });
  it('rejects non-Qwen bundles, missing paths, relative paths and exe directories without overwriting config', () => {
    const { app, file } = fixture(); saveAppPath(file, app, 'darwin');
    for (const path of [app + '/missing.app', '.', join(app, 'Contents'), app.replace('.app', '.txt')]) expect(() => saveAppPath(file, path, 'darwin')).toThrow();
    const fake = join(app, 'other.app'); mkdirSync(fake); expect(() => saveAppPath(file, fake, 'darwin')).toThrow('千问办公');
    const exe = join(app, 'QwenWorkCN.exe'); mkdirSync(exe); expect(() => saveAppPath(file, exe, 'win32')).toThrow(); expect(readAppConfig(file, 'darwin').appPath).toBe(app);
  });
  it('uses native dialogs without interpolating user paths and treats cancel as no change', async () => {
    const calls: { command: string; args: string[] }[] = [];
    const exec = async (command: string, args: string[]) => { calls.push({ command, args }); return { stdout: '/Applications/QwenWorkCN.app/\n' }; };
    expect(await pickAppPath('darwin', exec)).toBe('/Applications/QwenWorkCN.app/'); expect(calls[0].command).toBe('/usr/bin/osascript'); expect(calls[0].args[1]).toContain('choose file with prompt');
    await pickAppPath('win32', exec); expect(calls[1].args).toContain('-STA'); expect(Buffer.from(calls[1].args.at(-1)!, 'base64').toString('utf16le')).toContain('UTF8');
    expect(await pickAppPath('darwin', async () => { throw { stderr: 'User canceled. (-128)' }; })).toBeUndefined();
    expect(await pickAppPath('win32', async () => ({ stdout: '' }))).toBeUndefined();
    await expect(pickAppPath('darwin', async () => { throw new Error('dialog unavailable'); })).rejects.toThrow('dialog unavailable');
  });
  it('launches the selected bundle with the configured loopback debug port as separate arguments', async () => {
    const { app } = fixture(); let call: unknown;
    await launchApp(app, 'http://127.0.0.1:9231', 'darwin', async (command, args) => { call = { command, args }; return { stdout: '' }; });
    expect(call).toEqual({ command: '/usr/bin/open', args: ['-a', app, '--args', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9231'] });
    await expect(launchApp(app, 'http://evil.example:9229', 'darwin')).rejects.toThrow('本机');
  });
});
