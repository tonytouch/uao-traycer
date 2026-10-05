export {
  parseAgentOsProbe,
  parseAgentOsPublicConfig,
  parseAgentOsTokenWrite,
} from "../../../shared/agent-os-endpoints";
export type {
  AgentOsEndpointConfig,
  AgentOsProbe,
  AgentOsPublicConfig,
  AgentOsTokenService,
  AgentOsTokenWriteResult,
  UaoAgentOsApi,
} from "../../../shared/agent-os-endpoints";

export const UaoAgentOsChannel = {
  getConfig: "uao-agent-os:getConfig",
  setConfig: "uao-agent-os:setConfig",
  setToken: "uao-agent-os:setToken",
  probe: "uao-agent-os:probe",
} as const;
