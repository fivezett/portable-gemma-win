import { dlopen, FFIType } from "bun:ffi";
import { log } from "./log.ts";
import { isWindows } from "./paths.ts";

/**
 * Windows の Job Object による子プロセスの道連れ終了。
 *
 * MCP クライアントがこのプロセスを TerminateProcess で強制終了した場合、
 * 終了ハンドラは走らない。Job Object に JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE を
 * 設定しておくと、プロセス終了時に OS がハンドルを閉じ、その時点で
 * llama-server も道連れで落ちる。VRAM を掴んだ孤児プロセスを残さないための保険。
 */

const JobObjectExtendedLimitInformation = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
/** x64 での JOBOBJECT_EXTENDED_LIMIT_INFORMATION のサイズ */
const EXTENDED_LIMIT_INFORMATION_SIZE = 144;
/** 同構造体内の BasicLimitInformation.LimitFlags のオフセット */
const LIMIT_FLAGS_OFFSET = 16;

type Kernel32 = {
  CreateJobObjectW: (attributes: null, name: null) => unknown;
  SetInformationJobObject: (job: unknown, infoClass: number, info: unknown, length: number) => number;
  AssignProcessToJobObject: (job: unknown, process: unknown) => number;
  OpenProcess: (access: number, inherit: number, pid: number) => unknown;
  CloseHandle: (handle: unknown) => number;
  GetLastError: () => number;
};

let kernel32: Kernel32 | null = null;
let kernel32Failed = false;
/** ハンドルはプロセスが生きている間ずっと保持する(閉じた瞬間に子が死ぬため) */
let jobHandle: unknown = null;

function loadKernel32(): Kernel32 | null {
  if (kernel32 || kernel32Failed) return kernel32;
  try {
    // bun:ffi は Windows 以外でも読み込めるが、kernel32 は Windows にしかない。
    const lib = dlopen("kernel32.dll", {
      CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      SetInformationJobObject: {
        args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
      GetLastError: { args: [], returns: FFIType.u32 },
    });
    kernel32 = lib.symbols as unknown as Kernel32;
    return kernel32;
  } catch (error) {
    kernel32Failed = true;
    log.warn("kernel32 の読み込みに失敗しました。Job Object による道連れ終了は無効です", error);
    return null;
  }
}

function ensureJob(api: Kernel32): unknown {
  if (jobHandle) return jobHandle;

  const handle = api.CreateJobObjectW(null, null);
  if (!handle) {
    log.warn(`CreateJobObjectW に失敗しました (GetLastError=${api.GetLastError()})`);
    return null;
  }

  const info = new Uint8Array(EXTENDED_LIMIT_INFORMATION_SIZE);
  new DataView(info.buffer).setUint32(LIMIT_FLAGS_OFFSET, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);

  const ok = api.SetInformationJobObject(
    handle,
    JobObjectExtendedLimitInformation,
    info,
    EXTENDED_LIMIT_INFORMATION_SIZE,
  );
  if (ok === 0) {
    log.warn(`SetInformationJobObject に失敗しました (GetLastError=${api.GetLastError()})`);
    api.CloseHandle(handle);
    return null;
  }

  jobHandle = handle;
  return jobHandle;
}

/**
 * 指定 PID のプロセスを「親が死んだら一緒に死ぬ」Job に入れる。
 * @returns 成功したら true。失敗時は false(呼び出し側は終了ハンドラでの kill にフォールバックする)
 */
export function attachToKillOnExitJob(pid: number): boolean {
  if (!isWindows) return false;

  const api = loadKernel32();
  if (!api) return false;

  const job = ensureJob(api);
  if (!job) return false;

  const processHandle = api.OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, 0, pid);
  if (!processHandle) {
    log.warn(`OpenProcess に失敗しました pid=${pid} (GetLastError=${api.GetLastError()})`);
    return false;
  }

  try {
    const assigned = api.AssignProcessToJobObject(job, processHandle);
    if (assigned === 0) {
      log.warn(`AssignProcessToJobObject に失敗しました pid=${pid} (GetLastError=${api.GetLastError()})`);
      return false;
    }
    log.debug(`llama-server を Job Object に登録しました pid=${pid}`);
    return true;
  } finally {
    api.CloseHandle(processHandle);
  }
}
