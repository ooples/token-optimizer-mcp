/**
 * DataVisualizer - Advanced data visualization with multiple chart types and interactive features
 * Track 2E - Tool #8
 *
 * Target: 1,620 lines, 91% token reduction
 * Operations: 8 (create-chart, update-chart, export-chart, create-heatmap, create-timeline, create-network-graph, create-sankey, animate)
 */

import { CacheEngine } from "../../core/cache-engine";
import { TokenCounter } from "../../core/token-counter";
import { MetricsCollector } from "../../core/metrics";
import { createHash } from "crypto";

// ============================================================================
// Type Definitions
// ============================================================================

export interface DataVisualizerOptions {
  operation:
    | "create-chart"
    | "update-chart"
    | "export-chart"
    | "create-heatmap"
    | "create-timeline"
    | "create-network-graph"
    | "create-sankey"
    | "animate";

  // Chart identification
  chartId?: string;
  chartName?: string;

  // Data
  data?: any[];
  dataFormat?: "json" | "csv" | "array";

  // Chart type and configuration
  chartType?:
    | "line"
    | "bar"
    | "pie"
    | "scatter"
    | "area"
    | "radar"
    | "bubble"
    | "candlestick"
    | "waterfall"
    | "funnel";

  chartConfig?: {
    title?: string;
    subtitle?: string;
    xAxis?: AxisConfig;
    yAxis?: AxisConfig;
    series?: SeriesConfig[];
    legend?: LegendConfig;
    tooltip?: TooltipConfig;
    colors?: string[];
    theme?: "light" | "dark" | "custom";
    responsive?: boolean;
    animations?: boolean;
  };

  // Heatmap configuration
  heatmapConfig?: {
    xLabels: string[];
    yLabels: string[];
    values: number[][];
    colorScale?: "linear" | "logarithmic" | "threshold";
    colors?: { min: string; mid?: string; max: string };
  };

  // Timeline configuration
  timelineConfig?: {
    events: Array<{
      time: number;
      label: string;
      description?: string;
      category?: string;
    }>;
    groupBy?: string;
    showMarkers?: boolean;
  };

  // Network graph configuration
  networkConfig?: {
    nodes: Array<{ id: string; label?: string; group?: string }>;
    edges: Array<{ source: string; target: string; weight?: number }>;
    layout?: "force" | "circular" | "hierarchical" | "grid";
    physics?: boolean;
  };

  // Sankey configuration
  sankeyConfig?: {
    nodes: Array<{ name: string; category?: string }>;
    links: Array<{ source: string; target: string; value: number }>;
  };

  // Animation configuration
  animationConfig?: {
    frames: number;
    duration: number; // seconds
    transition?: "linear" | "ease" | "ease-in" | "ease-out";
  };

  // Export options
  exportFormat?: "png" | "svg" | "pdf" | "html" | "json";
  exportWidth?: number;
  exportHeight?: number;

  // Cache options
  useCache?: boolean;
  cacheTTL?: number;
}

export interface AxisConfig {
  field?: string;
  label?: string;
  format?: string;
  scale?: "linear" | "logarithmic" | "time" | "category";
  min?: number;
  max?: number;
  gridLines?: boolean;
  ticks?: {
    stepSize?: number;
    callback?: string; // JavaScript function as string
  };
}

export interface SeriesConfig {
  field: string;
  label?: string;
  color?: string;
  type?: "line" | "bar" | "area" | "scatter";
  fill?: boolean;
  borderWidth?: number;
  pointRadius?: number;
  tension?: number; // Curve tension for line charts
}

export interface LegendConfig {
  display?: boolean;
  position?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  labels?: {
    color?: string;
    font?: {
      size?: number;
      family?: string;
      weight?: string;
    };
  };
}

export interface TooltipConfig {
  enabled?: boolean;
  mode?: "index" | "dataset" | "point" | "nearest";
  intersect?: boolean;
  callbacks?: {
    label?: string; // JavaScript function as string
    title?: string;
  };
}

export interface Chart {
  id: string;
  name: string;
  type: string;
  config: any;
  data: any[];
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, any>;
}

export interface DataVisualizerResult {
  success: boolean;
  data?: {
    chart?: Chart;
    rendered?: string | Buffer;
    exported?: { path?: string; data: Buffer };
  };
  metadata: {
    tokensUsed?: number;
    tokensSaved?: number;
    cacheHit: boolean;
    dataPoints?: number;
  };
  error?: string;
}

// ============================================================================
// DataVisualizer Class
// ============================================================================

export class DataVisualizer {
  private charts: Map<string, Chart> = new Map();
  private chartCounter = 0;

  constructor(
    private cache: CacheEngine,
    private tokenCounter: TokenCounter,
    private metricsCollector: MetricsCollector,
  ) {}

