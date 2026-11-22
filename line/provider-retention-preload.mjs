import {
  installProviderRetention,
  assertRetainedJournalsClean,
} from "./provider-retention.mjs";
const config = process.env.CLAWDTIME_LINE_RETENTION_CONFIG;
if (!config) throw Error("retention_config_required");
assertRetainedJournalsClean(config);
installProviderRetention(config);
