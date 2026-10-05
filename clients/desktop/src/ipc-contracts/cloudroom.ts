export {
  parseCloudroomCreateResult,
  parseCloudroomEventsResult,
  parseCloudroomHealth,
  parseCloudroomPublicConfig,
  parseCloudroomSessionsResult,
} from "../../../shared/cloudroom";
export type {
  CloudroomCreateInput,
  CloudroomEvent,
  CloudroomHealth,
  CloudroomPublicConfig,
  CloudroomSessionSummary,
  UaoCloudroomApi,
} from "../../../shared/cloudroom";

export const UaoCloudroomChannel = {
  getConfig: "uao-cloudroom:getConfig",
  setConfig: "uao-cloudroom:setConfig",
  setToken: "uao-cloudroom:setToken",
  health: "uao-cloudroom:health",
  listSessions: "uao-cloudroom:listSessions",
  createSession: "uao-cloudroom:createSession",
  events: "uao-cloudroom:events",
} as const;