  /**
   * Main entry point for all data visualizer operations
   */
  async run(options: DataVisualizerOptions): Promise<DataVisualizerResult> {
    const startTime = Date.now();

    try {
      // Route to appropriate operation handler
      let result: DataVisualizerResult;

      switch (options.operation) {
        case "create-chart":
          result = await this.createChart(options);
          break;
        case "update-chart":
          result = await this.updateChart(options);
          break;
        case "export-chart":
          result = await this.exportChart(options);
          break;
        case "create-heatmap":
          result = await this.createHeatmap(options);
          break;
        case "create-timeline":
          result = await this.createTimeline(options);
          break;
        case "create-network-graph":
          result = await this.createNetworkGraph(options);
          break;
        case "create-sankey":
          result = await this.createSankey(options);
          break;
        case "animate":
          result = await this.animate(options);
          break;
        default:
          throw new Error(`Unknown operation: ${options.operation}`);
      }

      // Record metrics
      this.metricsCollector.record({
        operation: `data-visualizer:${options.operation}`,
        duration: Date.now() - startTime,
        success: result.success,
        cacheHit: result.metadata.cacheHit,
      });

      return result;
    } catch (error) {
      // Record error metrics
      this.metricsCollector.record({
        operation: `data-visualizer:${options.operation}`,
        duration: Date.now() - startTime,
        success: false,
        cacheHit: false,
      });

      return {
        success: false,
        metadata: {
          cacheHit: false,
          dataPoints: options.data?.length || 0,
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ============================================================================
  // Operation 1: Create Chart
  // ============================================================================

  private async createChart(
    options: DataVisualizerOptions,
  ): Promise<DataVisualizerResult> {
    if (!options.data || !options.chartType) {
      throw new Error(
        "Data and chart type are required for create-chart operation",
      );
    }

    // Generate cache key based on data and config
    const cacheKey = this.generateCacheKey("create-chart", options);

    // Check cache
    if (options.useCache !== false) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        const chart = JSON.parse(cached.toString()) as Chart;
        const tokensSaved = this.tokenCounter.count(
          JSON.stringify(chart),
        ).tokens;

        return {
          success: true,
          data: { chart },
          metadata: {
            tokensSaved,
            cacheHit: true,
            dataPoints: options.data.length,
          },
        };
      }
    }

    // Create chart
    const chartId = options.chartId || this.generateChartId();
    const chart: Chart = {
      id: chartId,
      name: options.chartName || `Chart ${chartId}`,
      type: options.chartType,
      config: this.buildChartConfig(options),
      data: options.data,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        dataFormat: options.dataFormat || "json",
        dataPoints: options.data.length,
      },
    };

    // Store chart
    this.charts.set(chartId, chart);

    // Cache the result
    const tokensUsed = this.tokenCounter.count(JSON.stringify(chart)).tokens;
    const cacheData = JSON.stringify(chart));
    this.cache.set(
      cacheKey,
      cacheData,
      tokensUsed,
      options.cacheTTL || 3600,
    );

    return {
      success: true,
      data: { chart },
      metadata: {
        tokensUsed,
        cacheHit: false,
        dataPoints: options.data.length,
      },
    };
  }

  // ============================================================================
  // Operation 2: Update Chart
  // ============================================================================

  private async updateChart(
    options: DataVisualizerOptions,
  ): Promise<DataVisualizerResult> {
    if (!options.chartId) {
      throw new Error("Chart ID is required for update-chart operation");
    }

    const existingChart = this.charts.get(options.chartId);
    if (!existingChart) {
      throw new Error(`Chart not found: ${options.chartId}`);
    }

    // Update chart
    const updatedChart: Chart = {
      ...existingChart,
      name: options.chartName || existingChart.name,
      type: (options.chartType || existingChart.type) as string,
      config: options.chartConfig
        ? this.buildChartConfig(options)
        : existingChart.config,
      data: options.data || existingChart.data,
      updatedAt: Date.now(),
    };

    // Store updated chart
    this.charts.set(options.chartId, updatedChart);

    // Invalidate cache for this chart
    const cacheKey = this.generateCacheKey("create-chart", {
      ...options,
      data: updatedChart.data,
      chartType: updatedChart.type as any,
    });
    this.cache.delete(cacheKey);

    const tokensUsed = this.tokenCounter.count(
      JSON.stringify(updatedChart),
    ).tokens;

    return {
      success: true,
      data: { chart: updatedChart },
      metadata: {
        tokensUsed,
        cacheHit: false,
        dataPoints: updatedChart.data.length,
      },
    };
  }

  // ============================================================================
  // Operation 3: Export Chart
  // ============================================================================

