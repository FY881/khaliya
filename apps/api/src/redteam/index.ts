/** Red-Team Arena public surface (P8, ARCHITECTURE §18 P8 / §19 C6). */
export * from "./types";
export { SEED_ATTACKS } from "./seed-attacks";
export { DEFAULT_ATTACKER } from "./attacker-genome";
export { detect, DETECTORS, GRADER_INJECTION, isContained, secretsOf, suspicious } from "./detectors";
export { simulateCall, newSimState, isForbiddenTool } from "./gateway-sim";
export { validateAttack, attackProblems, referenceProblems, sanitizeAttack, attackHash, attackSimilarity } from "./validate";
export { runTarget, targetMessages, parseTargetReply, mockTargetReply, mockDefence, stripPayload } from "./target";
export { runCritic, mockCritic, criticMessages, parseCritic, CRITIC_BREACH_AT } from "./critic";
export { generateAttacks, mutateAttack, mockAttackerBrain, attackerMessages } from "./attacker";
export { evaluateAttack, probe, confirmStep, createRegression, regressionGates, regressionItemSpec, transcriptOf, REPRODUCTIONS, type CriticMode } from "./arena";
export * from "./store";
export { redteamGate, type RedteamGateCandidate, type RedteamGateContext, type RedteamGateResult } from "./gate";
export { redteamCampaignJob, redteamCampaignInit, campaignTargets, registerRedteamHandlers, REDTEAM_HANDLERS, REDTEAM_CAMPAIGN_KIND, CampaignError, type CampaignParams, type CampaignState } from "./jobs";
export { redteamRoutes, mountRedteamRoutes, attackView } from "./routes";
