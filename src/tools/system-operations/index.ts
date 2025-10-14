/**
 * System Operations Tools
 *
 * Track 2C - System-level operations with smart caching
 */

export {
  SmartProcess,
  runSmartProcess,
  SMART_PROCESS_TOOL_DEFINITION,
  type SmartProcessOptions,
  type SmartProcessResult,
  type ProcessInfo,
  type ProcessTreeNode,
  type ResourceSnapshot,
} from "./smart-process";

export {
  SmartService,
  runSmartService,
  SMART_SERVICE_TOOL_DEFINITION,
  type SmartServiceOptions,
  type SmartServiceResult,
  type ServiceType,
  type ServiceStatus,
  type ServiceInfo,
  type HealthCheck,
  type DependencyGraph,
} from "./smart-service";

export {
  SmartNetwork,
  runSmartNetwork,
  SMART_NETWORK_TOOL_DEFINITION,
  type SmartNetworkOptions,
  type SmartNetworkResult,
  type NetworkOperation,
  type PingResult,
  type TracerouteHop,
  type PortScanResult,
  type DNSResult,
  type NetworkInterface,
  type BandwidthResult,
} from "./smart-network";

export {
  SmartCleanup,
  runSmartCleanup,
  SMART_CLEANUP_TOOL_DEFINITION,
  type SmartCleanupOptions,
  type SmartCleanupResult,
  type CleanupOperation,
  type CleanupCategory,
  type FileCandidate,
  type CleanupAnalysis,
  type CleanupPreview,
  type CleanupExecution,
  type CleanupRollback,
  type DiskSpaceEstimate,
} from "./smart-cleanup";

export {
  SmartMetrics,
  runSmartMetrics,
  SMART_METRICS_TOOL_DEFINITION,
  type SmartMetricsOptions,
  type SmartMetricsResult,
  type MetricsOperation,
  type CPUMetrics,
  type MemoryMetrics,
  type DiskMetrics,
  type NetworkMetrics,
  type TemperatureMetrics,
  type TimeSeriesData,
  type CompressedTimeSeries,
} from "./smart-metrics";

export {
  SmartUser,
  runSmartUser,
  SMART_USER_TOOL_DEFINITION,
  type SmartUserOptions,
  type SmartUserResult,
  type UserOperation,
  type UserInfo,
  type GroupInfo,
  type PermissionInfo,
  type ACLEntry,
  type SecurityIssue,
  type SecurityAuditReport,
} from "./smart-user";

export {
  SmartArchive,
  runSmartArchive,
  SMART_ARCHIVE_TOOL_DEFINITION,
  type SmartArchiveOptions,
  type SmartArchiveResult,
  type ArchiveFormat,
  type CompressionLevel,
  type ArchiveOperation,
  type ArchiveEntry,
  type ArchiveMetadata,
  type IncrementalBackupInfo,
  type ArchiveVerificationResult,
} from "./smart-archive";

export {
  SmartCron,
  runSmartCron,
  SMART_CRON_TOOL_DEFINITION,
  type SmartCronOptions,
  type SmartCronResult,
  type CronOperation,
  type SchedulerType,
  type TaskStatus,
  type TriggerType,
  type CronJob,
  type TaskTrigger,
  type ExecutionHistory,
  type ExecutionRecord,
  type NextRunPrediction,
  type ScheduleValidation,
} from "./smart-cron";