  private async exportChart(
    options: DataVisualizerOptions,
  ): Promise<DataVisualizerResult> {
    if (!options.chartId) {
      throw new Error("Chart ID is required for export-chart operation");
    }

    const chart = this.charts.get(options.chartId);
    if (!chart) {
      throw new Error(`Chart not found: ${options.chartId}`);
    }

    const format = options.exportFormat || "svg";
    const cacheKey = this.generateCacheKey("export-chart", options);

    // Check cache for rendered output
    if (options.useCache !== false) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        const tokensSaved = this.tokenCounter.count(cached.toString()).tokens;

        return {
          success: true,
          data: {
            rendered:
              format === "svg" || format === "html"
                ? cached.toString()
                : cached,
            exported: { data: cached },
          },
          metadata: {
            tokensSaved,
            cacheHit: true,
            dataPoints: chart.data.length,
          },
        };
      }
    }

    // Export chart based on format
    let exported: Buffer;

    switch (format) {
      case "svg":
        exported = await this.exportToSVG(chart, options);
        break;
      case "png":
        exported = await this.exportToPNG(chart, options);
        break;
      case "pdf":
        exported = await this.exportToPDF(chart, options);
        break;
      case "html":
        exported = await this.exportToHTML(chart, options);
        break;
      case "json":
        exported = JSON.stringify(chart, null, 2));
        break;
      default:
        throw new Error(`Unsupported export format: ${format}`);
    }

    // Cache the exported result
    const tokensUsed = this.tokenCounter.count(exported.toString()).tokens;
    this.cache.set(
      cacheKey,
      exported.toString("utf-8"),
      tokensUsed,
      options.cacheTTL || 1800,
    );

    return {
      success: true,
      data: {
        rendered:
          format === "svg" || format === "html"
            ? exported.toString()
            : exported,
        exported: { data: exported },
      },
      metadata: {
        tokensUsed,
        cacheHit: false,
        dataPoints: chart.data.length,
      },
    };
  }

  // ============================================================================
  // Operation 4: Create Heatmap
  // ============================================================================

  private async createHeatmap(
    options: DataVisualizerOptions,
  ): Promise<DataVisualizerResult> {
    if (!options.heatmapConfig) {
      throw new Error(
        "Heatmap configuration is required for create-heatmap operation",
      );
    }

    const {
      xLabels,
      yLabels,
      values,
      colorScale = "linear",
      colors,
    } = options.heatmapConfig;

    if (!xLabels || !yLabels || !values) {
      throw new Error("xLabels, yLabels, and values are required for heatmap");
    }

    // Validate dimensions
    if (values.length !== yLabels.length) {
      throw new Error("Number of rows in values must match yLabels length");
    }
    if (values[0].length !== xLabels.length) {
      throw new Error("Number of columns in values must match xLabels length");
    }

    const cacheKey = this.generateCacheKey("create-heatmap", options);

    // Check cache
    if (options.useCache !== false) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        const tokensSaved = this.tokenCounter.count(cached.toString()).tokens;

        return {
          success: true,
          data: { rendered: cached.toString() },
          metadata: {
            tokensSaved,
            cacheHit: true,
            dataPoints: values.flat().length,
          },
        };
      }
    }

    // Create heatmap SVG
    const svg = this.generateHeatmapSVG(
      xLabels,
      yLabels,
      values,
      colorScale,
      colors,
    );

    // Cache the result
    const tokensUsed = this.tokenCounter.count(svg).tokens;
    const cacheData = Buffer.from(svg);
    this.cache.set(
      cacheKey,
      cacheData,
      tokensUsed,
      options.cacheTTL || 3600,
    );

    return {
      success: true,
      data: { rendered: svg },
      metadata: {
        tokensUsed,
        cacheHit: false,
        dataPoints: values.flat().length,
      },
    };
  }

  // ============================================================================
  // Operation 5: Create Timeline
  // ============================================================================

  private async createTimeline(
    options: DataVisualizerOptions,
  ): Promise<DataVisualizerResult> {
    if (!options.timelineConfig || !options.timelineConfig.events) {
      throw new Error(
        "Timeline configuration with events is required for create-timeline operation",
      );
    }

    const { events, showMarkers = true, groupBy } = options.timelineConfig;

    const cacheKey = this.generateCacheKey("create-timeline", options);

    // Check cache
    if (options.useCache !== false) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        const tokensSaved = this.tokenCounter.count(cached.toString()).tokens;

        return {
          success: true,
          data: { rendered: cached.toString() },
          metadata: {
            tokensSaved,
            cacheHit: true,
            dataPoints: events.length,
          },
        };
      }
    }

    // Create timeline SVG
    const svg = this.generateTimelineSVG(events, groupBy, showMarkers);

    // Cache the result
    const tokensUsed = this.tokenCounter.count(svg).tokens;
    const cacheData = Buffer.from(svg);
    this.cache.set(
      cacheKey,
      cacheData,
      tokensUsed,
      options.cacheTTL || 3600,
    );

    return {
      success: true,
      data: { rendered: svg },
      metadata: {
        tokensUsed,
        cacheHit: false,
        dataPoints: events.length,
      },
    };
  }

  // ============================================================================
  // Operation 6: Create Network Graph
  // ============================================================================

  private async createNetworkGraph(
    options: DataVisualizerOptions,
  ): Promise<DataVisualizerResult> {
    if (!options.networkConfig) {
      throw new Error(
        "Network configuration is required for create-network-graph operation",
      );
    }

    const {
      nodes,
      edges,
      layout = "force",
      physics = true,
    } = options.networkConfig;

    if (!nodes || !edges) {
      throw new Error("Nodes and edges are required for network graph");
    }

    const cacheKey = this.generateCacheKey("create-network-graph", options);

    // Check cache
    if (options.useCache !== false) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        const tokensSaved = this.tokenCounter.count(cached.toString()).tokens;

        return {
          success: true,
          data: { rendered: cached.toString() },
          metadata: {
            tokensSaved,
            cacheHit: true,
            dataPoints: nodes.length + edges.length,
          },
        };
      }
    }

    // Create network graph SVG
    const svg = this.generateNetworkGraphSVG(nodes, edges, layout, physics);

    // Cache the result
    const tokensUsed = this.tokenCounter.count(svg).tokens;
    const cacheData = Buffer.from(svg);
    this.cache.set(
      cacheKey,
      cacheData,
      tokensUsed,
      options.cacheTTL || 3600,
    );

    return {
      success: true,
      data: { rendered: svg },
      metadata: {
        tokensUsed,
        cacheHit: false,
        dataPoints: nodes.length + edges.length,
      },
    };
  }

  // ============================================================================
  // Operation 7: Create Sankey
  // ============================================================================

  private async createSankey(
    options: DataVisualizerOptions,
  ): Promise<DataVisualizerResult> {
    if (!options.sankeyConfig) {
      throw new Error(
        "Sankey configuration is required for create-sankey operation",
      );
    }

    const { nodes, links } = options.sankeyConfig;

    if (!nodes || !links) {
      throw new Error("Nodes and links are required for Sankey diagram");
    }

    const cacheKey = this.generateCacheKey("create-sankey", options);

    // Check cache
    if (options.useCache !== false) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        const tokensSaved = this.tokenCounter.count(cached.toString()).tokens;

        return {
          success: true,
          data: { rendered: cached.toString() },
          metadata: {
            tokensSaved,
            cacheHit: true,
            dataPoints: nodes.length + links.length,
          },
        };
      }
    }

    // Create Sankey diagram SVG
    const svg = this.generateSankeySVG(nodes, links);

    // Cache the result
    const tokensUsed = this.tokenCounter.count(svg).tokens;
    const cacheData = Buffer.from(svg);
    this.cache.set(
      cacheKey,
      cacheData,
      tokensUsed,
      options.cacheTTL || 3600,
    );

    return {
      success: true,
      data: { rendered: svg },
      metadata: {
        tokensUsed,
        cacheHit: false,
        dataPoints: nodes.length + links.length,
      },
    };
  }

  // ============================================================================
  // Operation 8: Animate
  // ============================================================================

  private async animate(
    options: DataVisualizerOptions,
  ): Promise<DataVisualizerResult> {
    if (!options.chartId) {
      throw new Error("Chart ID is required for animate operation");
    }

    if (!options.animationConfig) {
      throw new Error(
        "Animation configuration is required for animate operation",
      );
    }

    const chart = this.charts.get(options.chartId);
    if (!chart) {
      throw new Error(`Chart not found: ${options.chartId}`);
    }

    const { frames, duration, transition = "ease" } = options.animationConfig;

    const cacheKey = this.generateCacheKey("animate", options);

    // Check cache
    if (options.useCache !== false) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        const tokensSaved = this.tokenCounter.count(cached.toString()).tokens;

        return {
          success: true,
          data: { rendered: cached.toString() },
          metadata: {
            tokensSaved,
            cacheHit: true,
            dataPoints: chart.data.length,
          },
        };
      }
    }

    // Generate animated visualization
    const animated = this.generateAnimatedVisualization(
      chart,
      frames,
      duration,
      transition,
    );

    // Cache the result
    const tokensUsed = this.tokenCounter.count(animated).tokens;
    const cacheData = Buffer.from(animated);
    this.cache.set(
      cacheKey,
      cacheData,
      tokensUsed,
      options.cacheTTL || 1800,
    );

    return {
      success: true,
      data: { rendered: animated },
      metadata: {
        tokensUsed,
        cacheHit: false,
        dataPoints: chart.data.length,
      },
    };
  }

  // ============================================================================
  // Helper Methods - Chart Building
  // ============================================================================

  private buildChartConfig(options: DataVisualizerOptions): any {
    const config = options.chartConfig || {};

    return {
      type: options.chartType,
      data: this.formatChartData(
        options.data || [],
        options.chartType || "line",
        config.series,
      ),
      options: {
        responsive: config.responsive !== false,
        maintainAspectRatio: true,
        plugins: {
          title: {
            display: !!config.title,
            text: config.title || "",
          },
          subtitle: {
            display: !!config.subtitle,
            text: config.subtitle || "",
          },
          legend: this.buildLegendConfig(config.legend),
          tooltip: this.buildTooltipConfig(config.tooltip),
        },
        scales: this.buildScalesConfig(config.xAxis, config.yAxis),
        animation: config.animations !== false,
      },
    };
  }

  private formatChartData(
    data: any[],
    chartType: string,
    series?: SeriesConfig[],
  ): any {
    if (!series || series.length === 0) {
      // Auto-detect data format
      return {
        labels: data.map((_, i) => `Point ${i + 1}`),
        datasets: [
          {
            label: "Data",
            data: data,
            borderColor: "#4BC0C0",
            backgroundColor: "rgba(75, 192, 192, 0.2)",
            fill: chartType === "area",
          },
        ],
      };
    }

    // Extract labels from first data point
    const labels = data.map((d) => d[series[0].field] || "");

    const datasets = series.map((s, i) => ({
      label: s.label || s.field,
      data: data.map((d) => d[s.field]),
      type: s.type || chartType,
      borderColor: s.color || this.getDefaultColor(i),
      backgroundColor: s.fill ? this.getDefaultColor(i, 0.2) : "transparent",
      borderWidth: s.borderWidth || 2,
      pointRadius: s.pointRadius || 3,
      tension: s.tension || 0.4,
      fill: s.fill || false,
    }));

    return { labels, datasets };
  }

  private buildLegendConfig(legend?: LegendConfig): any {
    if (!legend) {
      return { display: true };
    }

    return {
      display: legend.display !== false,
      position: legend.position || "top",
      align: legend.align || "center",
      labels: {
        color: legend.labels?.color || "#666",
        font: {
          size: legend.labels?.font?.size || 12,
          family: legend.labels?.font?.family || "Arial",
          weight: legend.labels?.font?.weight || "normal",
        },
      },
    };
  }

  private buildTooltipConfig(tooltip?: TooltipConfig): any {
    if (!tooltip) {
      return { enabled: true };
    }

    return {
      enabled: tooltip.enabled !== false,
      mode: tooltip.mode || "index",
      intersect: tooltip.intersect || false,
    };
  }

  private buildScalesConfig(xAxis?: AxisConfig, yAxis?: AxisConfig): any {
    const scales: any = {};

    if (xAxis) {
      scales.x = {
        type: xAxis.scale || "category",
        display: true,
        title: {
          display: !!xAxis.label,
          text: xAxis.label || "",
        },
        grid: {
          display: xAxis.gridLines !== false,
        },
        min: xAxis.min,
        max: xAxis.max,
        ticks: xAxis.ticks,
      };
    }

    if (yAxis) {
      scales.y = {
        type: yAxis.scale || "linear",
        display: true,
        title: {
          display: !!yAxis.label,
          text: yAxis.label || "",
        },
        grid: {
          display: yAxis.gridLines !== false,
        },
        min: yAxis.min,
        max: yAxis.max,
        ticks: yAxis.ticks,
      };
    }

    return scales;
  }

  // ============================================================================
  // Helper Methods - SVG Generation
  // ============================================================================

  private generateHeatmapSVG(
    xLabels: string[],
    yLabels: string[],
    values: number[][],
    colorScale: string,
    colors?: { min: string; mid?: string; max: string },
  ): string {
    const width = 800;
    const height = 600;
    const cellWidth = (width - 100) / xLabels.length;
    const cellHeight = (height - 100) / yLabels.length;

    // Find min and max values
    const flatValues = values.flat();
    const minValue = Math.min(...flatValues);
    const maxValue = Math.max(...flatValues);

    const colorScheme = colors || { min: "#0000ff", max: "#ff0000" };

    let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
    svg += `<style>.cell { stroke: #fff; stroke-width: 2; } .label { font-family: Arial; font-size: 12px; fill: #333; }</style>`;

    // Draw cells
    for (let y = 0; y < yLabels.length; y++) {
      for (let x = 0; x < xLabels.length; x++) {
        const value = values[y][x];
        const color = this.interpolateColor(
          value,
          minValue,
          maxValue,
          colorScheme.min,
          colorScheme.max,
          colorScale,
        );

        const cx = 80 + x * cellWidth;
        const cy = 50 + y * cellHeight;

        svg += `<rect class="cell" x="${cx}" y="${cy}" width="${cellWidth}" height="${cellHeight}" fill="${color}">`;
        svg += `<title>${yLabels[y]} - ${xLabels[x]}: ${value.toFixed(2)}</title>`;
        svg += `</rect>`;
      }
    }

    // Draw x-axis labels
    for (let x = 0; x < xLabels.length; x++) {
      const cx = 80 + x * cellWidth + cellWidth / 2;
      svg += `<text class="label" x="${cx}" y="${height - 20}" text-anchor="middle">${xLabels[x]}</text>`;
    }

    // Draw y-axis labels
    for (let y = 0; y < yLabels.length; y++) {
      const cy = 50 + y * cellHeight + cellHeight / 2;
      svg += `<text class="label" x="50" y="${cy}" text-anchor="end" dominant-baseline="middle">${yLabels[y]}</text>`;
    }

    // Color scale legend
    svg += this.generateColorScaleLegend(
      minValue,
      maxValue,
      colorScheme,
      width - 50,
      50,
    );

    svg += `</svg>`;
    return svg;
  }

  private generateTimelineSVG(
    events: Array<{
      time: number;
      label: string;
      description?: string;
      category?: string;
    }>,
    _groupBy?: string,
    showMarkers?: boolean,
  ): string {
    const width = 1000;
    const height = 400;
    const margin = { top: 50, right: 50, bottom: 50, left: 100 };

    // Sort events by time
    const sortedEvents = [...events].sort((a, b) => a.time - b.time);

    const minTime = sortedEvents[0].time;
    const maxTime = sortedEvents[sortedEvents.length - 1].time;
    const timeRange = maxTime - minTime;

    let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
    svg += `<style>`;
    svg += `.timeline-line { stroke: #333; stroke-width: 2; }`;
    svg += `.event-marker { fill: #4BC0C0; stroke: #333; stroke-width: 1; }`;
    svg += `.event-label { font-family: Arial; font-size: 12px; fill: #333; }`;
    svg += `.event-desc { font-family: Arial; font-size: 10px; fill: #666; }`;
    svg += `</style>`;

    // Draw main timeline
    const timelineY = height / 2;
    svg += `<line class="timeline-line" x1="${margin.left}" y1="${timelineY}" x2="${width - margin.right}" y2="${timelineY}" />`;

    // Draw events
    const availableWidth = width - margin.left - margin.right;

    for (let i = 0; i < sortedEvents.length; i++) {
      const event = sortedEvents[i];
      const x =
        margin.left + ((event.time - minTime) / timeRange) * availableWidth;
      const y = timelineY;

      // Alternate event positions above and below timeline
      const offsetY = i % 2 === 0 ? -30 : 30;
      const labelY = y + offsetY;

      if (showMarkers) {
        svg += `<circle class="event-marker" cx="${x}" cy="${y}" r="6">`;
        svg += `<title>${event.label}: ${new Date(event.time).toLocaleString()}</title>`;
        svg += `</circle>`;

        // Connect marker to label
        svg += `<line stroke="#ccc" stroke-width="1" x1="${x}" y1="${y}" x2="${x}" y2="${labelY - 10}" />`;
      }

      // Event label
      svg += `<text class="event-label" x="${x}" y="${labelY}" text-anchor="middle">${event.label}</text>`;

      if (event.description) {
        svg += `<text class="event-desc" x="${x}" y="${labelY + 15}" text-anchor="middle">${event.description}</text>`;
      }
    }

    // Time axis labels
    const numLabels = 5;
    for (let i = 0; i <= numLabels; i++) {
      const t = minTime + (timeRange * i) / numLabels;
      const x = margin.left + (availableWidth * i) / numLabels;
      svg += `<text class="event-label" x="${x}" y="${height - 20}" text-anchor="middle">${new Date(t).toLocaleDateString()}</text>`;
    }

    svg += `</svg>`;
    return svg;
  }

  private generateNetworkGraphSVG(
    nodes: Array<{ id: string; label?: string; group?: string }>,
    edges: Array<{ source: string; target: string; weight?: number }>,
    layout: string,
    _physics: boolean,
  ): string {
    const width = 800;
    const height = 600;

    // Calculate node positions based on layout
    const positions = this.calculateNodePositions(
      nodes,
      edges,
      layout,
      width,
      height,
    );

    let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
    svg += `<style>`;
    svg += `.edge { stroke: #999; stroke-width: 1; stroke-opacity: 0.6; }`;
    svg += `.node { fill: #4BC0C0; stroke: #333; stroke-width: 2; cursor: pointer; }`;
    svg += `.node:hover { fill: #FF6384; }`;
    svg += `.node-label { font-family: Arial; font-size: 12px; fill: #333; text-anchor: middle; }`;
    svg += `</style>`;

    // Draw edges first (so nodes appear on top)
    for (const edge of edges) {
      const sourcePos = positions.get(edge.source);
      const targetPos = positions.get(edge.target);

      if (sourcePos && targetPos) {
        const strokeWidth = edge.weight ? Math.sqrt(edge.weight) : 1;
        svg += `<line class="edge" x1="${sourcePos.x}" y1="${sourcePos.y}" x2="${targetPos.x}" y2="${targetPos.y}" stroke-width="${strokeWidth}">`;
        svg += `<title>${edge.source} → ${edge.target}${edge.weight ? `: ${edge.weight}` : ""}</title>`;
        svg += `</line>`;
      }
    }

    // Draw nodes
    for (const node of nodes) {
      const pos = positions.get(node.id);
      if (!pos) continue;

      svg += `<circle class="node" cx="${pos.x}" cy="${pos.y}" r="8">`;
      svg += `<title>${node.label || node.id}</title>`;
      svg += `</circle>`;

      svg += `<text class="node-label" x="${pos.x}" y="${pos.y - 15}">${node.label || node.id}</text>`;
    }

    svg += `</svg>`;
    return svg;
  }

  private generateSankeySVG(
    nodes: Array<{ name: string; category?: string }>,
    links: Array<{ source: string; target: string; value: number }>,
  ): string {
    const width = 1000;
    const height = 600;
    const nodeWidth = 30;
    const nodePadding = 20;

    // Build node index
    const nodeIndex = new Map(nodes.map((n, i) => [n.name, i]));

    // Calculate node levels and values
    const nodeLevels = this.calculateSankeyLevels(nodes, links);
    const nodeValues = this.calculateSankeyNodeValues(nodes, links);

    let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
    svg += `<style>`;
    svg += `.sankey-link { fill: none; stroke-opacity: 0.3; }`;
    svg += `.sankey-node { stroke: #333; stroke-width: 1; }`;
    svg += `.node-label { font-family: Arial; font-size: 12px; fill: #333; }`;
    svg += `</style>`;

    // Calculate positions
    const maxLevel = Math.max(...nodeLevels.values());
    const levelWidth = (width - 100) / (maxLevel + 1);

    const nodePositions = new Map<
      string,
      { x: number; y: number; height: number }
    >();

    // Group nodes by level
    const levelGroups = new Map<number, string[]>();
    for (const [node, level] of nodeLevels.entries()) {
      if (!levelGroups.has(level)) levelGroups.set(level, []);
      levelGroups.get(level)!.push(node);
    }

    // Calculate vertical positions
    for (const [level, nodesInLevel] of levelGroups.entries()) {
      const totalValue = nodesInLevel.reduce(
        (sum, n) => sum + (nodeValues.get(n) || 0),
        0,
      );
      const scale = (height - 100) / totalValue;

      let currentY = 50;
      for (const nodeName of nodesInLevel) {
        const value = nodeValues.get(nodeName) || 0;
        const nodeHeight = value * scale;

        nodePositions.set(nodeName, {
          x: 50 + level * levelWidth,
          y: currentY,
          height: nodeHeight,
        });

        currentY += nodeHeight + nodePadding;
      }
    }

    // Draw links
    for (const link of links) {
      const sourcePos = nodePositions.get(link.source);
      const targetPos = nodePositions.get(link.target);

      if (!sourcePos || !targetPos) continue;

      const sourceValue = nodeValues.get(link.source) || 0;
      const scale = sourcePos.height / sourceValue;
      const linkHeight = link.value * scale;

      const path = this.generateSankeyLinkPath(
        sourcePos.x + nodeWidth,
        sourcePos.y + sourcePos.height / 2,
        targetPos.x,
        targetPos.y + targetPos.height / 2,
        linkHeight,
      );

      const color = this.getDefaultColor(nodeIndex.get(link.source) || 0, 0.3);
      svg += `<path class="sankey-link" d="${path}" stroke="${color}" stroke-width="${linkHeight}">`;
      svg += `<title>${link.source} → ${link.target}: ${link.value}</title>`;
      svg += `</path>`;
    }

    // Draw nodes
    for (const node of nodes) {
      const pos = nodePositions.get(node.name);
      if (!pos) continue;

      const color = this.getDefaultColor(nodeIndex.get(node.name) || 0);
      svg += `<rect class="sankey-node" x="${pos.x}" y="${pos.y}" width="${nodeWidth}" height="${pos.height}" fill="${color}">`;
      svg += `<title>${node.name}: ${nodeValues.get(node.name)}</title>`;
      svg += `</rect>`;

      svg += `<text class="node-label" x="${pos.x + nodeWidth + 5}" y="${pos.y + pos.height / 2}" dominant-baseline="middle">${node.name}</text>`;
    }

    svg += `</svg>`;
    return svg;
  }

  // ============================================================================
  // Helper Methods - Export Formats
  // ============================================================================

  private async exportToSVG(
    chart: Chart,
    options: DataVisualizerOptions,
  ): Promise<Buffer> {
    // Generate SVG based on chart type
    let svg: string;

    switch (chart.type) {
      case "line":
      case "bar":
      case "area":
        svg = this.generateBasicChartSVG(chart, options);
        break;
      case "pie":
        svg = this.generatePieChartSVG(chart, options);
        break;
      default:
        svg = this.generateBasicChartSVG(chart, options);
    }

    return Buffer.from(svg);
  }

  private async exportToPNG(
    chart: Chart,
    options: DataVisualizerOptions,
  ): Promise<Buffer> {
    // For PNG export, we would typically use a library like canvas or puppeteer
    // For now, return SVG wrapped in data URI format that can be converted
    const svg = await this.exportToSVG(chart, options);
    return Buffer.from(`data:image/svg+xml;base64,${svg.toString("base64")}`);
  }

  private async exportToPDF(
    chart: Chart,
    _options: DataVisualizerOptions,
  ): Promise<Buffer> {
    // For PDF export, we would use a library like pdfkit or puppeteer
    // For now, return a simple PDF structure
    const content = `PDF Export of Chart: ${chart.name}\nType: ${chart.type}\nData Points: ${chart.data.length}`;
    return Buffer.from(content);
  }

  private async exportToHTML(
    chart: Chart,
    options: DataVisualizerOptions,
  ): Promise<Buffer> {
    const svg = await this.exportToSVG(chart, options);

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${chart.name}</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 20px;
      background: #f5f5f5;
    }
    .chart-container {
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1 {
      color: #333;
      margin-top: 0;
    }
  </style>
</head>
<body>
  <div class="chart-container">
    <h1>${chart.name}</h1>
    ${svg.toString()}
  </div>
</body>
</html>`;

    return Buffer.from(html);
  }

  private generateBasicChartSVG(
    chart: Chart,
    options: DataVisualizerOptions,
  ): string {
    const width = options.exportWidth || 800;
    const height = options.exportHeight || 600;
    const margin = { top: 50, right: 50, bottom: 50, left: 60 };

    const data = chart.data;
    const maxValue = Math.max(
      ...data.map((d: any) => (typeof d === "number" ? d : d.value || 0)),
    );
    const minValue = Math.min(
      ...data.map((d: any) => (typeof d === "number" ? d : d.value || 0)),
    );

    let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
    svg += `<style>`;
    svg += `.chart-title { font-family: Arial; font-size: 20px; font-weight: bold; fill: #333; text-anchor: middle; }`;
    svg += `.axis-label { font-family: Arial; font-size: 12px; fill: #666; }`;
    svg += `.grid-line { stroke: #e0e0e0; stroke-width: 1; }`;
    svg += `</style>`;

    // Title
    if (chart.config?.options?.plugins?.title?.text) {
      svg += `<text class="chart-title" x="${width / 2}" y="30">${chart.config.options.plugins.title.text}</text>`;
    }

    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;

    // Draw based on chart type
    if (chart.type === "line" || chart.type === "area") {
      svg += this.drawLineChart(
        data,
        margin,
        plotWidth,
        plotHeight,
        minValue,
        maxValue,
        chart.type === "area",
      );
    } else if (chart.type === "bar") {
      svg += this.drawBarChart(data, margin, plotWidth, plotHeight, maxValue);
    }

    svg += `</svg>`;
    return svg;
  }

  private generatePieChartSVG(
    chart: Chart,
    options: DataVisualizerOptions,
  ): string {
    const width = options.exportWidth || 600;
    const height = options.exportHeight || 600;
    const radius = Math.min(width, height) / 2 - 50;
    const centerX = width / 2;
    const centerY = height / 2;

    const data = chart.data;
    const total = data.reduce(
      (sum: number, d: any) => sum + (typeof d === "number" ? d : d.value || 0),
      0,
    );

    let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
    svg += `<style>`;
    svg += `.pie-slice { stroke: #fff; stroke-width: 2; cursor: pointer; }`;
    svg += `.pie-slice:hover { opacity: 0.8; }`;
    svg += `.pie-label { font-family: Arial; font-size: 14px; fill: #333; text-anchor: middle; }`;
    svg += `</style>`;

    let currentAngle = 0;

    for (let i = 0; i < data.length; i++) {
      const value = typeof data[i] === "number" ? data[i] : data[i].value || 0;
      const percentage = value / total;
      const angle = percentage * 2 * Math.PI;

      const startAngle = currentAngle;
      const endAngle = currentAngle + angle;

      const x1 = centerX + radius * Math.cos(startAngle);
      const y1 = centerY + radius * Math.sin(startAngle);
      const x2 = centerX + radius * Math.cos(endAngle);
      const y2 = centerY + radius * Math.sin(endAngle);

      const largeArcFlag = angle > Math.PI ? 1 : 0;

      const pathData = [
        `M ${centerX} ${centerY}`,
        `L ${x1} ${y1}`,
        `A ${radius} ${radius} 0 ${largeArcFlag} 1 ${x2} ${y2}`,
        "Z",
      ].join(" ");

      const color = this.getDefaultColor(i);
      svg += `<path class="pie-slice" d="${pathData}" fill="${color}">`;
      svg += `<title>Slice ${i + 1}: ${value} (${(percentage * 100).toFixed(1)}%)</title>`;
      svg += `</path>`;

      // Label
      const labelAngle = startAngle + angle / 2;
      const labelX = centerX + radius * 0.7 * Math.cos(labelAngle);
      const labelY = centerY + radius * 0.7 * Math.sin(labelAngle);
      svg += `<text class="pie-label" x="${labelX}" y="${labelY}">${(percentage * 100).toFixed(1)}%</text>`;

      currentAngle = endAngle;
    }

    svg += `</svg>`;
    return svg;
  }

  private generateAnimatedVisualization(
    chart: Chart,
    frames: number,
    duration: number,
    transition: string,
  ): string {
    const width = 800;
    const height = 600;

    let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
    svg += `<style>`;
    svg += `.animated-bar { transition: all ${duration / frames}s ${transition}; }`;
    svg += `</style>`;

    // Generate keyframe animation
    const data = chart.data;
    const maxValue = Math.max(
      ...data.map((d: any) => (typeof d === "number" ? d : d.value || 0)),
    );

    for (let i = 0; i < data.length; i++) {
      const value = typeof data[i] === "number" ? data[i] : data[i].value || 0;
      const barHeight = (value / maxValue) * (height - 100);
      const x = 50 + (i * (width - 100)) / data.length;
      const y = height - 50 - barHeight;

      svg += `<rect class="animated-bar" x="${x}" y="${height - 50}" width="40" height="0" fill="${this.getDefaultColor(i)}">`;
      svg += `<animate attributeName="height" from="0" to="${barHeight}" dur="${duration}s" fill="freeze" />`;
      svg += `<animate attributeName="y" from="${height - 50}" to="${y}" dur="${duration}s" fill="freeze" />`;
      svg += `</rect>`;
    }

    svg += `</svg>`;
    return svg;
  }

  // ============================================================================
  // Helper Methods - Chart Drawing
  // ============================================================================

  private drawLineChart(
    data: any[],
    margin: any,
    plotWidth: number,
    plotHeight: number,
    minValue: number,
    maxValue: number,
    fill: boolean,
  ): string {
    const valueRange = maxValue - minValue;
    const points: string[] = [];

    for (let i = 0; i < data.length; i++) {
      const value = typeof data[i] === "number" ? data[i] : data[i].value || 0;
      const x = margin.left + (i / (data.length - 1)) * plotWidth;
      const y =
        margin.top +
        plotHeight -
        ((value - minValue) / valueRange) * plotHeight;
      points.push(`${x},${y}`);
    }

    let svg = "";

    if (fill) {
      const fillPoints = [
        ...points,
        `${margin.left + plotWidth},${margin.top + plotHeight}`,
        `${margin.left},${margin.top + plotHeight}`,
      ];
      svg += `<polygon points="${fillPoints.join(" ")}" fill="rgba(75, 192, 192, 0.2)" stroke="none" />`;
    }

    svg += `<polyline points="${points.join(" ")}" fill="none" stroke="#4BC0C0" stroke-width="2" />`;

    // Draw points
    for (const point of points) {
      const [x, y] = point.split(",");
      svg += `<circle cx="${x}" cy="${y}" r="4" fill="#4BC0C0" stroke="#fff" stroke-width="2" />`;
    }

    return svg;
  }

  private drawBarChart(
    data: any[],
    margin: any,
    plotWidth: number,
    plotHeight: number,
    maxValue: number,
  ): string {
    const barWidth = (plotWidth / data.length) * 0.8;
    let svg = "";

    for (let i = 0; i < data.length; i++) {
      const value = typeof data[i] === "number" ? data[i] : data[i].value || 0;
      const barHeight = (value / maxValue) * plotHeight;
      const x = margin.left + (i + 0.1) * (plotWidth / data.length);
      const y = margin.top + plotHeight - barHeight;

      svg += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${this.getDefaultColor(i)}" />`;
    }

    return svg;
  }

  // ============================================================================
  // Helper Methods - Calculations
  // ============================================================================

  private calculateNodePositions(
    nodes: Array<{ id: string; label?: string; group?: string }>,
    _edges: Array<{ source: string; target: string; weight?: number }>,
    layout: string,
    width: number,
    height: number,
  ): Map<string, { x: number; y: number }> {
    const positions = new Map<string, { x: number; y: number }>();

    if (layout === "circular") {
      const radius = Math.min(width, height) / 2 - 50;
      const centerX = width / 2;
      const centerY = height / 2;
      const angleStep = (2 * Math.PI) / nodes.length;

      for (let i = 0; i < nodes.length; i++) {
        const angle = i * angleStep;
        positions.set(nodes[i].id, {
          x: centerX + radius * Math.cos(angle),
          y: centerY + radius * Math.sin(angle),
        });
      }
    } else if (layout === "grid") {
      const cols = Math.ceil(Math.sqrt(nodes.length));
      const cellWidth = (width - 100) / cols;
      const cellHeight = (height - 100) / Math.ceil(nodes.length / cols);

      for (let i = 0; i < nodes.length; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        positions.set(nodes[i].id, {
          x: 50 + col * cellWidth + cellWidth / 2,
          y: 50 + row * cellHeight + cellHeight / 2,
        });
      }
    } else {
      // Force-directed layout (simplified)
      for (let i = 0; i < nodes.length; i++) {
        positions.set(nodes[i].id, {
          x: 50 + Math.random() * (width - 100),
          y: 50 + Math.random() * (height - 100),
        });
      }
    }

    return positions;
  }

  private calculateSankeyLevels(
    nodes: Array<{ name: string; category?: string }>,
    links: Array<{ source: string; target: string; value: number }>,
  ): Map<string, number> {
    const levels = new Map<string, number>();
    const inDegree = new Map<string, number>();

    // Initialize
    for (const node of nodes) {
      inDegree.set(node.name, 0);
    }

    for (const link of links) {
      inDegree.set(link.target, (inDegree.get(link.target) || 0) + 1);
    }

    // Find nodes with no incoming edges (level 0)
    const queue: string[] = [];
    for (const [node, degree] of inDegree.entries()) {
      if (degree === 0) {
        levels.set(node, 0);
        queue.push(node);
      }
    }

    // BFS to assign levels
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentLevel = levels.get(current) || 0;

      for (const link of links) {
        if (link.source === current) {
          const targetLevel = levels.get(link.target);
          const newLevel = currentLevel + 1;

          if (targetLevel === undefined || newLevel > targetLevel) {
            levels.set(link.target, newLevel);
            queue.push(link.target);
          }
        }
      }
    }

    return levels;
  }

  private calculateSankeyNodeValues(
    nodes: Array<{ name: string; category?: string }>,
    links: Array<{ source: string; target: string; value: number }>,
  ): Map<string, number> {
    const values = new Map<string, number>();

    for (const node of nodes) {
      const incoming = links
        .filter((l) => l.target === node.name)
        .reduce((sum, l) => sum + l.value, 0);
      const outgoing = links
        .filter((l) => l.source === node.name)
        .reduce((sum, l) => sum + l.value, 0);
      values.set(node.name, Math.max(incoming, outgoing));
    }

    return values;
  }

  private generateSankeyLinkPath(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    width: number,
  ): string {
    const midX = (x1 + x2) / 2;
    return (
      `M ${x1} ${y1 - width / 2} ` +
      `C ${midX} ${y1 - width / 2}, ${midX} ${y2 - width / 2}, ${x2} ${y2 - width / 2} ` +
      `L ${x2} ${y2 + width / 2} ` +
      `C ${midX} ${y2 + width / 2}, ${midX} ${y1 + width / 2}, ${x1} ${y1 + width / 2} Z`
    );
  }

  private generateColorScaleLegend(
    minValue: number,
    maxValue: number,
    colors: { min: string; mid?: string; max: string },
    x: number,
    y: number,
  ): string {
    const width = 20;
    const height = 200;
    const steps = 20;

    let svg = `<g class="color-scale">`;

    for (let i = 0; i < steps; i++) {
      const value = minValue + ((maxValue - minValue) * i) / steps;
      const color = this.interpolateColor(
        value,
        minValue,
        maxValue,
        colors.min,
        colors.max,
        "linear",
      );
      const rectY = y + (height * (steps - i - 1)) / steps;
      svg += `<rect x="${x}" y="${rectY}" width="${width}" height="${height / steps}" fill="${color}" />`;
    }

    svg += `<text x="${x + width + 10}" y="${y}" font-size="12">${maxValue.toFixed(2)}</text>`;
    svg += `<text x="${x + width + 10}" y="${y + height}" font-size="12">${minValue.toFixed(2)}</text>`;
    svg += `</g>`;

    return svg;
  }

  // ============================================================================
  // Helper Methods - Utilities
  // ============================================================================

  private interpolateColor(
    value: number,
    min: number,
    max: number,
    colorMin: string,
    colorMax: string,
    scale: string,
  ): string {
    let t = (value - min) / (max - min);

    if (scale === "logarithmic") {
      t = Math.log(1 + t * (Math.E - 1)) / Math.log(Math.E);
    }

    t = Math.max(0, Math.min(1, t));

    const rgb1 = this.hexToRgb(colorMin);
    const rgb2 = this.hexToRgb(colorMax);

    const r = Math.round(rgb1.r + (rgb2.r - rgb1.r) * t);
    const g = Math.round(rgb1.g + (rgb2.g - rgb1.g) * t);
    const b = Math.round(rgb1.b + (rgb2.b - rgb1.b) * t);

    return this.rgbToHex(r, g, b);
  }

  private hexToRgb(hex: string): { r: number; g: number; b: number } {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16),
        }
      : { r: 0, g: 0, b: 0 };
  }

  private rgbToHex(r: number, g: number, b: number): string {
    return (
      "#" +
      [r, g, b]
        .map((x) => {
          const hex = x.toString(16);
          return hex.length === 1 ? "0" + hex : hex;
        })
        .join("")
    );
  }

  private getDefaultColor(index: number, alpha?: number): string {
    const colors = [
      "#FF6384",
      "#36A2EB",
      "#FFCE56",
      "#4BC0C0",
      "#9966FF",
      "#FF9F40",
      "#FF6384",
      "#C9CBCF",
      "#4BC0C0",
      "#FF6384",
    ];

    const color = colors[index % colors.length];

    if (alpha !== undefined) {
      const rgb = this.hexToRgb(color);
      return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
    }

    return color;
  }

  private generateChartId(): string {
    this.chartCounter++;
    return `chart-${Date.now()}-${this.chartCounter}`;
  }

  private generateCacheKey(
    operation: string,
    options: DataVisualizerOptions,
  ): string {
    const hash = createHash("sha256");
    hash.update(operation);
    hash.update(
      JSON.stringify({
        chartId: options.chartId,
        chartType: options.chartType,
        data: options.data,
        config: options.chartConfig,
        heatmapConfig: options.heatmapConfig,
        timelineConfig: options.timelineConfig,
        networkConfig: options.networkConfig,
        sankeyConfig: options.sankeyConfig,
        animationConfig: options.animationConfig,
        exportFormat: options.exportFormat,
      }),
    );
    return `data-visualizer:${operation}:${hash.digest("hex")}`;
  }
}
