/**
 * Intelligence & AI Tools
 *
 * Every tool in this directory is implemented, registered in
 * TOOL_DEFINITIONS and dispatched by the server. This barrel used to name
 * four of them as "implementation pending" and export one of the twelve,
 * which was wrong in both directions: it described shipped tools as absent,
 * and it left the rest of the directory unreachable through the barrel that
 * every other tool directory provides. Nothing imports it today, so the
 * cost of the stale comments was purely that they told a reader the
 * opposite of what the code does.
 */

export {
  AnomalyExplainer,
  ANOMALYEXPLAINERTOOL,
  runAnomalyExplainer,
} from './anomaly-explainer.js';
export type {
  AnomalyExplainerOptions,
  AnomalyExplainerResult,
} from './anomaly-explainer.js';

export {
  IntelligentAssistant,
  INTELLIGENTASSISTANTTOOL,
  runIntelligentAssistant,
} from './intelligent-assistant.js';
export type {
  IntelligentAssistantOptions,
  IntelligentAssistantResult,
} from './intelligent-assistant.js';

export {
  KnowledgeGraphTool,
  getKnowledgeGraphTool,
  KNOWLEDGE_GRAPH_TOOL_DEFINITION,
} from './knowledge-graph.js';
export type {
  KnowledgeGraphOptions,
  KnowledgeGraphResult,
} from './knowledge-graph.js';

export {
  NaturalLanguageQuery,
  NATURALLANGUAGEQUERYTOOL,
  runNaturalLanguageQuery,
} from './natural-language-query.js';
export type {
  NaturalLanguageQueryOptions,
  NaturalLanguageQueryResult,
} from './natural-language-query.js';

export {
  PatternRecognition,
  PATTERNRECOGNITIONTOOL,
  runPatternRecognition,
} from './pattern-recognition.js';
export type {
  PatternRecognitionOptions,
  PatternRecognitionResult,
} from './pattern-recognition.js';

export {
  PredictiveAnalytics,
  PREDICTIVEANALYTICSTOOL,
  runPredictiveAnalytics,
} from './predictive-analytics.js';
export type {
  PredictiveAnalyticsOptions,
  PredictiveAnalyticsResult,
} from './predictive-analytics.js';

export {
  RecommendationEngine,
  RECOMMENDATIONENGINETOOL,
  runRecommendationEngine,
} from './recommendation-engine.js';
export type {
  RecommendationEngineOptions,
  RecommendationEngineResult,
} from './recommendation-engine.js';

export {
  SentimentAnalysisTool,
  getSentimentAnalysisTool,
  SENTIMENT_ANALYSIS_TOOL_DEFINITION,
} from './sentiment-analysis.js';
export type {
  SentimentAnalysisOptions,
  SentimentAnalysisResult,
} from './sentiment-analysis.js';

export {
  SmartSummarization,
  SMARTSUMMARIZATIONTOOL,
  runSmartSummarization,
} from './smart-summarization.js';
export type {
  SmartSummarizationOptions,
  SmartSummarizationResult,
} from './smart-summarization.js';

export { wikiQuery, WIKI_QUERY_TOOL_DEFINITION } from './wiki-query.js';
export type { WikiQueryOptions, WikiQueryResult } from './wiki-query.js';

export { wikiRead, WIKI_READ_TOOL_DEFINITION } from './wiki-read.js';
export type {
  WikiReadOptions,
  WikiReadResult,
  WikiFinding,
} from './wiki-read.js';

export { wikiWrite, WIKI_WRITE_TOOL_DEFINITION } from './wiki-write.js';
export type { WikiWriteOptions, WikiWriteResult } from './wiki-write.js';
