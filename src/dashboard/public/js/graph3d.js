/*
 * A small, dependency-free 3D knowledge graph renderer.
 *
 * The dashboard must work offline, so this uses Canvas 2D as a projection
 * surface rather than downloading a WebGL library. The model itself is truly
 * three-dimensional: nodes have stable x/y/z coordinates, perspective and
 * depth ordering; pointer drag orbits the camera, the wheel zooms, and nodes
 * are hit-tested in projected screen space.
 */

const KIND_COLOURS = {
  file: '#7aa2f7',
  symbol: '#b48ef7',
  finding: '#2ee6a8',
  task: '#f0a742',
  decision: '#2ee6a8',
  failure: '#f2545b',
};

function hash(text) {
  let value = 2166136261;
  for (const char of String(text)) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function caption(node) {
  const value =
    node.claim ||
    node.name ||
    String(node.key || '')
      .split(/[\\/]/)
      .pop();
  return String(value || node.id || 'unknown node');
}

function coordinates(node, index, count) {
  // Fibonacci sphere plus stable per-id radius jitter. Unlike random layout,
  // returning to this project returns every node to the same place.
  const seed = hash(node.id || node.key || index);
  const y = 1 - ((index + 0.5) / Math.max(1, count)) * 2;
  const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y));
  const theta =
    index * Math.PI * (3 - Math.sqrt(5)) + (seed % 360) * (Math.PI / 180);
  const shell = 1.05 + ((seed >>> 8) % 100) / 260;
  return {
    x: Math.cos(theta) * radiusAtY * shell,
    y: y * shell,
    z: Math.sin(theta) * radiusAtY * shell,
  };
}

function rotate(point, yaw, pitch) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const x = point.x * cy - point.z * sy;
  const z1 = point.x * sy + point.z * cy;
  return {
    x,
    y: point.y * cp - z1 * sp,
    z: point.y * sp + z1 * cp,
  };
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function')
    ctx.roundRect(x, y, width, height, radius);
  else ctx.rect(x, y, width, height);
  ctx.fill();
}

