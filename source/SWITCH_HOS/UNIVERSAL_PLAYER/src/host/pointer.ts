type LogFn = (message: string) => void;

const ZL_BUTTON = 6;
const ZR_BUTTON = 7;
const RIGHT_STICK_X = 2;
const RIGHT_STICK_Y = 3;
const DEADZONE = 0.18;
const MAX_SPEED = 1100;
const CURSOR_HIDE_MS = 3000;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function curvedAxis(value: number) {
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(Number(value) || 0);
  if (magnitude <= DEADZONE) return 0;
  const normalized = Math.min(1, (magnitude - DEADZONE) / (1 - DEADZONE));
  return sign * normalized * (0.30 + 0.70 * normalized);
}

function setEventProperty(event: any, key: string, value: any) {
  try { Object.defineProperty(event, key, { configurable: true, enumerable: true, value }); }
  catch { try { event[key] = value; } catch {} }
}

type PointerEventCoords = {
  physicalX: number;
  physicalY: number;
  pageX: number;
  pageY: number;
  logicalX: number;
  logicalY: number;
  offsetX: number;
  offsetY: number;
};

function makeMouseEvent(type: string, coords: PointerEventCoords, button: number, buttons: number, movementX = 0, movementY = 0) {
  const event: any = new Event(type, { bubbles: true, cancelable: true });
  const which = button === 2 ? 3 : button === 1 ? 2 : button === 0 ? 1 : 0;
  const props: Record<string, any> = {
    button, buttons, which,
    clientX: coords.pageX, clientY: coords.pageY, pageX: coords.pageX, pageY: coords.pageY,
    screenX: coords.physicalX, screenY: coords.physicalY,
    movementX, movementY, offsetX: coords.offsetX, offsetY: coords.offsetY,
    layerX: coords.offsetX, layerY: coords.offsetY,
    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false
  };
  for (const [key, value] of Object.entries(props)) setEventProperty(event, key, value);
  return event;
}

