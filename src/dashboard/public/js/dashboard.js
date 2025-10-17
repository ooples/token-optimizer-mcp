/**
 * Token Optimizer Dashboard - Client-side JavaScript
 * Handles real-time updates, Chart.js visualizations, and timeline rendering
 */

// State management
let sessionData = null;
let sessionEvents = [];
let charts = {
    categoryChart: null,
    serverChart: null
};

// Configuration
const API_BASE = 'http://localhost:3100/api';
const REFRESH_INTERVAL = 5000; // 5 seconds
let refreshTimer = null;

// Initialize dashboard
document.addEventListener('DOMContentLoaded', () => {
    initializeCharts();
    loadDashboardData();
    startAutoRefresh();

    // Set up refresh button
    document.getElementById('refresh-btn').addEventListener('click', () => {
        loadDashboardData();
    });
});

/**
 * Initialize Chart.js charts
 */
function initializeCharts() {
    // Token Category Chart (Doughnut)
    const categoryCtx = document.getElementById('token-category-chart').getContext('2d');
    charts.categoryChart = new Chart(categoryCtx, {
        type: 'doughnut',
        data: {
            labels: ['Tools', 'Hooks', 'System Reminders', 'Responses'],
            datasets: [{
                data: [0, 0, 0, 0],
                backgroundColor: [
                    '#10b981',
                    '#f59e0b',
                    '#7c3aed',
                    '#2563eb'
                ],
                borderColor: '#1e293b',
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        color: '#cbd5e1',
                        padding: 15,
                        font: {
                            size: 12
                        }
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const label = context.label || '';
                            const value = context.parsed || 0;
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                            return `${label}: ${value.toLocaleString()} tokens (${percentage}%)`;
                        }
                    }
                }
            }
        }
    });

    // Server Attribution Chart (Pie)
    const serverCtx = document.getElementById('server-attribution-chart').getContext('2d');
    charts.serverChart = new Chart(serverCtx, {
        type: 'pie',
        data: {
            labels: [],
            datasets: [{
                data: [],
                backgroundColor: [
                    '#2563eb',
                    '#7c3aed',
                    '#10b981',
                    '#f59e0b',
                    '#ef4444',
                    '#06b6d4',
                    '#8b5cf6',
                    '#ec4899'
                ],
                borderColor: '#1e293b',
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        color: '#cbd5e1',
                        padding: 15,
                        font: {
                            size: 12
                        }
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const label = context.label || '';
                            const value = context.parsed || 0;
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                            return `${label}: ${value.toLocaleString()} tokens (${percentage}%)`;
                        }
                    }
                }
            }
        }
    });
}

/**
 * Load dashboard data from API
 */
async function loadDashboardData() {
    try {
        // Show loading state
        setLoadingState(true);

        // Fetch session summary
        const summaryResponse = await fetch(`${API_BASE}/session-summary`);
        if (!summaryResponse.ok) {
            throw new Error(`HTTP error! status: ${summaryResponse.status}`);
        }
        sessionData = await summaryResponse.json();

        if (!sessionData.success) {
            showError(sessionData.error || 'Failed to load session data');
            return;
        }

        // Fetch session events
        const eventsResponse = await fetch(`${API_BASE}/session-events?limit=100`);
        if (eventsResponse.ok) {
            const eventsData = await eventsResponse.json();
            if (eventsData.success) {
                sessionEvents = eventsData.events;
            }
        }

        // Update UI
        updateSummaryStats();
        updateCharts();
        updateTimeline();
        updateToolBreakdown();
        updatePerformanceMetrics();
        updateLastUpdated();

        setLoadingState(false);
    } catch (error) {
        console.error('Error loading dashboard data:', error);
        showError(`Failed to load dashboard: ${error.message}`);
        setLoadingState(false);
    }
}

/**
 * Update summary statistics
 */
function updateSummaryStats() {
    if (!sessionData) return;

    document.getElementById('session-id').textContent = `Session: ${sessionData.sessionId.substring(0, 8)}...`;
    document.getElementById('total-tokens').textContent = sessionData.totalTokens.toLocaleString();
    document.getElementById('total-turns').textContent = sessionData.totalTurns.toLocaleString();
    document.getElementById('total-tools').textContent = sessionData.totalTools.toLocaleString();
    document.getElementById('session-duration').textContent = sessionData.duration;
}

/**
 * Update charts with new data
 */
function updateCharts() {
    if (!sessionData) return;

    // Update category chart
    const categoryData = sessionData.tokensByCategory;
    charts.categoryChart.data.datasets[0].data = [
        categoryData.tools.tokens,
        categoryData.hooks.tokens,
        categoryData.system_reminders.tokens,
        categoryData.responses.tokens
    ];
    charts.categoryChart.update();

    // Update server attribution chart
    const serverData = sessionData.tokensByServer;
    const serverLabels = Object.keys(serverData);
    const serverValues = Object.values(serverData);

    if (serverLabels.length === 0) {
        // No server data, show placeholder
        charts.serverChart.data.labels = ['No MCP Server Data'];
        charts.serverChart.data.datasets[0].data = [1];
        charts.serverChart.data.datasets[0].backgroundColor = ['#334155'];
    } else {
        charts.serverChart.data.labels = serverLabels;
        charts.serverChart.data.datasets[0].data = serverValues;
    }
    charts.serverChart.update();
}

