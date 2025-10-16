/**
 * Report Generator
 * Generates comprehensive session reports in multiple formats
 */

import { AnalysisResult } from './session-analyzer.js';

export type ReportFormat = 'html' | 'markdown' | 'json';

export interface ReportOptions {
  includeCharts?: boolean;
  includeTimeline?: boolean;
  sessionId: string;
  sessionStartTime: string;
}

/**
 * Generate report in specified format
 */
export function generateReport(
  analysis: AnalysisResult,
  format: ReportFormat,
  options: ReportOptions
): string {
  switch (format) {
    case 'html':
      return generateHTMLReport(analysis, options);
    case 'markdown':
      return generateMarkdownReport(analysis, options);
    case 'json':
      return JSON.stringify(
        {
          sessionId: options.sessionId,
          sessionStartTime: options.sessionStartTime,
          analysis,
        },
        null,
        2
      );
    default:
      throw new Error(`Unknown format: ${format}`);
  }
}

function generateHTMLReport(
  analysis: AnalysisResult,
  options: ReportOptions
): string {
  const { sessionId, sessionStartTime } = options;

  // Generate pie chart data for token breakdown
  const pieChartData = analysis.topConsumers
    .slice(0, 5)
    .map(
      (tool) => `['${tool.toolName}', ${tool.totalTokens}]`
    )
    .join(',');

  // Generate bar chart data for server usage
  const barChartData = analysis.byServer
    .map(
      (server) => `['${server.serverName}', ${server.totalTokens}]`
    )
    .join(',');

  // Generate timeline data
  const timelineData = analysis.hourlyTrend
    .map((hour) => `['${hour.hour}', ${hour.totalTokens}]`)
    .join(',');

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Session Report - ${sessionId}</title>
    <script type="text/javascript" src="https://www.gstatic.com/charts/loader.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #333;
            padding: 20px;
            line-height: 1.6;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            overflow: hidden;
        }

        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            text-align: center;
        }

        .header h1 {
            font-size: 2.5rem;
            margin-bottom: 10px;
        }

        .header .meta {
            opacity: 0.9;
            font-size: 0.95rem;
        }

        .content {
            padding: 30px;
        }

        .section {
            margin-bottom: 40px;
        }

        .section-title {
            font-size: 1.8rem;
            color: #667eea;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 3px solid #667eea;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }

        .stat-card {
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            padding: 20px;
            border-radius: 8px;
            text-align: center;
            transition: transform 0.2s;
        }

        .stat-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
        }

        .stat-value {
            font-size: 2rem;
            font-weight: bold;
            color: #667eea;
            margin-bottom: 5px;
        }

        .stat-label {
            font-size: 0.9rem;
            color: #666;
            text-transform: uppercase;
        }

        .table-container {
            overflow-x: auto;
            margin: 20px 0;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            background: white;
        }

        th {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 15px;
            text-align: left;
            font-weight: 600;
        }

        td {
            padding: 12px 15px;
            border-bottom: 1px solid #eee;
        }

        tr:hover {
            background: #f8f9fa;
        }

        .chart-container {
            margin: 30px 0;
            background: #f8f9fa;
            padding: 20px;
            border-radius: 8px;
        }

        .recommendations {
            background: #fff3cd;
            border-left: 4px solid #ffc107;
            padding: 20px;
            border-radius: 8px;
            margin: 20px 0;
        }

        .recommendations li {
            margin: 10px 0;
            padding-left: 10px;
        }

        .anomaly-badge {
            background: #dc3545;
            color: white;
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 0.85rem;
        }

        .mode-badge {
            padding: 4px 10px;
            border-radius: 4px;
            font-size: 0.85rem;
            font-weight: 600;
        }

        .mode-thinking {
            background: #e3f2fd;
            color: #1976d2;
        }

        .mode-planning {
            background: #f3e5f5;
            color: #7b1fa2;
        }

        .mode-normal {
            background: #e8f5e9;
            color: #388e3c;
        }

        .export-button {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 12px 30px;
            border-radius: 6px;
            font-size: 1rem;
            cursor: pointer;
            transition: transform 0.2s;
            margin: 10px;
        }

        .export-button:hover {
            transform: scale(1.05);
        }

        details {
            margin: 20px 0;
            border: 1px solid #ddd;
            border-radius: 8px;
            padding: 15px;
        }

        summary {
            cursor: pointer;
            font-weight: 600;
            color: #667eea;
            font-size: 1.1rem;
        }

        summary:hover {
            color: #764ba2;
        }

        .progress-bar {
            background: #e0e0e0;
            border-radius: 10px;
            height: 20px;
            overflow: hidden;
            margin: 10px 0;
        }

        .progress-fill {
            background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
            height: 100%;
            transition: width 0.3s;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 Token Optimizer Session Report</h1>
            <div class="meta">
                <p><strong>Session ID:</strong> ${sessionId}</p>
                <p><strong>Start Time:</strong> ${sessionStartTime}</p>
                <p><strong>Duration:</strong> ${analysis.summary.sessionDuration}</p>
            </div>
        </div>

        <div class="content">
            <!-- Summary Stats -->
            <section class="section">
                <h2 class="section-title">📊 Session Summary</h2>
                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-value">${analysis.summary.totalTokens.toLocaleString()}</div>
                        <div class="stat-label">Total Tokens</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${analysis.summary.totalOperations}</div>
                        <div class="stat-label">Operations</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${Math.round(analysis.summary.averageTurnTokens).toLocaleString()}</div>
                        <div class="stat-label">Avg Turn Tokens</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${analysis.summary.thinkingTurns}</div>
                        <div class="stat-label">Thinking Turns</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${Math.round(analysis.efficiency.tokensPerTool)}</div>
                        <div class="stat-label">Tokens/Tool</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${analysis.efficiency.thinkingModePercent.toFixed(1)}%</div>
                        <div class="stat-label">Thinking Mode %</div>
                    </div>
                </div>
            </section>

            <!-- Token Usage Breakdown Chart -->
            <section class="section">
                <h2 class="section-title">🥧 Token Usage Breakdown</h2>
                <div class="chart-container">
                    <div id="pie_chart" style="width: 100%; height: 400px;"></div>
                </div>
            </section>

            <!-- MCP Server Usage Chart -->
            <section class="section">
                <h2 class="section-title">📡 MCP Server Usage</h2>
                <div class="chart-container">
                    <div id="bar_chart" style="width: 100%; height: 400px;"></div>
                </div>
            </section>

            <!-- Hourly Timeline Chart -->
            <section class="section">
                <h2 class="section-title">📈 Hourly Token Trend</h2>
                <div class="chart-container">
                    <div id="timeline_chart" style="width: 100%; height: 400px;"></div>
                </div>
            </section>

            <!-- Top Token Consumers -->
            <section class="section">
                <h2 class="section-title">🔥 Top Token Consumers</h2>
                <div class="table-container">
                    <table>
                        <thead>
                            <tr>
                                <th>Tool Name</th>
                                <th>Count</th>
                                <th>Total Tokens</th>
                                <th>Avg Tokens</th>
                                <th>% of Total</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${analysis.topConsumers
                              .map(
                                (tool) => `
                            <tr>
                                <td><strong>${tool.toolName}</strong></td>
                                <td>${tool.count}</td>
                                <td>${tool.totalTokens.toLocaleString()}</td>
                                <td>${Math.round(tool.averageTokens).toLocaleString()}</td>
                                <td>${tool.percentOfTotal.toFixed(2)}%</td>
                            </tr>
                            `
                              )
                              .join('')}
                        </tbody>
                    </table>
                </div>
            </section>

            <!-- Anomalies -->
            ${
              analysis.anomalies.length > 0
                ? `
            <section class="section">
                <h2 class="section-title">⚠️ Anomalies Detected</h2>
                <div class="table-container">
                    <table>
                        <thead>
                            <tr>
                                <th>Turn #</th>
                                <th>Timestamp</th>
                                <th>Tokens</th>
                                <th>Mode</th>
                                <th>Reason</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${analysis.anomalies
                              .map(
                                (anomaly) => `
                            <tr>
                                <td><span class="anomaly-badge">#${anomaly.turnNumber}</span></td>
                                <td>${anomaly.timestamp}</td>
                                <td><strong>${anomaly.totalTokens.toLocaleString()}</strong></td>
                                <td><span class="mode-badge mode-${anomaly.mode}">${anomaly.mode}</span></td>
                                <td>${anomaly.reason}</td>
                            </tr>
                            `
                              )
                              .join('')}
                        </tbody>
                    </table>
                </div>
            </section>
            `
                : ''
            }

            <!-- Recommendations -->
            ${
              analysis.recommendations.length > 0
                ? `
            <section class="section">
                <h2 class="section-title">💡 Recommendations</h2>
                <div class="recommendations">
                    <ul>
                        ${analysis.recommendations.map((rec) => `<li>${rec}</li>`).join('')}
                    </ul>
                </div>
            </section>
            `
                : ''
            }

            <!-- Detailed Server Stats -->
            <details>
                <summary>📊 Detailed Server Statistics</summary>
                <div class="table-container" style="margin-top: 20px;">
                    <table>
                        <thead>
                            <tr>
                                <th>Server</th>
                                <th>Operations</th>
                                <th>Total Tokens</th>
                                <th>Avg Tokens</th>
                                <th>Tools Used</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${analysis.byServer
                              .map(
                                (server) => `
                            <tr>
                                <td><strong>${server.serverName}</strong></td>
                                <td>${server.count}</td>
                                <td>${server.totalTokens.toLocaleString()}</td>
                                <td>${Math.round(server.averageTokens).toLocaleString()}</td>
                                <td>${server.tools.length}</td>
                            </tr>
                            `
                              )
                              .join('')}
                        </tbody>
                    </table>
                </div>
            </details>

            <!-- Export Buttons -->
            <section class="section" style="text-align: center;">
                <button class="export-button" onclick="exportAsMarkdown()">📄 Export as Markdown</button>
                <button class="export-button" onclick="exportAsJSON()">📋 Export as JSON</button>
                <button class="export-button" onclick="window.print()">🖨️ Print Report</button>
            </section>
        </div>
    </div>

    <script type="text/javascript">
        // Load Google Charts
        google.charts.load('current', {'packages':['corechart', 'line']});
        google.charts.setOnLoadCallback(drawCharts);

        function drawCharts() {
            // Pie Chart
            var pieData = google.visualization.arrayToDataTable([
                ['Tool', 'Tokens'],
                ${pieChartData}
            ]);

            var pieOptions = {
                title: 'Token Distribution by Tool',
                pieHole: 0.4,
                colors: ['#667eea', '#764ba2', '#f093fb', '#4facfe', '#43e97b'],
                chartArea: {width: '90%', height: '80%'}
            };

            var pieChart = new google.visualization.PieChart(document.getElementById('pie_chart'));
            pieChart.draw(pieData, pieOptions);

            // Bar Chart
            var barData = google.visualization.arrayToDataTable([
                ['Server', 'Tokens'],
                ${barChartData}
            ]);

            var barOptions = {
                title: 'Token Usage by MCP Server',
                colors: ['#667eea'],
                chartArea: {width: '70%', height: '70%'},
                hAxis: {title: 'Total Tokens'}
            };

            var barChart = new google.visualization.BarChart(document.getElementById('bar_chart'));
            barChart.draw(barData, barOptions);

            // Timeline Chart
            var timelineData = google.visualization.arrayToDataTable([
                ['Hour', 'Tokens'],
                ${timelineData}
            ]);

            var timelineOptions = {
                title: 'Token Usage Over Time',
                curveType: 'function',
                colors: ['#667eea'],
                chartArea: {width: '80%', height: '70%'},
                hAxis: {title: 'Hour'},
                vAxis: {title: 'Tokens'}
            };

            var timelineChart = new google.visualization.LineChart(document.getElementById('timeline_chart'));
            timelineChart.draw(timelineData, timelineOptions);
        }

        function exportAsMarkdown() {
            const markdown = generateMarkdown();
            const blob = new Blob([markdown], {type: 'text/markdown'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'session-report-${sessionId}.md';
            a.click();
        }

        function exportAsJSON() {
            const data = ${JSON.stringify({ sessionId, sessionStartTime, analysis })};
            const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'session-report-${sessionId}.json';
            a.click();
        }

        function generateMarkdown() {
            var md = '# Session Report: ${sessionId}\\n\\n';
            md += '**Start Time:** ${sessionStartTime}\\n';
            md += '**Duration:** ${analysis.summary.sessionDuration}\\n\\n';
            md += '## Summary\\n';
            md += '- Total Tokens: ' + ${analysis.summary.totalTokens}.toLocaleString() + '\\n';
            md += '- Total Operations: ${analysis.summary.totalOperations}\\n';
            md += '- Average Turn Tokens: ' + ${Math.round(analysis.summary.averageTurnTokens)}.toLocaleString() + '\\n';
            md += '- Thinking Turns: ${analysis.summary.thinkingTurns}\\n';
            md += '- Tokens per Tool: ' + ${Math.round(analysis.efficiency.tokensPerTool)}.toLocaleString() + '\\n\\n';
            md += '## Top Token Consumers\\n\\n';
            ${JSON.stringify(analysis.topConsumers)}.slice(0, 10).forEach(function(t, i) {
                md += (i + 1) + '. **' + t.toolName + '**: ' + t.totalTokens.toLocaleString() + ' tokens (' + t.percentOfTotal.toFixed(2) + '%)\\n';
            });
            md += '\\n## Recommendations\\n\\n';
            ${JSON.stringify(analysis.recommendations)}.forEach(function(r, i) {
                md += (i + 1) + '. ' + r + '\\n';
            });
            return md;
        }

        // Responsive chart resizing
        window.addEventListener('resize', drawCharts);
    </script>
</body>
</html>`;
}

function generateMarkdownReport(
  analysis: AnalysisResult,
  options: ReportOptions
): string {
  const { sessionId, sessionStartTime } = options;

  let md = `# 🚀 Session Report: ${sessionId}\n\n`;
  md += `**Start Time:** ${sessionStartTime}\n`;
  md += `**Duration:** ${analysis.summary.sessionDuration}\n\n`;

  md += `## 📊 Summary\n\n`;
  md += `- **Total Tokens:** ${analysis.summary.totalTokens.toLocaleString()}\n`;
  md += `- **Total Operations:** ${analysis.summary.totalOperations}\n`;
  md += `- **Average Turn Tokens:** ${Math.round(analysis.summary.averageTurnTokens).toLocaleString()}\n`;
  md += `- **Thinking Turns:** ${analysis.summary.thinkingTurns} (${analysis.efficiency.thinkingModePercent.toFixed(1)}%)\n`;
  md += `- **Planning Turns:** ${analysis.summary.planningTurns}\n`;
  md += `- **Normal Turns:** ${analysis.summary.normalTurns}\n`;
  md += `- **Tokens per Tool:** ${Math.round(analysis.efficiency.tokensPerTool)}\n`;
  md += `- **Cache Hit Potential:** ${analysis.efficiency.cacheHitPotential}\n\n`;

  md += `## 🔥 Top Token Consumers\n\n`;
  md += `| Tool Name | Count | Total Tokens | Avg Tokens | % of Total |\n`;
  md += `|-----------|-------|--------------|------------|------------|\n`;
  for (const tool of analysis.topConsumers) {
    md += `| ${tool.toolName} | ${tool.count} | ${tool.totalTokens.toLocaleString()} | ${Math.round(tool.averageTokens).toLocaleString()} | ${tool.percentOfTotal.toFixed(2)}% |\n`;
  }
  md += `\n`;

  if (analysis.anomalies.length > 0) {
    md += `## ⚠️ Anomalies Detected\n\n`;
    md += `| Turn # | Timestamp | Tokens | Mode | Reason |\n`;
    md += `|--------|-----------|--------|------|--------|\n`;
    for (const anomaly of analysis.anomalies) {
      md += `| #${anomaly.turnNumber} | ${anomaly.timestamp} | ${anomaly.totalTokens.toLocaleString()} | ${anomaly.mode} | ${anomaly.reason} |\n`;
    }
    md += `\n`;
  }

  if (analysis.recommendations.length > 0) {
    md += `## 💡 Recommendations\n\n`;
    for (let i = 0; i < analysis.recommendations.length; i++) {
      md += `${i + 1}. ${analysis.recommendations[i]}\n`;
    }
    md += `\n`;
  }

  md += `## 📡 MCP Server Usage\n\n`;
  md += `| Server | Operations | Total Tokens | Avg Tokens | Tools Used |\n`;
  md += `|--------|------------|--------------|------------|------------|\n`;
  for (const server of analysis.byServer) {
    md += `| ${server.serverName} | ${server.count} | ${server.totalTokens.toLocaleString()} | ${Math.round(server.averageTokens).toLocaleString()} | ${server.tools.length} |\n`;
  }
  md += `\n`;

  md += `## 📈 Hourly Trend\n\n`;
  md += `| Hour | Operations | Total Tokens | Avg Tokens |\n`;
  md += `|------|------------|--------------|------------|\n`;
  for (const hour of analysis.hourlyTrend) {
    md += `| ${hour.hour} | ${hour.operationCount} | ${hour.totalTokens.toLocaleString()} | ${Math.round(hour.averageTokens).toLocaleString()} |\n`;
  }
  md += `\n`;

  md += `---\n`;
  md += `*Generated by Token Optimizer MCP at ${new Date().toISOString()}*\n`;

  return md;
}
