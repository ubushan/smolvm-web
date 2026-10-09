'use strict';
// Windows integrated authentication (Kerberos / NTLM) for the corporate proxy,
// as the logged-in Windows user, without a password: SSPI
// (InitializeSecurityContext) through one long-lived PowerShell helper.
// Node has no SSPI binding and smolvm-web has no native dependencies, so the
// helper compiles a small P/Invoke class with Add-Type (Windows PowerShell 5.1,
// present on every Windows 10/11).
//
// Protocol on the helper's stdin/stdout, one line each:
//   step <id> <package> <spn> [<input base64>]  ->  <id> ok continue|done [<token base64>]
//   free <id>
// errors                                       ->  <id> err <message>

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cfg = require('./config');

const AVAILABLE = process.platform === 'win32';

const CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class SmolSspi {
  [StructLayout(LayoutKind.Sequential)] public struct SecHandle { public IntPtr Lower; public IntPtr Upper; }
  [StructLayout(LayoutKind.Sequential)] public struct SecBuffer { public int cbBuffer; public int BufferType; public IntPtr pvBuffer; }
  [StructLayout(LayoutKind.Sequential)] public struct SecBufferDesc { public int ulVersion; public int cBuffers; public IntPtr pBuffers; }
  [StructLayout(LayoutKind.Sequential)] public struct TimeStamp { public uint Low; public int High; }

  [DllImport("secur32.dll", CharSet = CharSet.Unicode)]
  static extern int AcquireCredentialsHandleW(string principal, string package, int credentialUse, IntPtr logonId,
    IntPtr authData, IntPtr getKeyFn, IntPtr getKeyArgument, ref SecHandle credential, out TimeStamp expiry);

  [DllImport("secur32.dll", CharSet = CharSet.Unicode)]
  static extern int InitializeSecurityContextW(ref SecHandle credential, IntPtr context, string targetName, int contextReq,
    int reserved1, int targetDataRep, IntPtr input, int reserved2, ref SecHandle newContext, ref SecBufferDesc output,
    out int contextAttr, out TimeStamp expiry);

  [DllImport("secur32.dll")] static extern int FreeContextBuffer(IntPtr buffer);
  [DllImport("secur32.dll")] static extern int DeleteSecurityContext(ref SecHandle context);
  [DllImport("secur32.dll")] static extern int FreeCredentialsHandle(ref SecHandle credential);

  const int SECPKG_CRED_OUTBOUND = 2;
  const int ISC_REQ_ALLOCATE_MEMORY = 0x100;
  const int SECURITY_NATIVE_DREP = 0x10;
  const int SECBUFFER_TOKEN = 2;
  const int SEC_E_OK = 0;
  const int SEC_I_CONTINUE_NEEDED = 0x00090312;

  class Ctx { public SecHandle Cred; public SecHandle Handle; public bool HasHandle; }
  static readonly Dictionary<string, Ctx> contexts = new Dictionary<string, Ctx>();

  public static string Step(string id, string package, string spn, string inputB64) {
    Ctx c;
    if (!contexts.TryGetValue(id, out c)) {
      c = new Ctx();
      TimeStamp ts;
      int ra = AcquireCredentialsHandleW(null, package, SECPKG_CRED_OUTBOUND, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, ref c.Cred, out ts);
      if (ra != SEC_E_OK) throw new Exception("AcquireCredentialsHandle 0x" + ra.ToString("X8"));
      contexts[id] = c;
    }
    int bufSize = Marshal.SizeOf(typeof(SecBuffer));
    IntPtr pOut = Marshal.AllocHGlobal(bufSize);
    IntPtr pIn = IntPtr.Zero, pInDesc = IntPtr.Zero, pInData = IntPtr.Zero, pCtx = IntPtr.Zero;
    try {
      SecBuffer outBuf = new SecBuffer();
      outBuf.BufferType = SECBUFFER_TOKEN;
      Marshal.StructureToPtr(outBuf, pOut, false);
      SecBufferDesc outDesc = new SecBufferDesc();
      outDesc.cBuffers = 1;
      outDesc.pBuffers = pOut;
      if (!string.IsNullOrEmpty(inputB64)) {
        byte[] data = Convert.FromBase64String(inputB64);
        pInData = Marshal.AllocHGlobal(data.Length);
        Marshal.Copy(data, 0, pInData, data.Length);
        SecBuffer inBuf = new SecBuffer();
        inBuf.BufferType = SECBUFFER_TOKEN;
        inBuf.cbBuffer = data.Length;
        inBuf.pvBuffer = pInData;
        pIn = Marshal.AllocHGlobal(bufSize);
        Marshal.StructureToPtr(inBuf, pIn, false);
        SecBufferDesc inDesc = new SecBufferDesc();
        inDesc.cBuffers = 1;
        inDesc.pBuffers = pIn;
        pInDesc = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecBufferDesc)));
        Marshal.StructureToPtr(inDesc, pInDesc, false);
      }
      if (c.HasHandle) {
        pCtx = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecHandle)));
        Marshal.StructureToPtr(c.Handle, pCtx, false);
      }
      SecHandle newCtx = new SecHandle();
      int attrs;
      TimeStamp ts2;
      int rc = InitializeSecurityContextW(ref c.Cred, pCtx, spn, ISC_REQ_ALLOCATE_MEMORY, 0, SECURITY_NATIVE_DREP,
        pInDesc, 0, ref newCtx, ref outDesc, out attrs, out ts2);
      if (rc != SEC_E_OK && rc != SEC_I_CONTINUE_NEEDED) throw new Exception("InitializeSecurityContext 0x" + rc.ToString("X8"));
      c.Handle = newCtx;
      c.HasHandle = true;
      SecBuffer res = (SecBuffer)Marshal.PtrToStructure(pOut, typeof(SecBuffer));
      string token = "";
      if (res.cbBuffer > 0 && res.pvBuffer != IntPtr.Zero) {
        byte[] b = new byte[res.cbBuffer];
        Marshal.Copy(res.pvBuffer, b, 0, res.cbBuffer);
        FreeContextBuffer(res.pvBuffer);
        token = Convert.ToBase64String(b);
      }
      return (rc == SEC_I_CONTINUE_NEEDED ? "continue " : "done ") + token;
    } finally {
      Marshal.FreeHGlobal(pOut);
      if (pIn != IntPtr.Zero) Marshal.FreeHGlobal(pIn);
      if (pInDesc != IntPtr.Zero) Marshal.FreeHGlobal(pInDesc);
      if (pInData != IntPtr.Zero) Marshal.FreeHGlobal(pInData);
      if (pCtx != IntPtr.Zero) Marshal.FreeHGlobal(pCtx);
    }
  }

  public static void Free(string id) {
    Ctx c;
    if (!contexts.TryGetValue(id, out c)) return;
    if (c.HasHandle) DeleteSecurityContext(ref c.Handle);
    FreeCredentialsHandle(ref c.Cred);
    contexts.Remove(id);
  }

  public static string User() { return Environment.UserDomainName + "\\" + Environment.UserName; }
}
`;

const PS = `$ErrorActionPreference = 'Stop'
try { Add-Type -TypeDefinition @'
${CSHARP}
'@ } catch { [Console]::Out.WriteLine("fatal " + ($_.Exception.Message -replace '\\s+', ' ')); exit 3 }
[Console]::Out.WriteLine("ready " + [SmolSspi]::User())
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  try {
    if ($p[0] -eq 'step') {
      $tok = ''
      if ($p.Length -gt 4) { $tok = $p[4] }
      $r = [SmolSspi]::Step($p[1], $p[2], $p[3], $tok)
      [Console]::Out.WriteLine($p[1] + ' ok ' + $r)
    } elseif ($p[0] -eq 'free') { [SmolSspi]::Free($p[1]) }
  } catch { [Console]::Out.WriteLine($p[1] + ' err ' + ($_.Exception.Message -replace '\\s+', ' ')) }
  [Console]::Out.Flush()
}
`;

let proc = null;
let ready = null;      // Promise<{user}>
let lastError = null;
const pending = new Map();
let seq = 0;

function scriptFile() {
  const file = path.join(cfg.DIR, 'sspi-helper.ps1');
  let cur = null;
  try { cur = fs.readFileSync(file, 'utf8'); } catch {}
  if (cur !== PS) { fs.mkdirSync(cfg.DIR, { recursive: true }); fs.writeFileSync(file, PS, 'utf8'); }
  return file;
}

function start() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    let file;
    try { file = scriptFile(); } catch (e) { return reject(e); }
    proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    let err = '';
    const fail = (e) => {
      lastError = e.message;
      for (const p of pending.values()) p.reject(e);
      pending.clear();
      proc = null; ready = null;
      reject(e);
    };
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.startsWith('ready ')) { lastError = null; resolve({ user: line.slice(6) }); continue; }
        if (line.startsWith('fatal ')) { fail(new Error(`SSPI недоступен (PowerShell Add-Type): ${line.slice(6)}`)); continue; }
        const [id, status, ...rest] = line.split(' ');
        const p = pending.get(id);
        if (!p) continue;
        pending.delete(id);
        if (status === 'ok') p.resolve({ done: rest[0] === 'done', token: rest[1] || '' });
        else p.reject(new Error(`SSPI: ${rest.join(' ')}`));
      }
    });
    proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    proc.on('error', (e) => fail(new Error(`не удалось запустить PowerShell: ${e.message}`)));
    proc.on('exit', (code) => fail(new Error(`помощник SSPI завершился (код ${code})${err ? `: ${err.trim().slice(-300)}` : ''}`)));
  });
  ready.catch(() => {});
  return ready;
}

function call(line, id) {
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(`${line}\n`);
    setTimeout(() => { if (pending.delete(id)) reject(new Error('SSPI: нет ответа')); }, 15000);
  });
}

// One authentication exchange with a proxy. scheme: "Negotiate" (Kerberos,
// falling back to NTLM inside SPNEGO) or "NTLM".
async function session(proxyHost, scheme = 'Negotiate') {
  if (!AVAILABLE) throw new Error('встроенная авторизация Windows доступна только на Windows');
  await start();
  const id = `s${++seq}`;
  const pkg = /^ntlm$/i.test(scheme) ? 'NTLM' : 'Negotiate';
  const spn = `HTTP/${proxyHost}`;
  return {
    scheme: pkg,
    async next(challenge = '') {
      if (!/^[A-Za-z0-9+/=]*$/.test(challenge)) throw new Error('некорректный ответ прокси');
      return call(`step ${id} ${pkg} ${spn}${challenge ? ` ${challenge}` : ''}`, id);
    },
    close() { if (proc) try { proc.stdin.write(`free ${id}\n`); } catch {} },
  };
}

async function status() {
  if (!AVAILABLE) return { available: false };
  try { const r = await start(); return { available: true, user: r.user }; } catch (e) { return { available: false, error: e.message || lastError }; }
}

module.exports = { AVAILABLE, session, status, _internal: { CSHARP, PS } };