export function installPointerBridge(log: LogFn) {
  const g: any = globalThis as any;
  if (g.__mvmzPointerBridgeInstalled) return;
  g.__mvmzPointerBridgeInstalled = true;

  const width = Math.max(1, Number(screen.width || 1280));
  const height = Math.max(1, Number(screen.height || 720));
  let pointerX = width / 2;
  let pointerY = height / 2;
  let padLeft = false;
  let padRight = false;
  let touchLeft = false;
  let activated = false;
  let cursor: any = null;
  let lastFrameTime = Number(performance.now?.() || Date.now());
  let lastActivityAt = 0;

  const markActivity = () => {
    activated = true;
    lastActivityAt = Number(performance.now?.() || Date.now());
  };

  let coordinateLogCount = 0;
  const resolveEventCoords = (): PointerEventCoords => {
    const fit = g.__mvmzViewportFit;
    const visualScale = Number(fit?.scale || 1) || 1;
    const visualLeft = Number(fit?.x || 0);
    const visualTop = Number(fit?.top || 0);
    const logicalX = (pointerX - visualLeft) / visualScale;
    const logicalY = (pointerY - visualTop) / visualScale;
    const canvas = g.Graphics?._canvas || g.Graphics?._app?.view || g.Graphics?._app?.renderer?.view || null;
    const engineScale = Number(g.Graphics?._realScale || visualScale) || visualScale;
    const pageLeft = Number(canvas?.offsetLeft ?? visualLeft) || 0;
    const pageTop = Number(canvas?.offsetTop ?? visualTop) || 0;
    const pageX = pageLeft + logicalX * engineScale;
    const pageY = pageTop + logicalY * engineScale;
    return {
      physicalX: pointerX, physicalY: pointerY,
      pageX, pageY, logicalX, logicalY,
      offsetX: logicalX * engineScale, offsetY: logicalY * engineScale
    };
  };  const leftPressed = () => padLeft || touchLeft;
  const buttonMask = () => (leftPressed() ? 1 : 0) | (padRight ? 2 : 0);
  const eventTargets = () => {
    const targets: any[] = [];
    const canvas = g.Graphics?._canvas || g.Graphics?._app?.view || g.Graphics?._app?.renderer?.view || null;
    for (const target of [canvas, g.document, g]) {
      if (target?.dispatchEvent && !targets.includes(target)) targets.push(target);
    }
    return targets;
  };

  const dispatchMouse = (type: string, button: number, movementX = 0, movementY = 0) => {
    const coords = resolveEventCoords();
    if (coordinateLogCount < 6 && (type === 'mousedown' || type === 'mousemove')) {
      coordinateLogCount++;
      const fit = g.__mvmzViewportFit;
      log(`[pointer] coord map | physical=${coords.physicalX.toFixed(1)},${coords.physicalY.toFixed(1)} logical=${coords.logicalX.toFixed(1)},${coords.logicalY.toFixed(1)} page=${coords.pageX.toFixed(1)},${coords.pageY.toFixed(1)} fitScale=${Number(fit?.scale || 1).toFixed(4)} engineScale=${Number(g.Graphics?._realScale || 1).toFixed(4)} offset=${Number(g.Graphics?._canvas?.offsetLeft || 0).toFixed(1)},${Number(g.Graphics?._canvas?.offsetTop || 0).toFixed(1)}`);
      if (coordinateLogCount === 6) log('[pointer] further coordinate mapping logs suppressed');
    }
    for (const target of eventTargets()) {
      try { target.dispatchEvent(makeMouseEvent(type, coords, button, buttonMask(), movementX, movementY)); } catch {}
    }
  };

  const movePointer = (x: number, y: number, emit = true) => {
    const nextX = clamp(Number(x) || 0, 0, width - 1);
    const nextY = clamp(Number(y) || 0, 0, height - 1);
    const dx = nextX - pointerX;
    const dy = nextY - pointerY;
    pointerX = nextX;
    pointerY = nextY;
    if (emit && (dx || dy)) dispatchMouse('mousemove', -1, dx, dy);
  };

  const setPadLeft = (down: boolean) => {
    const before = leftPressed();
    padLeft = down;
    const after = leftPressed();
    if (before === after) return;
    markActivity();
    dispatchMouse(after ? 'mousedown' : 'mouseup', 0);
    if (!after) dispatchMouse('click', 0);
  };

  const setTouchLeft = (down: boolean) => {
    const before = leftPressed();
    touchLeft = down;
    const after = leftPressed();
    if (before === after) return;
    markActivity();
    dispatchMouse(after ? 'mousedown' : 'mouseup', 0);
    if (!after) dispatchMouse('click', 0);
  };

  const setPadRight = (down: boolean) => {
    if (padRight === down) return;
    padRight = down;
    markActivity();
    dispatchMouse(down ? 'mousedown' : 'mouseup', 2);
    if (down) dispatchMouse('contextmenu', 2);
  };

  const touchPoint = (event: any) => {
    const list = event?.changedTouches?.length ? event.changedTouches : event?.touches;
    const touch = list?.[0];
    if (!touch) return null;
    return {
      x: Number(touch.clientX ?? touch.pageX ?? touch.screenX ?? 0),
      y: Number(touch.clientY ?? touch.pageY ?? touch.screenY ?? 0)
    };
  };

  try {
    screen.addEventListener('touchstart', (event: any) => {
      const point = touchPoint(event);
      if (!point) return;
      markActivity();
      movePointer(point.x, point.y, true);
      setTouchLeft(true);
      try { event.preventDefault?.(); } catch {}
    }, { passive: false } as any);
    screen.addEventListener('touchmove', (event: any) => {
      const point = touchPoint(event);
      if (!point) return;
      markActivity();
      movePointer(point.x, point.y, true);
      try { event.preventDefault?.(); } catch {}
    }, { passive: false } as any);
    screen.addEventListener('touchend', (event: any) => {
      const point = touchPoint(event);
      if (point) movePointer(point.x, point.y, true);
      setTouchLeft(false);
      try { event.preventDefault?.(); } catch {}
    }, { passive: false } as any);
  } catch (error) {
    log(`[pointer] touch hook FAILED | ${String(error)}`);
  }

  const updateCursor = () => {
    if (!activated) return;
    const pixi = g.PIXI;
    const scene = g.SceneManager?._scene;
    if (!pixi?.Graphics || !scene?.addChild) return;
    if (!cursor) {
      try {
        cursor = new pixi.Graphics();
        cursor.__mvmzPointerCursor = true;
        cursor.interactive = false;
        cursor.interactiveChildren = false;
        cursor.lineStyle(4, 0x000000, 0.95);
        cursor.drawCircle(0, 0, 7);
        cursor.moveTo(-11, 0); cursor.lineTo(11, 0);
        cursor.moveTo(0, -11); cursor.lineTo(0, 11);
        cursor.lineStyle(1, 0xffffff, 1);
        cursor.drawCircle(0, 0, 7);
        cursor.moveTo(-11, 0); cursor.lineTo(11, 0);
        cursor.moveTo(0, -11); cursor.lineTo(0, 11);
        log('[pointer] PIXI cursor overlay created');
      } catch (error) {
        log(`[pointer] cursor creation FAILED | ${String(error)}`);
        cursor = null;
        return;
      }
    }
    try {
      if (cursor.parent !== scene) {
        try { cursor.parent?.removeChild?.(cursor); } catch {}
        scene.addChild(cursor);
      }
      if (scene.children?.length && scene.getChildIndex?.(cursor) !== scene.children.length - 1) {
        scene.setChildIndex?.(cursor, scene.children.length - 1);
      }
      const fit = g.__mvmzViewportFit;
      const logicalWidth = Math.max(1, Number(fit?.logicalWidth || g.Graphics?.width || g.Graphics?._width || width));
      const logicalHeight = Math.max(1, Number(fit?.logicalHeight || g.Graphics?.height || g.Graphics?._height || height));
      const mapped = resolveEventCoords();
      const logicalX = mapped.logicalX;
      const logicalY = mapped.logicalY;
      const idleMs = Number(performance.now?.() || Date.now()) - lastActivityAt;
      const recentActivity = lastActivityAt > 0 && idleMs < CURSOR_HIDE_MS;
      const insideViewport = logicalX >= 0 && logicalY >= 0 && logicalX < logicalWidth && logicalY < logicalHeight;
      const shouldShow = recentActivity && insideViewport;
      // IMPORTANT: never toggle PIXI.DisplayObject.visible for the host cursor.
      // On HOS/Pixi4 this cursor lives as the last child of the active scene;
      // toggling visible=false can invalidate the scene/presenter state and blank
      // the whole frame until another pointer event forces activity again.
      // Keep it renderable/visible and park only the cursor geometry offscreen.
      cursor.visible = true;
      cursor.renderable = true;
      cursor.x = shouldShow ? logicalX : -4096;
      cursor.y = shouldShow ? logicalY : -4096;
      const parked = !shouldShow;
      if (cursor.__mvmzPointerParked !== parked) {
        cursor.__mvmzPointerParked = parked;
        log(parked ? '[pointer] cursor parked offscreen after idle' : '[pointer] cursor restored from offscreen park');
      }
    } catch {}
  };

  const frame = (timestamp?: number) => {
    const now = Number(timestamp ?? performance.now?.() ?? Date.now());
    const dt = Math.min(0.05, Math.max(0, (now - lastFrameTime) / 1000));
    lastFrameTime = now;
    try {
      const pad = navigator.getGamepads()[0];
      const axisX = curvedAxis(Number(pad?.axes?.[RIGHT_STICK_X] || 0));
      const axisY = curvedAxis(Number(pad?.axes?.[RIGHT_STICK_Y] || 0));
      if (axisX || axisY) {
        markActivity();
        movePointer(pointerX + axisX * MAX_SPEED * dt, pointerY + axisY * MAX_SPEED * dt, true);
      }
      setPadLeft(!!pad?.buttons?.[ZL_BUTTON]?.pressed);
      setPadRight(!!pad?.buttons?.[ZR_BUTTON]?.pressed);
    } catch {}
    updateCursor();
    try { requestAnimationFrame(frame); } catch {}
  };

  g.__mvmzPointer = {
    get x() { return pointerX; },
    get y() { return pointerY; },
    get active() { return activated; },
    moveTo(x: number, y: number) { markActivity(); movePointer(x, y, true); }
  };
  log('[pointer] bridge installed | touch=left mouse rightStick=axes2/3 ZL=left ZR=right cursor=PIXI idleParkMs=3000 visibleToggle=off coordinateMap=logical-inverse');
  try { requestAnimationFrame(frame); } catch (error) { log(`[pointer] RAF pump FAILED | ${String(error)}`); }
}
