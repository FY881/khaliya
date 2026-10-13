/** Free Agent Army (P16 foundations). See KHALIYA_MASTER_PLAN §2–§3. */
export * from "./audit";
export * from "./autonomy";
export * from "./capability";
export * from "./crypto";
export * from "./divisions";
export * from "./killswitch";
export * from "./missions";
export * from "./passport";
export * from "./ranks";
export { ARMY_JOB_HANDLERS, ARMY_MISSION_KIND, armyMissionJob, BREAKER_RATIO, deterministicPlan, evaluateCriteria, MAX_SUBTASKS, registerArmyJobs, startMission, swarmInit, type Subtask, type SwarmState } from "./swarm";
export { armyRoutes, mountArmyRoutes } from "./routes";