/**
 * Update timeline with session events
 */
function updateTimeline() {
    const container = document.getElementById('timeline-container');

    if (!sessionEvents || sessionEvents.length === 0) {
        container.innerHTML = '<div class="timeline-placeholder">No events to display</div>';
        return;
    }

    // Create timeline events
    let html = '';
    sessionEvents.forEach(event => {
        const eventClass = getEventClass(event.type);
        const eventLabel = getEventLabel(event);
        const eventDetails = getEventDetails(event);

        html += `
            <div class="timeline-event ${eventClass}">
                <div class="event-header">
                    <span class="event-type">${eventLabel}</span>
                    <span class="event-timestamp">${formatTimestamp(event.timestamp)}</span>
                </div>
                <div class="event-details">${eventDetails}</div>
            </div>
        `;
    });

    container.innerHTML = html;
}

/**
 * Update tool breakdown table
 */
function updateToolBreakdown() {
    if (!sessionData || !sessionData.toolBreakdown) return;

    const tbody = document.getElementById('tool-breakdown-body');
    const breakdown = sessionData.toolBreakdown;

    if (Object.keys(breakdown).length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="no-data">No data available</td></tr>';
        return;
    }

    // Sort by token count (descending)
    const sortedTools = Object.entries(breakdown).sort((a, b) => b[1].tokens - a[1].tokens);

    let html = '';
    sortedTools.forEach(([toolName, data]) => {
        const avgDuration = data.count > 0 ? Math.round(data.totalDuration / data.count) : 0;
        html += `
            <tr>
                <td><strong>${toolName}</strong></td>
                <td>${data.count}</td>
                <td>${data.tokens.toLocaleString()}</td>
                <td>${avgDuration.toLocaleString()}</td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
}

/**
 * Update performance metrics
 */
function updatePerformanceMetrics() {
    if (!sessionData || !sessionData.performance) return;

    const perf = sessionData.performance;
    document.getElementById('avg-tool-duration').textContent = `${perf.avgToolDuration_ms.toLocaleString()} ms`;
    document.getElementById('tools-with-duration').textContent = perf.toolsWithDuration.toLocaleString();
}

/**
 * Update last updated timestamp
 */
function updateLastUpdated() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString();
    document.getElementById('last-updated').textContent = `Last Updated: ${timeStr}`;
}

/**
 * Get CSS class for event type
 */
function getEventClass(type) {
    switch (type) {
        case 'tool_call':
        case 'tool_result':
            return 'tool-call';
        case 'hook_execution':
            return 'hook-execution';
        case 'system_reminder':
            return 'system-reminder';
        default:
            return '';
    }
}

/**
 * Get human-readable label for event
 */
function getEventLabel(event) {
    switch (event.type) {
        case 'tool_call':
            return `Tool: ${event.toolName}`;
        case 'tool_result':
            return `Result: ${event.toolName}`;
        case 'hook_execution':
            return `Hook: ${event.hookName}`;
        case 'system_reminder':
            return 'System Reminder';
        case 'session_start':
            return 'Session Started';
        case 'session_end':
            return 'Session Ended';
        default:
            return event.type;
    }
}

/**
 * Get event details
 */
function getEventDetails(event) {
    let details = [];

    if (event.estimatedTokens) {
        details.push(`${event.estimatedTokens.toLocaleString()} tokens`);
    }

    if (event.duration_ms) {
        details.push(`${event.duration_ms.toLocaleString()} ms`);
    }

    if (event.turn) {
        details.push(`Turn ${event.turn}`);
    }

    return details.join(' • ') || 'No additional details';
}

/**
 * Format timestamp for display
 */
function formatTimestamp(timestamp) {
    if (!timestamp) return 'Unknown time';

    try {
        const date = new Date(timestamp);
        return date.toLocaleTimeString();
    } catch (error) {
        return timestamp;
    }
}

/**
 * Set loading state
 */
function setLoadingState(isLoading) {
    const refreshBtn = document.getElementById('refresh-btn');
    if (isLoading) {
        refreshBtn.disabled = true;
        refreshBtn.textContent = 'Loading...';
        refreshBtn.classList.add('loading');
    } else {
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Refresh';
        refreshBtn.classList.remove('loading');
    }
}

/**
 * Show error message
 */
function showError(message) {
    console.error('Dashboard Error:', message);
    // You can implement a toast notification here
    alert(`Error: ${message}`);
}

/**
 * Start auto-refresh
 */
function startAutoRefresh() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
    }

    refreshTimer = setInterval(() => {
        loadDashboardData();
    }, REFRESH_INTERVAL);
}

/**
 * Stop auto-refresh
 */
function stopAutoRefresh() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
}

// Handle page visibility changes
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        stopAutoRefresh();
    } else {
        startAutoRefresh();
        loadDashboardData();
    }
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    stopAutoRefresh();
});
