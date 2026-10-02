import { spawn } from 'node:child_process';

// 桌面宿主能力：只有「服务跑在你正用的这台电脑上」才有意义，所以调用处一律先过回环判定
// （见 server.js 的 isLoopbackRequest）——LAN 上的手机触发这些，弹窗会落在没人看的桌面上。

// 用系统记事本打开一个文件（设置页的「打开 .env」/「打开 settings.json」）。
export function openInEditor(file) {
  return new Promise((resolve, reject) => {
    const child = spawn('notepad.exe', [file], { detached: true, stdio: 'ignore' });
    child.on('error', reject);
    child.unref();
    resolve();
  });
}

// Windows 的原生文件选择框（词表路径的「浏览…」）。取消时返回 null。
export function pickWindowsFile() {
  return new Promise((resolve, reject) => {
    const script = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      "$d.Title = '选择词表文件（Vocabulary.md）'",
      "$d.Filter = 'Markdown 词表 (*.md)|*.md|文本文件 (*.txt)|*.txt|所有文件 (*.*)|*.*'",
      '$d.CheckFileExists = $true',
      "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }",
    ].join('\n');
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.on('error', reject);
    child.on('close', () => resolve(out.trim() || null));
  });
}
