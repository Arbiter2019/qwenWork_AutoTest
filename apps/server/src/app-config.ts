import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, normalize } from 'node:path';
import { promisify } from 'node:util';
import type { AppConfig } from '../../../packages/core/src/types.ts';

type Execute = (command: string, args: string[]) => Promise<{ stdout: string }>;
const execFileAsync = promisify(execFile);
const execute: Execute = async (command, args) => execFileAsync(command, args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 });

export function defaultAppConfig(platform: NodeJS.Platform = process.platform): AppConfig {
  return { platform, pickerLabel: platform === 'darwin' ? '在访达中选择 App' : '浏览本地应用', expectedExtension: platform === 'darwin' ? '.app' : '.exe' };
}

export function readAppConfig(file: string, platform: NodeJS.Platform = process.platform): AppConfig {
  const base = defaultAppConfig(platform);
  if (!existsSync(file)) return base;
  try { const value = JSON.parse(readFileSync(file, 'utf8')); return { ...base, appPath: typeof value.appPath === 'string' ? value.appPath : undefined }; } catch { return base; }
}

export function validateAppPath(input: string, platform: NodeJS.Platform = process.platform): string {
  if (!['darwin', 'win32'].includes(platform)) throw new Error('当前仅支持 macOS 和 Windows');
  const appPath = normalize(input.trim());
  if (!input.trim() || !isAbsolute(appPath) || !existsSync(appPath)) throw new Error('请选择存在的千问办公应用绝对路径');
  if (platform === 'darwin') {
    if (extname(appPath).toLowerCase() !== '.app' || !statSync(appPath).isDirectory() || !existsSync(`${appPath}/Contents/MacOS/QwenWorkCN`) || !statSync(`${appPath}/Contents/MacOS/QwenWorkCN`).isFile()) throw new Error('请选择千问办公的 .app 应用包');
  } else if (!statSync(appPath).isFile() || !/^QwenWorkCN\.exe$/i.test(basename(appPath))) throw new Error('请选择千问办公 QwenWorkCN.exe 应用文件');
  return appPath.replace(/[\\/]+$/, '');
}

export function saveAppPath(file: string, input: string, platform: NodeJS.Platform = process.platform): AppConfig {
  const appPath = validateAppPath(input, platform);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify({ appPath }, null, 2), { mode: 0o600 }); renameSync(file + '.tmp', file);
  return { ...defaultAppConfig(platform), appPath };
}

export async function pickAppPath(platform: NodeJS.Platform = process.platform, run: Execute = execute): Promise<string | undefined> {
  try {
    let stdout: string;
    if (platform === 'darwin') {
      const script = 'use scripting additions\ntry\nset chosenApp to choose file with prompt "选择千问办公 App" of type {"com.apple.application-bundle"} default location (path to applications folder)\nreturn POSIX path of chosenApp\non error number -128\nreturn ""\nend try';
      ({ stdout } = await run('/usr/bin/osascript', ['-e', script]));
    } else if (platform === 'win32') {
      const script = '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title="选择千问办公 App"; $d.Filter="千问办公 (QwenWorkCN.exe)|QwenWorkCN.exe"; try { if($d.ShowDialog() -eq "OK"){[Console]::WriteLine($d.FileName)} } finally { $d.Dispose() }';
      ({ stdout } = await run('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]));
    } else throw new Error('当前仅支持 macOS 和 Windows 应用选择');
    return stdout.trim().replace(/^\uFEFF/, '') || undefined;
  } catch (error) {
    if (/-128/.test(String((error as { stderr?: string }).stderr ?? ''))) return undefined;
    throw error;
  }
}

export async function launchApp(input: string, endpoint: string, platform: NodeJS.Platform = process.platform, run?: Execute): Promise<void> {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('调试连接仅允许本机 HTTP 地址');
  const appPath = validateAppPath(input, platform);
  const args = ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${url.port || '80'}`];
  if (platform === 'darwin') { await (run ?? execute)('/usr/bin/open', ['-a', appPath, '--args', ...args]); return; }
  if (run) { await run(appPath, args); return; }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(appPath, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
}
