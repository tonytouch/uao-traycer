export {
  parseOpenMuseHealth,
  parseOpenMusePublicConfig,
} from "../../../shared/openmuse";
export type {
  OpenMuseEndpointConfig,
  OpenMuseHealth,
  UaoOpenMuseApi,
} from "../../../shared/openmuse";

export const UaoOpenMuseChannel = {
  getConfig: "uao-openmuse:getConfig",
  setConfig: "uao-openmuse:setConfig",
  health: "uao-openmuse:health",
} as const;
