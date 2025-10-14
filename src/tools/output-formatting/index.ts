/**
 * Output Formatting Tools - Track 2C
 *
 * Intelligent format conversion and output formatting with smart caching
 */

export {
  SmartFormat,
  runSmartFormat,
  SMART_FORMAT_TOOL_DEFINITION,
  type SmartFormatOptions,
  type SmartFormatResult,
  type FormatType,
  type ConversionOperation,
  type FormatConversionResult,
  type BatchConversionResult,
  type ValidationError,
  type FormatDetectionResult,
  type StreamConversionResult,
} from "./smart-format";

export {
  SmartStream,
  runSmartStream,
  SMART_STREAM_TOOL_DEFINITION,
  type SmartStreamOptions,
  type SmartStreamResult,
  type StreamOperation,
  type CompressionFormat,
  type TransformType,
  type StreamMetadata,
  type ProgressState,
  type ChunkSummary,
  type StreamReadResult,
  type StreamWriteResult,
  type StreamTransformResult,
} from "./smart-stream";

export {
  SmartReport,
  runSmartReport,
  SMART_REPORT_TOOL_DEFINITION,
  type SmartReportOptions,
  type SmartReportResult,
  type ReportFormat,
  type ReportOperation,
  type ReportSection,
  type ChartData,
  type ChartType,
  type ReportTemplate,
  type ReportMetadata,
  type GeneratedReport,
} from "./smart-report";

export {
  SmartDiff,
  runSmartDiff,
  SMART_DIFF_TOOL_DEFINITION,
  type SmartDiffOptions,
  type SmartDiffResult,
  type DiffOperation,
  type DiffFormat,
  type DiffGranularity,
  type ConflictResolutionStrategy,
  type DiffHunk,
  type SemanticChange,
  type Conflict,
  type DiffResult,
  type SemanticDiffResult,
  type ConflictDetectionResult,
  type MergePreviewResult,
} from "./smart-diff";

export {
  SmartExport,
  runSmartExport,
  SMART_EXPORT_TOOL_DEFINITION,
  type SmartExportOptions,
  type SmartExportResult,
  type ExportFormat,
  type ExportOperation,
  type ExportMetadata,
  type ExcelExportResult,
  type CSVExportResult,
  type JSONExportResult,
  type ParquetExportResult,
  type SQLExportResult,
  type BatchExportResult,
} from "./smart-export";

export {
  SmartLog,
  runSmartLog,
  SMART_LOG_TOOL_DEFINITION,
  type SmartLogOptions,
  type SmartLogResult,
  type LogOperation,
  type LogFormat,
  type LogLevel,
  type TimeFormat,
  type PatternType,
  type LogEntry,
  type LogPattern,
  type LogFileMetadata,
  type LogIndex,
  type AggregateResult,
  type ParseResult,
  type FilterResult,
  type PatternDetectionResult,
  type TailResult,
} from "./smart-log";

export {
  SmartPretty,
  runSmartPretty,
  SMART_PRETTY_TOOL_DEFINITION,
  type SmartPrettyOptions,
  type SmartPrettyResult,
  type PrettyOperation,
  type OutputMode,
  type ThemeName,
  type ThemeDefinition,
  type HighlightResult,
  type FormatResult,
  type LanguageDetectionResult,
  type ThemeApplicationResult,
} from "./smart-pretty";
