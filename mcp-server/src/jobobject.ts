import { dlopen, FFIType } from "bun:ffi";
import { log } from "./log.ts";
import { isWindows } from "./paths.ts";

/**
 * Tie the child process lifetime to ours using a Windows Job Object.
 *
 * When an MCP client kills this process with TerminateProcess, no exit handler runs.
 * A Job Object created with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE closes together with
 * the process, and the OS terminates everything in it at that moment. This is what
 * keeps a llama-server holding several GB of VRAM from being orphaned.
 */

const JobObjectExtendedLimitInformation = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
/** sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) on x64 */
const EXTENDED_LIMIT_INFORMATION_SIZE = 144;
/** Offset of BasicLimitInformation.LimitFlags within that struct */
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
/** Held for the whole process lifetime: closing the handle kills the children */
let jobHandle: unknown = null;

function loadKernel32(): Kernel32 | null {
  if (kernel32 || kernel32Failed) return kernel32;
  try {
    // bun:ffi loads anywhere, but kernel32 only exists on Windows.
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
    log.warn("Could not load kernel32; Job Object cleanup is disabled", error);
    return null;
  }
}

function ensureJob(api: Kernel32): unknown {
  if (jobHandle) return jobHandle;

  const handle = api.CreateJobObjectW(null, null);
  if (!handle) {
    log.warn(`CreateJobObjectW failed (GetLastError=${api.GetLastError()})`);
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
    log.warn(`SetInformationJobObject failed (GetLastError=${api.GetLastError()})`);
    api.CloseHandle(handle);
    return null;
  }

  jobHandle = handle;
  return jobHandle;
}

/**
 * Put the given PID into a job that dies with this process.
 * @returns true on success; false means the caller must fall back to exit handlers.
 */
export function attachToKillOnExitJob(pid: number): boolean {
  if (!isWindows) return false;

  const api = loadKernel32();
  if (!api) return false;

  const job = ensureJob(api);
  if (!job) return false;

  const processHandle = api.OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, 0, pid);
  if (!processHandle) {
    log.warn(`OpenProcess failed for pid=${pid} (GetLastError=${api.GetLastError()})`);
    return false;
  }

  try {
    const assigned = api.AssignProcessToJobObject(job, processHandle);
    if (assigned === 0) {
      log.warn(`AssignProcessToJobObject failed for pid=${pid} (GetLastError=${api.GetLastError()})`);
      return false;
    }
    log.debug(`Attached llama-server to the job object, pid=${pid}`);
    return true;
  } finally {
    api.CloseHandle(processHandle);
  }
}