export function createKnowledgeGraph3D(host, initial, options = {}) {
  host.innerHTML = '';
  host.classList.add('knowledge-graph-3d');
  host.dataset.renderer = 'perspective-3d';

  const canvas = document.createElement('canvas');
  canvas.className = 'knowledge-graph-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute(
    'aria-keyshortcuts',
    'Alt+ArrowLeft Alt+ArrowRight Enter Space ArrowLeft ArrowRight ArrowUp ArrowDown Plus Minus R'
  );
  host.appendChild(canvas);

  const chrome = document.createElement('div');
  chrome.className = 'graph-3d-chrome';
  chrome.innerHTML =
    '<span class="graph-3d-badge">Interactive 3D</span>' +
    '<span class="graph-3d-help">Drag to orbit · scroll to zoom · click a node · Alt+←/→ then Enter by keyboard</span>' +
    '<button class="graph-3d-reset" type="button" aria-label="Reset 3D graph view">Reset view</button>';
  host.appendChild(chrome);

  const tooltip = document.createElement('div');
  tooltip.className = 'graph-3d-tooltip';
  tooltip.hidden = true;
  host.appendChild(tooltip);

  const context = canvas.getContext('2d', { alpha: false });
  const view = {
    yaw: -0.42,
    pitch: -0.24,
    zoom: options.compact ? 0.9 : 1.08,
    velocityYaw: 0,
    velocityPitch: 0,
    selected: options.selected || null,
    hovered: null,
  };
  let graph = initial || { nodes: [], edges: [] };
  let points = [];
  let projected = [];
  let width = 0;
  let height = 0;
  let frame = 0;
  let animation = 0;
  let dragging = false;
  let moved = false;
  let previous = { x: 0, y: 0 };
  let destroyed = false;
  let resizeFrame = 0;

  function prepare() {
    const nodes = (graph.nodes || []).slice(0, options.cap || 150);
    points = nodes.map((node, index) => ({
      node,
      ...coordinates(node, index, nodes.length),
    }));
    if (!points.some((point) => point.node.id === view.selected))
      view.selected = null;
    const index = new Map(points.map((point) => [point.node.id, point]));
    points.forEach((point) => {
      point.degree = 0;
    });
    for (const edge of graph.edges || []) {
      if (index.has(edge.from)) index.get(edge.from).degree += 1;
      if (index.has(edge.to)) index.get(edge.to).degree += 1;
    }
    canvas.setAttribute(
      'aria-label',
      `Interactive 3D knowledge graph with ${points.length} nodes and ${(graph.edges || []).length} connections`
    );
    host.dataset.nodes = String(points.length);
    host.dataset.edges = String((graph.edges || []).length);
  }

  function resize() {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    // Size the backing buffer from the host's CONTENT box. Using
    // getBoundingClientRect() here included the host's two border pixels, then
    // assigning that border-box size to the child canvas made the auto-sized
    // host two pixels larger. ResizeObserver observed the growth and repeated
    // it forever, which looked like a camera continuously zooming into the
    // overview graph while the entire canvas expanded without bound.
    const nextWidth = Math.max(1, Math.round(host.clientWidth));
    const nextHeight = Math.max(1, Math.round(host.clientHeight));
    const nextCanvasWidth = Math.round(nextWidth * ratio);
    const nextCanvasHeight = Math.round(nextHeight * ratio);
    if (
      nextWidth === width &&
      nextHeight === height &&
      canvas.width === nextCanvasWidth &&
      canvas.height === nextCanvasHeight
    )
      return;
    width = nextWidth;
    height = nextHeight;
    canvas.width = nextCanvasWidth;
    canvas.height = nextCanvasHeight;
    // CSS owns the display size (100% x 100%). Setting pixel dimensions here
    // would reintroduce the child -> auto-sized parent feedback loop.
    canvas.style.removeProperty('width');
    canvas.style.removeProperty('height');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw();
  }

  function project(point) {
    const rotated = rotate(point, view.yaw, view.pitch);
    const cameraDepth = rotated.z + 4.2;
    const focal = Math.min(width, height) * 1.52 * view.zoom;
    return {
      ...point,
      rotated,
      screenX: width / 2 + (rotated.x * focal) / cameraDepth,
      screenY: height / 2 + (rotated.y * focal) / cameraDepth,
      scale: Math.max(0.58, Math.min(1.45, 4.2 / cameraDepth)),
    };
  }

  function drawBackdrop() {
    const gradient = context.createRadialGradient(
      width * 0.5,
      height * 0.45,
      0,
      width * 0.5,
      height * 0.5,
      Math.max(width, height) * 0.72
    );
    gradient.addColorStop(0, '#172638');
    gradient.addColorStop(0.52, '#0f1823');
    gradient.addColorStop(1, '#0a1017');
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);

    // Sparse stable stars make camera movement legible without competing with
    // the graph. They are decoration, never data marks.
    for (let index = 0; index < 46; index += 1) {
      const seed = hash(`background-${index}`);
      const x = (seed % 1000) / 1000;
      const y = ((seed >>> 10) % 1000) / 1000;
      context.fillStyle = `rgba(122, 162, 247, ${0.07 + ((seed >>> 20) % 9) / 100})`;
      context.fillRect(x * width, y * height, 1, 1);
    }
  }

  function draw() {
    if (destroyed || !width || !height) return;
    drawBackdrop();
    projected = points.map(project).sort((a, b) => b.rotated.z - a.rotated.z);
    const byId = new Map(projected.map((point) => [point.node.id, point]));

    context.lineCap = 'round';
    for (const edge of graph.edges || []) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) continue;
      const active =
        view.selected &&
        (edge.from === view.selected || edge.to === view.selected);
      const depth = (from.scale + to.scale) / 2;
      context.strokeStyle = active
        ? 'rgba(46, 230, 168, 0.58)'
        : `rgba(122, 162, 247, ${Math.min(0.32, 0.1 * depth + 0.06)})`;
      context.lineWidth = active ? 1.7 : 0.8;
      context.beginPath();
      context.moveTo(from.screenX, from.screenY);
      context.lineTo(to.screenX, to.screenY);
      context.stroke();
    }

    // Paint farthest-first so nearer nodes, glows, and labels remain visible.
    // Label priority runs in the opposite direction without changing paint order.
    const nearestRank = new Map(
      [...projected].reverse().map((point, index) => [point.node.id, index])
    );
    projected.forEach((point) => {
      const rank = nearestRank.get(point.node.id) ?? Infinity;
      const selected = point.node.id === view.selected;
      const hovered = point.node.id === view.hovered;
      const colour =
        KIND_COLOURS[point.node.kind] ||
        KIND_COLOURS[point.node.type] ||
        '#9fb2c2';
      const baseRadius = point.node.kind === 'finding' ? 6.2 : 4.8;
      const radius =
        baseRadius * point.scale + Math.min(2.5, point.degree * 0.28);

      if (selected || hovered) {
        const glow = context.createRadialGradient(
          point.screenX,
          point.screenY,
          radius,
          point.screenX,
          point.screenY,
          radius * 3.8
        );
        glow.addColorStop(
          0,
          selected ? 'rgba(46,230,168,.38)' : 'rgba(122,162,247,.3)'
        );
        glow.addColorStop(1, 'rgba(46,230,168,0)');
        context.fillStyle = glow;
        context.beginPath();
        context.arc(point.screenX, point.screenY, radius * 3.8, 0, Math.PI * 2);
        context.fill();
      }

      context.shadowColor = colour;
      context.shadowBlur = selected ? 18 : hovered ? 12 : 5;
      context.fillStyle = colour;
      context.beginPath();
      context.arc(point.screenX, point.screenY, radius, 0, Math.PI * 2);
      context.fill();
      context.shadowBlur = 0;
      context.strokeStyle = selected ? '#effff9' : 'rgba(255,255,255,.38)';
      context.lineWidth = selected ? 1.8 : 0.7;
      context.stroke();

      // Keep the field readable: label the selected/hovered nodes and the most
      // connected front-facing nodes, not all 150 at once.
      const label = selected || hovered || (point.degree > 0 && rank < 8);
      if (label && !options.compact) {
        const text = caption(point.node).slice(
          0,
          selected || hovered ? 54 : 25
        );
        context.font = `${selected ? 600 : 500} 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        const textWidth = Math.min(300, context.measureText(text).width);
        const labelX = Math.min(
          width - textWidth - 22,
          point.screenX + radius + 7
        );
        const labelY = Math.max(18, Math.min(height - 12, point.screenY + 4));
        context.fillStyle = 'rgba(10,15,20,.78)';
        roundedRect(context, labelX - 5, labelY - 13, textWidth + 10, 19, 5);
        context.fillStyle = selected ? '#eafff7' : '#b9c9d5';
        context.fillText(text, labelX, labelY, 300);
      }
    });

    frame += 1;
    host.dataset.frame = String(frame);
    host.dataset.yaw = view.yaw.toFixed(4);
    host.dataset.pitch = view.pitch.toFixed(4);
    host.dataset.zoom = view.zoom.toFixed(4);
    host.dataset.selected = view.selected || '';
    host.dispatchEvent(
      new CustomEvent('graph3d:render', { detail: { frame } })
    );
  }

  function animate() {
    cancelAnimationFrame(animation);
    const tick = () => {
      view.yaw += view.velocityYaw;
      view.pitch = Math.max(
        -1.22,
        Math.min(1.22, view.pitch + view.velocityPitch)
      );
      view.velocityYaw *= 0.91;
      view.velocityPitch *= 0.91;
      draw();
      if (Math.abs(view.velocityYaw) + Math.abs(view.velocityPitch) > 0.0002)
        animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
  }

  function localPoint(event) {
    const box = canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  function nearestNode(point, radius = 18) {
    let hit = null;
    let distance = radius;
    for (const node of projected) {
      const next = Math.hypot(node.screenX - point.x, node.screenY - point.y);
      if (next < distance) {
        hit = node;
        distance = next;
      }
    }
    return hit;
  }

  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    moved = false;
    previous = localPoint(event);
    view.velocityYaw = 0;
    view.velocityPitch = 0;
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('is-dragging');
  });

  canvas.addEventListener('pointermove', (event) => {
    const point = localPoint(event);
    if (dragging) {
      const dx = point.x - previous.x;
      const dy = point.y - previous.y;
      moved ||= Math.abs(dx) + Math.abs(dy) > 2;
      view.velocityYaw = dx * 0.0046;
      view.velocityPitch = dy * 0.0046;
      view.yaw += view.velocityYaw;
      view.pitch = Math.max(
        -1.22,
        Math.min(1.22, view.pitch + view.velocityPitch)
      );
      previous = point;
      draw();
      return;
    }
    const hit = nearestNode(point);
    const next = hit?.node.id || null;
    if (next !== view.hovered) {
      view.hovered = next;
      canvas.style.cursor = hit ? 'pointer' : 'grab';
      tooltip.hidden = !hit;
      if (hit) {
        tooltip.textContent = `${hit.node.kind || 'node'} · ${caption(hit.node)}`;
        tooltip.style.left = `${Math.min(width - 230, point.x + 14)}px`;
        tooltip.style.top = `${Math.max(12, point.y - 18)}px`;
      }
      draw();
    }
  });

  const stopDragging = (event) => {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove('is-dragging');
    const point = localPoint(event);
    if (!moved) {
      const hit = nearestNode(point);
      if (hit) {
        view.selected = hit.node.id;
        options.onSelect?.(hit.node);
      }
    } else {
      animate();
    }
    draw();
  };
  canvas.addEventListener('pointerup', stopDragging);
  canvas.addEventListener('pointercancel', stopDragging);
  canvas.addEventListener('pointerleave', () => {
    if (!dragging) {
      view.hovered = null;
      tooltip.hidden = true;
      draw();
    }
  });

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      view.zoom = Math.max(
        0.55,
        Math.min(2.5, view.zoom * Math.exp(-event.deltaY * 0.0012))
      );
      draw();
    },
    { passive: false }
  );

  canvas.addEventListener('keydown', (event) => {
    const step = 0.1;
    if (
      event.altKey &&
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
      points.length
    ) {
      const ids = points.map((point) => point.node.id);
      const current = ids.indexOf(view.selected);
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      const start = current < 0 ? (direction < 0 ? 0 : -1) : current;
      view.selected = ids[(start + direction + ids.length) % ids.length];
      canvas.setAttribute(
        'aria-label',
        `Selected ${caption(points.find((point) => point.node.id === view.selected).node)} in the interactive 3D knowledge graph. Press Enter to open.`
      );
    } else if (event.key === 'Enter' || event.key === ' ') {
      const selected =
        points.find((point) => point.node.id === view.selected) || points[0];
      if (!selected) return;
      view.selected = selected.node.id;
      options.onSelect?.(selected.node);
    } else if (event.key === 'ArrowLeft') view.yaw -= step;
    else if (event.key === 'ArrowRight') view.yaw += step;
    else if (event.key === 'ArrowUp')
      view.pitch = Math.max(-1.22, view.pitch - step);
    else if (event.key === 'ArrowDown')
      view.pitch = Math.min(1.22, view.pitch + step);
    else if (event.key === '+' || event.key === '=')
      view.zoom = Math.min(2.5, view.zoom * 1.12);
    else if (event.key === '-' || event.key === '_')
      view.zoom = Math.max(0.55, view.zoom / 1.12);
    else if (event.key.toLowerCase() === 'r') reset();
    else return;
    event.preventDefault();
    draw();
  });

  function reset() {
    view.yaw = -0.42;
    view.pitch = -0.24;
    view.zoom = options.compact ? 0.9 : 1.08;
    view.velocityYaw = 0;
    view.velocityPitch = 0;
    draw();
  }

  chrome.querySelector('.graph-3d-reset').addEventListener('click', reset);

  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(resize);
  });
  observer.observe(host);
  prepare();
  resize();

  const api = {
    update(next) {
      graph = next || { nodes: [], edges: [] };
      prepare();
      draw();
    },
    select(id) {
      view.selected =
        id && points.some((point) => point.node.id === id) ? id : null;
      draw();
    },
    reset,
    projectedNodes() {
      return projected.map((point) => ({
        id: point.node.id,
        x: point.screenX,
        y: point.screenY,
      }));
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(animation);
      cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      host.innerHTML = '';
      delete host.__knowledgeGraph3d;
    },
  };
  host.__knowledgeGraph3d = api;
  return api;
}
