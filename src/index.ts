/**
 * dsh-cloud-sandbox — Linux Docker execution-sandbox runtime plugin for DeepSeek Harness (DSH).
 *
 * Public entry point exporting:
 * - `DockerRuntimePool` & `createDockerRuntimePool` (host-level shared container pool & fair queue)
 * - `DockerSubprocessRuntime` (`ctx.subprocess` provider)
 * - `DockerShellExecutor` (optional `ctx.shell` executor with fail-closed sandbox policy)
 * - `WorkspaceFencedFileSystem` (optional `ctx.fs` strict read+write workspace fence)
 * - `WorkspacePolicy`, `FairScheduler`, `UnixSocketDockerClient`, `demuxDockerStream`, `BoundedStreamCollector`
 */

export * from './types.ts'
export {
  WorkspacePolicy,
  canonicalizeHostPath,
  computeWorkspaceId,
  isPathContained,
  toPosixPath,
  type ResolvedWorkspace,
} from './workspace/workspace-policy.ts'
export {
  isDisallowedWindowsUncPath,
  isSensitiveWindowsOrWslPath,
  isWindowsDrivePath,
  normalizeWslMountPrefix,
  parseWslUncPath,
  toContainerPosixPath,
  windowsPathToWslPath,
  wslPathToWindowsPath,
  type ParsedWslUncPath,
} from './workspace/wsl-paths.ts'
export {
  FairScheduler,
  type EphemeralContainerSlotLease,
  type FairSchedulerOptions,
  type TaskLease,
  type TerminalLease,
  type WorkspaceContainerState,
} from './scheduler/fair-scheduler.ts'
export {
  LIFECYCLE_LABEL,
  MANAGED_LABEL,
  POOL_ID_LABEL,
  UnixSocketDockerClient,
  WORKSPACE_ID_LABEL,
  buildHardenedContainerPayload,
  demuxDockerStream,
  type ConcreteDockerTransport,
  type DockerClient,
  type DockerContainerCreateRequest,
  type DockerContainerInspect,
  type DockerContainerSummary,
  type DockerExecCreateRequest,
  type DockerExecInspect,
  type DockerExecStream,
  type UnixSocketDockerClientOptions,
} from './docker/socket-client.ts'
export {
  DEFAULT_WINDOWS_DOCKER_PIPE,
  DEFAULT_WSL_DOCKER_SOCKET,
  WslBridgeSocket,
  buildWslBridgeCommand,
  createWslSocketStream,
  type WslBridgeCommand,
} from './docker/wsl-bridge.ts'
export { BoundedStreamCollector } from './docker/stream-collector.ts'
export {
  DockerRuntimePool,
  buildContainerEnv,
  createDockerRuntimePool,
  scrubEnvMap,
  type ManagedContainer,
} from './docker/runtime-pool.ts'
export {
  DockerSubprocessRuntime,
  type DockerSubprocessConfig,
} from './subprocess/docker-subprocess.ts'
export {
  DockerShellExecutor,
  type DockerShellConfig,
} from './shell/docker-shell.ts'
export {
  WorkspaceFencedFileSystem,
  type WorkspaceFencedFsConfig,
} from './fs/workspace-fenced-fs.ts'

import { DockerSubprocessRuntime } from './subprocess/docker-subprocess.ts'
export default DockerSubprocessRuntime
