import { contextBridge, ipcRenderer } from "electron";
import {
  parseAgentOsProbe,
  parseAgentOsPublicConfig,
  parseAgentOsTokenWrite,
  UaoAgentOsChannel,
  type UaoAgentOsApi,
} from "../ipc-contracts/agent-os";
import {
  parseCloudroomCreateResult,
  parseCloudroomEventsResult,
  parseCloudroomHealth,
  parseCloudroomPublicConfig,
  parseCloudroomSessionsResult,
  UaoCloudroomChannel,
  type UaoCloudroomApi,
} from "../ipc-contracts/cloudroom";
import {
  parseOfficeTabs,
  type UaoOfficeApi,
} from "../ipc-contracts/uao-office";

const api: UaoOfficeApi = {
  list: async () =>
    parseOfficeTabs(await ipcRenderer.invoke("uao-office:list")),
  create: async (kind) => {
    await ipcRenderer.invoke("uao-office:create", kind);
  },
  browse: async () => {
    await ipcRenderer.invoke("uao-office:browse");
  },
  activate: async (id) => {
    await ipcRenderer.invoke("uao-office:activate", id);
  },
  close: async (id) => {
    await ipcRenderer.invoke("uao-office:close", id);
  },
  setViewport: (bounds) => {
    ipcRenderer.send("uao-office:viewport", bounds);
  },
  onChanged: (handler) => {
    const listener = () => handler();
    ipcRenderer.on("uao-office:changed", listener);
    return () => {
      ipcRenderer.removeListener("uao-office:changed", listener);
    };
  },
};
contextBridge.exposeInMainWorld("uaoOffice", api);

const agentOs: UaoAgentOsApi = {
  getConfig: async () =>
    parseAgentOsPublicConfig(
      await ipcRenderer.invoke(UaoAgentOsChannel.getConfig),
    ),
  setConfig: async (draft) =>
    parseAgentOsPublicConfig(
      await ipcRenderer.invoke(UaoAgentOsChannel.setConfig, draft),
    ),
  setToken: async (service, token) =>
    parseAgentOsTokenWrite(
      await ipcRenderer.invoke(UaoAgentOsChannel.setToken, service, token),
    ),
  probe: async () =>
    parseAgentOsProbe(await ipcRenderer.invoke(UaoAgentOsChannel.probe)),
};
contextBridge.exposeInMainWorld("uaoAgentOs", agentOs);

const cloudroom: UaoCloudroomApi = {
  getConfig: async () =>
    parseCloudroomPublicConfig(
      await ipcRenderer.invoke(UaoCloudroomChannel.getConfig),
    ),
  setConfig: async (draft) =>
    parseCloudroomPublicConfig(
      await ipcRenderer.invoke(UaoCloudroomChannel.setConfig, draft),
    ),
  setToken: async (token) =>
    parseAgentOsTokenWrite(
      await ipcRenderer.invoke(UaoCloudroomChannel.setToken, token),
    ),
  health: async () =>
    parseCloudroomHealth(await ipcRenderer.invoke(UaoCloudroomChannel.health)),
  listSessions: async () =>
    parseCloudroomSessionsResult(
      await ipcRenderer.invoke(UaoCloudroomChannel.listSessions),
    ),
  createSession: async (input) =>
    parseCloudroomCreateResult(
      await ipcRenderer.invoke(UaoCloudroomChannel.createSession, input),
    ),
  events: async (sessionId, after) =>
    parseCloudroomEventsResult(
      await ipcRenderer.invoke(UaoCloudroomChannel.events, sessionId, after),
    ),
};
contextBridge.exposeInMainWorld("uaoCloudroom", cloudroom);
