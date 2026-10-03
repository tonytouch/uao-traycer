import { contextBridge, ipcRenderer } from "electron";
import { parseOfficeTabs, type UaoOfficeApi } from "../ipc-contracts/uao-office";

const api: UaoOfficeApi = {
  list: async () => parseOfficeTabs(await ipcRenderer.invoke("uao-office:list")),
  create: async kind => { await ipcRenderer.invoke("uao-office:create", kind); },
  browse: async () => { await ipcRenderer.invoke("uao-office:browse"); },
  activate: async id => { await ipcRenderer.invoke("uao-office:activate", id); },
  close: async id => { await ipcRenderer.invoke("uao-office:close", id); },
  setViewport: bounds => { ipcRenderer.send("uao-office:viewport", bounds); },
  onChanged: handler => {
    const listener = () => handler();
    ipcRenderer.on("uao-office:changed", listener);
    return () => { ipcRenderer.removeListener("uao-office:changed", listener); };
  },
};
contextBridge.exposeInMainWorld("uaoOffice", api);

