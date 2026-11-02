import {
  SshSftpChmodResponseSchema,
  SshSftpCopyResponseSchema,
  SshSftpDeleteResponseSchema,
  SshSftpDownloadResponseSchema,
  SshSftpListResponseSchema,
  SshSftpMkdirResponseSchema,
  SshSftpReadResponseSchema,
  SshSftpRenameResponseSchema,
  SshSftpWriteResponseSchema,
  SshTransferCancelResponseSchema,
  SshTransferDismissResponseSchema,
  SshTransferListResponseSchema,
  SshTransferPauseResponseSchema,
  SshTransferProgressSchema,
  SshTransferResumeResponseSchema,
  SshTransferStartResponseSchema,
  type SftpConflictPolicy,
  type SftpEndpoint,
  type SftpEntry,
  type SftpOpenedFile,
  type SftpWriteResult,
  type SshTransfer,
} from "@jagentdesk/protocol/ssh/sftp-schemas";
import {
  SshModuleRpcError,
  callSshModule,
  subscribeSshModule,
  type SshModuleTransport,
} from "../module-rpc";

export interface SftpListing {
  path: string;
  parentPath: string | null;
  entries: SftpEntry[];
}

export interface SftpDeviceDownload {
  transfer: SshTransfer;
  /** Pass to the existing file_download_token_request once the transfer completes. */
  cwd: string;
  path: string;
}

export interface SftpApi {
  list(endpoint: SftpEndpoint, path: string, showHidden: boolean): Promise<SftpListing>;
  mkdir(endpoint: SftpEndpoint, path: string): Promise<void>;
  rename(endpoint: SftpEndpoint, fromPath: string, toPath: string): Promise<void>;
  remove(endpoint: SftpEndpoint, path: string): Promise<void>;
  chmod(endpoint: SftpEndpoint, path: string, mode: string): Promise<void>;
  read(endpoint: SftpEndpoint, path: string): Promise<SftpOpenedFile>;
  write(input: {
    endpoint: SftpEndpoint;
    path: string;
    content: string;
    hasBom: boolean;
    expectedRevision?: string;
  }): Promise<SftpWriteResult>;
  copy(input: {
    source: SftpEndpoint;
    sourcePaths: string[];
    target: SftpEndpoint;
    targetDir: string;
    conflict?: SftpConflictPolicy;
  }): Promise<SshTransfer[]>;
  download(endpoint: SftpEndpoint, path: string): Promise<SftpDeviceDownload>;
  listTransfers(): Promise<SshTransfer[]>;
  startTransfer(transferId: string, conflict?: SftpConflictPolicy): Promise<SshTransfer>;
  pauseTransfer(transferId: string): Promise<SshTransfer>;
  resumeTransfer(transferId: string): Promise<SshTransfer>;
  cancelTransfer(transferId: string): Promise<SshTransfer>;
  dismissTransfer(transferId: string): Promise<void>;
  subscribeTransfers(handler: (transfer: SshTransfer) => void): () => void;
}

function required<T>(value: T | null, what: string): T {
  if (value === null) throw new SshModuleRpcError("failed", `The daemon returned no ${what}`);
  return value;
}

export function createSftpApi(transport: SshModuleTransport): SftpApi {
  return {
    async list(endpoint, path, showHidden) {
      const payload = await callSshModule(transport, SshSftpListResponseSchema, {
        type: "ssh.sftp.list.request",
        endpoint,
        path,
        showHidden,
      });
      return {
        path: required(payload.path, "path"),
        parentPath: payload.parentPath,
        entries: payload.entries,
      };
    },
    async mkdir(endpoint, path) {
      await callSshModule(transport, SshSftpMkdirResponseSchema, {
        type: "ssh.sftp.mkdir.request",
        endpoint,
        path,
      });
    },
    async rename(endpoint, fromPath, toPath) {
      await callSshModule(transport, SshSftpRenameResponseSchema, {
        type: "ssh.sftp.rename.request",
        endpoint,
        fromPath,
        toPath,
      });
    },
    async remove(endpoint, path) {
      await callSshModule(transport, SshSftpDeleteResponseSchema, {
        type: "ssh.sftp.delete.request",
        endpoint,
        path,
      });
    },
    async chmod(endpoint, path, mode) {
      await callSshModule(transport, SshSftpChmodResponseSchema, {
        type: "ssh.sftp.chmod.request",
        endpoint,
        path,
        mode,
      });
    },
    async read(endpoint, path) {
      const payload = await callSshModule(transport, SshSftpReadResponseSchema, {
        type: "ssh.sftp.read.request",
        endpoint,
        path,
      });
      return required(payload.file, "file");
    },
    async write(input) {
      const payload = await callSshModule(transport, SshSftpWriteResponseSchema, {
        type: "ssh.sftp.write.request",
        ...input,
      });
      return required(payload.result, "write result");
    },
    async copy(input) {
      const payload = await callSshModule(transport, SshSftpCopyResponseSchema, {
        type: "ssh.sftp.copy.request",
        ...input,
      });
      return payload.transfers;
    },
    async download(endpoint, path) {
      const payload = await callSshModule(transport, SshSftpDownloadResponseSchema, {
        type: "ssh.sftp.download.request",
        endpoint,
        path,
      });
      const download = required(payload.download, "download");
      return { transfer: required(payload.transfer, "transfer"), ...download };
    },
    async listTransfers() {
      const payload = await callSshModule(transport, SshTransferListResponseSchema, {
        type: "ssh.transfer.list.request",
      });
      return payload.transfers;
    },
    async startTransfer(transferId, conflict) {
      const payload = await callSshModule(transport, SshTransferStartResponseSchema, {
        type: "ssh.transfer.start.request",
        transferId,
        ...(conflict ? { conflict } : {}),
      });
      return required(payload.transfer, "transfer");
    },
    async pauseTransfer(transferId) {
      const payload = await callSshModule(transport, SshTransferPauseResponseSchema, {
        type: "ssh.transfer.pause.request",
        transferId,
      });
      return required(payload.transfer, "transfer");
    },
    async resumeTransfer(transferId) {
      const payload = await callSshModule(transport, SshTransferResumeResponseSchema, {
        type: "ssh.transfer.resume.request",
        transferId,
      });
      return required(payload.transfer, "transfer");
    },
    async cancelTransfer(transferId) {
      const payload = await callSshModule(transport, SshTransferCancelResponseSchema, {
        type: "ssh.transfer.cancel.request",
        transferId,
      });
      return required(payload.transfer, "transfer");
    },
    async dismissTransfer(transferId) {
      await callSshModule(transport, SshTransferDismissResponseSchema, {
        type: "ssh.transfer.dismiss.request",
        transferId,
      });
    },
    subscribeTransfers(handler) {
      return subscribeSshModule(
        transport,
        "ssh.transfer.progress",
        SshTransferProgressSchema,
        (event) => handler(event.transfer),
      );
    },
  };
}
